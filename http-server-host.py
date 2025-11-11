#!/usr/bin/env python3
"""
Native messaging host for Interview Autofill Extension ChatGPT API Server
Provides HTTP server functionality on localhost:8765 for OpenAI-compatible API endpoints
"""

import sys
import json
import struct
import http.server
import socketserver
import threading
import urllib.parse
import time
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class ChatGPTAPIHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        """Suppress default HTTP server logging"""
        pass

    def do_OPTIONS(self):
        """Handle CORS preflight requests"""
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self):
        """Handle GET requests"""
        if self.path == '/health' or self.path == '/api/health':
            self.send_json_response(200, {
                'status': 'healthy',
                'timestamp': int(time.time() * 1000),
                'service': 'chatgpt-api-server'
            })
        else:
            self.send_json_response(404, {'error': 'Endpoint not found'})

    def do_POST(self):
        """Handle POST requests"""
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)

        try:
            # Parse request body
            request_data = {
                'type': 'http_request',
                'method': 'POST',
                'path': self.path,
                'headers': dict(self.headers),
                'body': post_data.decode('utf-8', errors='ignore')
            }

            # Send to Chrome extension via native messaging
            response = send_to_extension(request_data)

            # Send response back to HTTP client
            self.send_json_response(response.get('status', 200), response.get('body', {}))

        except Exception as e:
            logger.error(f"Error handling POST request: {e}")
            self.send_json_response(500, {'error': str(e)})

    def do_DELETE(self):
        """Handle DELETE requests"""
        try:
            request_data = {
                'type': 'http_request',
                'method': 'DELETE',
                'path': self.path,
                'headers': dict(self.headers),
                'body': ''
            }

            response = send_to_extension(request_data)
            self.send_json_response(response.get('status', 200), response.get('body', {}))

        except Exception as e:
            logger.error(f"Error handling DELETE request: {e}")
            self.send_json_response(500, {'error': str(e)})

    def send_json_response(self, status_code, data):
        """Send JSON response with appropriate headers"""
        response_body = json.dumps(data, ensure_ascii=False).encode('utf-8')

        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Length', str(len(response_body)))
        self.end_headers()

        self.wfile.write(response_body)

def send_to_extension(data):
    """Send message to Chrome extension and wait for response"""
    try:
        # Send message to extension
        encoded = json.dumps(data).encode('utf-8')
        sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
        sys.stdout.buffer.write(encoded)
        sys.stdout.buffer.flush()

        # Read response length
        text_length_bytes = sys.stdin.buffer.read(4)
        if len(text_length_bytes) < 4:
            raise Exception('Failed to read response length from extension')

        text_length = struct.unpack('@I', text_length_bytes)[0]

        # Read response data
        response_bytes = sys.stdin.buffer.read(text_length)
        if len(response_bytes) < text_length:
            raise Exception('Failed to read complete response from extension')

        response = response_bytes.decode('utf-8')
        return json.loads(response)

    except Exception as e:
        logger.error(f"Error communicating with extension: {e}")
        return {
            'status': 503,
            'body': {'error': f'Extension communication error: {str(e)}'}
        }

def run_server(port=8765):
    """Run HTTP server in a separate thread"""
    try:
        with socketserver.TCPServer(("", port), ChatGPTAPIHandler) as httpd:
            logger.info(f"ChatGPT API server started on port {port}")
            httpd.serve_forever()
    except Exception as e:
        logger.error(f"Failed to start HTTP server on port {port}: {e}")
        sys.exit(1)

class NativeMessagingHost:
    def __init__(self):
        self.server_thread = None
        self.http_server = None
        self.running = False

    def start_http_server(self, port=8765):
        """Start HTTP server in background thread"""
        if self.server_thread and self.server_thread.is_alive():
            return True

        try:
            self.server_thread = threading.Thread(
                target=run_server,
                args=(port,),
                daemon=True
            )
            self.server_thread.start()
            time.sleep(0.5)  # Give server time to start

            if self.server_thread.is_alive():
                logger.info(f"HTTP server started successfully on port {port}")
                return True
            else:
                logger.error("HTTP server failed to start")
                return False

        except Exception as e:
            logger.error(f"Error starting HTTP server: {e}")
            return False

    def stop_http_server(self):
        """Stop HTTP server"""
        # Note: Stopping the TCPServer gracefully would require additional implementation
        logger.info("HTTP server stop requested")

    def run_native_messaging_loop(self):
        """Main native messaging loop"""
        logger.info("Starting native messaging host")
        self.running = True

        try:
            while self.running:
                # Read message length
                text_length_bytes = sys.stdin.buffer.read(4)
                if len(text_length_bytes) < 4:
                    break  # EOF reached

                text_length = struct.unpack('@I', text_length_bytes)[0]

                # Read message content
                message_bytes = sys.stdin.buffer.read(text_length)
                if len(message_bytes) < text_length:
                    break

                message = message_bytes.decode('utf-8')

                try:
                    data = json.loads(message)
                    response = self.handle_message(data)
                except json.JSONDecodeError as e:
                    logger.error(f"JSON decode error: {e}")
                    response = {
                        'type': 'error',
                        'error': 'Invalid JSON format'
                    }
                except Exception as e:
                    logger.error(f"Error handling message: {e}")
                    response = {
                        'type': 'error',
                        'error': str(e)
                    }

                # Send response back
                encoded_response = json.dumps(response).encode('utf-8')
                sys.stdout.buffer.write(struct.pack('@I', len(encoded_response)))
                sys.stdout.buffer.write(encoded_response)
                sys.stdout.buffer.flush()

        except KeyboardInterrupt:
            logger.info("Received keyboard interrupt")
        except Exception as e:
            logger.error(f"Error in native messaging loop: {e}")
        finally:
            self.running = False
            self.stop_http_server()
            logger.info("Native messaging host stopped")

    def handle_message(self, data):
        """Handle incoming messages from Chrome extension"""
        message_type = data.get('type', '')

        if message_type == 'start_server':
            port = data.get('port', 8765)
            success = self.start_http_server(port)
            return {
                'type': 'server_started',
                'success': success,
                'port': port
            }

        elif message_type == 'stop_server':
            self.stop_http_server()
            return {
                'type': 'server_stopped',
                'success': True
            }

        elif message_type == 'ping':
            return {
                'type': 'pong',
                'timestamp': int(time.time() * 1000)
            }

        else:
            return {
                'type': 'unknown',
                'error': f'Unknown message type: {message_type}'
            }

def main():
    """Main entry point"""
    logger.info("ChatGPT API Native Messaging Host starting...")

    try:
        host = NativeMessagingHost()
        host.run_native_messaging_loop()
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()