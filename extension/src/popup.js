async function getSettings() {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve));
}

async function saveSettings(partial) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', partial }, resolve));
}

async function init() {
  const enabledEl = document.getElementById('enabled');
  const modeEl = document.getElementById('mode');
  const answerEl = document.getElementById('answer');

  const resp = await getSettings();
  const settings = resp?.settings || {};
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = new URL(tab.url).hostname;
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
    await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_ANSWER' });
    window.close();
  });
}

init();
