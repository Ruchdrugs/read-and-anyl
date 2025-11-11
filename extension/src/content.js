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

const DEBUG = (() => {
  try { return !!(window.__INTERVIEW_AUTOFILL_DEBUG__ || localStorage.getItem('autofill_debug')); } catch (_) { return false; }
})();

function logDebug(...args) { if (DEBUG) try { console.debug('[Autofill]', ...args); } catch (_) {} }

function isLinkedInHost() {
  const h = location.hostname || '';
  return /(\.|^)linkedin\.com$/i.test(h);
}

function isLikelyQuestionLabel(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return (
    /\?\s*$/.test(t) ||
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
    t.includes('accomplishment') ||
    // Screener-style prompts common on LinkedIn apply flows
    /\bhow many years\b/.test(t) ||
    /\byears of experience\b/.test(t) ||
    /\bare you willing\b/.test(t) ||
    /\bdo you have\b/.test(t) ||
    /\bauthori[sz]ation to work\b/.test(t) ||
    /\bsalary (?:range|expectation|expectations)\b/.test(t) ||
    /\bwork (?:permit|authorization)\b/.test(t) ||
    /\bcover letter\b/.test(t) ||
    /\badditional (?:information|details)\b/.test(t) ||
    /\bplease provide\b/.test(t) ||
    /\bexplain\b/.test(t) ||
    /\bwhy (?:us|this|company)\b/.test(t)
  );
}

