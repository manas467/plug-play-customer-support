# Plug-and-Play Multilingual Support Platform

Greenfield local-first support SaaS prototype: business workspaces ingest their own help content, ground English/Hindi replies in citations, and hand unresolved conversations to an agent inbox.

## Local setup

1. Install Node.js 20+, pnpm, Python 3.11+, Docker Desktop, and [Ollama](https://ollama.com/).
2. Copy `.env.example` to `.env`; set `JWT_SECRET` to a random value of at least 32 characters. Set `ML_API_KEY` to a random shared key when enabling ML service authentication.
3. Start PostgreSQL: `docker compose up -d postgres`.
4. Pull a small chat model: `ollama pull qwen2.5:1.5b`.
5. Start the ML service on a private interface/network: `cd services/ml`, create/activate a virtual environment, `pip install -r requirements.txt`, then `uvicorn app.main:app --host 127.0.0.1 --port 8000`. Set the same `ML_API_KEY` for the API and ML service.
6. Start the API: `pnpm install`, then `pnpm --filter @support/api dev`.
7. Start the dashboard: `pnpm --filter @support/web dev` and open http://localhost:5173.

The app works without a GPU. On an 8 GB machine, small quantized Ollama models may respond slowly; keep the context small. Embeddings use multilingual-e5-small on CPU. For a one-command demo account, set `DEMO_EMAIL` and `DEMO_PASSWORD`; on first API start, that account and a demo workspace are seeded.

## Fine-tuning and evaluation

The app does not require a fine-tuned adapter. `python evaluate.py` runs the small held-out generation benchmark and reports expected-content, citation/abstention, script, and handoff rates. It requires a running ML service and Ollama. Treat this as a smoke benchmark, then add representative, reviewed cases and labeled relevant passages before changing retrieval thresholds or the vector/text blend. Never put tenant-uploaded/private content in evaluation or training data.

## Security notes

Workspace-scoped authorization is enforced in API queries. The ML service limits concurrent work and request sizes; `ML_API_KEY` enables API-to-ML authentication. Keep ML and Ollama on private networks, configure HTTPS, durable object storage, backups, and production identity controls before exposing this development MVP publicly. The widget domain allowlist is a browser embedding restriction, not visitor authentication.
