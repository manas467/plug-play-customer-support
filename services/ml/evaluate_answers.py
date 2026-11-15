"""Score answer grounding, citation selection, language script, and abstention."""
import json
import os
import re
from pathlib import Path

import requests

BASE_URL = os.getenv("ML_SERVICE_URL", "http://localhost:8000").rstrip("/")
DATA = Path(__file__).parent / "data" / "answer_eval.jsonl"


def main():
    cases = [json.loads(line) for line in DATA.read_text(encoding="utf-8").splitlines() if line.strip()]
    headers = {"x-ml-api-key": os.environ["ML_API_KEY"]} if os.getenv("ML_API_KEY") else {}
    results = []
    for case in cases:
        response = requests.post(f"{BASE_URL}/generate", json={key: case[key] for key in ("question", "language", "context")} | {"model": os.getenv("OLLAMA_CHAT_MODEL", "qwen2.5:1.5b")}, headers=headers, timeout=180)
        response.raise_for_status()
        answer = response.json()["answer"].strip()
        citations = [int(value) for value in re.findall(r"\[(\d+)\]", answer)]
        is_handoff = answer.casefold().startswith("handoff")
        has_hindi = any("\u0900" <= char <= "\u097f" for char in answer)
        content_correct = is_handoff if case["handoff"] else all(term.casefold() in answer.casefold() for term in case["required_terms"])
        citation_correct = citations == case["citations"] if not case["handoff"] else not citations
        language_correct = (case["language"] == "hi") == has_hindi if not is_handoff else True
        results.append({"id": case["id"], "answer": answer, "content_correct": content_correct, "citation_correct": citation_correct, "language_script_correct": language_correct, "abstention_correct": is_handoff == case["handoff"]})
    total = len(results)
    report = {key: sum(row[key] for row in results) / total for key in ("content_correct", "citation_correct", "language_script_correct", "abstention_correct")}
    report.update({"cases": total, "details": results})
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
