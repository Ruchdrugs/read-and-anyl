const DEFAULTS = {
  resumeText: '',
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
  getEl('resumeText').value = settings.resumeText || '';
  getEl('role').value = settings.persona?.role || '';
  getEl('tone').value = settings.persona?.tone || '';
  getEl('extra').value = settings.persona?.extra || '';
}

async function save() {
  const next = {
    resumeText: getEl('resumeText').value,
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
