// Field type handlers for different input types
// Handles text, select, radio, checkbox, number, and file fields

// Import fuzzy matching utilities
// Note: Will be loaded before this file in manifest.json

/**
 * Set native value for text inputs (bypasses React/Vue setters)
 */
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

/**
 * Set value for standard text inputs and textareas
 */
function setTextFieldValue(field, text) {
  if (!field) return false;
  const tag = field.tagName?.toLowerCase();
  if (tag === 'textarea' || (tag === 'input' && (field.type === 'text' || !field.type))) {
    const val = (text || '').toString();
    try { field.focus(); } catch (_) {}
    try { field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
    setNativeValue(field, val);
    try { field.setSelectionRange?.(val.length, val.length); } catch (_) {}
    try { field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
    try { field.dispatchEvent(new Event('change', { bubbles: true, composed: true })); } catch (_) {}
    try { field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })); } catch (_) {}
    return true;
  }

  // Handle contenteditable elements
  if (field.isContentEditable || tag === 'div') {
    const val = (text || '').toString();
    try {
      field.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(field);
      sel.removeAllRanges();
      sel.addRange(range);
      try { field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertFromPaste', data: val })); } catch (_) {}
      if (!document.execCommand('insertText', false, val)) {
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
    return true;
  }

  return false;
}

/**
 * Set value for select/dropdown fields using fuzzy matching
 */
function setSelectFieldValue(field, answer, label) {
  if (!field || field.tagName?.toLowerCase() !== 'select') return false;

  const options = Array.from(field.querySelectorAll('option'));
  if (options.length === 0) return false;

  const answerLower = (answer || '').toLowerCase().trim();
  if (!answerLower) return false;

  // Try exact match first
  let bestOption = null;
  let bestScore = 0;

  for (const option of options) {
    const optionText = (option.textContent || '').toLowerCase().trim();
    const optionValue = (option.value || '').toLowerCase().trim();

    // Skip empty options
    if (!optionText && !optionValue) continue;

    // Exact match
    if (optionText === answerLower || optionValue === answerLower) {
      bestOption = option;
      bestScore = 1.0;
      break;
    }

    // Partial match
    if (answerLower.includes(optionText) || optionText.includes(answerLower)) {
      const score = Math.min(answerLower.length, optionText.length) / Math.max(answerLower.length, optionText.length);
      if (score > bestScore) {
        bestScore = score;
        bestOption = option;
      }
    }

    // Check value too
    if (answerLower.includes(optionValue) || optionValue.includes(answerLower)) {
      const score = Math.min(answerLower.length, optionValue.length) / Math.max(answerLower.length, optionValue.length);
      if (score > bestScore) {
        bestScore = score;
        bestOption = option;
      }
    }

    // Extract numbers from answer for numeric options (e.g., "5 years" -> 5)
    const answerNum = answerLower.match(/\b(\d+)\b/);
    const optionNum = optionText.match(/\b(\d+)\b/);
    if (answerNum && optionNum && answerNum[1] === optionNum[1]) {
      const score = 0.9;
      if (score > bestScore) {
        bestScore = score;
        bestOption = option;
      }
    }
  }

  // If no good match, use first non-empty option as default
  if (!bestOption || bestScore < 0.3) {
    bestOption = options.find(opt => (opt.textContent || opt.value || '').trim().length > 0);
  }

  if (bestOption) {
    field.value = bestOption.value;
    try { field.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    try { field.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    return true;
  }

  return false;
}

/**
 * Set value for radio button groups
 */
function setRadioFieldValue(field, answer, label) {
  if (!field || field.type !== 'radio') return false;

  const name = field.name || field.getAttribute('name');
  if (!name) return false;

  // Get all radios in the group
  const radios = Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`));
  if (radios.length === 0) return false;

  const answerLower = (answer || '').toLowerCase().trim();
  if (!answerLower) return false;

  // Determine if answer is positive or negative (for yes/no questions)
  const isPositive = /\b(yes|true|agree|i am|i do|i have|authorized|willing)\b/i.test(answerLower);
  const isNegative = /\b(no|false|disagree|i am not|i do not|i don't|not authorized|not willing)\b/i.test(answerLower);

  let bestRadio = null;
  let bestScore = 0;

  for (const radio of radios) {
    // Get label for this radio
    let radioLabel = '';

    // Try <label for="id">
    const radioId = radio.getAttribute('id');
    if (radioId) {
      const forLabel = document.querySelector(`label[for="${CSS.escape(radioId)}"]`);
      if (forLabel) radioLabel = (forLabel.textContent || '').trim();
    }

    // Try radio.labels
    if (!radioLabel && radio.labels && radio.labels.length > 0) {
      radioLabel = Array.from(radio.labels).map(l => l.textContent || '').join(' ').trim();
    }

    // Try nearest label
    if (!radioLabel) {
      const nearLabel = radio.closest('label');
      if (nearLabel) radioLabel = (nearLabel.textContent || '').trim();
    }

    // Try siblings
    if (!radioLabel && radio.nextSibling) {
      const nextText = radio.nextSibling.textContent || '';
      if (nextText.trim().length > 0 && nextText.trim().length < 100) {
        radioLabel = nextText.trim();
      }
    }

    const radioLabelLower = radioLabel.toLowerCase();

    // Exact match
    if (radioLabelLower === answerLower) {
      bestRadio = radio;
      bestScore = 1.0;
      break;
    }

    // Partial match
    if (answerLower.includes(radioLabelLower) || radioLabelLower.includes(answerLower)) {
      const score = Math.min(answerLower.length, radioLabelLower.length) / Math.max(answerLower.length, radioLabelLower.length);
      if (score > bestScore) {
        bestScore = score;
        bestRadio = radio;
      }
    }

    // Boolean matching for yes/no questions
    if (isPositive && /\b(yes|true|agree|authorized|willing)\b/i.test(radioLabelLower)) {
      const score = 0.9;
      if (score > bestScore) {
        bestScore = score;
        bestRadio = radio;
      }
    }
    if (isNegative && /\b(no|false|disagree|not authorized|not willing)\b/i.test(radioLabelLower)) {
      const score = 0.9;
      if (score > bestScore) {
        bestScore = score;
        bestRadio = radio;
      }
    }
  }

  if (bestRadio && bestScore > 0.3) {
    bestRadio.checked = true;
    try { bestRadio.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    try { bestRadio.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    try { bestRadio.dispatchEvent(new Event('click', { bubbles: true })); } catch (_) {}
    return true;
  }

  return false;
}

/**
 * Set value for checkbox fields
 */
function setCheckboxFieldValue(field, answer, label) {
  if (!field || field.type !== 'checkbox') return false;

  const answerLower = (answer || '').toLowerCase().trim();
  if (!answerLower) return false;

  // Determine intent: positive or negative
  const positiveKeywords = /\b(yes|true|agree|i am|i do|i have|correct|confirmed)\b/i;
  const negativeKeywords = /\b(no|false|disagree|i am not|i do not|i don't|not|incorrect)\b/i;

  const hasPositive = positiveKeywords.test(answerLower);
  const hasNegative = negativeKeywords.test(answerLower);

  // If ambiguous, don't change
  if (hasPositive === hasNegative) return false;

  field.checked = hasPositive;
  try { field.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
  try { field.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  try { field.dispatchEvent(new Event('click', { bubbles: true })); } catch (_) {}
  return true;
}

/**
 * Set value for number/tel fields
 */
function setNumberFieldValue(field, answer) {
  if (!field) return false;
  const tag = field.tagName?.toLowerCase();
  if (tag !== 'input' || (field.type !== 'number' && field.type !== 'tel')) return false;

  // Extract first number from answer
  const match = (answer || '').match(/\d+(?:\.\d+)?/);
  if (!match) return false;

  const numberValue = match[0];
  setNativeValue(field, numberValue);
  try { field.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  try { field.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
  return true;
}

/**
 * Handle file upload fields (cannot be set programmatically)
 */
function handleFileField(field, label) {
  if (!field || field.type !== 'file') return 'not_file_field';

  // Check if file already uploaded by looking for filename display nearby
  const parent = field.closest('div, section, label, form');
  if (parent) {
    const text = (parent.textContent || '').toLowerCase();
    // Look for file extensions that indicate upload completed
    if (/\.(pdf|doc|docx|txt|rtf)/.test(text)) {
      console.log('[Autofill] File already uploaded, skipping:', label);
      return 'skipped_already_uploaded';
    }
  }

  // Cannot programmatically upload files (security restriction)
  console.log('[Autofill] File upload field detected - please upload manually:', label);
  return 'skipped_manual_upload_required';
}

// Export all handlers
if (typeof window !== 'undefined') {
  window.fieldHandlers = {
    setTextFieldValue,
    setSelectFieldValue,
    setRadioFieldValue,
    setCheckboxFieldValue,
    setNumberFieldValue,
    handleFileField
  };
}
