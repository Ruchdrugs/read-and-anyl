// ChatGPT Session Pool Manager
// Handles multiple ChatGPT browser sessions with intelligent load balancing and health monitoring

class ChatGPTSessionPool {
  constructor() {
    this.sessions = new Map(); // sessionId -> session object
    this.requestQueue = [];
    this.maxPoolSize = 3;
    this.healthCheckInterval = 30000; // 30 seconds
    this.requestTimeout = 60000; // 60 seconds
    this.maxQueueSize = 100;
    this.sessionRotationThreshold = 50; // requests per session
    this.sessionMaxAge = 7200000; // 2 hours in milliseconds

    // Statistics
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      sessionsCreated: 0,
      sessionsRotated: 0
    };

    // Start health monitoring
    this.startHealthMonitoring();
  }

  // Create new ChatGPT session
  async createSession() {
    try {
      const newTab = await new Promise((resolve) => {
        chrome.tabs.create({ url: 'https://chat.openai.com', active: false }, resolve);
      });

      if (!newTab?.id) {
        throw new Error('Failed to create ChatGPT tab');
      }

      const session = {
        id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        tabId: newTab.id,
        status: 'WARMING_UP',
        createdAt: Date.now(),
        lastUsed: Date.now(),
        requestCount: 0,
        errorCount: 0,
        averageResponseTime: 0,
        healthStatus: null,
        consecutiveErrors: 0
      };

      this.sessions.set(session.id, session);
      this.stats.sessionsCreated++;

      // Wait for session to warm up
      await this.warmUpSession(session.id);

      return session;
    } catch (error) {
      console.error('Failed to create ChatGPT session:', error);
      throw error;
    }
  }

  // Wait for ChatGPT session to be ready for input
  async warmUpSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    try {
      // Wait for page to load and input to be available
      for (let attempt = 0; attempt < 20; attempt++) {
        const health = await this.checkSessionHealth(sessionId);
        if (health.healthy && health.canSendMessage) {
          session.status = 'IDLE';
          session.healthStatus = health;
          return true;
        }

        if (attempt > 10) {
          // Try refreshing if still not ready
          await chrome.tabs.reload(session.tabId);
        }

        await new Promise(r => setTimeout(r, 2000));
      }

      throw new Error('Session failed to warm up');
    } catch (error) {
      session.status = 'UNHEALTHY';
      throw error;
    }
  }

  // Add request to queue
  async enqueueRequest(prompt, options = {}) {
    if (this.requestQueue.length >= this.maxQueueSize) {
      throw new Error('Request queue is full');
    }

    const request = {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      prompt,
      priority: options.priority || 'normal', // high, normal, low
      timeout: options.timeout || this.requestTimeout,
      createdAt: Date.now(),
      resolve: null,
      reject: null
    };

    return new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;

      // Add to queue based on priority
      if (request.priority === 'high') {
        this.requestQueue.unshift(request);
      } else {
        this.requestQueue.push(request);
      }

      this.stats.totalRequests++;
      this.processQueue();
    });
  }

  // Process queued requests
  async processQueue() {
    if (this.requestQueue.length === 0) return;

    // Find available session
    const availableSession = this.findAvailableSession();
    if (!availableSession) {
      // Try to create new session if below max
      if (this.sessions.size < this.maxPoolSize) {
        try {
          const newSession = await this.createSession();
          this.processQueue(); // Retry with new session
        } catch (error) {
          console.error('Failed to create new session:', error);
        }
      }
      return;
    }

    const request = this.requestQueue.shift();
    this.processRequest(availableSession, request);
  }

  // Find best available session for request
  findAvailableSession() {
    const sessions = Array.from(this.sessions.values())
      .filter(s => s.status === 'IDLE')
      .sort((a, b) => {
        // Prefer sessions with fewer errors and better response times
        const scoreA = this.calculateSessionScore(a);
        const scoreB = this.calculateSessionScore(b);
        return scoreB - scoreA;
      });

    return sessions[0] || null;
  }

  // Calculate session score for load balancing
  calculateSessionScore(session) {
    let score = 100;

    // Penalize for errors
    score -= session.errorCount * 10;
    score -= session.consecutiveErrors * 20;

    // Penalize for high response times
    score -= Math.min(session.averageResponseTime / 100, 50); // Cap at 50 points penalty

    // Prefer recently used sessions (but not too recent)
    const timeSinceLastUse = Date.now() - session.lastUsed;
    if (timeSinceLastUse < 5000) score -= 5; // Too recent
    if (timeSinceLastUse > 300000) score -= 10; // Too old

    // Penalize for age
    const age = Date.now() - session.createdAt;
    if (age > this.sessionMaxAge) score -= 20; // Too old

    // Penalize for high request count (rotation candidate)
    if (session.requestCount > this.sessionRotationThreshold) score -= 15;

    return Math.max(0, score);
  }

  // Process single request using specific session
  async processRequest(session, request) {
    const startTime = Date.now();
    session.status = 'BUSY';
    session.lastUsed = Date.now();
    session.requestCount++;

    try {
      // Send prompt to ChatGPT
      await this.sendPromptToChatGPT(session.tabId, request.prompt);

      // Extract response
      const response = await this.extractResponseFromChatGPT(
        session.tabId,
        request.timeout
      );

      if (response.success && response.text) {
        // Update statistics
        const responseTime = Date.now() - startTime;
        this.updateSessionStats(session, responseTime, true);

        request.resolve({
          success: true,
          text: response.text,
          sessionId: session.id,
          responseTime
        });

        this.stats.successfulRequests++;

        // Reset consecutive errors on success
        session.consecutiveErrors = 0;

        // Check if session needs rotation
        if (session.requestCount >= this.sessionRotationThreshold) {
          session.status = 'ROTATION_NEEDED';
        }
      } else {
        throw new Error(response.error || 'Failed to extract response');
      }

    } catch (error) {
      // Update error statistics
      this.updateSessionStats(session, Date.now() - startTime, false);
      session.errorCount++;
      session.consecutiveErrors++;

      request.resolve({
        success: false,
        error: error.message,
        sessionId: session.id
      });

      this.stats.failedRequests++;

      // Mark session as unhealthy if too many consecutive errors
      if (session.consecutiveErrors >= 3) {
        session.status = 'UNHEALTHY';
        this.rotateSession(session.id);
      }
    } finally {
      if (session.status === 'BUSY') {
        session.status = 'IDLE';
      }
      // Continue processing queue
      this.processQueue();
    }
  }

  // Send prompt to ChatGPT tab
  async sendPromptToChatGPT(tabId, prompt) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Timeout sending prompt to ChatGPT'));
      }, 10000);

      chrome.tabs.sendMessage(tabId, {
        type: 'CHATGPT_ASK',
        prompt
      }, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.ok) {
          reject(new Error(response.error || 'Failed to send prompt'));
        } else {
          resolve(response);
        }
      });
    });
  }

  // Extract response from ChatGPT tab
  async extractResponseFromChatGPT(tabId, timeoutMs) {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({ success: false, error: 'Timeout extracting response' });
      }, timeoutMs + 5000); // Extra buffer

      chrome.tabs.sendMessage(tabId, {
        type: 'CHATGPT_EXTRACT_RESPONSE',
        timeoutMs
      }, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else if (!response?.ok) {
          resolve({ success: false, error: response.error || 'Extraction failed' });
        } else {
          resolve({
            success: true,
            text: response.text,
            complete: response.complete
          });
        }
      });
    });
  }

  // Check session health
  async checkSessionHealth(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({
          healthy: false,
          issues: ['Health check timeout'],
          canSendMessage: false
        });
      }, 5000);

      chrome.tabs.sendMessage(session.tabId, {
        type: 'CHATGPT_CHECK_HEALTH'
      }, (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError || !response?.ok) {
          resolve({
            healthy: false,
            issues: ['Communication error'],
            canSendMessage: false
          });
        } else {
          resolve(response.health);
        }
      });
    });
  }

  // Update session statistics
  updateSessionStats(session, responseTime, success) {
    const alpha = 0.3; // Exponential moving average factor
    session.averageResponseTime = session.averageResponseTime * (1 - alpha) + responseTime * alpha;

    // Update global stats
    const beta = 0.1; // Smoothing factor for global average
    this.stats.averageResponseTime = this.stats.averageResponseTime * (1 - beta) + responseTime * beta;
  }

  // Rotate unhealthy session
  async rotateSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      // Close old tab
      await chrome.tabs.remove(session.tabId);
    } catch (error) {
      console.error('Failed to close session tab:', error);
    }

    // Remove from pool
    this.sessions.delete(sessionId);
    this.stats.sessionsRotated++;

    // Create replacement session if needed
    if (this.sessions.size < this.maxPoolSize) {
      this.createSession().catch(console.error);
    }
  }

  // Start health monitoring
  startHealthMonitoring() {
    setInterval(async () => {
      for (const [sessionId, session] of this.sessions) {
        try {
          const health = await this.checkSessionHealth(sessionId);
          session.healthStatus = health;

          if (!health.healthy && session.status === 'IDLE') {
            session.status = 'UNHEALTHY';
            this.rotateSession(sessionId);
          }

          // Check for session age rotation
          const age = Date.now() - session.createdAt;
          if (age > this.sessionMaxAge) {
            session.status = 'ROTATION_NEEDED';
            this.rotateSession(sessionId);
          }

        } catch (error) {
          console.error(`Health check failed for session ${sessionId}:`, error);
          session.status = 'UNHEALTHY';
        }
      }
    }, this.healthCheckInterval);
  }

  // Get pool status
  getStatus() {
    const sessions = Array.from(this.sessions.values());
    const idleSessions = sessions.filter(s => s.status === 'IDLE');
    const busySessions = sessions.filter(s => s.status === 'BUSY');
    const unhealthySessions = sessions.filter(s => s.status === 'UNHEALTHY');

    return {
      poolSize: this.sessions.size,
      maxPoolSize: this.maxPoolSize,
      queueLength: this.requestQueue.length,
      sessions: sessions.map(s => ({
        id: s.id,
        status: s.status,
        requestCount: s.requestCount,
        errorCount: s.errorCount,
        averageResponseTime: Math.round(s.averageResponseTime),
        age: Math.round((Date.now() - s.createdAt) / 1000),
        lastUsed: Math.round((Date.now() - s.lastUsed) / 1000)
      })),
      statistics: {
        ...this.stats,
        successRate: this.stats.totalRequests > 0 ?
          Math.round((this.stats.successfulRequests / this.stats.totalRequests) * 100) : 0
      },
      health: {
        idle: idleSessions.length,
        busy: busySessions.length,
        unhealthy: unhealthySessions.length
      }
    };
  }

  // Cleanup method for extension shutdown
  async cleanup() {
    for (const session of this.sessions.values()) {
      try {
        await chrome.tabs.remove(session.tabId);
      } catch (error) {
        console.error('Failed to close session during cleanup:', error);
      }
    }
    this.sessions.clear();
    this.requestQueue = [];
  }
}

// Global instance
let sessionPool = null;

function getSessionPool() {
  if (!sessionPool) {
    sessionPool = new ChatGPTSessionPool();
  }
  return sessionPool;
}

// Initialize session pool on load
getSessionPool();

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatGPTSessionPool, getSessionPool };
}