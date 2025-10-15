# Resume Analyzer CLI

A small Python CLI that:
- Extracts text from a resume PDF
- Parses key sections (contact, skills, experience, education)
- Analyzes strengths and gaps
- Generates interview answers for common questions
- Can optionally use a local LLM via Ollama (no API keys required)
 - Optionally triggers Gemini in your browser (no API keys) via the included Chrome MV3 extension, which opens `gemini.google.com` and pastes a composed prompt automatically. You must be logged in.

## Quick start

1. Create a Python 3.10+ virtualenv
2. Install dependencies: `pip install -r requirements.txt`
3. Run:
```
python -m resume_cli --resume path/to/resume.pdf --questions sample_questions.yaml --out out
```

If you have Ollama installed, you can enable local LLM generation:
```
python -m resume_cli --resume path/to/resume.pdf --questions sample_questions.yaml --out out --use-ollama --model llama3.1:8b
```

If you prefer to ask clarifying questions via Gemini manually, see the `out/clarifying_questions.md` after running. Copy/paste those into Gemini Web and paste replies into `out/gemini_answers.md`.

## Browser extension (Gemini, no API keys)

The `extension/` directory contains a Chrome MV3 extension that:
- Reads question fields on the current page and drafts answers locally using your pasted resume in Options.
- Adds an "Ask Gemini (No API)" button in the popup to open `gemini.google.com/app`, paste a composed prompt (resume + page context + labels), and click send. Login required; this does not use any API keys.

Steps:
1. Open `chrome://extensions` and enable Developer mode.
2. Click "Load unpacked" and select the repo root (so the `manifest.json` at the root maps paths).
3. Open the extension Options page and paste your resume text and persona.
4. On any application page, open the extension popup and click either:
   - "Draft & Fill Answers" to locally draft and fill fields, or
   - "Ask Gemini (No API)" to open Gemini and inject the prompt.

Notes:
- Sites with aggressive DOM isolation may block autofill; in that case use the Gemini button.
- We do not bypass CAPTCHA, paywalls, or logins.
