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
    const { ok, answer, error } = await askForAnswer(label || node.placeholder || '');
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