function isStrongQuestionLabel(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  return /\?\s*$/.test(t) || /\b(tell me about|describe|why|how did you|what would you|please provide|explain)\b/.test(t);
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

  // 3b) aria-describedby often holds the question copy on LinkedIn
  const ariaDescribedBy = node.getAttribute?.('aria-describedby');
  if (ariaDescribedBy) {
    const ids = ariaDescribedBy.split(/\s+/).filter(Boolean);
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

function setNativeValue(element, value) {
  try {
    const tag = element.tagName?.toLowerCase();
    const proto = tag === 'textarea'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
      return true;
    }
  } catch (_) {}
  try { element.value = value; return true; } catch (_) {}
  return false;
}

function setFieldValue(field, text) {
  if (!field) return;
  const tag = field.tagName?.toLowerCase();
  if (tag === 'textarea' || (tag === 'input' && field.type === 'text')) {
    const val = (text || '').toString();
    try { field.focus(); } catch (_) {}
    try { field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
    setNativeValue(field, val);
    try { field.setSelectionRange?.(val.length, val.length); } catch (_) {}
    try { field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
    try { field.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (_) {}
    try { field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); } catch (_) {}
    logDebug('Set value on input/textarea', { placeholder: field.placeholder, valueLen: val.length });
    return;
  }
  if (field.isContentEditable || tag === 'div') {
    const val = (text || '').toString();
    try {
      field.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(field);
      sel.removeAllRanges();
      sel.addRange(range);
      // Fire beforeinput to satisfy editors listening for it
      try { field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
      // Attempt insertText first
      if (!document.execCommand('insertText', false, val)) {
        // Fallback to insertHTML
        document.execCommand('insertHTML', false, val.replace(/\n/g, '<br/>'));
      }
    } catch (_) {
      field.innerHTML = val
        .replace(/\n\n/g, '<br/><br/>')
        .replace(/\n/g, '<br/>');
    }
    try { field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
    try { field.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (_) {}
    try { field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); } catch (_) {}
    logDebug('Inserted text into contenteditable', { valueLen: val.length });
    return;
  }
}

const FILLED_ATTR = 'data-autofilled';
const filledNodes = new WeakSet();

function isLinkedInNonQuestionField(node, label, placeholder) {
  if (!isLinkedInHost()) return false;
  const pl = (placeholder || '').toLowerCase();
  const lb = (label || '').toLowerCase();
  const near = node.closest('section, form, article, div');
  const nearText = (near?.innerText || near?.textContent || '').toLowerCase();

  // Exclude search, messaging, comments, and feed composers
  const isSearch = node.matches('input[type="search"], input[role="searchbox"], input.search-global-typeahead__input') || /search/.test(pl) || /search/.test(lb);
  const isMessaging = nearText.includes('send message') || near?.querySelector?.('.msg-form__contenteditable');
  const isComment = nearText.includes('comment') && nearText.includes('post');
  const isFeedComposer = nearText.includes('start a post') || nearText.includes('share your thoughts');
  if (isSearch || isMessaging || isComment || isFeedComposer) return true;
  return false;
}

function isInLinkedInApplyContainer(node) {
  if (!isLinkedInHost() || !node) return false;
  const container = node.closest('.jobs-easy-apply-modal, .jobs-apply-form, .jobs-apply-page, .jobs-easy-apply-content, artdeco-modal');
  if (!container) return false;
  const txt = (container.innerText || container.textContent || '').toLowerCase();
  return /easy apply|apply|application|screening|additional questions|cover letter/.test(txt);
}

function findQuestionFields() {
  const fields = [];
  const candidates = document.querySelectorAll(QUESTION_SELECTORS.join(','));
  for (const node of candidates) {
    if (node.hasAttribute?.(FILLED_ATTR) || filledNodes.has(node)) continue;
    const label = getFieldLabel(node);
    if (isLinkedInNonQuestionField(node, label, node.getAttribute?.('placeholder'))) {
      logDebug('Skipping non-question field', { label, placeholder: node.getAttribute?.('placeholder') });
      continue;
    }

    // In LinkedIn Easy Apply, relax heuristics and include obvious text inputs
    const inLinkedInApply = isInLinkedInApplyContainer(node);
    if (inLinkedInApply) {
      const tag = node.tagName?.toLowerCase();
      const rows = Number(node.getAttribute?.('rows') || 0);
      const maxLength = Number(node.getAttribute?.('maxlength') || 0);
      const ariaMultiline = node.getAttribute?.('aria-multiline') === 'true';
      const isTextual = (
        tag === 'textarea' ||
        node.isContentEditable ||
        (tag === 'div' && node.getAttribute?.('role') === 'textbox') ||
        (tag === 'input' && (node.type === 'text' || !node.type) && (rows >= 3 || ariaMultiline || maxLength >= 120))
      );
      if (isTextual) {
        const placeholder = node.getAttribute?.('placeholder') || '';
        fields.push({ node, label: label || placeholder || 'application question' });
        continue;
      }
    }
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
      if (!isLinkedInNonQuestionField(node, label, placeholder)) {
        fields.push({ node, label: label || placeholder || nearText });
      } else {
        logDebug('Heuristic candidate rejected (LinkedIn non-question)', { label, placeholder });
      }
      continue;
    }

    // As a final fallback, include all textareas/contenteditables
    const tag = node.tagName?.toLowerCase();
    if (tag === 'textarea' || node.isContentEditable) {
      if (!isLinkedInNonQuestionField(node, label, placeholder)) {
        fields.push({ node, label: label || placeholder || 'free text' });
      } else {
        logDebug('Fallback candidate rejected (LinkedIn non-question)', { label, placeholder });
      }
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
    // Try ChatGPT as fallback if enabled
    try {
      const chatgptAnswers = await tryChatGPTAnswers(labels, pageContext);
      if (chatgptAnswers && chatgptAnswers.length > 0) {
        answers = chatgptAnswers;
      }
    } catch (error) {
      console.log('ChatGPT fallback failed:', error);
    }

    // Final fallback to local drafting per field if both AI services failed
    if (!answers) {
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
  if (message?.type === 'ENABLE_DEBUG') {
    try { window.__INTERVIEW_AUTOFILL_DEBUG__ = true; localStorage.setItem('autofill_debug', '1'); } catch (_) {}
  }
});

// Always auto-run and watch for dynamic fields
(function setupAutoFill() {
  // Avoid interfering with Gemini page itself
  const host = location.hostname;
  if (/(^|\.)gemini\.google\.com$/i.test(host)) return;

  // On LinkedIn, avoid feed and messaging surfaces
  if (isLinkedInHost()) {
    const path = location.pathname || '';
    if (/^\/feed\b/.test(path) || /^\/messaging\b/.test(path)) return;
  }

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
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['placeholder', 'aria-label', 'aria-labelledby', 'contenteditable', 'role', 'class']
    });
    logDebug('MutationObserver attached');
  } catch (_) {
    // ignore observer failures
  }

  // React to SPA navigations
  try {
    const rerun = () => schedule();
    window.addEventListener('popstate', rerun, { passive: true });
    window.addEventListener('hashchange', rerun, { passive: true });
    const origPush = history.pushState;
    history.pushState = function() { origPush.apply(this, arguments); schedule(); };
    const origReplace = history.replaceState;
    history.replaceState = function() { origReplace.apply(this, arguments); schedule(); };
    logDebug('Navigation hooks installed');
  } catch (_) {}

  // On LinkedIn, re-run after step transitions (Next/Continue/Review/Submit)
  if (isLinkedInHost()) {
    try {
      document.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target : null;
        const b = t ? t.closest('button, [role="button"]') : null;
        if (!b) return;
        const txt = (b.innerText || b.ariaLabel || b.getAttribute?.('aria-label') || '').toLowerCase();
        if (/\b(next|continue|review|submit|apply)\b/.test(txt)) {
          setTimeout(() => handleAutoFill(), 450);
        }
      }, true);
      logDebug('LinkedIn step button hook installed');
    } catch (_) {}
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
