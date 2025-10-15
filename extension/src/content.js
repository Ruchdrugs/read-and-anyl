// Content script: detects question fields and can auto-fill answers

const QUESTION_SELECTORS = [
  'textarea',
  'input[type="text"]',
  'input:not([type])',
  'input[type="search"]',
  '[role="textbox"]',
  'div[contenteditable="true"]',
  'quill-editor',
  '.ql-editor',
  '.ProseMirror',
  '.ck-content',
  '.mce-content-body',
  '.notion-page-content [contenteditable="true"]'
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
    t.includes('motivation letter') ||
    t.includes('why us') ||
    t.includes('why company') ||
    t.includes('why this') ||
    t.includes('tell us') ||
    t.includes('anything else') ||
    t.includes('additional information') ||
    t.includes('essay') ||
    t.includes('statement') ||
    t.includes('background') ||
    t.includes('portfolio') ||
    t.includes('accomplishment')
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
  if (headerText && headerText.trim()) return headerText.trim();

  // 6) Previous sibling text blocks commonly used as prompts
  try {
    let prev = node.previousElementSibling;
    let hops = 0;
    while (prev && hops < 4) {
      const txt = (prev.innerText || prev.textContent || '').trim();
      if (txt && txt.length > 0 && txt.length < 500) return txt;
      prev = prev.previousElementSibling;
      hops += 1;
    }
  } catch (_) {}

  return '';
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
    const rows = Number(node.getAttribute?.('rows') || 0);
    const maxLength = Number(node.getAttribute?.('maxlength') || 0);
    const ariaMultiline = node.getAttribute?.('aria-multiline') === 'true';

    if (
      placeholder?.length > 20 ||
      rows >= 3 ||
      ariaMultiline ||
      maxLength >= 120 ||
      nearText.includes('questions') ||
      nearText.includes('application') ||
      nearText.includes('cover letter') ||
      nearText.includes('motivation')
    ) {
      fields.push({ node, label: label || placeholder || nearText });
      continue;
    }

    // As a final fallback, include all textareas/contenteditables
    const tag = node.tagName?.toLowerCase();
    if (tag === 'textarea' || node.isContentEditable) {
      fields.push({ node, label: label || placeholder || 'free text' });
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
  if (!fields || fields.length === 0) return;
  const pageContext = collectPageContext();

  // Assign stable ids to fields for mapping
  const labels = [];
  fields.forEach((f, i) => {
    try { f.node.setAttribute('data-autofill-id', String(i)); } catch (_) {}
    labels.push((f.label || f.node.getAttribute?.('placeholder') || '').toString());
  });

  // Ask Gemini web (no API) for all answers in one go
  let answers = null;
  try {
    const resp = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GEMINI_BATCH_ASK_AND_EXTRACT', labels, pageContext }, resolve));
    if (resp?.ok && Array.isArray(resp.answers)) {
      answers = resp.answers;
    }
  } catch (_) {}

  if (!answers) {
    // Fallback to local drafting per field if Gemini failed
    for (const { node, label } of fields) {
      const { ok, answer } = await askForAnswer(label || node.placeholder || '', pageContext);
      if (ok && answer) {
        setFieldValue(node, answer);
        node.setAttribute?.(FILLED_ATTR, '1');
        filledNodes.add(node);
      }
    }
    return;
  }

  // Fill answers back into fields
  for (const a of answers) {
    const parsedIdx = Number(a?.i);
    const idx = Number.isFinite(parsedIdx) ? parsedIdx : null;
    const text = (a?.text || a?.answer || '').toString();
    if (idx == null || !text) continue;
    const f = fields[idx];
    if (!f?.node) continue;
    setFieldValue(f.node, text);
    try { f.node.setAttribute?.(FILLED_ATTR, '1'); } catch (_) {}
    filledNodes.add(f.node);
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
  if (type === 'GEMINI_EXTRACT_JSON') {
    (async () => {
      try {
        const start = (message && message.start) || 'ANSWERS_START_7b8c02';
        const end = (message && message.end) || 'ANSWERS_END_7b8c02';
        const maxWaitMs = Math.min(Number(message?.timeoutMs || 20000), 45000);
        const started = Date.now();

        function extractOnce() {
          // Prefer code/pre blocks
          const blocks = Array.from(document.querySelectorAll('pre, code, div, article'));
          for (const el of blocks) {
            const txt = (el.innerText || el.textContent || '').trim();
            if (!txt) continue;
            const si = txt.indexOf(start);
            const ei = txt.indexOf(end);
            if (si !== -1 && ei !== -1 && ei > si) {
              let raw = txt.substring(si + start.length, ei).trim();
              raw = raw.replace(/^```[\s\S]*?\n/, '').replace(/```$/,'').trim();
              return raw;
            }
          }
          const bodyTxt = (document.body?.innerText || '').trim();
          const si2 = bodyTxt.indexOf(start);
          const ei2 = bodyTxt.indexOf(end);
          if (si2 !== -1 && ei2 !== -1 && ei2 > si2) {
            return bodyTxt.substring(si2 + start.length, ei2).trim();
          }
          return null;
        }

        let jsonText = extractOnce();
        while (!jsonText && Date.now() - started < maxWaitMs) {
          await new Promise(r => setTimeout(r, 1000));
          jsonText = extractOnce();
        }
        if (!jsonText) return sendResponse({ ok: false, error: 'JSON markers not found' });
        sendResponse({ ok: true, json: jsonText });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
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
