// ChatGPT Local API Server
// Provides OpenAI-compatible REST API endpoints for ChatGPT interactions

class ChatGPTApiServer {
  constructor(port = 8765) {
    this.port = port;
    this.sessionPool = null;
    this.server = null;
    this.isRunning = false;
  }

  // Start the API server
  async start() {
    if (this.isRunning) {
      console.log('ChatGPT API server already running');
      return;
    }

    try {
      // Initialize session pool
      if (typeof getSessionPool !== 'undefined') {
        this.sessionPool = getSessionPool();
      } else {
        throw new Error('Session pool not available. Ensure session-pool.js is loaded first.');
      }

      // Start native messaging host connection
      this.server = new ChromeNativeServer(this.port);
      this.setupRoutes();
      await this.server.start();
      this.isRunning = true;
      console.log(`ChatGPT API server started on port ${this.port}`);
    } catch (error) {
      console.error('Failed to start API server:', error);
      throw error;
    }
  }

  // Stop the API server
  async stop() {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this.isRunning = false;
    console.log('ChatGPT API server stopped');
  }

  // Setup API routes
  setupRoutes() {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    // CORS preflight
    this.server.options('*', (req, res) => {
      res.writeHead(200, corsHeaders);
      res.end();
    });

    // Health check
    this.server.get('/health', (req, res) => {
      const status = this.sessionPool ? this.sessionPool.getStatus() : null;
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify({
        status: 'healthy',
        timestamp: Date.now(),
        version: '1.0.0',
        chatgpt: status || { poolSize: 0, status: 'unavailable' }
      }));
    });

    // Chat completions (OpenAI-compatible)
    this.server.post('/api/chat/completions', async (req, res) => {
      try {
        const body = await this.parseRequestBody(req);

        // Validate request
        if (!body.messages || !Array.isArray(body.messages)) {
          throw new Error('Invalid messages array');
        }

        // Convert messages to single prompt
        const prompt = this.convertMessagesToPrompt(body.messages);

        // Determine priority based on content
        const priority = this.determinePriority(prompt);

        // Send to session pool
        const result = await this.sessionPool.enqueueRequest(prompt, {
          priority,
          timeout: (body.timeout || 60) * 1000
        });

        if (result.success) {
          const response = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'gpt-4',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: result.text
              },
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: this.estimateTokens(prompt),
              completion_tokens: this.estimateTokens(result.text),
              total_tokens: this.estimateTokens(prompt + result.text)
            }
          };

          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(response));
        } else {
          const statusCode = this.getErrorStatusCode(result.error);
          res.writeHead(statusCode, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({
            error: {
              message: result.error,
              type: 'api_error',
              code: 'chatgpt_error'
            }
          }));
        }

      } catch (error) {
        console.error('Chat completion error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: {
            message: error.message,
            type: 'invalid_request_error'
          }
        }));
      }
    });

    // Create new session
    this.server.post('/api/session/new', async (req, res) => {
      try {
        const session = await this.sessionPool.createSession();
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          sessionId: session.id,
          status: session.status
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: error.message
        }));
      }
    });

    // Get session status
    this.server.get('/api/session/status', (req, res) => {
      const status = this.sessionPool.getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(status));
    });

    // Delete session
    this.server.delete('/api/session/:id', async (req, res) => {
      try {
        const sessionId = req.params.id;
        await this.sessionPool.rotateSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: 'Session not found'
        }));
      }
    });

    // Simple completion endpoint (non-streaming)
    this.server.post('/api/completions', async (req, res) => {
      try {
        const body = await this.parseRequestBody(req);

        if (!body.prompt) {
          throw new Error('Prompt is required');
        }

        const priority = this.determinePriority(body.prompt);

        const result = await this.sessionPool.enqueueRequest(body.prompt, {
          priority,
          timeout: (body.timeout || 60) * 1000
        });

        if (result.success) {
          const response = {
            id: `cmpl-${Date.now()}`,
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model || 'gpt-4',
            choices: [{
              text: result.text,
              index: 0,
              logprobs: null,
              finish_reason: 'stop'
            }],
            usage: {
              prompt_tokens: this.estimateTokens(body.prompt),
              completion_tokens: this.estimateTokens(result.text),
              total_tokens: this.estimateTokens(body.prompt + result.text)
            }
          };

          res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(response));
        } else {
          const statusCode = this.getErrorStatusCode(result.error);
          res.writeHead(statusCode, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({
            error: {
              message: result.error,
              type: 'api_error'
            }
          }));
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
        res.end(JSON.stringify({
          error: {
            message: error.message,
            type: 'invalid_request_error'
          }
        }));
      }
    });
  }

  // Convert OpenAI messages format to ChatGPT prompt
  convertMessagesToPrompt(messages) {
    let prompt = '';

    for (const message of messages) {
      const role = message.role || 'user';
      const content = message.content || '';

      if (role === 'system') {
        prompt += `System: ${content}\n\n`;
      } else if (role === 'user') {
        prompt += `User: ${content}\n\n`;
      } else if (role === 'assistant') {
        prompt += `Assistant: ${content}\n\n`;
      }
    }

    prompt += 'Assistant: ';
    return prompt;
  }

  // Determine request priority based on content
  determinePriority(prompt) {
    // High priority for resume-related content
    if (/resume|experience|skills|job|interview|application|urgent|asap/i.test(prompt)) {
      return 'high';
    }

    // Low priority for bulk/batch operations
    if (/batch|multiple|list|generate.*\d+|bulk/i.test(prompt)) {
      return 'low';
    }

    return 'normal';
  }

  // Get appropriate HTTP status code for error type
  getErrorStatusCode(error) {
    if (/timeout/i.test(error)) return 408;
    if (/queue.*full|capacity/i.test(error)) return 429;
    if (/session.*not.*found|unauthorized/i.test(error)) return 401;
    if (/captcha|rate.*limit/i.test(error)) return 429;
    return 500;
  }

  // Estimate token count (rough approximation)
  estimateTokens(text) {
    return Math.ceil(text.length / 4); // ~4 characters per token
  }

  // Parse request body
  async parseRequestBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk.toString());
      req.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('Invalid JSON in request body'));
        }
      });
      req.on('error', reject);
    });
  }
}

