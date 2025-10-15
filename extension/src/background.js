// Background service worker for MV3
// Handles LLM calls and messaging between popup/content

const DEFAULT_SETTINGS = {
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  maxTokens: 500,
  temperature: 0.7,
  siteConfig: {}, // {hostname: {enabled: true, mode: 'auto'|'manual'}}
  persona: {
    role: 'Senior Software Engineer',
    tone: 'concise, confident, collaborative',
    extra: ''
  }
};

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['settings'], ({ settings }) => {
      resolve({ ...DEFAULT_SETTINGS, ...(settings || {}) });
    });
  });
}

async function saveSettings(next) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ settings: next }, () => resolve());
  });
}

function buildSystemPrompt(persona) {
  const { role, tone, extra } = persona || {};
  return [
    `You are ${role || 'an experienced professional'} answering interview questions on web forms.`,
    `Write in a ${tone || 'clear and concise'} tone.`,
    extra ? `Additional persona guidance: ${extra}` : null,
    'Prefer structured, high-signal answers with brief bullet points where useful.',
    'When code is requested, provide runnable snippets and explain trade-offs succinctly.'
  ].filter(Boolean).join('\n');
}

async function callLLM({ apiBaseUrl, apiKey, model, messages, maxTokens, temperature }) {
  if (!apiKey) throw new Error('Missing API key in Options');
  const url = `${apiBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature
    })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  return content.trim();
}

async function draftAnswer(questionText, pageContext) {
  const settings = await getSettings();
  const system = buildSystemPrompt(settings.persona);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: [
      'Answer the following interview question. If it asks for examples, provide concrete ones.',
      'Keep it tailored to the role and context. Avoid generic fluff.\n',
      'Question:',
      questionText,
      '',
      pageContext ? `Page context (job, company, requirements):\n${pageContext}` : ''
    ].filter(Boolean).join('\n') }
  ];
  const content = await callLLM({ ...settings, messages });
  return content;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};
  if (type === 'DRAFT_ANSWER') {
    (async () => {
      try {
        const answer = await draftAnswer(message.questionText, message.pageContext);
        sendResponse({ ok: true, answer });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true; // keep port open
  }
  if (type === 'GET_SETTINGS') {
    (async () => {
      const settings = await getSettings();
      sendResponse({ ok: true, settings });
    })();
    return true;
  }
  if (type === 'SAVE_SETTINGS') {
    (async () => {
      const settings = await getSettings();
      const next = { ...settings, ...(message?.partial || {}) };
      await saveSettings(next);
      sendResponse({ ok: true });
    })();
    return true;
  }
});
