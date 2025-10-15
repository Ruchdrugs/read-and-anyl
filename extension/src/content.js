// Content script: detects question fields and can auto-fill answers

const QUESTION_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'input:not([type])',
  'input[type="search"]',
  '[role="textbox"]',
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
  // Derive a human-readable label for a field from multiple sources
  // 1) <label for="id"> association
  try {
    const id = node.getAttribute?.('id');
    if (id) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (forLabel) return (forLabel.innerText || forLabel.textContent || '').trim();
    }
  } catch (_) {}

  // 2) node.labels (native association)
  if (node.labels && node.labels.length > 0) {
    return Array.from(node.labels).map(l => l.innerText || l.textContent || '').join(' ').trim();
  }

  // 3) aria-labelledby -> resolve referenced element text
  const ariaLabelledBy = node.getAttribute?.('aria-labelledby');
  if (ariaLabelledBy) {
    const ids = ariaLabelledBy.split(/\s+/).filter(Boolean);
    const parts = ids.map(id => document.getElementById(id)).filter(Boolean).map(el => el.innerText || el.textContent || '');
    const txt = parts.join(' ').trim();
    if (txt) return txt;
  }

  // 4) aria-label / placeholder
  const direct = [
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('placeholder')
  ].filter(Boolean).join(' ').trim();
  if (direct) return direct;

  // 5) Nearby headings/legends/labels
  const preceding = node.closest('div, section, label, form, fieldset, article');
  let headerText = '';
  if (preceding) {
    const header = preceding.querySelector('h1, h2, h3, h4, h5, h6, legend, label, strong');
    if (header) headerText = header.innerText || header.textContent || '';
  }
  return headerText.trim();
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

const FILLED_ATTR = 'data-autofilled';
const filledNodes = new WeakSet();

function findQuestionFields() {
  const fields = [];
  const candidates = document.querySelectorAll(QUESTION_SELECTORS.join(','));
  for (const node of candidates) {
    if (node.hasAttribute?.(FILLED_ATTR) || filledNodes.has(node)) continue;
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
      resolve({ ok: true, answer: resp.answer, quality: resp.quality, reason: resp.reason });
    });
  });
}

function isWeakAnswer(answer, quality) {
  const txt = (answer || '').trim();
  if (quality === 'weak') return true;
  if (txt.length < 90) return true;
  if (/Here is a concise answer grounded in my experience:/i.test(txt)) return true;
  return false;
}

async function handleAutoFill() {
  const fields = findQuestionFields();
  const pageContext = collectPageContext();
  const weakLabels = [];
  for (const { node, label } of fields) {
    const { ok, answer, error, quality } = await askForAnswer(label || node.placeholder || '', pageContext);
    if (ok && answer) {
      setFieldValue(node, answer);
      node.setAttribute?.(FILLED_ATTR, '1');
      filledNodes.add(node);
      if (isWeakAnswer(answer, quality)) weakLabels.push(label || '');
    } else {
      console.warn('Draft answer failed:', error);
    }
  }

  // If answers appear weak, open Gemini with a composed prompt for assistance
  if (weakLabels.length > 0 && window.top === window.self) {
    try {
      const built = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GEMINI_BUILD_PROMPT', labels: weakLabels, pageContext }, resolve));
      if (built?.ok && built.prompt) {
        await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GEMINI_OPEN_AND_ASK', prompt: built.prompt }, resolve));
      }
    } catch (_) {
      // ignore fallback errors
    }
  }
}

// Listen for popup trigger
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'TRIGGER_ANSWER') {
    handleAutoFill();
  }
});

// Always auto-run and watch for dynamic fields
(function setupAutoFill() {
  // Avoid interfering with Gemini page itself
  const host = location.hostname;
  if (/(^|\.)gemini\.google\.com$/i.test(host)) return;

  handleAutoFill();
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      handleAutoFill();
    }, 500);
  };
  try {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue;
            if (n.matches?.(QUESTION_SELECTORS.join(',')) || n.querySelector?.(QUESTION_SELECTORS.join(','))) {
              schedule();
              break;
            }
          }
        }
        if (m.type === 'attributes' && QUESTION_SELECTORS.some(sel => m.target?.matches?.(sel))) {
          schedule();
        }
      }
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['placeholder', 'aria-label', 'aria-labelledby'] });
  } catch (_) {
    // ignore observer failures
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
