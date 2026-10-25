# Plug-and-Play Multilingual Support Platform

Greenfield local-first support SaaS prototype: business workspaces ingest their own help content, ground English/Hindi replies in citations, and hand unresolved conversations to an agent inbox.

## Local setup

1. Install Node.js 20+, pnpm, Python 3.11+, Docker Desktop, and [Ollama](https://ollama.com/).
2. Copy `.env.example` to `.env`; replace `JWT_SECRET` before using anything beyond local development.
3. Start PostgreSQL: `docker compose up -d postgres`.
4. Pull a small chat model: `ollama pull qwen2.5:1.5b`.
5. Start the ML service: `cd services/ml`, create/activate a virtual environment, `pip install -r requirements.txt`, then `uvicorn app.main:app --reload --port 8000`.
6. Start the API: `pnpm install`, then `pnpm --filter @support/api dev`.
7. Start the dashboard: `pnpm --filter @support/web dev` and open http://localhost:5173.

The app works without a GPU. On an 8 GB machine, small quantized Ollama models may respond slowly; keep the context small. Embeddings use multilingual-e5-small on CPU. For a one-command demo account, set `DEMO_EMAIL` and `DEMO_PASSWORD`; on first API start, that account and a demo workspace are seeded.

## Fine-tuning and evaluation

`services/ml/data/support_sft.jsonl` contains synthetic bilingual support examples. Run `python train_lora.py --input data/support_sft.jsonl` in a free GPU notebook after installing `training-requirements.txt`; the app does not require a fine-tuned adapter. `python evaluate.py` compares the local model's grounded answers against the included synthetic cases. Never put tenant-uploaded/private content in training data.

## Security notes

Workspace-scoped authorization is enforced in API queries. Widget origins are checked against the workspace allowlist, and public endpoints are rate-limited. This is a development MVP: configure HTTPS, strong secrets, durable object storage, backups, and production identity controls before exposing it publicly.
