"""Offline labeled retrieval benchmark. Uses the live multilingual embed endpoint."""
import json
import os
from pathlib import Path

import requests

BASE_URL = os.getenv("ML_SERVICE_URL", "http://localhost:8000").rstrip("/")
DATA = Path(__file__).parent / "data" / "retrieval_eval.jsonl"
TOP_K = int(os.getenv("RETRIEVAL_EVAL_K", "3"))


def embeddings(texts, input_type):
    result = []
    headers = {"x-ml-api-key": os.environ["ML_API_KEY"]} if os.getenv("ML_API_KEY") else {}
    for offset in range(0, len(texts), 16):
        response = requests.post(f"{BASE_URL}/embed", json={"texts": texts[offset:offset + 16], "input_type": input_type}, headers=headers, timeout=120)
        response.raise_for_status()
        result.extend(response.json()["embeddings"])
    return result


def lexical_score(query, text):
    terms = {term.casefold() for term in query.split() if len(term) > 1}
    words = {term.casefold() for term in text.split()}
    return len(terms & words) / max(1, len(terms))


def dcg(relevances):
    return sum(value / __import__("math").log2(index + 2) for index, value in enumerate(relevances))


def main():
    cases = [json.loads(line) for line in DATA.read_text(encoding="utf-8").splitlines() if line.strip()]
    weights = [float(value) for value in os.getenv("VECTOR_WEIGHTS", "1,0.75,0.5,0").split(",")]
    report = {"cases": len(cases), "k": TOP_K, "weights": {}}
    for weight in weights:
        hits, reciprocal_ranks, ndcgs = [], [], []
        for case in cases:
            docs = case["documents"]
            q = embeddings([case["query"]], "query")[0]
            doc_vectors = embeddings([doc["text"] for doc in docs], "passage")
            ranked = []
            for doc, vector in zip(docs, doc_vectors):
                cosine = sum(a * b for a, b in zip(q, vector))
                lexical = lexical_score(case["query"], doc["text"])
                ranked.append((weight * cosine + (1 - weight) * lexical, doc["id"]))
            ranked.sort(reverse=True)
            relevant = set(case["relevant"])
            top = [doc_id for _, doc_id in ranked[:TOP_K]]
            hits.append(len(relevant & set(top)) / len(relevant))
            reciprocal_ranks.append(next((1 / (i + 1) for i, doc_id in enumerate(doc_id for _, doc_id in ranked) if doc_id in relevant), 0))
            ideal = dcg([1] * min(len(relevant), TOP_K))
            ndcgs.append(dcg([int(doc_id in relevant) for doc_id in top]) / ideal if ideal else 0)
        report["weights"][str(weight)] = {"recall_at_k": sum(hits) / len(hits), "mrr": sum(reciprocal_ranks) / len(cases), "ndcg_at_k": sum(ndcgs) / len(cases)}
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
