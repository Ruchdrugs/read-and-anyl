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

  // Load stored answers
  loadStoredAnswers(settings.storedAnswers || {});
}

function loadStoredAnswers(storedAnswers) {
  const container = getEl('storedAnswersContainer');
  if (!container) return;

  // Clear existing rows
  container.innerHTML = '';

  // Add rows for existing stored answers
  const entries = Object.entries(storedAnswers);
  if (entries.length === 0) {
    addAnswerRow('', ''); // Add one empty row
  } else {
    entries.forEach(([question, answer]) => {
      addAnswerRow(question, answer);
    });
  }
}

function addAnswerRow(question = '', answer = '') {
  const container = getEl('storedAnswersContainer');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'answer-row';

  const questionInput = document.createElement('input');
  questionInput.type = 'text';
  questionInput.className = 'question-pattern';
  questionInput.placeholder = 'Question pattern (e.g., years of experience)';
  questionInput.value = question;

  const answerInput = document.createElement('input');
  answerInput.type = 'text';
  answerInput.className = 'answer-value';
  answerInput.placeholder = 'Your answer';
  answerInput.value = answer;

  const removeBtn = document.createElement('button');
  removeBtn.textContent = 'Remove';
  removeBtn.className = 'remove-answer';
  removeBtn.type = 'button';
  removeBtn.addEventListener('click', () => row.remove());

  row.appendChild(questionInput);
  row.appendChild(answerInput);
  row.appendChild(removeBtn);

  container.appendChild(row);
}

function collectStoredAnswers() {
  const container = getEl('storedAnswersContainer');
  if (!container) return {};

  const rows = container.querySelectorAll('.answer-row');
  const storedAnswers = {};

  rows.forEach(row => {
    const question = row.querySelector('.question-pattern')?.value?.trim();
    const answer = row.querySelector('.answer-value')?.value?.trim();
    if (question && answer) {
      storedAnswers[question] = answer;
    }
  });

  return storedAnswers;
}

function loadCommonQuestions() {
  const commonQuestions = {
    'years of experience': '',
    'work authorization': '',
    'visa sponsorship': '',
    'willing to relocate': '',
    'salary expectations': '',
    'start date': '',
    'security clearance': '',
    'driver license': ''
  };

  const container = getEl('storedAnswersContainer');
  if (!container) return;

  // Clear existing rows
  container.innerHTML = '';

  // Add rows for common questions
  Object.entries(commonQuestions).forEach(([question, answer]) => {
    addAnswerRow(question, answer);
  });
}

async function save() {
  const next = {
    resumeText: getEl('resumeText').value,
    persona: {
      role: getEl('role').value.trim(),
      tone: getEl('tone').value.trim(),
      extra: getEl('extra').value.trim()
    },
    storedAnswers: collectStoredAnswers()
  };
  await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', partial: next }, resolve));
  const btn = document.getElementById('save');
  btn.textContent = 'Saved';
  setTimeout(() => (btn.textContent = 'Save'), 1200);
}

// ------------------------------
// PDF upload and lightweight text extraction
// ------------------------------

function updatePdfStatus(message, isError = false) {
  const el = getEl('pdfStatus');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = isError ? '#b00020' : '#666';
}

function setSelectedPdfName(name) {
  const el = getEl('resumePdfName');
  if (el) el.value = name || '';
}

// Decode PDF string literal escapes per PDF spec basics: \\\, \(, \), \n, \r, \t, \b, \f, and octal \ddd
function decodePdfStringLiteral(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    // Escape
    i++;
    if (i >= s.length) break;
    const e = s[i];
    switch (e) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case '(': out += '('; break;
      case ')': out += ')'; break;
      case '\\': out += '\\'; break;
      default: {
        // Octal up to 3 digits
        if (e >= '0' && e <= '7') {
          let oct = e;
          for (let k = 0; k < 2 && i + 1 < s.length; k++) {
            const nx = s[i + 1];
            if (nx >= '0' && nx <= '7') { oct += nx; i++; } else { break; }
          }
          out += String.fromCharCode(parseInt(oct, 8));
        } else {
          // Unknown escape, keep literal
          out += e;
        }
      }
    }
  }
  return out;
}

function uint8ToLatin1String(uint8) {
  const CHUNK = 0x8000;
  const parts = [];
  for (let i = 0; i < uint8.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK)));
  }
  return parts.join('');
}

// Very lightweight text scraper: pulls string literals used by Tj/TJ operators.
function extractTextFromPdfBytes(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const bin = uint8ToLatin1String(bytes);

  // Collect ( ... ) Tj
  const result = [];
  const reTj = /\(((?:\\\)|\\\(|\\.|[^\\\)])*)\)\s*Tj/g; // (literal) Tj
  let m;
  while ((m = reTj.exec(bin)) !== null) {
    result.push(decodePdfStringLiteral(m[1]));
  }

  // Collect TJ arrays: [ ... ] TJ where elements can be (literal) or numbers (kerning)
  const reTJ = /\[((?:\s*\(((?:\\\)|\\\(|\\.|[^\\\)])*)\)\s*|-?\d+(?:\.\d+)?)\s*)+\]\s*TJ/g;
  let a;
  while ((a = reTJ.exec(bin)) !== null) {
    const block = a[0];
    const inner = [...block.matchAll(/\(((?:\\\)|\\\(|\\.|[^\\\)])*)\)/g)].map(x => decodePdfStringLiteral(x[1]));
    if (inner.length) result.push(inner.join(''));
  }

  // Heuristic cleanup
  let text = result.join('\n');
  text = text
    .replace(/[\t\f\r]+/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

async function handlePdfSelected(file) {
  if (!file) return;
  setSelectedPdfName(file.name || '');
  if (file.type && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    updatePdfStatus('Please select a PDF file.', true);
    return;
  }
  updatePdfStatus('Reading PDF…');
  try {
    const buf = await file.arrayBuffer();
    updatePdfStatus('Extracting text…');
    const text = extractTextFromPdfBytes(buf);
    if (!text || text.length < 200) {
      updatePdfStatus('Could not reliably extract text. Please paste your resume text.', true);
      return;
    }
    const prev = getEl('resumeText').value.trim();
    const merged = prev ? `${prev}\n\n${text}` : text;
    getEl('resumeText').value = merged;
    await save();
    updatePdfStatus('PDF extracted and saved. You can review/edit the text below.');
  } catch (err) {
    console.error(err);
    updatePdfStatus('Failed to process PDF. Please paste your resume text.', true);
  }
}

function bindPdfInput() {
  const fileInput = getEl('resumePdf');
  if (!fileInput) return;
  fileInput.addEventListener('change', async (e) => {
    const file = e.target?.files && e.target.files[0];
    if (file) {
      await handlePdfSelected(file);
    }
  });
}

getEl('save').addEventListener('click', save);
bindPdfInput();
load();
