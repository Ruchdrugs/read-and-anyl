// Fuzzy matching utilities for stored answers and option selection

/**
 * Calculate similarity between two strings (0-1 score)
 * Uses word overlap and simple Levenshtein-like distance
 */
function fuzzyMatch(text1, text2) {
  if (!text1 || !text2) return 0;

  const t1 = text1.toLowerCase().trim();
  const t2 = text2.toLowerCase().trim();

  // Exact match
  if (t1 === t2) return 1.0;

  // Calculate word overlap score
  const words1 = t1.split(/\s+/).filter(w => w.length > 2);
  const words2 = t2.split(/\s+/).filter(w => w.length > 2);

  if (words1.length === 0 || words2.length === 0) {
    // Fall back to substring matching
    if (t1.includes(t2) || t2.includes(t1)) {
      return Math.min(t1.length, t2.length) / Math.max(t1.length, t2.length);
    }
    return 0;
  }

  const set1 = new Set(words1);
  const set2 = new Set(words2);

  let overlap = 0;
  for (const word of set1) {
    if (set2.has(word)) overlap++;
  }

  const overlapScore = (2 * overlap) / (set1.size + set2.size);

  // Calculate substring containment bonus
  let containmentScore = 0;
  if (t1.includes(t2)) {
    containmentScore = t2.length / t1.length;
  } else if (t2.includes(t1)) {
    containmentScore = t1.length / t2.length;
  }

  // Weighted combination
  return Math.max(overlapScore * 0.7 + containmentScore * 0.3, containmentScore);
}

/**
 * Find best matching option from array of options
 * @param {string} target - Target text to match
 * @param {Array<string|{text: string, value: any}>} options - Array of option strings or objects with text property
 * @returns {{match: string|object|null, score: number, index: number}}
 */
function findBestMatch(target, options) {
  if (!target || !options || options.length === 0) {
    return { match: null, score: 0, index: -1 };
  }

  let bestMatch = null;
  let bestScore = 0;
  let bestIndex = -1;

  options.forEach((option, index) => {
    const optionText = typeof option === 'string' ? option : (option.text || option.label || '');
    const score = fuzzyMatch(target, optionText);

    if (score > bestScore) {
      bestScore = score;
      bestMatch = option;
      bestIndex = index;
    }
  });

  return { match: bestMatch, score: bestScore, index: bestIndex };
}

/**
 * Calculate similarity between question and stored answer pattern
 * Specialized for matching questions to stored Q&A pairs
 */
function matchQuestionToPattern(question, pattern) {
  if (!question || !pattern) return 0;

  const q = question.toLowerCase().trim();
  const p = pattern.toLowerCase().trim();

  // Exact match
  if (q === p) return 1.0;

  // Pattern is substring of question
  if (q.includes(p)) return 0.9;

  // Question is substring of pattern
  if (p.includes(q)) return 0.85;

  // Use fuzzy match for word overlap
  const fuzzyScore = fuzzyMatch(q, p);

  // Boost score if key question words match
  const keyQuestionWords = [
    'years', 'experience', 'authorization', 'visa', 'sponsorship',
    'relocate', 'salary', 'compensation', 'start date', 'available',
    'clearance', 'license', 'eligible', 'willing', 'authorized'
  ];

  let keyWordMatches = 0;
  for (const keyword of keyQuestionWords) {
    if (q.includes(keyword) && p.includes(keyword)) {
      keyWordMatches++;
    }
  }

  const keyWordBonus = Math.min(keyWordMatches * 0.15, 0.3);

  return Math.min(fuzzyScore + keyWordBonus, 1.0);
}

/**
 * Extract numbers from text for numeric comparisons
 */
function extractNumbers(text) {
  if (!text) return [];
  const matches = text.match(/\d+(?:\.\d+)?/g);
  return matches ? matches.map(m => parseFloat(m)) : [];
}

/**
 * Check if two texts have similar numeric values
 */
function haveSimilarNumbers(text1, text2) {
  const nums1 = extractNumbers(text1);
  const nums2 = extractNumbers(text2);

  if (nums1.length === 0 || nums2.length === 0) return false;

  // Check if any numbers match
  for (const n1 of nums1) {
    for (const n2 of nums2) {
      if (Math.abs(n1 - n2) < 0.01) return true;
    }
  }

  return false;
}

// Export functions
if (typeof window !== 'undefined') {
  window.answerMatcher = {
    fuzzyMatch,
    findBestMatch,
    matchQuestionToPattern,
    extractNumbers,
    haveSimilarNumbers
  };
}
