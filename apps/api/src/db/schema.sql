CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE DEFAULT ('w_' || encode(gen_random_bytes(18), 'hex')),
  brand_color TEXT NOT NULL DEFAULT '#5b5bd6', welcome_message TEXT NOT NULL DEFAULT 'Hi! How can we help?',
  allowed_domains TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','agent')),
  PRIMARY KEY (workspace_id,user_id)
);
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('file','url','faq')),
  original_name TEXT, url TEXT, storage_path TEXT, status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','ready','error')),
  error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE, chunk_index INT NOT NULL,
  content TEXT NOT NULL, page INT, embedding VECTOR(384) NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX IF NOT EXISTS source_chunks_workspace_idx ON source_chunks(workspace_id,source_id);
CREATE INDEX IF NOT EXISTS source_chunks_embedding_idx ON source_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS source_chunks_search_idx ON source_chunks USING gin(search_vector);
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL, customer_name TEXT, customer_email TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','escalated','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_workspace_idx ON conversations(workspace_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('customer','assistant','agent','system')),
  content TEXT NOT NULL, language TEXT, citations JSONB NOT NULL DEFAULT '[]', handoff BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE, helpful BOOLEAN NOT NULL,
  comment TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(message_id)
);
