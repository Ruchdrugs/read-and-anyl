import re
from typing import Dict, List


def parse_resume(text: str) -> Dict:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    content = "\n".join(lines)

    email_match = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", content)
    phone_match = re.search(r"(?:\+\d{1,3}[ -]?)?(?:\(?\d{3}\)?[ -]?\d{3}[ -]?\d{4})", content)
    linkedin_match = re.search(r"linkedin\.com\/in\/[A-Za-z0-9_-]+", content, re.I)
    github_match = re.search(r"github\.com\/[A-Za-z0-9._-]+", content, re.I)

    # Basic section splits
    def section(header: str) -> str:
        pattern = re.compile(rf"^\s*{header}\s*$", re.I | re.M)
        parts = pattern.split(content)
        if len(parts) > 1:
            # Take everything after the header occurrence
            return parts[-1].strip()
        return ""

    skills_block = section("Skills|Technical Skills|Skills & Tools|Core Skills")
    experience_block = section("Experience|Professional Experience|Work Experience")
    education_block = section("Education|Academic Background")
    projects_block = section("Projects|Selected Projects")

    skills = re.findall(r"[A-Za-z0-9+#.\-_/]{2,}", skills_block) if skills_block else []

    return {
        "contact": {
            "email": email_match.group(0) if email_match else None,
            "phone": phone_match.group(0) if phone_match else None,
            "linkedin": linkedin_match.group(0) if linkedin_match else None,
            "github": github_match.group(0) if github_match else None,
        },
        "skills": sorted(set(s.lower() for s in skills))[:200],
        "raw_sections": {
            "skills": skills_block,
            "experience": experience_block,
            "education": education_block,
            "projects": projects_block,
        },
    }
