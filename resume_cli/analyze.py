from typing import Dict, List

ROLE_KEYWORDS = {
    "backend": ["python", "java", "go", "microservices", "api", "postgres", "redis", "aws"],
    "frontend": ["react", "typescript", "javascript", "vue", "css", "html", "nextjs"],
    "ml": ["pytorch", "tensorflow", "ml", "machine learning", "nlp", "cv"],
    "devops": ["kubernetes", "docker", "terraform", "cicd", "aws", "gcp", "azure"],
}


def analyze_resume(parsed: Dict) -> Dict:
    skills = set(parsed.get("skills", []))

    likely_roles = []
    for role, keywords in ROLE_KEYWORDS.items():
        score = sum(1 for k in keywords if k in skills)
        if score >= 2:
            likely_roles.append({"role": role, "score": score})

    strengths = []
    if len(skills) >= 10:
        strengths.append("Breadth of skills")
    if any(k in skills for k in ("python", "java", "react", "kubernetes")):
        strengths.append("In-demand core technologies present")

    gaps = []
    if not parsed["raw_sections"].get("projects"):
        gaps.append("Add 1-2 measurable project summaries with outcomes")
    if not parsed["raw_sections"].get("experience"):
        gaps.append("Detail recent experience with metrics (impact, scale)")

    return {
        "likely_roles": sorted(likely_roles, key=lambda x: -x["score"]),
        "strengths": strengths,
        "gaps": gaps,
    }
