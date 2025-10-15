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
      // Open Gemini web (no API key) and inject composed prompt
      const geminiUrl = 'https://gemini.google.com/app';
      const newTab = await new Promise((resolve) => chrome.tabs.create({ url: geminiUrl, active: true }, resolve));
      const tabId = newTab?.id;
      if (!tabId) return window.close();
      // Wait and then send GEmiNI_ASK to content script on that tab
      setTimeout(async () => {
        try {
          await sendMessageToTab(tabId, { type: 'GEMINI_ASK', prompt: built.prompt });
        } catch (e) {
          // no-op
        }
      }, 2000);
    } catch (_) {
      // ignore
    }
    window.close();
  });

  // Insert Ask Gemini button after Answer
  answerEl.parentElement?.appendChild(askGeminiEl);
}

init();
