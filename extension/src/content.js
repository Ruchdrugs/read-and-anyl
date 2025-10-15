// Content script: detects question fields and can auto-fill answers

const QUESTION_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'div[contenteditable="true"]',
  'quill-editor',
  '.ql-editor'
];

function isLikelyQuestionLabel(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return (
    t.includes('why do you want') ||
    t.includes('tell me about') ||
    t.includes('experience') ||
    t.includes('challenge') ||
    t.includes('conflict') ||
    t.includes('impact') ||
    t.includes('project') ||
    t.includes('strength') ||
    t.includes('weakness') ||
    t.includes('situation') ||
    t.includes('example') ||
    t.includes('describe') ||
    t.includes('how did you') ||
    t.includes('what would you') ||
    t.includes('cover letter') ||
    t.includes('motivation letter')
  );
}

function getFieldLabel(node) {
  // Try associated label, aria-label, placeholder, preceding text
  if (node.labels && node.labels.length > 0) {
    return Array.from(node.labels).map(l => l.innerText).join(' ');
  }
  const attrs = [
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('placeholder'),
    node.getAttribute?.('aria-labelledby')
  ].filter(Boolean).join(' ');

  const preceding = node.closest('div, section, label, form');
  let headerText = '';
  if (preceding) {
    const header = preceding.querySelector('h1, h2, h3, h4, h5, h6, legend, label');
    if (header) headerText = header.innerText || header.textContent || '';
  }
  return [attrs, headerText].filter(Boolean).join(' ').trim();
}

function collectPageContext() {
  const title = document.title || '';
  const metaDesc = document.querySelector('meta[name="description"]')?.content || '';
  const job = Array.from(document.querySelectorAll('h1, h2'))
    .map(e => e.innerText || e.textContent || '')
    .join(' \n');
  return [title, metaDesc, job].filter(Boolean).join('\n');
}

function setFieldValue(field, text) {
  if (!field) return;
  const tag = field.tagName?.toLowerCase();
  if (tag === 'textarea' || (tag === 'input' && field.type === 'text')) {
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (field.isContentEditable || tag === 'div') {
    field.innerHTML = text
      .replace(/\n\n/g, '<br/><br/>')
      .replace(/\n/g, '<br/>');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
}

function findQuestionFields() {
  const fields = [];
  const candidates = document.querySelectorAll(QUESTION_SELECTORS.join(','));
  for (const node of candidates) {
    const label = getFieldLabel(node);
    if (isLikelyQuestionLabel(label)) {
      fields.push({ node, label });
      continue;
    }
    // Heuristic: long placeholder or within sections named questions/application
    const placeholder = node.getAttribute?.('placeholder') || '';
    const near = node.closest('section, div, fieldset');
    const nearText = near?.querySelector('h2, h3, legend, label')?.innerText?.toLowerCase?.() || '';
    if (placeholder?.length > 60 || nearText.includes('questions') || nearText.includes('application')) {
      fields.push({ node, label: label || placeholder || nearText });
    }
  }
  return fields;
}

async function askForAnswer(questionText, pageContext) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'DRAFT_ANSWER', questionText, pageContext }, (resp) => {
      if (!resp?.ok) return resolve({ ok: false, error: resp?.error || 'Unknown error' });
      resolve({ ok: true, answer: resp.answer });
    });
  });
}

async function handleAutoFill() {
  const fields = findQuestionFields();
  const pageContext = collectPageContext();
  for (const { node, label } of fields) {
    const { ok, answer, error } = await askForAnswer(label || node.placeholder || '', pageContext);
    if (ok && answer) setFieldValue(node, answer);
    else console.warn('Draft answer failed:', error);
  }
}

// Listen for popup trigger
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'TRIGGER_ANSWER') {
    handleAutoFill();
  }
});

// Optional: auto-run if site enabled
(async function maybeAutoRun() {
  try {
    const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, resolve));
    const settings = resp?.settings || {};
    const host = location.hostname;
    const site = settings?.siteConfig?.[host];
    if (site?.enabled && site?.mode === 'auto') {
      handleAutoFill();
    }
  } catch (e) {
    // ignore
  }
})();

// ------------------------------
// Gemini integration helpers
// ------------------------------

function collectQuestionLabels() {
  const fields = findQuestionFields();
  return fields.map(({ label }) => (label || '').toString());
}

async function waitForGeminiComposer(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Try common Gemini composer selectors
    const textarea = document.querySelector('textarea');
    const editable = document.querySelector('div[contenteditable="true"]');
    const input = textarea || editable;
    if (input) return input;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

function setComposerText(inputEl, text) {
  const val = (text || '').trim();
  const tag = inputEl.tagName?.toLowerCase();
  if (tag === 'textarea') {
    inputEl.value = val;
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  if (inputEl.isContentEditable || tag === 'div') {
    inputEl.innerHTML = val
      .replace(/\n\n/g, '<br/><br/>')
      .replace(/\n/g, '<br/>');
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
}

function clickGeminiSend() {
  // Try to find a send button
  const candidates = Array.from(document.querySelectorAll('button, div[role="button"]'));
  const btn = candidates.find((b) => {
    const t = (b.innerText || b.ariaLabel || b.getAttribute?.('aria-label') || '').toLowerCase();
    return t.includes('send') || t.includes('submit') || t.includes('ask');
  });
  if (btn) {
    btn.click();
    return true;
  }
  // Fallback: press Enter
  const active = document.activeElement;
  if (active) {
    active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type } = message || {};
  if (type === 'COLLECT_FIELDS') {
    try {
      const labels = collectQuestionLabels();
      const pageContext = collectPageContext();
      sendResponse({ ok: true, labels, pageContext });
    } catch (error) {
      sendResponse({ ok: false, error: String(error?.message || error) });
    }
    return true;
  }
  if (type === 'GEMINI_ASK') {
    (async () => {
      try {
        const input = await waitForGeminiComposer(12000);
        if (!input) return sendResponse({ ok: false, error: 'Gemini composer not found' });
        const okSet = setComposerText(input, message.prompt || '');
        if (!okSet) return sendResponse({ ok: false, error: 'Failed to set prompt' });
        input.focus();
        clickGeminiSend();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true; // keep port open
  }
});
