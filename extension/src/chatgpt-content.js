// ChatGPT web interface automation
// Handles prompt injection, response extraction, and session health monitoring

// Wait for ChatGPT input to be available (timeout: 12 seconds)
async function waitForChatGPTInput() {
  const selectors = [
    'textarea[data-id="prompt-textarea"]',
    'textarea[placeholder*="Message"]',
    '#prompt-textarea',
    'textarea[aria-label*="message"]'
  ];

  for (let attempt = 0; attempt < 24; attempt++) {
    for (const selector of selectors) {
      const input = document.querySelector(selector);
      if (input && input.offsetParent !== null) {
        return input;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

// Set prompt text in ChatGPT input
function setChatGPTPrompt(inputEl, text) {
  const val = (text || '').trim();

  // Focus the input
  inputEl.focus();

  // Clear existing content
  inputEl.value = '';
  inputEl.textContent = '';

  // Simulate typing with realistic delays
  for (let i = 0; i < val.length; i++) {
    const char = val[i];
    inputEl.value += char;
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: char }));
    // Use smaller delays for better UX
    const delay = Math.random() * 20 + 5; // 5-25ms per character
    if (i % 10 === 0) {
      // Yield control every 10 characters
      await new Promise(r => setTimeout(r, delay));
    }
  }

  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

// Click ChatGPT send button
function clickChatGPTSend() {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send"]',
    'button[type="submit"]',
    'svg[data-icon="send"]'
  ];

  for (const selector of selectors) {
    const button = document.querySelector(selector);
    if (button && button.offsetParent !== null && !button.disabled) {
      button.click();
      return true;
    }
  }

  // Fallback: press Enter in input
  const activeElement = document.activeElement;
  if (activeElement && activeElement.tagName === 'TEXTAREA') {
    activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  }

  return false;
}

// Extract ChatGPT response with streaming support
async function extractChatGPTResponse(timeoutMs = 30000) {
  const startTime = Date.now();
  let lastResponse = '';
  let stableCount = 0;

  while (Date.now() - startTime < timeoutMs) {
    // Look for response containers
    const responseSelectors = [
      '[data-message-author-role="assistant"]',
      '.text-message',
      '.markdown',
      '[data-testid="conversation-turn-3"]',
      '.prose'
    ];

    for (const selector of responseSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        // Get the last response element
        const lastElement = elements[elements.length - 1];
        const currentResponse = lastElement.innerText || lastElement.textContent || '';

        // Check if response has changed and is substantial
        if (currentResponse !== lastResponse && currentResponse.length > lastResponse.length) {
          lastResponse = currentResponse;
          stableCount = 0;
        } else if (currentResponse === lastResponse) {
          stableCount++;
        }

        // Check if response seems complete (no streaming indicators)
        const hasStreamingIndicator = document.querySelector('[data-testid="thinking"]') ||
                                     document.querySelector('.streaming') ||
                                     document.querySelector('.result-thinking') ||
                                     currentResponse.endsWith('▋');

        if (!hasStreamingIndicator &&
            currentResponse.length > 50 &&
            stableCount >= 3) { // Stable for 3 consecutive checks
          return { success: true, text: currentResponse, complete: true };
        }
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  // Return whatever we got (may be partial)
  return {
    success: lastResponse.length > 0,
    text: lastResponse,
    complete: false,
    timeout: true
  };
}

// Check session health (detect CAPTCHAs, rate limits, etc.)
function checkSessionHealth() {
  const issues = [];

  // Check for CAPTCHA
  if (document.querySelector('#captcha') ||
      document.querySelector('[class*="captcha"]') ||
      document.querySelector('[class*="challenge"]')) {
    issues.push('CAPTCHA detected');
  }

  // Check for rate limit messages
  const rateLimitSelectors = [
    '[class*="rate-limit"]',
    '[class*="too-many"]',
    '[class*="limit-exceeded"]',
    '[class*="quota"]',
    '[class*="usage-limit"]'
  ];

  for (const selector of rateLimitSelectors) {
    const element = document.querySelector(selector);
    if (element) {
      issues.push('Rate limit detected');
      break;
    }
  }

  // Check for error messages
  const errorSelectors = [
    '[class*="error"]',
    '[class*="unavailable"]',
    '[class*="temporarily"]'
  ];

  for (const selector of errorSelectors) {
    const element = document.querySelector(selector);
    if (element && element.offsetParent !== null) {
      const text = (element.innerText || element.textContent || '').toLowerCase();
      if (text.includes('error') || text.includes('unavailable') || text.includes('temporarily')) {
        issues.push('Service error detected');
        break;
      }
    }
  }

  // Check if input is available
  const input = document.querySelector('textarea');
  if (!input) {
    issues.push('Input element not found');
  } else if (input.disabled) {
    issues.push('Input is disabled');
  }

  // Check if we're on the right page
  if (!location.hostname.includes('chat.openai.com')) {
    issues.push('Not on ChatGPT domain');
  }

  return {
    healthy: issues.length === 0,
    issues,
    canSendMessage: !!(input && !input.disabled),
    isOnCorrectDomain: location.hostname.includes('chat.openai.com')
  };
}

// Message handler for background script communication
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};

  if (type === 'CHATGPT_ASK') {
    (async () => {
      try {
        const input = await waitForChatGPTInput();
        if (!input) {
          return sendResponse({ ok: false, error: 'ChatGPT input not found' });
        }

        const okSet = setChatGPTPrompt(input, message.prompt || '');
        if (!okSet) {
          return sendResponse({ ok: false, error: 'Failed to set prompt' });
        }

        const okSend = clickChatGPTSend();
        if (!okSend) {
          return sendResponse({ ok: false, error: 'Failed to send message' });
        }

        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (type === 'CHATGPT_EXTRACT_RESPONSE') {
    (async () => {
      try {
        const result = await extractChatGPTResponse(message.timeoutMs || 30000);
        sendResponse({ ok: true, ...result });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }

  if (type === 'CHATGPT_CHECK_HEALTH') {
    try {
      const health = checkSessionHealth();
      sendResponse({ ok: true, health });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return true;
  }

  if (type === 'CHATGPT_CHECK_AUTH') {
    try {
      const isAuthenticated = checkAuthenticationStatus();
      sendResponse({ ok: true, authenticated: isAuthenticated });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return true;
  }

  if (type === 'CHATGPT_VALIDATE_SESSION') {
    try {
      const isValid = validateSession();
      sendResponse({ ok: true, authenticated: isValid });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return true;
  }

  return false;
});

// Check if user is authenticated in ChatGPT
function checkAuthenticationStatus() {
  // Look for signs of authenticated state
  const authSelectors = [
    'button[data-testid="send-button"]',
    'textarea[data-id="prompt-textarea"]',
    '[data-testid="user-menu"]',
    '.main-user-menu'
  ];

  // Look for login/signup indicators (not authenticated)
  const loginSelectors = [
    'a[href*="login"]',
    'a[href*="signup"]',
    'button:contains("Log in")',
    'button:contains("Sign up")',
    '.login-button',
    '.signup-button'
  ];

  const hasAuthElements = authSelectors.some(selector => {
    const element = document.querySelector(selector);
    return element && element.offsetParent !== null;
  });

  const hasLoginElements = loginSelectors.some(selector => {
    const elements = document.querySelectorAll(selector);
    return Array.from(elements).some(el =>
      el.offsetParent !== null &&
      (el.innerText.includes('Log in') || el.innerText.includes('Sign up'))
    );
  });

  // If we see auth elements and no login elements, assume authenticated
  return hasAuthElements && !hasLoginElements;
}

// Validate current session is active and usable
function validateSession() {
  try {
    // Check if we're on the correct domain
    if (!location.hostname.includes('chat.openai.com')) {
      return false;
    }

    // Check authentication status
    if (!checkAuthenticationStatus()) {
      return false;
    }

    // Check for functional input
    const input = document.querySelector('textarea[data-id="prompt-textarea"], textarea');
    if (!input || input.disabled) {
      return false;
    }

    // Check for send button
    const sendButton = document.querySelector('button[data-testid="send-button"], button[aria-label*="Send"]');
    if (!sendButton || sendButton.disabled) {
      return false;
    }

    return true;
  } catch (error) {
    console.error('Session validation error:', error);
    return false;
  }
}

// Auto-detect if we're on ChatGPT page and notify background script
if (location.hostname.includes('chat.openai.com')) {
  // Notify background script that this is a ChatGPT tab
  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'CHATGPT_PAGE_LOADED',
      url: location.href,
      title: document.title
    }).catch(() => {
      // Ignore errors - background script might not be ready
    });
  }, 1000);
}