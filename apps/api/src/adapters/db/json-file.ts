/**
 * Adaptador JSON em arquivo — desenvolvimento local e testes.
 * Zero dependências nativas, API idêntica aos demais adaptadores.
 * NÃO usar em produção multiusuário (sem transações concorrentes).
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

interface JsonDb {
  users: UserRecord[];
  conversations: Conversation[];
  messages: ChatMessage[];
  files: StoredFile[];
  images: GeneratedImage[];
  tasks: AgentTask[];
  usage: (UsageEvent & { id: string })[];
  audit: (AuditLog & { id: string })[];
  settings: Record<string, string>;
  chunks: DocumentChunk[];
  runs: AgentRun[];
  searches: SearchRecord[];
  memory: MemoryItem[];
  codeChunks: CodeChunk[];
}

const EMPTY: JsonDb = {
  users: [],
  conversations: [],
  messages: [],
  files: [],
  images: [],
  tasks: [],
  usage: [],
  audit: [],
  settings: {},
  chunks: [],
  runs: [],
  searches: [],
  memory: [],
  codeChunks: [],
};

export class JsonFileAdapter implements DbAdapter {
  readonly driver = "json" as const;
  private path: string;
  private db: JsonDb = structuredClone(EMPTY);

  constructor(path = "./data/cr-ia.json") {
    this.path = resolve(path);
  }

  async init(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      try {
        const raw = readFileSync(this.path, "utf-8");
        const parsed = JSON.parse(raw) as Partial<JsonDb>;
        this.db = { ...structuredClone(EMPTY), ...parsed };
        return;
      } catch {
        // arquivo corrompido: preserva backup e recomeça vazio
        const bak = `${this.path}.corrompido-${Date.now()}.bak`;
        try { writeFileSync(bak, readFileSync(this.path)); } catch { /* noop */ }
      }
    }
    this.persist();
  }

  async close(): Promise<void> {
    this.persist();
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify(this.db, null, 2), "utf-8");
  }

  /**
   * Recarrega o arquivo antes de ler/escrever — permite API + worker
   * rodando em processos separados (escala dev/teste).
   */
  private sync(): void {
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<JsonDb>;
      this.db = { ...structuredClone(EMPTY), ...parsed };
    } catch {
      /* mantém estado em memória */
    }
  }

  // ---- Usuários ----
  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = nowIso();
    const rec: UserRecord = {
      id: uid("usr"),
      email: input.email.toLowerCase(),
      name: input.name,
      role: input.role,
      blocked: false,
      passwordHash: input.passwordHash,
      resetToken: null,
      resetExpiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.users.push(rec);
    this.persist();
    return rec;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    return this.db.users.find((u) => u.id === id) ?? null;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    return this.db.users.find((u) => u.email === email.toLowerCase()) ?? null;
  }

  async listUsers(): Promise<UserRecord[]> {
    return [...this.db.users].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateUser(id: string, patch: Partial<UserRecord>): Promise<UserRecord | null> {
    const u = await this.getUserById(id);
    if (!u) return null;
    Object.assign(u, patch, { updatedAt: nowIso() });
    this.persist();
    return u;
  }

  async deleteUser(id: string): Promise<boolean> {
    const i = this.db.users.findIndex((u) => u.id === id);
    if (i < 0) return false;
    this.db.users.splice(i, 1);
    this.persist();
    return true;
  }

  // ---- Conversas ----
  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    this.sync();    const now = nowIso();
    const c: Conversation = {
      id: uid("cnv"),
      userId: input.userId,
      title: input.title,
      modelId: input.modelId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.conversations.push(c);
    this.persist();
    return c;
  }

  async listConversations(userId: string, search?: string): Promise<Conversation[]> {
    this.sync();    let list = this.db.conversations.filter((c) => c.userId === userId);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.title.toLowerCase().includes(q));
    }
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getConversation(id: string, userId: string): Promise<Conversation | null> {
    this.sync();    return this.db.conversations.find((c) => c.id === id && c.userId === userId) ?? null;
  }

  async updateConversation(id: string, userId: string, patch: Partial<Conversation>): Promise<Conversation | null> {
    const c = await this.getConversation(id, userId);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: nowIso() });
    this.persist();
    return c;
  }

  async deleteConversation(id: string, userId: string): Promise<boolean> {
    const i = this.db.conversations.findIndex((c) => c.id === id && c.userId === userId);
    if (i < 0) return false;
    this.db.conversations.splice(i, 1);
    this.db.messages = this.db.messages.filter((m) => m.conversationId !== id);
    this.persist();
    return true;
  }

  // ---- Mensagens ----
  async addMessage(input: CreateMessageInput): Promise<ChatMessage> {
    this.sync();    const m: ChatMessage = {
      id: uid("msg"),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      modelId: input.modelId ?? null,
      tokensIn: input.tokensIn ?? 0,
      tokensOut: input.tokensOut ?? 0,
      createdAt: nowIso(),
    };
    this.db.messages.push(m);
    const conv = this.db.conversations.find((c) => c.id === input.conversationId);
    if (conv) conv.updatedAt = m.createdAt;
    this.persist();
    return m;
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    this.sync();    return this.db.messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---- Arquivos ----
  async saveFile(file: StoredFile): Promise<StoredFile> {
    this.sync();    this.db.files.push(file);
    this.persist();
    return file;
  }

  async getFile(id: string, userId?: string): Promise<StoredFile | null> {
    const f = this.db.files.find((x) => x.id === id);
    if (!f) return null;
    if (userId && f.userId !== userId) return null;
    return f;
  }

  async listFiles(userId: string): Promise<StoredFile[]> {
    return this.db.files.filter((f) => f.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteFile(id: string, userId: string): Promise<boolean> {
    const i = this.db.files.findIndex((f) => f.id === id && f.userId === userId);
    if (i < 0) return false;
    this.db.files.splice(i, 1);
    this.persist();
    return true;
  }

  // ---- Imagens ----
  async saveImage(image: GeneratedImage): Promise<GeneratedImage> {
    this.sync();    this.db.images.push(image);
    this.persist();
    return image;
  }

  async listImages(userId: string): Promise<GeneratedImage[]> {
    return this.db.images.filter((x) => x.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getImage(id: string, userId: string): Promise<GeneratedImage | null> {
    return this.db.images.find((x) => x.id === id && x.userId === userId) ?? null;
  }

  async deleteImage(id: string, userId: string): Promise<boolean> {
    const i = this.db.images.findIndex((x) => x.id === id && x.userId === userId);
    if (i < 0) return false;
    this.db.images.splice(i, 1);
    this.persist();
    return true;
  }

  // ---- Tarefas ----
  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    this.sync();    const now = nowIso();
    const t: AgentTask = {
      id: uid("tsk"),
      userId: input.userId,
      type: input.type,
      title: input.title,
      status: "pending",
      payload: input.payload ?? {},
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.tasks.push(t);
    this.persist();
    return t;
  }

  async getTask(id: string, userId?: string): Promise<AgentTask | null> {
    this.sync();    const t = this.db.tasks.find((x) => x.id === id);
    if (!t) return null;
    if (userId && t.userId !== userId) return null;
    return t;
  }

  async listTasks(userId?: string, status?: TaskStatus): Promise<AgentTask[]> {
    this.sync();    let list = [...this.db.tasks];
    if (userId) list = list.filter((t) => t.userId === userId);
    if (status) list = list.filter((t) => t.status === status);
    return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async claimNextTask(now: string): Promise<AgentTask | null> {
    this.sync();    const next = this.db.tasks
      .filter((t) => t.status === "pending" && (!t.runAfter || t.runAfter <= now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!next) return null;
    next.status = "running";
    next.attempts += 1;
    next.updatedAt = nowIso();
    this.persist();
    return { ...next };
  }

  async updateTask(id: string, patch: Partial<AgentTask>): Promise<AgentTask | null> {
    this.sync();    const t = this.db.tasks.find((x) => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: nowIso() });
    this.persist();
    return { ...t };
  }

  // ---- Uso / auditoria / config ----
  async logUsage(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void> {
    this.sync();    this.db.usage.push({ ...event, id: uid("usg"), createdAt: nowIso() });
    this.persist();
  }

  async countUsageSince(userId: string, kind: UsageEvent["kind"], sinceIso: string): Promise<number> {
    return this.db.usage.filter((u) => u.userId === userId && u.kind === kind && u.createdAt >= sinceIso).length;
  }

  async usageSummary(): Promise<{ total: number; byModel: Record<string, number>; byKind: Record<string, number> }> {
    const byModel: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const u of this.db.usage) {
      byModel[u.modelId] = (byModel[u.modelId] ?? 0) + 1;
      byKind[u.kind] = (byKind[u.kind] ?? 0) + 1;
    }
    return { total: this.db.usage.length, byModel, byKind };
  }

  async usageBreakdown(days = 30): Promise<UsageBreakdownRow[]> {
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const emailOf = new Map(this.db.users.map((u) => [u.id, u.email]));
    const groups = new Map<string, UsageBreakdownRow>();
    for (const u of this.db.usage) {
      const day = u.createdAt.slice(0, 10);
      if (day < since) continue;
      const key = `${day}|${u.userId}|${u.modelId}|${u.kind}|${u.costFlag ? 1 : 0}`;
      const g = groups.get(key) ?? {
        day, userId: u.userId, email: emailOf.get(u.userId) ?? u.userId,
        modelId: u.modelId, kind: u.kind, count: 0, tokensIn: 0, tokensOut: 0, costFlag: u.costFlag, costUsd: 0,
      };
      g.count += 1;
      g.tokensIn += u.tokensIn;
      g.tokensOut += u.tokensOut;
      g.costUsd += u.costUsd ?? 0;
      groups.set(key, g);
    }
    return [...groups.values()].sort((a, b) =>
      b.day.localeCompare(a.day) || a.email.localeCompare(b.email) || a.modelId.localeCompare(b.modelId));
  }

  async tableCounts(): Promise<Record<string, number>> {
    return {
      users: this.db.users.length,
      conversations: this.db.conversations.length,
      messages: this.db.messages.length,
      files: this.db.files.length,
      images: this.db.images.length,
      tasks: this.db.tasks.length,
      usage_events: this.db.usage.length,
      audit_log: this.db.audit.length,
      document_chunks: this.db.chunks.length,
      agent_runs: this.db.runs.length,
      searches: this.db.searches.length,
      memory_items: this.db.memory.length,
      code_chunks: this.db.codeChunks.length,
    };
  }

  async dbSizeMB(): Promise<number | null> {
    try {
      const raw = readFileSync(this.path);
      return Math.round((raw.byteLength / 1024 / 1024) * 100) / 100;
    } catch {
      return null;
    }
  }

  // ---- Documentos indexados (v0.2.0) ----
  async saveDocumentChunks(chunks: CreateChunkInput[]): Promise<DocumentChunk[]> {
    this.sync();
    const now = nowIso();
    const saved = chunks.map((c, i) => ({
      ...c, id: uid("chk"), createdAt: now,
      chunkIndex: c.chunkIndex ?? i,
    }));
    this.db.chunks.push(...saved);
    this.persist();
    return saved;
  }

  async listDocumentChunks(userId: string): Promise<DocumentChunk[]> {
    return this.db.chunks.filter((c) => c.userId === userId);
  }

  async deleteDocumentChunks(fileId: string, userId: string): Promise<void> {
    this.sync();
    this.db.chunks = this.db.chunks.filter((c) => !(c.fileId === fileId && c.userId === userId));
    this.persist();
  }

  // ---- Pesquisa web + memória + código (Fase 3) ----
  async saveSearch(input: { userId: string; provider: string; query: string; resultsCount: number }): Promise<SearchRecord> {
    this.sync();
    const rec: SearchRecord = { ...input, id: uid("sea"), createdAt: nowIso() };
    this.db.searches.push(rec);
    this.persist();
    return rec;
  }

  async listSearches(userId: string, limit = 50): Promise<SearchRecord[]> {
    return this.db.searches
      .filter((s) => s.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(200, Math.max(1, limit)));
  }

  async listAllSearches(limit = 100): Promise<(SearchRecord & { email: string })[]> {
    const byId = new Map(this.db.users.map((u) => [u.id, u.email]));
    return [...this.db.searches]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(500, Math.max(1, limit)))
      .map((s) => ({ ...s, email: byId.get(s.userId) ?? "?" }));
  }

  async saveMemoryItem(input: { userId: string; project: string; kind: MemoryItem["kind"]; title: string; content: string }): Promise<MemoryItem> {
    this.sync();
    const rec: MemoryItem = { ...input, id: uid("mem"), createdAt: nowIso() };
    this.db.memory.push(rec);
    this.persist();
    return rec;
  }

  async listMemoryItems(userId: string, project?: string, kind?: MemoryItem["kind"]): Promise<MemoryItem[]> {
    return this.db.memory
      .filter((m) => m.userId === userId && (project === undefined || m.project === project) && (kind === undefined || m.kind === kind))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200);
  }

  async deleteMemoryItem(id: string, userId: string): Promise<boolean> {
    this.sync();
    const before = this.db.memory.length;
    this.db.memory = this.db.memory.filter((m) => !(m.id === id && m.userId === userId));
    this.persist();
    return this.db.memory.length < before;
  }

  async saveCodeChunks(chunks: { userId: string; repo: string; path: string; chunkIndex: number; text: string; embedding: string | null }[]): Promise<CodeChunk[]> {
    this.sync();
    const now = nowIso();
    const saved = chunks.map((c, i) => ({ ...c, chunkIndex: c.chunkIndex ?? i, id: uid("cck"), createdAt: now }));
    this.db.codeChunks.push(...saved);
    this.persist();
    return saved;
  }

  async listCodeChunks(userId: string, repo?: string): Promise<CodeChunk[]> {
    return this.db.codeChunks.filter((c) => c.userId === userId && (repo === undefined || c.repo === repo));
  }

  async deleteCodeChunks(repo: string, userId: string): Promise<void> {
    this.sync();
    this.db.codeChunks = this.db.codeChunks.filter((c) => !(c.repo === repo && c.userId === userId));
    this.persist();
  }

  // ---- Agente desenvolvedor (v0.2.0) ----
  async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
    this.sync();
    const now = nowIso();
    const run: AgentRun = {
      id: uid("run"),
      userId: input.userId,
      repo: input.repo,
      baseBranch: input.baseBranch,
      workBranch: input.workBranch,
      goal: input.goal,
      commands: input.commands ?? [],
      patch: input.patch ?? null,
      status: "pending",
      currentPhase: "validate",
      steps: [],
      approvals: {},
      prUrl: null,
      checks: [],
      result: null,
      error: null,
      taskId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.runs.push(run);
    this.persist();
    return { ...run };
  }

  async getAgentRun(id: string, userId?: string): Promise<AgentRun | null> {
    const r = this.db.runs.find((x) => x.id === id && (!userId || x.userId === userId));
    return r ? structuredClone(r) : null;
  }

  async listAgentRuns(userId?: string): Promise<AgentRun[]> {
    return this.db.runs
      .filter((x) => !userId || x.userId === userId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => structuredClone(r));
  }

  async updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<AgentRun | null> {
    this.sync();
    const r = this.db.runs.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, patch, { updatedAt: nowIso() });
    this.persist();
    return structuredClone(r);
  }

  async logAudit(entry: Omit<AuditLog, "id" | "createdAt">): Promise<void> {
    this.sync();    this.db.audit.push({ ...entry, id: uid("aud"), createdAt: nowIso() });
    this.persist();
  }

  async listAudit(limit = 200): Promise<AuditLog[]> {
    return [...this.db.audit].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async getSetting(key: string): Promise<string | null> {
    return this.db.settings[key] ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.db.settings[key] = value;
    this.persist();
  }

  async deleteSetting(key: string): Promise<void> {
    delete this.db.settings[key];
    this.persist();
  }
}
