/**
 * Adaptador Cloudflare D1 — produção serverless.
 * Recebe o binding D1 via contexto do Workers. Schema em 0001_init_d1.sql.
 */
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
import type { D1DatabaseLike } from "../../types.js";
import type { CreateAgentRunInput, CreateChunkInput, CreateConversationInput, CreateMessageInput, CreateTaskInput, CreateUserInput, DbAdapter, UpdateAgentRunPatch, UserRecord } from "./types.js";

type Row = Record<string, unknown>;
const str = (v: unknown): string => String(v ?? "");
const num = (v: unknown): number => Number(v ?? 0);
const nil = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const obj = (v: unknown): Record<string, unknown> => {
  if (!v) return {};
  if (typeof v === "object") return v as Record<string, unknown>;
  try { return JSON.parse(String(v)); } catch { return {}; }
};

export class D1Adapter implements DbAdapter {
  readonly driver = "d1" as const;
  constructor(private db: D1DatabaseLike) {}

  async init(): Promise<void> {
    await this.db.prepare("SELECT 1").bind().first();
  }
  async close(): Promise<void> { /* sem conexão persistente */ }

  private userFromRow(r: Row): UserRecord {
    return {
      id: str(r.id), email: str(r.email), name: str(r.name),
      role: str(r.role) as UserRecord["role"], blocked: num(r.blocked) === 1,
      passwordHash: str(r.password_hash), resetToken: nil(r.reset_token),
      resetExpiresAt: nil(r.reset_expires_at),
      createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    };
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const id = uid("usr");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO users (id, email, name, role, blocked, password_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, input.email.toLowerCase(), input.name, input.role, 0, input.passwordHash, now, now).run();
    return (await this.getUserById(id))!;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE id=?").bind(id).first<Row>();
    return r ? this.userFromRow(r) : null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.db.prepare("SELECT * FROM users WHERE email=?").bind(email.toLowerCase()).first<Row>();
    return r ? this.userFromRow(r) : null;
  }

  async listUsers(): Promise<UserRecord[]> {
    const { results } = await this.db.prepare("SELECT * FROM users ORDER BY created_at ASC").bind().all<Row>();
    return results.map((r) => this.userFromRow(r));
  }

  async updateUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const sets: string[] = ["updated_at=?"];
    const vals: unknown[] = [nowIso()];
    const map: Record<string, string> = {
      name: "name", role: "role", blocked: "blocked",
      passwordHash: "password_hash", resetToken: "reset_token", resetExpiresAt: "reset_expires_at",
    };
    for (const [k, col] of Object.entries(map)) {
      const v = (patch as Record<string, unknown>)[k];
      if (v !== undefined) {
        vals.push(k === "blocked" ? (v ? 1 : 0) : v);
        sets.push(`${col}=?`);
      }
    }
    vals.push(id);
    await this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
    return this.getUserById(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM users WHERE id=?").bind(id).run();
    return (await this.getUserById(id)) === null;
  }

