async function getSettings() {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve));
}

async function saveSettings(partial) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', partial }, resolve));
}

function queryActiveTab() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        resolve((tabs && tabs[0]) || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function init() {
  const enabledEl = document.getElementById('enabled');
  const modeEl = document.getElementById('mode');
  const answerEl = document.getElementById('answer');
  const askGeminiEl = document.createElement('button');
  askGeminiEl.textContent = 'Ask Gemini (No API)';
  askGeminiEl.style.marginLeft = '8px';

  // Create ChatGPT controls
  const chatgptContainerEl = document.createElement('div');
  chatgptContainerEl.style.marginTop = '10px';
  chatgptContainerEl.style.padding = '8px';
  chatgptContainerEl.style.border = '1px solid #ccc';
  chatgptContainerEl.style.borderRadius = '4px';
  chatgptContainerEl.style.fontSize = '12px';

  const chatgptStatusEl = document.createElement('div');
  chatgptStatusEl.innerHTML = 'Loading ChatGPT status...';

  const askChatGptEl = document.createElement('button');
  askChatGptEl.textContent = 'Ask ChatGPT (Web API)';
  askChatGptEl.style.marginRight = '8px';
  askChatGptEl.style.marginTop = '5px';

  const chatgptSettingsEl = document.createElement('button');
  chatgptSettingsEl.textContent = 'ChatGPT Settings';
  chatgptSettingsEl.style.marginTop = '5px';

  chatgptContainerEl.appendChild(chatgptStatusEl);
  chatgptContainerEl.appendChild(document.createElement('br'));
  chatgptContainerEl.appendChild(askChatGptEl);
  chatgptContainerEl.appendChild(chatgptSettingsEl);

  const resp = await getSettings();
  const settings = resp?.settings || {};
  const tab = await queryActiveTab();
  const host = tab?.url ? new URL(tab.url).hostname : location.hostname;
  const site = settings.siteConfig?.[host] || { enabled: false, mode: 'manual' };

  enabledEl.checked = !!site.enabled;
  modeEl.value = site.mode || 'manual';

  enabledEl.addEventListener('change', async () => {
    const next = { ...settings };
    next.siteConfig = next.siteConfig || {};
    next.siteConfig[host] = { ...(next.siteConfig[host] || {}), enabled: enabledEl.checked };
    await saveSettings(next);
  });
  modeEl.addEventListener('change', async () => {
    const next = { ...settings };
    next.siteConfig = next.siteConfig || {};
    next.siteConfig[host] = { ...(next.siteConfig[host] || {}), mode: modeEl.value };
    await saveSettings(next);
  });

  answerEl.addEventListener('click', async () => {
    if (!tab?.id) return;
    try {
      // Enable lightweight debug on the page for troubleshooting
      try { await sendMessageToTab(tab.id, { type: 'ENABLE_DEBUG' }); } catch (_) {}
      await sendMessageToTab(tab.id, { type: 'TRIGGER_ANSWER' });
    } catch (_) {
      // ignore
    }
    window.close();
  });

  askGeminiEl.addEventListener('click', async () => {
    if (!tab?.id) return;
    try {
      const collect = await sendMessageToTab(tab.id, { type: 'COLLECT_FIELDS' });
      const labels = collect?.labels || [];
      const pageContext = collect?.pageContext || '';
      const built = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GEMINI_BUILD_PROMPT', labels, pageContext }, resolve));
      if (!built?.ok) return window.close();
      await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GEMINI_OPEN_AND_ASK', prompt: built.prompt }, resolve));
    } catch (_) {
      // ignore
    }
    window.close();
  });

  // ChatGPT button handlers
  askChatGptEl.addEventListener('click', async () => {
    if (!tab?.id) return;
    try {
      const collect = await sendMessageToTab(tab.id, { type: 'COLLECT_FIELDS' });
      const labels = collect?.labels || [];
      const pageContext = collect?.pageContext || '';

      // Build ChatGPT prompt
      const prompt = [
        'You are helping with job application interview questions. Based on the context and questions below, draft professional answers for each question.',
        '',
        'Page context:', pageContext,
        '',
        'Questions to answer:', labels.map((q, i) => `${i + 1}. ${q}`).join('\n'),
        '',
        'Return ONLY a JSON array where each element has keys {"question_index": number, "answer": string}.',
        'Make answers professional, concise (100-150 words), and tailored to the context.',
        ''
      ].join('\n');

      await new Promise((resolve) => chrome.runtime.sendMessage({
        type: 'CHATGPT_ASK_DIRECT',
        prompt,
        priority: 'high',
        timeout: 120
      }, resolve));
    } catch (_) {
      // ignore
    }
    window.close();
  });

  chatgptSettingsEl.addEventListener('click', async () => {
    try {
      // Get current settings
      const settingsResponse = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'CHATGPT_GET_SETTINGS' }, resolve);
      });

      if (settingsResponse?.ok) {
        // Simple settings toggle (for demo purposes)
        const newEnabled = !settingsResponse.settings.enabled;
        await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'CHATGPT_SAVE_SETTINGS',
            partial: { enabled: newEnabled }
          }, resolve);
        });

        // Update status display
        await updateChatGPTStatus(chatgptStatusEl);
      }
    } catch (_) {
      // ignore
    }
  });

  // Insert ChatGPT container and Ask Gemini button after Answer
  answerEl.parentElement?.appendChild(chatgptContainerEl);
  answerEl.parentElement?.appendChild(askGeminiEl);

  // Update ChatGPT status
  updateChatGPTStatus(chatgptStatusEl);
}

// Update ChatGPT status display
async function updateChatGPTStatus(statusEl) {
  try {
    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'CHATGPT_GET_STATUS' }, resolve);
    });

    if (response?.ok) {
      const status = response.status;
      statusEl.innerHTML = `
        <strong>ChatGPT API:</strong>
        ${status.poolSize}/${status.maxPoolSize} sessions active
        <br><small>Queue: ${status.queueLength} requests</small>
        <br><small>Success rate: ${status.statistics?.successRate || 0}%</small>
      `;
    } else {
      statusEl.innerHTML = '<strong>ChatGPT API:</strong> <span style="color: red;">Unavailable</span>';
    }
  } catch (error) {
    statusEl.innerHTML = '<strong>ChatGPT API:</strong> <span style="color: red;">Error loading status</span>';
  }
}

init();
