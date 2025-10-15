const DEFAULTS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  maxTokens: 500,
  temperature: 0.7,
  persona: {
    role: 'Senior Software Engineer',
    tone: 'concise, confident, collaborative',
    extra: ''
  }
};

function getEl(id) { return document.getElementById(id); }

async function load() {
  const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve));
  const settings = { ...DEFAULTS, ...(resp?.settings || {}) };
  getEl('apiBaseUrl').value = settings.apiBaseUrl;
  getEl('apiKey').value = settings.apiKey;
  getEl('model').value = settings.model;
  getEl('maxTokens').value = settings.maxTokens;
  getEl('temperature').value = settings.temperature;
  getEl('role').value = settings.persona?.role || '';
  getEl('tone').value = settings.persona?.tone || '';
  getEl('extra').value = settings.persona?.extra || '';
}

async function save() {
  const next = {
    apiBaseUrl: getEl('apiBaseUrl').value.trim(),
    apiKey: getEl('apiKey').value.trim(),
    model: getEl('model').value.trim(),
    maxTokens: Number(getEl('maxTokens').value) || 500,
    temperature: Number(getEl('temperature').value) || 0.7,
    persona: {
      role: getEl('role').value.trim(),
      tone: getEl('tone').value.trim(),
      extra: getEl('extra').value.trim()
    }
  };
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', partial: next }, resolve));
  const btn = document.getElementById('save');
  btn.textContent = 'Saved';
  setTimeout(() => (btn.textContent = 'Save'), 1200);
}

getEl('save').addEventListener('click', save);
load();
