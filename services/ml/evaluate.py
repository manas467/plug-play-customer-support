"""Starter held-out benchmark for local grounded support generation.

Set EVAL_MODELS to a comma-separated list to compare an Ollama base model and
an imported fine-tuned model, e.g. qwen2.5:1.5b,support-tuned.
"""
import json
import os
import requests

CASES = [
    {"question": "How do I reset my password?", "language": "en", "context": "[1] Account guide\nSelect Forgot password and follow the email link. The link expires in 30 minutes.", "terms": ["forgot password", "30 minutes"], "handoff": False},
    {"question": "मैं अपना पासवर्ड कैसे रीसेट करूँ?", "language": "hi", "context": "[1] खाता गाइड\nसाइन-इन पर Forgot password चुनें और ईमेल लिंक खोलें। लिंक 30 मिनट में समाप्त होता है।", "terms": ["Forgot password", "30"], "handoff": False},
    {"question": "Does the product have a mobile app?", "language": "en", "context": "[1] Returns guide\nItems can be returned within 14 days.", "terms": [], "handoff": True},
    {"question": "क्या ऐप ऑफलाइन काम करता है?", "language": "hi", "context": "[1] वापसी गाइड\nउत्पाद 14 दिनों के भीतर लौटाए जा सकते हैं।", "terms": [], "handoff": True},
    {"question": "How can I export a report?", "language": "en", "context": "[1] Reports guide\nOpen Reports, choose a date range, then select Export CSV.", "terms": ["reports", "csv"], "handoff": False},
    {"question": "डार्क मोड कहाँ मिलेगा?", "language": "hi", "context": "[1] थीम गाइड\nप्रोफ़ाइल मेनू खोलें और Theme में Dark चुनें।", "terms": ["theme", "dark"], "handoff": False},
]


def main():
    models = [item.strip() for item in os.getenv("EVAL_MODELS", "qwen2.5:1.5b").split(",") if item.strip()]
    report = {}
    for model in models:
        results = []
        for case in CASES:
            payload = {key: case[key] for key in ("question", "language", "context")}
            payload["model"] = model
            response = requests.post("http://localhost:8000/generate", json=payload, timeout=180)
            response.raise_for_status()
            answer = response.json()["answer"].strip()
            is_handoff = answer.upper().startswith("HANDOFF")
            terms_ok = all(term.casefold() in answer.casefold() for term in case["terms"])
            citation_ok = is_handoff or "[1]" in answer
            script_ok = (case["language"] == "en" and not any("\u0900" <= c <= "\u097f" for c in answer)) or (case["language"] == "hi" and any("\u0900" <= c <= "\u097f" for c in answer))
            handoff_ok = is_handoff == case["handoff"]
            results.append({"question": case["question"], "answer": answer, "expected_terms": terms_ok, "citation_or_abstention": citation_ok, "language_script": script_ok, "handoff": handoff_ok})
        count = len(results)
        report[model] = {"cases": count, "expected_terms_rate": sum(x["expected_terms"] for x in results) / count, "citation_or_abstention_rate": sum(x["citation_or_abstention"] for x in results) / count, "language_script_rate": sum(x["language_script"] for x in results) / count, "handoff_accuracy": sum(x["handoff"] for x in results) / count, "details": results}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()