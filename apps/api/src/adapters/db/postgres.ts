/**
 * Adaptador PostgreSQL — produção na VPS (Hostinger via Docker Compose).
 * Usa `pg` com pool. Schema em migrations/0001_init_postgres.sql.
 */
import { Pool } from "pg";
import type {
  AgentRun,
  AgentTask,
  AuditLog,
  ChatMessage,
  CodeChunk,
  Conversation,
  DocumentChunk,
  GeneratedImage,
  MemoryItem,
  SearchRecord,
  StoredFile,
  TaskStatus,
  UsageBreakdownRow,
  UsageEvent,
} from "@cr-ia/shared";
import { nowIso, uid } from "../../lib/ids.js";
import type { CreateAgentRunInput, CreateChunkInput, CreateConversationInput, CreateMessageInput, CreateTaskInput, CreateUserInput, DbAdapter, UpdateAgentRunPatch, UserRecord } from "./types.js";

function taskFromRow(r: Record<string, unknown>): AgentTask {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    type: r.type as AgentTask["type"],
    title: r.title as string,
    status: r.status as TaskStatus,
    payload: (r.payload as Record<string, unknown>) ?? {},
    result: (r.result as Record<string, unknown> | null) ?? null,
    error: (r.error as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    maxAttempts: Number(r.max_attempts ?? 3),
    runAfter: (r.run_after as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  };
}

export class PostgresAdapter implements DbAdapter {
  readonly driver = "postgres" as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const id = uid("usr");
    const { rows } = await this.pool.query(
      `INSERT INTO users (id, email, name, role, password_hash)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, input.email.toLowerCase(), input.name, input.role, input.passwordHash]
    );
    return this.userFromRow(rows[0]);
  }

  private userFromRow(r: Record<string, unknown>): UserRecord {
    return {
      id: r.id as string,
      email: r.email as string,
      name: r.name as string,
      role: r.role as UserRecord["role"],
      blocked: Boolean(r.blocked),
      passwordHash: r.password_hash as string,
      resetToken: (r.reset_token as string | null) ?? null,
      resetExpiresAt: (r.reset_expires_at as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return rows[0] ? this.userFromRow(rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
    return rows[0] ? this.userFromRow(rows[0]) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { rows } = await this.pool.query("SELECT * FROM users ORDER BY created_at ASC");
    return rows.map((r) => this.userFromRow(r));
  }

  async updateUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const sets: string[] = ["updated_at=NOW()"];
    const vals: unknown[] = [];
    const map: Record<string, string> = {
      name: "name", role: "role", blocked: "blocked",
      passwordHash: "password_hash", resetToken: "reset_token", resetExpiresAt: "reset_expires_at",
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) {
        vals.push(v);
        sets.push(`${col}=$${vals.length}`);
      }
    }
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE users SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`, vals
    );
    return rows[0] ? this.userFromRow(rows[0]) : null;
  }

  async deleteUser(id: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM users WHERE id=$1", [id]);
    return (r.rowCount ?? 0) > 0;
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const id = uid("cnv");
    const { rows } = await this.pool.query(
      "INSERT INTO conversations (id, user_id, title, model_id) VALUES ($1,$2,$3,$4) RETURNING *",
      [id, input.userId, input.title, input.modelId ?? null]
    );
    return this.convFromRow(rows[0]);
  }

  private convFromRow(r: Record<string, unknown>): Conversation {
    return {
      id: r.id as string,
      userId: r.user_id as string,
      title: r.title as string,
      modelId: (r.model_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  async listConversations(userId: string, search?: string): Promise<Conversation[]> {
    const { rows } = search
      ? await this.pool.query(
          "SELECT * FROM conversations WHERE user_id=$1 AND title ILIKE $2 ORDER BY updated_at DESC",
          [userId, `%${search}%`]
        )
      : await this.pool.query("SELECT * FROM conversations WHERE user_id=$1 ORDER BY updated_at DESC", [userId]);
    return rows.map((r) => this.convFromRow(r));
  }

  async getConversation(id: string, userId: string): Promise<Conversation | null> {
    const { rows } = await this.pool.query("SELECT * FROM conversations WHERE id=$1 AND user_id=$2", [id, userId]);
    return rows[0] ? this.convFromRow(rows[0]) : null;
  }

  async updateConversation(id: string, userId: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const { rows } = await this.pool.query(
      "UPDATE conversations SET title=COALESCE($3,title), model_id=COALESCE($4,model_id), updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *",
      [id, userId, patch.title ?? null, patch.modelId ?? null]
    );
    return rows[0] ? this.convFromRow(rows[0]) : null;
  }

  async deleteConversation(id: string, userId: string): Promise<boolean> {
    await this.pool.query("DELETE FROM messages WHERE conversation_id=$1", [id]);
    const r = await this.pool.query("DELETE FROM conversations WHERE id=$1 AND user_id=$2", [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async addMessage(input: CreateMessageInput): Promise<ChatMessage> {
    const id = uid("msg");
    const { rows } = await this.pool.query(
      `INSERT INTO messages (id, conversation_id, role, content, model_id, tokens_in, tokens_out)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, input.conversationId, input.role, input.content, input.modelId ?? null, input.tokensIn ?? 0, input.tokensOut ?? 0]
    );
    await this.pool.query("UPDATE conversations SET updated_at=NOW() WHERE id=$1", [input.conversationId]);
    const r = rows[0];
    return {
      id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content,
      modelId: r.model_id ?? null, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC", [conversationId]
    );
    return rows.map((r) => ({
      id: r.id, conversationId: r.conversation_id, role: r.role, content: r.content,
      modelId: r.model_id ?? null, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async saveFile(file: StoredFile): Promise<StoredFile> {
    await this.pool.query(
      "INSERT INTO files (id, user_id, name, mime, size, url) VALUES ($1,$2,$3,$4,$5,$6)",
      [file.id, file.userId, file.name, file.mime, file.size, file.url]
    );
    return file;
  }

  async getFile(id: string, userId?: string): Promise<StoredFile | null> {
    const { rows } = userId
      ? await this.pool.query("SELECT * FROM files WHERE id=$1 AND user_id=$2", [id, userId])
      : await this.pool.query("SELECT * FROM files WHERE id=$1", [id]);
    if (!rows[0]) return null;
    const r = rows[0];
    return { id: r.id, userId: r.user_id, name: r.name, mime: r.mime, size: Number(r.size), url: r.url, createdAt: new Date(r.created_at).toISOString() };
  }

  async listFiles(userId: string): Promise<StoredFile[]> {
    const { rows } = await this.pool.query("SELECT * FROM files WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    return rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.name, mime: r.mime, size: Number(r.size), url: r.url, createdAt: new Date(r.created_at).toISOString() }));
  }

  async deleteFile(id: string, userId: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM files WHERE id=$1 AND user_id=$2", [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async saveImage(image: GeneratedImage): Promise<GeneratedImage> {
    await this.pool.query(
      `INSERT INTO images (id, user_id, prompt, negative_prompt, format, model_id, file_id, url, width, height)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [image.id, image.userId, image.prompt, image.negativePrompt ?? null, image.format, image.modelId, image.fileId, image.url, image.width, image.height]
    );
    return image;
  }

  async listImages(userId: string): Promise<GeneratedImage[]> {
    const { rows } = await this.pool.query("SELECT * FROM images WHERE user_id=$1 ORDER BY created_at DESC", [userId]);
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, prompt: r.prompt, negativePrompt: r.negative_prompt ?? undefined,
      format: r.format, modelId: r.model_id, fileId: r.file_id, url: r.url,
      width: Number(r.width), height: Number(r.height), createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async getImage(id: string, userId: string): Promise<GeneratedImage | null> {
    const all = await this.listImages(userId);
    return all.find((x) => x.id === id) ?? null;
  }

  async deleteImage(id: string, userId: string): Promise<boolean> {
    const r = await this.pool.query("DELETE FROM images WHERE id=$1 AND user_id=$2", [id, userId]);
    return (r.rowCount ?? 0) > 0;
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const id = uid("tsk");
    const { rows } = await this.pool.query(
      `INSERT INTO tasks (id, user_id, type, title, payload, run_after, max_attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, input.userId, input.type, input.title, JSON.stringify(input.payload ?? {}), input.runAfter ?? null, input.maxAttempts ?? 3]
    );
    return taskFromRow(rows[0]);
  }

  async getTask(id: string, userId?: string): Promise<AgentTask | null> {
    const { rows } = userId
      ? await this.pool.query("SELECT * FROM tasks WHERE id=$1 AND user_id=$2", [id, userId])
      : await this.pool.query("SELECT * FROM tasks WHERE id=$1", [id]);
    return rows[0] ? taskFromRow(rows[0]) : null;
  }

  async listTasks(userId?: string, status?: TaskStatus): Promise<AgentTask[]> {
    let q = "SELECT * FROM tasks";
    const cond: string[] = [];
    const vals: unknown[] = [];
    if (userId) { vals.push(userId); cond.push(`user_id=$${vals.length}`); }
    if (status) { vals.push(status); cond.push(`status=$${vals.length}`); }
    if (cond.length) q += " WHERE " + cond.join(" AND ");
    q += " ORDER BY updated_at DESC";
    const { rows } = await this.pool.query(q, vals);
    return rows.map(taskFromRow);
  }

  async claimNextTask(now: string): Promise<AgentTask | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT * FROM tasks WHERE status='pending' AND (run_after IS NULL OR run_after <= $1)
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [now]
      );
      if (!rows[0]) { await client.query("ROLLBACK"); return null; }
      const upd = await client.query(
        "UPDATE tasks SET status='running', attempts=attempts+1, updated_at=NOW() WHERE id=$1 RETURNING *",
        [rows[0].id]
      );
      await client.query("COMMIT");
      return taskFromRow(upd.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async updateTask(id: string, patch: Partial<AgentTask>): Promise<AgentTask | null> {
    const sets = ["updated_at=NOW()"];
    const vals: unknown[] = [];
    if (patch.status !== undefined) { vals.push(patch.status); sets.push(`status=$${vals.length}`); }
    if (patch.result !== undefined) { vals.push(JSON.stringify(patch.result)); sets.push(`result=$${vals.length}`); }
    if (patch.error !== undefined) { vals.push(patch.error); sets.push(`error=$${vals.length}`); }
    if (patch.attempts !== undefined) { vals.push(patch.attempts); sets.push(`attempts=$${vals.length}`); }
    if (patch.runAfter !== undefined) { vals.push(patch.runAfter); sets.push(`run_after=$${vals.length}`); }
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`, vals
    );
    return rows[0] ? taskFromRow(rows[0]) : null;
  }

  async logUsage(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void> {
    await this.pool.query(
      "INSERT INTO usage_events (id, user_id, model_id, kind, tokens_in, tokens_out, cost_flag, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [uid("usg"), event.userId, event.modelId, event.kind, event.tokensIn, event.tokensOut, event.costFlag, event.costUsd ?? null]
    );
  }

  async countUsageSince(userId: string, kind: UsageEvent["kind"], sinceIso: string): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*)::int AS c FROM usage_events WHERE user_id=$1 AND kind=$2 AND created_at >= $3",
      [userId, kind, sinceIso]
    );
    return rows[0]?.c ?? 0;
  }

  async usageSummary(): Promise<{ total: number; byModel: Record<string, number>; byKind: Record<string, number> }> {
    const { rows } = await this.pool.query("SELECT model_id, kind, COUNT(*)::int AS c FROM usage_events GROUP BY model_id, kind");
    const byModel: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byModel[r.model_id] = (byModel[r.model_id] ?? 0) + r.c;
      byKind[r.kind] = (byKind[r.kind] ?? 0) + r.c;
      total += r.c;
    }
    return { total, byModel, byKind };
  }

  async usageBreakdown(days = 30): Promise<UsageBreakdownRow[]> {
    const { rows } = await this.pool.query(
      `SELECT to_char(u.created_at, 'YYYY-MM-DD') AS day, u.user_id, us.email,
              u.model_id, u.kind, COUNT(*)::int AS count,
              COALESCE(SUM(u.tokens_in),0)::int AS tokens_in,
              COALESCE(SUM(u.tokens_out),0)::int AS tokens_out,
              BOOL_OR(u.cost_flag) AS cost_flag,
              COALESCE(SUM(u.cost_usd),0)::float AS cost_usd
         FROM usage_events u JOIN users us ON us.id = u.user_id
        WHERE u.created_at >= NOW() - ($1 || ' days')::interval
        GROUP BY 1,2,3,4,5 ORDER BY 1 DESC, 3, 4`,
      [String(days)]
    );
    return rows.map((r) => ({
      day: r.day, userId: r.user_id, email: r.email, modelId: r.model_id,
      kind: r.kind, count: r.count, tokensIn: r.tokens_in, tokensOut: r.tokens_out,
      costFlag: Boolean(r.cost_flag), costUsd: Number(r.cost_usd ?? 0),
    }));
  }

  async tableCounts(): Promise<Record<string, number>> {
    const tables = ["users", "conversations", "messages", "files", "images", "tasks",
      "usage_events", "audit_log", "settings", "document_chunks", "agent_runs",
      "searches", "memory_items", "code_chunks"];
    const out: Record<string, number> = {};
    for (const t of tables) {
      try {
        const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
        out[t] = rows[0]?.c ?? 0;
      } catch {
        out[t] = -1; // tabela ausente (migration pendente) — sinalizado, não escondido
      }
    }
    return out;
  }

  async dbSizeMB(): Promise<number | null> {
    try {
      const { rows } = await this.pool.query("SELECT pg_database_size(current_database())::bigint AS b");
      const bytes = Number(rows[0]?.b ?? 0);
      return Math.round((bytes / 1024 / 1024) * 100) / 100;
    } catch {
      return null;
    }
  }

  // ---- Documentos indexados (v0.2.0) ----
  async saveDocumentChunks(chunks: CreateChunkInput[]): Promise<DocumentChunk[]> {
    const saved: DocumentChunk[] = [];
    for (const [i, c] of chunks.entries()) {
      const id = uid("chk");
      const { rows } = await this.pool.query(
        `INSERT INTO document_chunks (id, file_id, user_id, file_name, chunk_index, text, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, created_at`,
        [id, c.fileId, c.userId, c.fileName, c.chunkIndex ?? i, c.text, c.embedding]
      );
      const r = rows[0];
      saved.push({
        id: r.id, fileId: r.file_id, userId: r.user_id, fileName: r.file_name,
        chunkIndex: Number(r.chunk_index), text: r.text, embedding: r.embedding ?? null,
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    return saved;
  }

  async listDocumentChunks(userId: string): Promise<DocumentChunk[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM document_chunks WHERE user_id=$1 ORDER BY file_name, chunk_index",
      [userId]
    );
    return rows.map((r) => ({
      id: r.id, fileId: r.file_id, userId: r.user_id, fileName: r.file_name,
      chunkIndex: Number(r.chunk_index), text: r.text, embedding: r.embedding ?? null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async deleteDocumentChunks(fileId: string, userId: string): Promise<void> {
    await this.pool.query("DELETE FROM document_chunks WHERE file_id=$1 AND user_id=$2", [fileId, userId]);
  }

  // ---- Pesquisa web + memória + código (Fase 3) ----
  async saveSearch(input: { userId: string; provider: string; query: string; resultsCount: number }): Promise<SearchRecord> {
    const id = uid("sea");
    const { rows } = await this.pool.query(
      "INSERT INTO searches (id, user_id, provider, query, results_count) VALUES ($1,$2,$3,$4,$5) RETURNING *, created_at",
      [id, input.userId, input.provider, input.query, input.resultsCount]
    );
    const r = rows[0];
    return {
      id: r.id, userId: r.user_id, provider: r.provider, query: r.query,
      resultsCount: Number(r.results_count), createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async listSearches(userId: string, limit = 50): Promise<SearchRecord[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM searches WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2",
      [userId, Math.min(200, Math.max(1, limit))]
    );
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, provider: r.provider, query: r.query,
      resultsCount: Number(r.results_count), createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async listAllSearches(limit = 100): Promise<(SearchRecord & { email: string })[]> {
    const { rows } = await this.pool.query(
      `SELECT s.*, u.email AS email FROM searches s
       LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC LIMIT $1`,
      [Math.min(500, Math.max(1, limit))]
    );
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, provider: r.provider, query: r.query,
      resultsCount: Number(r.results_count), createdAt: new Date(r.created_at).toISOString(),
      email: String(r.email ?? "?"),
    }));
  }

  async saveMemoryItem(input: { userId: string; project: string; kind: MemoryItem["kind"]; title: string; content: string }): Promise<MemoryItem> {
    const id = uid("mem");
    const { rows } = await this.pool.query(
      "INSERT INTO memory_items (id, user_id, project, kind, title, content) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *, created_at",
      [id, input.userId, input.project, input.kind, input.title, input.content]
    );
    const r = rows[0];
    return {
      id: r.id, userId: r.user_id, project: r.project, kind: r.kind,
      title: r.title, content: r.content, createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async listMemoryItems(userId: string, project?: string, kind?: MemoryItem["kind"]): Promise<MemoryItem[]> {
    const conds = ["user_id=$1"];
    const params: unknown[] = [userId];
    if (project !== undefined) {
      params.push(project);
      conds.push(`project=$${params.length}`);
    }
    if (kind !== undefined) {
      params.push(kind);
      conds.push(`kind=$${params.length}`);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM memory_items WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, params
    );
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, project: r.project, kind: r.kind,
      title: r.title, content: r.content, createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async deleteMemoryItem(id: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM memory_items WHERE id=$1 AND user_id=$2", [id, userId]);
    return (rowCount ?? 0) > 0;
  }

  async saveCodeChunks(chunks: { userId: string; repo: string; path: string; chunkIndex: number; text: string; embedding: string | null }[]): Promise<CodeChunk[]> {
    const saved: CodeChunk[] = [];
    for (const [i, c] of chunks.entries()) {
      const id = uid("cck");
      const { rows } = await this.pool.query(
        `INSERT INTO code_chunks (id, user_id, repo, path, chunk_index, text, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, created_at`,
        [id, c.userId, c.repo, c.path, c.chunkIndex ?? i, c.text, c.embedding]
      );
      const r = rows[0];
      saved.push({
        id: r.id, userId: r.user_id, repo: r.repo, path: r.path,
        chunkIndex: Number(r.chunk_index), text: r.text, embedding: r.embedding ?? null,
        createdAt: new Date(r.created_at).toISOString(),
      });
    }
    return saved;
  }

  async listCodeChunks(userId: string, repo?: string): Promise<CodeChunk[]> {
    const { rows } = repo
      ? await this.pool.query(
        "SELECT * FROM code_chunks WHERE user_id=$1 AND repo=$2 ORDER BY path, chunk_index",
        [userId, repo]
      )
      : await this.pool.query(
        "SELECT * FROM code_chunks WHERE user_id=$1 ORDER BY repo, path, chunk_index",
        [userId]
      );
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, repo: r.repo, path: r.path,
      chunkIndex: Number(r.chunk_index), text: r.text, embedding: r.embedding ?? null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async deleteCodeChunks(repo: string, userId: string): Promise<void> {
    await this.pool.query("DELETE FROM code_chunks WHERE repo=$1 AND user_id=$2", [repo, userId]);
  }

  // ---- Agente desenvolvedor (v0.2.0) ----
  private runFromRow(r: Record<string, unknown>): AgentRun {
    const j = <T>(v: unknown, fb: T): T => {
      if (typeof v === "string") {
        try { return JSON.parse(v) as T; } catch { return fb; }
      }
      return (v as T) ?? fb;
    };
    return {
      id: r.id as string,
      userId: r.user_id as string,
      repo: r.repo as string,
      baseBranch: r.base_branch as string,
      workBranch: r.work_branch as string,
      goal: r.goal as string,
      commands: j<string[]>(r.commands, []),
      patch: (r.patch as string | null) ?? null,
      status: r.status as AgentRun["status"],
      currentPhase: (r.current_phase as AgentRun["currentPhase"]) ?? "validate",
      steps: j(r.steps, []),
      approvals: j(r.approvals, {}),
      prUrl: (r.pr_url as string | null) ?? null,
      checks: j(r.checks, []),
      result: (r.result as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      taskId: (r.task_id as string | null) ?? null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const id = uid("run");
    const { rows } = await this.pool.query(
      `INSERT INTO agent_runs (id, user_id, repo, base_branch, work_branch, goal, commands, patch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, input.userId, input.repo, input.baseBranch, input.workBranch, input.goal,
        JSON.stringify(input.commands ?? []), input.patch ?? null]
    );
    return this.runFromRow(rows[0]);
  }

  async getAgentRun(id: string, userId?: string): Promise<AgentRun | null> {
    const { rows } = userId
      ? await this.pool.query("SELECT * FROM agent_runs WHERE id=$1 AND user_id=$2", [id, userId])
      : await this.pool.query("SELECT * FROM agent_runs WHERE id=$1", [id]);
    return rows[0] ? this.runFromRow(rows[0]) : null;
  }

  async listAgentRuns(userId?: string): Promise<AgentRun[]> {
    const { rows } = userId
      ? await this.pool.query("SELECT * FROM agent_runs WHERE user_id=$1 ORDER BY updated_at DESC", [userId])
      : await this.pool.query("SELECT * FROM agent_runs ORDER BY updated_at DESC");
    return rows.map((r) => this.runFromRow(r));
  }

  async updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<AgentRun | null> {
    const sets = ["updated_at=NOW()"];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown, json = false) => {
      vals.push(json ? JSON.stringify(v) : v);
      sets.push(`${col}=$${vals.length}`);
    };
    if (patch.status !== undefined) set("status", patch.status);
    if (patch.currentPhase !== undefined) set("current_phase", patch.currentPhase);
    if (patch.steps !== undefined) set("steps", patch.steps, true);
    if (patch.approvals !== undefined) set("approvals", patch.approvals, true);
    if (patch.prUrl !== undefined) set("pr_url", patch.prUrl);
    if (patch.checks !== undefined) set("checks", patch.checks, true);
    if (patch.result !== undefined) set("result", patch.result);
    if (patch.error !== undefined) set("error", patch.error);
    if (patch.taskId !== undefined) set("task_id", patch.taskId);
    vals.push(id);
    const { rows } = await this.pool.query(
      `UPDATE agent_runs SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`, vals
    );
    return rows[0] ? this.runFromRow(rows[0]) : null;
  }

  async logAudit(entry: Omit<AuditLog, "id" | "createdAt">): Promise<void> {
    await this.pool.query("INSERT INTO audit_log (id, user_id, action, detail) VALUES ($1,$2,$3,$4)",
      [uid("aud"), entry.userId, entry.action, entry.detail]);
  }

  async listAudit(limit = 200): Promise<AuditLog[]> {
    const { rows } = await this.pool.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1", [limit]);
    return rows.map((r) => ({
      id: r.id, userId: r.user_id, action: r.action, detail: r.detail,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  async getSetting(key: string): Promise<string | null> {
    const { rows } = await this.pool.query("SELECT value FROM settings WHERE key=$1", [key]);
    return rows[0]?.value ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2",
      [key, value]
    );
  }

  async deleteSetting(key: string): Promise<void> {
    await this.pool.query("DELETE FROM settings WHERE key=$1", [key]);
  }

  /** Aplica o schema inicial (idempotente). */
  static async applySchema(pool: Pool, sql: string): Promise<void> {
    await pool.query(sql);
    void nowIso;
  }
}
