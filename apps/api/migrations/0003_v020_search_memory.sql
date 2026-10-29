-- CR IA v0.2.0 Fase 3 — histórico de pesquisas + memória + índice de código (PostgreSQL)
-- Aplicar: npm run migrate -w apps/api

CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  query TEXT NOT NULL,
  results_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_searches_user ON searches(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('decision','fix','note')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_items(user_id, project);

CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  embedding TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_user_repo ON code_chunks(user_id, repo);