// Chrome Native Messaging Server implementation
class ChromeNativeServer {
  constructor(port) {
    this.port = port;
    this.routes = new Map();
    this.nativePort = null;
    this.requestHandlers = new Map();
  }

  async start() {
    try {
      // Connect to native messaging host
      this.nativePort = chrome.runtime.connectNative('com.interview-autofill.httpserver');

      // Set up message handling
      this.nativePort.onMessage.addListener(this.handleNativeMessage.bind(this));
      this.nativePort.onDisconnect.addListener(() => {
        console.log('Native messaging host disconnected');
        this.nativePort = null;
      });

      // Send server configuration
      this.nativePort.postMessage({
        type: 'start_server',
        port: this.port
      });

      console.log('Connected to native messaging host');
    } catch (error) {
      // Fallback to simple request-response mode without native messaging
      console.log('Native messaging not available, using fallback mode');
      this.setupFallbackMode();
    }
  }

  async stop() {
    if (this.nativePort) {
      this.nativePort.postMessage({ type: 'stop_server' });
      this.nativePort.disconnect();
      this.nativePort = null;
    }
  }

  setupFallbackMode() {
    // In fallback mode, we handle requests directly through messaging
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'http_request') {
        this.handleHttpRequest(request, sendResponse);
        return true;
      }
    });
  }

  handleNativeMessage(message) {
    if (message.type === 'http_request') {
      this.handleHttpRequest(message, (response) => {
        this.nativePort.postMessage(response);
      });
    }
  }

  handleHttpRequest(request, callback) {
    const { method, path, headers, body } = request;
    const routeKey = `${method.toUpperCase()} ${path}`;
    const handler = this.routes.get(routeKey);

    if (!handler) {
      callback({
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Not found' })
      });
      return;
    }

    try {
      const mockReq = {
        method: method.toUpperCase(),
        path,
        headers: headers || {},
        params: this.extractParams(path),
        on: (event, handler) => {
          if (event === 'data' && body) {
            handler(body);
          } else if (event === 'end') {
            handler();
          }
        }
      };

      const mockRes = {
        writeHead: (status, headers) => {
          callback({
            status,
            headers: headers || {},
            body: ''
          });
        },
        end: (responseBody) => {
          if (typeof callback === 'function') {
            const currentCallback = callback;
            callback = () => {};
            currentCallback({
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: responseBody || ''
            });
          }
        }
      };

      handler(mockReq, mockRes);
    } catch (error) {
      callback({
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: error.message })
      });
    }
  }

  extractParams(path) {
    // Simple parameter extraction (can be enhanced)
    const params = {};
    if (path.includes('/session/')) {
      const parts = path.split('/session/');
      if (parts.length > 1) {
        params.id = parts[1].split('/')[0];
      }
    }
    return params;
  }

  get(path, handler) {
    this.routes.set(`GET ${path}`, handler);
  }

  post(path, handler) {
    this.routes.set(`POST ${path}`, handler);
  }

  delete(path, handler) {
    this.routes.set(`DELETE ${path}`, handler);
  }

  options(path, handler) {
    this.routes.set(`OPTIONS ${path}`, handler);
  }
}

// Global API server instance
let apiServer = null;

// Initialize API server
async function initializeApiServer() {
  try {
    const settings = await getChatGPTSettings();
    if (settings.enableLocalApi) {
      apiServer = new ChatGPTApiServer(settings.apiPort);
      await apiServer.start();
    }
  } catch (error) {
    console.error('Failed to initialize API server:', error);
  }
}

// Cleanup on extension unload
if (typeof chrome !== 'undefined' && chrome.runtime.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => {
    if (apiServer) {
      apiServer.stop();
    }
  });
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatGPTApiServer, initializeApiServer };
}