from pathlib import Path
from typing import Dict, List, Tuple
import subprocess
import json

SYSTEM_PROMPT = (
    "You are an expert career coach. Given resume text, parsed fields, and insights, "
    "write concise, compelling interview answers with STAR where applicable."
)


def _ollama_generate(prompt: str, model: str) -> str:
    try:
        result = subprocess.run(
            ["ollama", "run", model],
            input=prompt.encode("utf-8"),
            capture_output=True,
            check=False,
        )
        out = result.stdout.decode("utf-8", errors="ignore")
        if out.strip():
            return out.strip()
    except FileNotFoundError:
        pass
    return ""


def generate_answers(
    questions: List[str],
    resume_text: str,
    parsed: Dict,
    insights: Dict,
    use_ollama: bool = False,
    model: str = "llama3.1:8b",
) -> Tuple[Dict[str, str], List[str]]:
    answers: Dict[str, str] = {}
    clarifying_questions: List[str] = []

    for q in questions:
        prompt = (
            f"{SYSTEM_PROMPT}\n\n"
            f"Question: {q}\n\n"
            f"Resume text:\n{resume_text[:8000]}\n\n"
            f"Parsed JSON:\n{json.dumps(parsed)[:6000]}\n\n"
            f"Insights JSON:\n{json.dumps(insights)}\n\n"
            "Respond briefly (120-180 words), concrete, with numbers when possible."
        )
        answer = ""
        if use_ollama:
            answer = _ollama_generate(prompt, model)
        if not answer:
            # Template fallback
            answer = (
                "[Template answer]\n"
                f"- Restate fit for the role based on {insights.get('likely_roles', [])}.\n"
                "- Use STAR: situation, task, actions, results with metrics.\n"
                "- Tie to company goals and values.\n"
            )

        # Emit clarifying prompts for Gemini manual use
        clarifying = (
            f"For question '{q}', what specific project, metric, or outcome best showcases impact?"
        )
        clarifying_questions.append(clarifying)
        answers[q] = answer

    return answers, clarifying_questions


def write_clarifying_questions(questions: List[str], out_path: Path) -> None:
    md = ["# Clarifying questions for Gemini (manual)\n"]
    for q in questions:
        md.append(f"- {q}")
    out_path.write_text("\n".join(md))
