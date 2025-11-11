// ChatGPT Authentication and Session Manager
// Handles authentication, session persistence, and security for ChatGPT sessions

class ChatGPTAuthManager {
  constructor() {
    this.authenticatedSessions = new Set();
    this.sessionCookies = new Map();
    this.authCheckInterval = 60000; // 1 minute
    this.sessionTimeout = 3600000; // 1 hour
    this.maxRetryAttempts = 3;
    this.retryDelay = 5000; // 5 seconds

    // Start authentication monitoring
    this.startAuthMonitoring();
  }

  // Check if ChatGPT session is authenticated
  async isSessionAuthenticated(tabId) {
    try {
      // Check if we can access ChatGPT features
      const response = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'CHATGPT_CHECK_AUTH'
        }, (response) => {
          resolve(response);
        });
      });

      if (chrome.runtime.lastError) {
        return { authenticated: false, error: chrome.runtime.lastError.message };
      }

      return response || { authenticated: false, error: 'No response' };
    } catch (error) {
      return { authenticated: false, error: error.message };
    }
  }

  // Validate session by checking for authentication indicators
  async validateSession(tabId) {
    try {
      // Check for login state by looking for specific elements
      const result = await new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'CHATGPT_VALIDATE_SESSION'
        }, resolve);
      });

      if (chrome.runtime.lastError) {
        return false;
      }

      return result?.authenticated || false;
    } catch (error) {
      console.error('Session validation failed:', error);
      return false;
    }
  }

  // Initiate authentication flow for a session
  async initiateAuth(tabId) {
    try {
      // Navigate to ChatGPT login page if not already there
      const tab = await new Promise((resolve) => {
        chrome.tabs.get(tabId, resolve);
      });

      if (!tab.url.includes('chat.openai.com')) {
        await new Promise((resolve) => {
          chrome.tabs.update(tabId, { url: 'https://chat.openai.com' }, resolve);
        });

        // Wait for page to load
        await new Promise(r => setTimeout(r, 3000));
      }

      // Check if already authenticated after navigation
      const authStatus = await this.isSessionAuthenticated(tabId);
      if (authStatus.authenticated) {
        this.authenticatedSessions.add(tabId);
        return { success: true, message: 'Already authenticated' };
      }

      return {
        success: false,
        needsUserAction: true,
        message: 'Please log in to ChatGPT in the opened tab'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to initiate authentication'
      };
    }
  }

  // Refresh session by reloading and re-validating
  async refreshSession(tabId) {
    try {
      // Reload the tab
      await new Promise((resolve, reject) => {
        chrome.tabs.reload(tabId, {}, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve();
          }
        });
      });

      // Wait for page to load
      await new Promise(r => setTimeout(r, 5000));

      // Validate the refreshed session
      const isValid = await this.validateSession(tabId);
      if (isValid) {
        this.authenticatedSessions.add(tabId);
        return { success: true, message: 'Session refreshed successfully' };
      } else {
        this.authenticatedSessions.delete(tabId);
        return {
          success: false,
          needsUserAction: true,
          message: 'Please re-authenticate in the refreshed tab'
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to refresh session'
      };
    }
  }

  // Handle authentication errors with retry logic
  async handleAuthError(tabId, error) {
    const sessionKey = `auth_retry_${tabId}`;
    const retryCount = parseInt(localStorage.getItem(sessionKey) || '0');

    if (retryCount >= this.maxRetryAttempts) {
      // Max retries reached, require user intervention
      localStorage.removeItem(sessionKey);
      return {
        success: false,
        requiresReauth: true,
        message: 'Authentication failed. Please log in again.'
      };
    }

    // Increment retry count
    localStorage.setItem(sessionKey, String(retryCount + 1));

    // Wait before retry
    await new Promise(r => setTimeout(r, this.retryDelay));

    // Try to refresh the session
    const refreshResult = await this.refreshSession(tabId);
    if (refreshResult.success) {
      localStorage.removeItem(sessionKey);
      return { success: true, message: 'Authentication recovered' };
    }

    // If refresh failed, try initiating auth
    const authResult = await this.initiateAuth(tabId);
    if (authResult.success) {
      localStorage.removeItem(sessionKey);
      return { success: true, message: 'Authentication successful' };
    }

    // Retry failed
    return {
      success: false,
      retryCount: retryCount + 1,
      maxRetries: this.maxRetryAttempts,
      ...authResult
    };
  }

  // Monitor authentication status across sessions
  startAuthMonitoring() {
    setInterval(async () => {
      const tabs = await new Promise((resolve) => {
        chrome.tabs.query({}, resolve);
      });

      const chatgptTabs = tabs.filter(tab =>
        tab.url && tab.url.includes('chat.openai.com')
      );

      for (const tab of chatgptTabs) {
        try {
          const isAuth = await this.isSessionAuthenticated(tab.id);
          if (isAuth.authenticated) {
            this.authenticatedSessions.add(tab.id);
          } else {
            this.authenticatedSessions.delete(tab.id);
          }
        } catch (error) {
          console.error(`Auth check failed for tab ${tab.id}:`, error);
          this.authenticatedSessions.delete(tab.id);
        }
      }
    }, this.authCheckInterval);
  }

  // Get authentication status for all sessions
  getAuthStatus() {
    return {
      authenticatedSessions: Array.from(this.authenticatedSessions),
      totalSessions: this.authenticatedSessions.size,
      lastChecked: Date.now()
    };
  }

  // Check if specific session is authenticated
  isSessionValid(tabId) {
    return this.authenticatedSessions.has(tabId);
  }

  // Remove session from authenticated list
  invalidateSession(tabId) {
    this.authenticatedSessions.delete(tabId);
  }

  // Cleanup expired sessions
  cleanupExpiredSessions() {
    // This would be called periodically to remove old invalid sessions
    // Implementation depends on how we track session age
  }

  // Prompt user for authentication
  async promptUserForAuth(tabId) {
    try {
      // Focus the ChatGPT tab
      await new Promise((resolve) => {
        chrome.tabs.update(tabId, { active: true }, resolve);
      });

      // Show notification (if supported)
      if (chrome.notifications) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('assets/icon48.png'),
          title: 'ChatGPT Authentication Required',
          message: 'Please log in to ChatGPT to continue using the API'
        });
      }

      return {
        success: true,
        message: 'Please complete authentication in the ChatGPT tab'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to prompt for authentication'
      };
    }
  }

  // Get authentication URL for manual login
  getAuthUrl() {
    return 'https://chat.openai.com';
  }

  // Create new authenticated session
  async createAuthenticatedSession() {
    try {
      // Create new tab
      const newTab = await new Promise((resolve) => {
        chrome.tabs.create({
          url: 'https://chat.openai.com',
          active: false
        }, resolve);
      });

      if (!newTab?.id) {
        throw new Error('Failed to create new tab');
      }

      // Wait for page to load
      await new Promise(r => setTimeout(r, 3000));

      // Check authentication status
      const authStatus = await this.isSessionAuthenticated(newTab.id);

      return {
        tabId: newTab.id,
        authenticated: authStatus.authenticated,
        needsUserAction: !authStatus.authenticated,
        message: authStatus.authenticated ?
          'Session created and authenticated' :
          'Please complete authentication in the new tab'
      };
    } catch (error) {
      throw new Error(`Failed to create authenticated session: ${error.message}`);
    }
  }

  // Switch to different ChatGPT account
  async switchAccount(tabId) {
    try {
      // Clear session cookies by going to logout page
      await new Promise((resolve) => {
        chrome.tabs.update(tabId, {
          url: 'https://chat.openai.com/api/auth/logout'
        }, resolve);
      });

      // Wait for logout to complete
      await new Promise(r => setTimeout(r, 2000));

      // Navigate back to login page
      await new Promise((resolve) => {
        chrome.tabs.update(tabId, {
          url: 'https://chat.openai.com'
        }, resolve);
      });

      // Remove from authenticated sessions
      this.authenticatedSessions.delete(tabId);

      return {
        success: true,
        needsUserAction: true,
        message: 'Logged out. Please log in with a different account.'
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        message: 'Failed to switch accounts'
      };
    }
  }
}

// Global auth manager instance
let authManager = null;

function getAuthManager() {
  if (!authManager) {
    authManager = new ChatGPTAuthManager();
  }
  return authManager;
}

// Initialize auth manager
getAuthManager();

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ChatGPTAuthManager, getAuthManager };
}