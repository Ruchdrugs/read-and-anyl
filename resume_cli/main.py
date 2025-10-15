from pathlib import Path
from typing import Optional
import sys
import json
import yaml
import argparse
from rich.console import Console
from rich.panel import Panel
from .pdf_extract import extract_text_from_pdf
from .parser import parse_resume
from .analyze import analyze_resume
from .answers import generate_answers, write_clarifying_questions

console = Console()


def cli_main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Analyze resume PDF and draft interview answers")
    parser.add_argument("--resume", required=True, type=Path, help="Path to resume PDF")
    parser.add_argument("--questions", required=True, type=Path, help="YAML list of interview questions")
    parser.add_argument("--out", default=Path("out"), type=Path, help="Output directory")
    parser.add_argument("--use-ollama", action="store_true", help="Use local LLM via Ollama")
    parser.add_argument("--model", default="llama3.1:8b", help="Ollama model name")
    args = parser.parse_args(argv)

    resume: Path = args.resume
    questions: Path = args.questions
    out: Path = args.out
    use_ollama: bool = bool(args.use_ollama)
    model: str = args.model

    if not resume.exists() or not resume.is_file():
        console.print(f"[red]Resume file not found:[/] {resume}")
        return 2
    if not questions.exists() or not questions.is_file():
        console.print(f"[red]Questions file not found:[/] {questions}")
        return 2

    out.mkdir(parents=True, exist_ok=True)

    console.rule("Resume Analyzer")
    console.print(Panel.fit(f"Reading [bold]{resume}[/]"))
    text, meta = extract_text_from_pdf(resume)

    console.print(Panel.fit("Parsing resume"))
    data = parse_resume(text)

    console.print(Panel.fit("Analyzing resume"))
    insights = analyze_resume(data)

    console.print(Panel.fit("Loading questions"))
    questions_list = yaml.safe_load(questions.read_text())
    if not isinstance(questions_list, list):
        console.print("[red]Questions YAML must be a list of strings[/]")
        return 2

    console.print(Panel.fit("Generating answers"))
    answers, clarifying_questions = generate_answers(
        questions_list, resume_text=text, parsed=data, insights=insights, use_ollama=use_ollama, model=model
    )

    (out / "resume_text.txt").write_text(text)
    (out / "resume_metadata.json").write_text(json.dumps(meta, indent=2))
    (out / "parsed.json").write_text(json.dumps(data, indent=2))
    (out / "insights.json").write_text(json.dumps(insights, indent=2))
    (out / "answers.json").write_text(json.dumps(answers, indent=2))
    write_clarifying_questions(clarifying_questions, out / "clarifying_questions.md")

    console.rule("Done")
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main())
