// Background service worker for MV3
// Implements a fully local answer generator using stored resume text

const DEFAULT_SETTINGS = {
  // Persisted user data
  resumeText: '',
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
  ].filter(Boolean).join('\n');
}

// ------------------------------
// Local resume-based generator
// ------------------------------

const STOPWORDS = new Set([
  'the','and','for','with','that','this','from','have','has','was','were','are','our','your','you','i','me','my','we','us','to','of','in','on','at','as','by','or','an','a','it','is','be','been','but','so','if','then','than','over','into','out','up','down','about','across','within','without','per'
]);

function normalizeWhitespace(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9%+\.\-\s]/g, ' ') // keep digits and %/+/.- for metrics
    .split(/\s+/)
    .filter(Boolean);
}

function extractKeywords(text, max = 24) {
  const terms = tokenize(text).filter(t => t.length >= 3 && !STOPWORDS.has(t));
  const freq = new Map();
  for (const t of terms) freq.set(t, (freq.get(t) || 0) + 1);
  return Array.from(freq.entries())
    .sort((a,b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

function splitResumeIntoItems(resumeText) {
  const lines = (resumeText || '').split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = normalizeWhitespace(raw);
    if (!line) continue;
    // Treat bullet-like lines or sentences as items
    if (/^[\-•·\*\u2022]/.test(line) || line.length > 40) {
      items.push(line.replace(/^[\-•·\*\u2022]\s*/, ''));
    }
  }
  return items;
}

function scoreItemRelevance(item, keywordSet) {
  // Simple overlap score, weighted by presence of numbers/metrics
  const tokens = tokenize(item);
  let overlap = 0;
  for (const tok of tokens) if (keywordSet.has(tok)) overlap += 1;
  const hasMetric = /\b\d{1,4}(?:%|x|x\b|\b)\b|\b\d+\.\d+\b/.test(item);
  const hasLeadership = /(lead|led|mentor|mentored|managed|owner|owned|drive|drove|architect|designed)/i.test(item);
  let score = overlap;
  if (hasMetric) score += 1.5;
  if (hasLeadership) score += 0.5;
  return score;
}

function pickTop(items, question, pageContext, k = 5) {
  const keywords = new Set([
    ...extractKeywords(question || ''),
    ...extractKeywords(pageContext || '')
  ]);
  const scored = items.map((it) => ({ item: it, score: scoreItemRelevance(it, keywords) }));
  return scored
    .filter(s => s.score > 0)
    .sort((a,b) => b.score - a.score)
    .slice(0, k)
    .map(s => s.item);
}

function composeAnswer({ question, persona, picks }) {
  const system = buildSystemPrompt(persona);
  const intro = system ? `${system}\n` : '';
  const header = question ? `Question: ${normalizeWhitespace(question)}\n\n` : '';
  if (!picks || picks.length === 0) {
    return (
      intro + header +
      [
        'Here is a concise answer grounded in my experience:',
        '- I align my experience to the role by focusing on impact and clear business outcomes.',
        '- I communicate trade-offs, collaborate closely with stakeholders, and iterate quickly.',
        '- When appropriate, I back claims with metrics and specific examples.'
      ].join('\n')
    ).trim();
  }
  const bullets = picks.map(p => `- ${p}`);
  return (
    intro + header +
    [
      'Relevant experience from my resume:',
      ...bullets,
      '',
      'I tailor these examples to the question by emphasizing results, the reasoning behind decisions, and lessons learned.'
    ].join('\n')
  ).trim();
}

async function generateAnswerFromResume(questionText, pageContext) {
  const settings = await getSettings();
  const persona = settings.persona || {};
  const resumeText = settings.resumeText || '';
  const items = splitResumeIntoItems(resumeText);
  const picks = pickTop(items, questionText, pageContext, 6);
  return composeAnswer({ question: questionText, persona, picks });
}

async function draftAnswer(questionText, pageContext) {
  return await generateAnswerFromResume(questionText, pageContext);
}

function evaluateAnswerQuality(answer) {
  const txt = (answer || '').trim();
  if (!txt) return { quality: 'weak', reason: 'empty answer' };
  if (/Here is a concise answer grounded in my experience:/i.test(txt)) {
    return { quality: 'weak', reason: 'generic template used' };
  }
  if (txt.length < 110) {
    return { quality: 'weak', reason: 'too short' };
  }
  const hasBullets = /\n\-\s/.test(txt);
  const hasMetric = /\b\d{1,4}(?:%|x|\b)/.test(txt) || /\b\d+\.\d+\b/.test(txt);
  if (hasBullets && hasMetric) return { quality: 'good', reason: 'structured and metric-backed' };
  if (hasBullets) return { quality: 'ok', reason: 'structured but low metrics' };
  return { quality: 'ok', reason: 'adequate length' };
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type } = message || {};
  if (type === 'DRAFT_ANSWER') {
    (async () => {
      try {
        const answer = await draftAnswer(message.questionText, message.pageContext);
        const { quality, reason } = evaluateAnswerQuality(answer);
        sendResponse({ ok: true, answer, quality, reason });
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
  if (type === 'GEMINI_BUILD_PROMPT') {
    (async () => {
      try {
        const settings = await getSettings();
        const persona = settings.persona || {};
        const resumeText = settings.resumeText || '';
        const labels = message?.labels || [];
        const pageContext = message?.pageContext || '';
        const prompt = [
          buildSystemPrompt(persona),
          '',
          'You are assisting with drafting interview answers. Based on the resume and the question labels found on this page, provide any clarifying questions needed to craft precise, metric-backed answers (limit to 6).',
          'Then propose concise draft answers (120-180 words) for each label context, grounded strictly in the resume. Use STAR when applicable.',
          '',
          'Resume:',
          resumeText,
          '',
          'Page context:',
          pageContext,
          '',
          'Question labels:',
          JSON.stringify(labels)
        ].join('\n');
        sendResponse({ ok: true, prompt });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }
  if (type === 'GEMINI_OPEN_AND_ASK') {
    (async () => {
      try {
        const prompt = message?.prompt || '';
        const geminiUrl = 'https://gemini.google.com/app';
        const newTab = await new Promise((resolve) => chrome.tabs.create({ url: geminiUrl, active: true }, resolve));
        const tabId = newTab?.id;
        if (!tabId) {
          sendResponse({ ok: false, error: 'Failed to open Gemini tab' });
          return;
        }
        // Attempt several times as Gemini UI loads
        for (let attempt = 0; attempt < 6; attempt++) {
          await delay(attempt === 0 ? 1500 : 1000);
          try {
            await new Promise((resolve, reject) => {
              chrome.tabs.sendMessage(tabId, { type: 'GEMINI_ASK', prompt }, (resp) => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                if (!resp?.ok) return reject(new Error(resp?.error || 'Injection failed'));
                resolve(resp);
              });
            });
            break; // success
          } catch (_) {
            // try next attempt
          }
        }
        sendResponse({ ok: true, tabId });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
    })();
    return true;
  }
});