  private convFromRow(r: Row): Conversation {
    return { id: str(r.id), userId: str(r.user_id), title: str(r.title), modelId: nil(r.model_id), createdAt: str(r.created_at), updatedAt: str(r.updated_at) };
  }

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const id = uid("cnv");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO conversations (id, user_id, title, model_id, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    ).bind(id, input.userId, input.title, input.modelId ?? null, now, now).run();
    return (await this.getConversation(id, input.userId))!;
  }

  async listConversations(userId: string, search?: string): Promise<Conversation[]> {
    const { results } = search
      ? await this.db.prepare("SELECT * FROM conversations WHERE user_id=? AND title LIKE ? ORDER BY updated_at DESC").bind(userId, `%${search}%`).all<Row>()
      : await this.db.prepare("SELECT * FROM conversations WHERE user_id=? ORDER BY updated_at DESC").bind(userId).all<Row>();
    return results.map((r) => this.convFromRow(r));
  }

  async getConversation(id: string, userId: string): Promise<Conversation | null> {
    const r = await this.db.prepare("SELECT * FROM conversations WHERE id=? AND user_id=?").bind(id, userId).first<Row>();
    return r ? this.convFromRow(r) : null;
  }

  async updateConversation(id: string, userId: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    await this.db.prepare(
      "UPDATE conversations SET title=COALESCE(?,title), model_id=COALESCE(?,model_id), updated_at=? WHERE id=? AND user_id=?"
    ).bind(patch.title ?? null, patch.modelId ?? null, nowIso(), id, userId).run();
    return this.getConversation(id, userId);
  }

  async deleteConversation(id: string, userId: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM messages WHERE conversation_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM conversations WHERE id=? AND user_id=?").bind(id, userId).run();
    return (await this.getConversation(id, userId)) === null;
  }

  private msgFromRow(r: Row): ChatMessage {
    return {
      id: str(r.id), conversationId: str(r.conversation_id), role: str(r.role) as ChatMessage["role"],
      content: str(r.content), modelId: nil(r.model_id),
      tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), createdAt: str(r.created_at),
    };
  }

  async addMessage(input: CreateMessageInput): Promise<ChatMessage> {
    const id = uid("msg");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO messages (id, conversation_id, role, content, model_id, tokens_in, tokens_out, created_at) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(id, input.conversationId, input.role, input.content, input.modelId ?? null, input.tokensIn ?? 0, input.tokensOut ?? 0, now).run();
    await this.db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").bind(now, input.conversationId).run();
    const r = await this.db.prepare("SELECT * FROM messages WHERE id=?").bind(id).first<Row>();
    return this.msgFromRow(r!);
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const { results } = await this.db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC").bind(conversationId).all<Row>();
    return results.map((r) => this.msgFromRow(r));
  }

  private fileFromRow(r: Row): StoredFile {
    return { id: str(r.id), userId: str(r.user_id), name: str(r.name), mime: str(r.mime), size: num(r.size), url: str(r.url), createdAt: str(r.created_at) };
  }

  async saveFile(file: StoredFile): Promise<StoredFile> {
    await this.db.prepare("INSERT INTO files (id, user_id, name, mime, size, url, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(file.id, file.userId, file.name, file.mime, file.size, file.url, file.createdAt).run();
    return file;
  }

  async getFile(id: string, userId?: string): Promise<StoredFile | null> {
    const r = userId
      ? await this.db.prepare("SELECT * FROM files WHERE id=? AND user_id=?").bind(id, userId).first<Row>()
      : await this.db.prepare("SELECT * FROM files WHERE id=?").bind(id).first<Row>();
    return r ? this.fileFromRow(r) : null;
  }

  async listFiles(userId: string): Promise<StoredFile[]> {
    const { results } = await this.db.prepare("SELECT * FROM files WHERE user_id=? ORDER BY created_at DESC").bind(userId).all<Row>();
    return results.map((r) => this.fileFromRow(r));
  }

  async deleteFile(id: string, userId: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM files WHERE id=? AND user_id=?").bind(id, userId).run();
    return (await this.getFile(id, userId)) === null;
  }

  private imgFromRow(r: Row): GeneratedImage {
    return {
      id: str(r.id), userId: str(r.user_id), prompt: str(r.prompt),
      negativePrompt: nil(r.negative_prompt) ?? undefined, format: str(r.format) as GeneratedImage["format"],
      modelId: str(r.model_id), fileId: str(r.file_id), url: str(r.url),
      width: num(r.width), height: num(r.height), createdAt: str(r.created_at),
    };
  }

  async saveImage(image: GeneratedImage): Promise<GeneratedImage> {
    await this.db.prepare(
      "INSERT INTO images (id, user_id, prompt, negative_prompt, format, model_id, file_id, url, width, height, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(image.id, image.userId, image.prompt, image.negativePrompt ?? null, image.format, image.modelId, image.fileId, image.url, image.width, image.height, image.createdAt).run();
    return image;
  }

  async listImages(userId: string): Promise<GeneratedImage[]> {
    const { results } = await this.db.prepare("SELECT * FROM images WHERE user_id=? ORDER BY created_at DESC").bind(userId).all<Row>();
    return results.map((r) => this.imgFromRow(r));
  }

  async getImage(id: string, userId: string): Promise<GeneratedImage | null> {
    const r = await this.db.prepare("SELECT * FROM images WHERE id=? AND user_id=?").bind(id, userId).first<Row>();
    return r ? this.imgFromRow(r) : null;
  }

  async deleteImage(id: string, userId: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM images WHERE id=? AND user_id=?").bind(id, userId).run();
    return (await this.getImage(id, userId)) === null;
  }

  private taskFromRow(r: Row): AgentTask {
    return {
      id: str(r.id), userId: str(r.user_id), type: str(r.type) as AgentTask["type"],
      title: str(r.title), status: str(r.status) as TaskStatus,
      payload: obj(r.payload),
      result: r.result ? (obj(r.result)) : null,
      error: nil(r.error), attempts: num(r.attempts), maxAttempts: num(r.max_attempts) || 3,
      runAfter: nil(r.run_after), createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    };
  }

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    const id = uid("tsk");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO tasks (id, user_id, type, title, status, payload, attempts, max_attempts, run_after, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, input.userId, input.type, input.title, "pending", JSON.stringify(input.payload ?? {}), 0, input.maxAttempts ?? 3, input.runAfter ?? null, now, now).run();
    const t = await this.getTask(id);
    return t!;
  }

  async getTask(id: string, userId?: string): Promise<AgentTask | null> {
    const r = userId
      ? await this.db.prepare("SELECT * FROM tasks WHERE id=? AND user_id=?").bind(id, userId).first<Row>()
      : await this.db.prepare("SELECT * FROM tasks WHERE id=?").bind(id).first<Row>();
    return r ? this.taskFromRow(r) : null;
  }

  async listTasks(userId?: string, status?: TaskStatus): Promise<AgentTask[]> {
    let q = "SELECT * FROM tasks";
    const cond: string[] = [];
    const vals: unknown[] = [];
    if (userId) { cond.push("user_id=?"); vals.push(userId); }
    if (status) { cond.push("status=?"); vals.push(status); }
    if (cond.length) q += " WHERE " + cond.join(" AND ");
    q += " ORDER BY updated_at DESC";
    const { results } = await this.db.prepare(q).bind(...vals).all<Row>();
    return results.map((r) => this.taskFromRow(r));
  }

  async claimNextTask(now: string): Promise<AgentTask | null> {
    const r = await this.db.prepare(
      "SELECT * FROM tasks WHERE status='pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY created_at ASC LIMIT 1"
    ).bind(now).first<Row>();
    if (!r) return null;
    await this.updateTask(str(r.id), { status: "running", attempts: num(r.attempts) + 1 });
    return this.taskFromRow({ ...r, status: "running", attempts: num(r.attempts) + 1 });
  }

  async updateTask(id: string, patch: Partial<AgentTask>): Promise<AgentTask | null> {
    const sets = ["updated_at=?"];
    const vals: unknown[] = [nowIso()];
    if (patch.status !== undefined) { sets.push("status=?"); vals.push(patch.status); }
    if (patch.result !== undefined) { sets.push("result=?"); vals.push(JSON.stringify(patch.result)); }
    if (patch.error !== undefined) { sets.push("error=?"); vals.push(patch.error); }
    if (patch.attempts !== undefined) { sets.push("attempts=?"); vals.push(patch.attempts); }
    if (patch.runAfter !== undefined) { sets.push("run_after=?"); vals.push(patch.runAfter); }
    vals.push(id);
    await this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
    return this.getTask(id);
  }

  async logUsage(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void> {
    await this.db.prepare(
      "INSERT INTO usage_events (id, user_id, model_id, kind, tokens_in, tokens_out, cost_flag, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
    ).bind(uid("usg"), event.userId, event.modelId, event.kind, event.tokensIn, event.tokensOut, event.costFlag ? 1 : 0, event.costUsd ?? null, nowIso()).run();
  }

  async countUsageSince(userId: string, kind: UsageEvent["kind"], sinceIso: string): Promise<number> {
    const r = await this.db.prepare(
      "SELECT COUNT(*) AS c FROM usage_events WHERE user_id=? AND kind=? AND created_at >= ?"
    ).bind(userId, kind, sinceIso).first<Row>();
    return num(r?.c);
  }

  async usageSummary(): Promise<{ total: number; byModel: Record<string, number>; byKind: Record<string, number> }> {
    const { results } = await this.db.prepare("SELECT model_id, kind, COUNT(*) AS c FROM usage_events GROUP BY model_id, kind").bind().all<Row>();
    const byModel: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    let total = 0;
    for (const r of results) {
      byModel[str(r.model_id)] = (byModel[str(r.model_id)] ?? 0) + num(r.c);
      byKind[str(r.kind)] = (byKind[str(r.kind)] ?? 0) + num(r.c);
      total += num(r.c);
    }
    return { total, byModel, byKind };
  }

  async usageBreakdown(days = 30): Promise<UsageBreakdownRow[]> {
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const { results } = await this.db.prepare(
      `SELECT substr(u.created_at,1,10) AS day, u.user_id, us.email, u.model_id, u.kind,
              COUNT(*) AS count, COALESCE(SUM(u.tokens_in),0) AS tokens_in,
              COALESCE(SUM(u.tokens_out),0) AS tokens_out, MAX(u.cost_flag) AS cost_flag, COALESCE(SUM(u.cost_usd),0) AS cost_usd
         FROM usage_events u JOIN users us ON us.id = u.user_id
        WHERE u.created_at >= ? GROUP BY 1,2,3,4,5 ORDER BY 1 DESC, 3, 4`
    ).bind(since).all<Row>();
    return results.map((r) => ({
      day: str(r.day), userId: str(r.user_id), email: str(r.email), modelId: str(r.model_id),
      kind: str(r.kind) as UsageBreakdownRow["kind"], count: num(r.count),
      tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out), costFlag: num(r.cost_flag) === 1, costUsd: num(r.cost_usd),
    }));
  }

  async tableCounts(): Promise<Record<string, number>> {
    const tables = ["users", "conversations", "messages", "files", "images", "tasks",
      "usage_events", "audit_log", "settings", "document_chunks", "agent_runs",
      "searches", "memory_items", "code_chunks"];
    const out: Record<string, number> = {};
    for (const t of tables) {
      try {
        const r = await this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).bind().first<Row>();
        out[t] = num(r?.c);
      } catch {
        out[t] = -1;
      }
    }
    return out;
  }

  async dbSizeMB(): Promise<number | null> {
    return null; // D1 não expõe tamanho via SQL — ver dashboard Cloudflare
  }

  // ---- Documentos indexados (v0.2.0) ----
  private chunkFromRow(r: Row): DocumentChunk {
    return {
      id: str(r.id), fileId: str(r.file_id), userId: str(r.user_id), fileName: str(r.file_name),
      chunkIndex: num(r.chunk_index), text: str(r.text), embedding: nil(r.embedding),
      createdAt: str(r.created_at),
    };
  }

  async saveDocumentChunks(chunks: CreateChunkInput[]): Promise<DocumentChunk[]> {
    const now = nowIso();
    const saved: DocumentChunk[] = [];
    for (const [i, c] of chunks.entries()) {
      const id = uid("chk");
      await this.db.prepare(
        "INSERT INTO document_chunks (id, file_id, user_id, file_name, chunk_index, text, embedding, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(id, c.fileId, c.userId, c.fileName, c.chunkIndex ?? i, c.text, c.embedding, now).run();
      saved.push({ ...c, chunkIndex: c.chunkIndex ?? i, id, createdAt: now });
    }
    return saved;
  }

  async listDocumentChunks(userId: string): Promise<DocumentChunk[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM document_chunks WHERE user_id=? ORDER BY file_name, chunk_index"
    ).bind(userId).all<Row>();
    return results.map((r) => this.chunkFromRow(r));
  }

  async deleteDocumentChunks(fileId: string, userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM document_chunks WHERE file_id=? AND user_id=?").bind(fileId, userId).run();
  }

  // ---- Pesquisa web + memória + código (Fase 3) ----
  private searchFromRow(r: Row): SearchRecord {
    return {
      id: str(r.id), userId: str(r.user_id), provider: str(r.provider), query: str(r.query),
      resultsCount: num(r.results_count), createdAt: str(r.created_at),
    };
  }

  private memoryFromRow(r: Row): MemoryItem {
    return {
      id: str(r.id), userId: str(r.user_id), project: str(r.project),
      kind: (r.kind === "fix" || r.kind === "note" ? r.kind : "decision") as MemoryItem["kind"],
      title: str(r.title), content: str(r.content), createdAt: str(r.created_at),
    };
  }

  private codeFromRow(r: Row): CodeChunk {
    return {
      id: str(r.id), userId: str(r.user_id), repo: str(r.repo), path: str(r.path),
      chunkIndex: num(r.chunk_index), text: str(r.text), embedding: nil(r.embedding),
      createdAt: str(r.created_at),
    };
  }

  async saveSearch(input: { userId: string; provider: string; query: string; resultsCount: number }): Promise<SearchRecord> {
    const id = uid("sea");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO searches (id, user_id, provider, query, results_count, created_at) VALUES (?,?,?,?,?,?)"
    ).bind(id, input.userId, input.provider, input.query, input.resultsCount, now).run();
    return { ...input, id, createdAt: now };
  }

  async listSearches(userId: string, limit = 50): Promise<SearchRecord[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM searches WHERE user_id=? ORDER BY created_at DESC LIMIT ?"
    ).bind(userId, Math.min(200, Math.max(1, limit))).all<Row>();
    return results.map((r) => this.searchFromRow(r));
  }

  async listAllSearches(limit = 100): Promise<(SearchRecord & { email: string })[]> {
    const { results } = await this.db.prepare(
      `SELECT s.*, u.email AS email FROM searches s
       LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC LIMIT ?`
    ).bind(Math.min(500, Math.max(1, limit))).all<Row>();
    return results.map((r) => ({ ...this.searchFromRow(r), email: str(r.email) || "?" }));
  }

  async saveMemoryItem(input: { userId: string; project: string; kind: MemoryItem["kind"]; title: string; content: string }): Promise<MemoryItem> {
    const id = uid("mem");
    const now = nowIso();
    await this.db.prepare(
      "INSERT INTO memory_items (id, user_id, project, kind, title, content, created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, input.userId, input.project, input.kind, input.title, input.content, now).run();
    return { ...input, id, createdAt: now };
  }

  async listMemoryItems(userId: string, project?: string, kind?: MemoryItem["kind"]): Promise<MemoryItem[]> {
    let sql = "SELECT * FROM memory_items WHERE user_id=?";
    const params: unknown[] = [userId];
    if (project !== undefined) {
      sql += " AND project=?";
      params.push(project);
    }
    if (kind !== undefined) {
      sql += " AND kind=?";
      params.push(kind);
    }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const { results } = await this.db.prepare(sql).bind(...params).all<Row>();
    return results.map((r) => this.memoryFromRow(r));
  }

  async deleteMemoryItem(id: string, userId: string): Promise<boolean> {
    await this.db.prepare("DELETE FROM memory_items WHERE id=? AND user_id=?").bind(id, userId).run();
    const left = await this.db.prepare("SELECT id FROM memory_items WHERE id=? AND user_id=?").bind(id, userId).first();
    return left === null;
  }

  async saveCodeChunks(chunks: { userId: string; repo: string; path: string; chunkIndex: number; text: string; embedding: string | null }[]): Promise<CodeChunk[]> {
    const now = nowIso();
    const saved: CodeChunk[] = [];
    for (const [i, c] of chunks.entries()) {
      const id = uid("cck");
      await this.db.prepare(
        "INSERT INTO code_chunks (id, user_id, repo, path, chunk_index, text, embedding, created_at) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(id, c.userId, c.repo, c.path, c.chunkIndex ?? i, c.text, c.embedding, now).run();
      saved.push({ ...c, chunkIndex: c.chunkIndex ?? i, id, createdAt: now });
    }
    return saved;
  }

  async listCodeChunks(userId: string, repo?: string): Promise<CodeChunk[]> {
    const { results } = repo
      ? await this.db.prepare(
        "SELECT * FROM code_chunks WHERE user_id=? AND repo=? ORDER BY path, chunk_index"
      ).bind(userId, repo).all<Row>()
      : await this.db.prepare(
        "SELECT * FROM code_chunks WHERE user_id=? ORDER BY repo, path, chunk_index"
      ).bind(userId).all<Row>();
    return results.map((r) => this.codeFromRow(r));
  }

  async deleteCodeChunks(repo: string, userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM code_chunks WHERE repo=? AND user_id=?").bind(repo, userId).run();
  }

  // ---- Agente desenvolvedor (v0.2.0) ----
  private runFromRow(r: Row): AgentRun {
    const arr = <T>(v: unknown): T[] => {
      try { const p = typeof v === "string" ? JSON.parse(v) : v; return Array.isArray(p) ? p : []; }
      catch { return []; }
    };
    return {
      id: str(r.id), userId: str(r.user_id), repo: str(r.repo),
      baseBranch: str(r.base_branch), workBranch: str(r.work_branch), goal: str(r.goal),
      commands: arr<string>(r.commands),
      patch: nil(r.patch),
      status: str(r.status) as AgentRun["status"],
      currentPhase: (str(r.current_phase) || "validate") as AgentRun["currentPhase"],
      steps: arr(r.steps),
      approvals: obj(r.approvals) as AgentRun["approvals"],
      prUrl: nil(r.pr_url),
      checks: arr(r.checks),
      result: nil(r.result),
      error: nil(r.error),
      taskId: nil(r.task_id),
      createdAt: str(r.created_at), updatedAt: str(r.updated_at),
    };
  }

  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    const id = uid("run");
    const now = nowIso();
    await this.db.prepare(
      `INSERT INTO agent_runs (id, user_id, repo, base_branch, work_branch, goal, commands, patch,
        status, current_phase, steps, approvals, checks, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(id, input.userId, input.repo, input.baseBranch, input.workBranch, input.goal,
      JSON.stringify(input.commands ?? []), input.patch ?? null,
      "pending", "validate", "[]", "{}", "[]", now, now).run();
    return (await this.getAgentRun(id))!;
  }

  async getAgentRun(id: string, userId?: string): Promise<AgentRun | null> {
    const r = userId
      ? await this.db.prepare("SELECT * FROM agent_runs WHERE id=? AND user_id=?").bind(id, userId).first<Row>()
      : await this.db.prepare("SELECT * FROM agent_runs WHERE id=?").bind(id).first<Row>();
    return r ? this.runFromRow(r) : null;
  }

  async listAgentRuns(userId?: string): Promise<AgentRun[]> {
    const { results } = userId
      ? await this.db.prepare("SELECT * FROM agent_runs WHERE user_id=? ORDER BY updated_at DESC").bind(userId).all<Row>()
      : await this.db.prepare("SELECT * FROM agent_runs ORDER BY updated_at DESC").bind().all<Row>();
    return results.map((r) => this.runFromRow(r));
  }

  async updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<AgentRun | null> {
    const sets = ["updated_at=?"];
    const vals: unknown[] = [nowIso()];
    if (patch.status !== undefined) { sets.push("status=?"); vals.push(patch.status); }
    if (patch.currentPhase !== undefined) { sets.push("current_phase=?"); vals.push(patch.currentPhase); }
    if (patch.steps !== undefined) { sets.push("steps=?"); vals.push(JSON.stringify(patch.steps)); }
    if (patch.approvals !== undefined) { sets.push("approvals=?"); vals.push(JSON.stringify(patch.approvals)); }
    if (patch.prUrl !== undefined) { sets.push("pr_url=?"); vals.push(patch.prUrl); }
    if (patch.checks !== undefined) { sets.push("checks=?"); vals.push(JSON.stringify(patch.checks)); }
    if (patch.result !== undefined) { sets.push("result=?"); vals.push(patch.result); }
    if (patch.error !== undefined) { sets.push("error=?"); vals.push(patch.error); }
    if (patch.taskId !== undefined) { sets.push("task_id=?"); vals.push(patch.taskId); }
    vals.push(id);
    await this.db.prepare(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id=?`).bind(...vals).run();
    return this.getAgentRun(id);
  }

  async logAudit(entry: Omit<AuditLog, "id" | "createdAt">): Promise<void> {
    await this.db.prepare("INSERT INTO audit_log (id, user_id, action, detail, created_at) VALUES (?,?,?,?,?)")
      .bind(uid("aud"), entry.userId, entry.action, entry.detail, nowIso()).run();
  }

  async listAudit(limit = 200): Promise<AuditLog[]> {
    const { results } = await this.db.prepare("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?").bind(limit).all<Row>();
    return results.map((r) => ({ id: str(r.id), userId: nil(r.user_id), action: str(r.action), detail: str(r.detail), createdAt: str(r.created_at) }));
  }

  async getSetting(key: string): Promise<string | null> {
    const r = await this.db.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<Row>();
    return r ? str(r.value) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(key, value).run();
  }

  async deleteSetting(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM settings WHERE key=?").bind(key).run();
  }
}
