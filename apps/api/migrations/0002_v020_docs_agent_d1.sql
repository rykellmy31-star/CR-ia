-- CR IA v0.2.0 — busca em documentos + agente desenvolvedor (Cloudflare D1 / SQLite)
-- Aplicar: wrangler d1 execute cr-ia-db --file=migrations/0002_v020_docs_agent_d1.sql

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  embedding TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_user ON document_chunks(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON document_chunks(file_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  work_branch TEXT NOT NULL,
  goal TEXT NOT NULL,
  commands TEXT NOT NULL DEFAULT '[]',
  patch TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','awaiting_approval','done','failed','cancelled')),
  current_phase TEXT NOT NULL DEFAULT 'validate',
  steps TEXT NOT NULL DEFAULT '[]',
  approvals TEXT NOT NULL DEFAULT '{}',
  pr_url TEXT,
  checks TEXT NOT NULL DEFAULT '[]',
  result TEXT,
  error TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_user ON agent_runs(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent_runs(status);
