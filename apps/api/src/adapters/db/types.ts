/**
 * CR IA — adaptador de banco de dados.
 * Implementações: JSON local (dev/testes), PostgreSQL (VPS), D1 (Cloudflare).
 * A lógica de negócio usa SOMENTE esta interface.
 */
import type {
  AgentPhase,
  AgentRun,
  AgentRunStatus,
  AgentStep,
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
  User,
} from "@cr-ia/shared";

export interface UserRecord extends User {
  passwordHash: string;
  resetToken: string | null;
  resetExpiresAt: string | null;
}

export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash: string;
  role: User["role"];
}

export interface CreateConversationInput {
  userId: string;
  title: string;
  modelId?: string | null;
}

export interface CreateMessageInput {
  conversationId: string;
  role: ChatMessage["role"];
  content: string;
  modelId?: string | null;
  tokensIn?: number;
  tokensOut?: number;
}

export interface CreateTaskInput {
  userId: string;
  type: AgentTask["type"];
  title: string;
  payload?: Record<string, unknown>;
  runAfter?: string | null;
  maxAttempts?: number;
}

export interface CreateChunkInput {
  fileId: string;
  userId: string;
  fileName: string;
  chunkIndex: number;
  text: string;
  embedding: string | null;
}

export interface CreateAgentRunInput {
  userId: string;
  repo: string;
  baseBranch: string;
  workBranch: string;
  goal: string;
  commands?: string[];
  patch?: string | null;
}

export interface UpdateAgentRunPatch {
  status?: AgentRunStatus;
  currentPhase?: AgentPhase;
  steps?: AgentStep[];
  approvals?: AgentRun["approvals"];
  prUrl?: string | null;
  checks?: AgentRun["checks"];
  result?: string | null;
  error?: string | null;
  taskId?: string | null;
}

export interface DbAdapter {
  readonly driver: "json" | "postgres" | "d1";
  init(): Promise<void>;
  close(): Promise<void>;

  // Usuários
  createUser(input: CreateUserInput): Promise<UserRecord>;
  getUserById(id: string): Promise<UserRecord | null>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  listUsers(): Promise<UserRecord[]>;
  updateUser(id: string, patch: Partial<Pick<UserRecord, "name" | "role" | "blocked" | "passwordHash" | "resetToken" | "resetExpiresAt">>): Promise<UserRecord | null>;
  deleteUser(id: string): Promise<boolean>;

  // Conversas
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  listConversations(userId: string, search?: string): Promise<Conversation[]>;
  getConversation(id: string, userId: string): Promise<Conversation | null>;
  updateConversation(id: string, userId: string, patch: Partial<Pick<Conversation, "title" | "modelId">>): Promise<Conversation | null>;
  deleteConversation(id: string, userId: string): Promise<boolean>;

  // Mensagens
  addMessage(input: CreateMessageInput): Promise<ChatMessage>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;

  // Arquivos
  saveFile(file: StoredFile): Promise<StoredFile>;
  getFile(id: string, userId?: string): Promise<StoredFile | null>;
  listFiles(userId: string): Promise<StoredFile[]>;
  deleteFile(id: string, userId: string): Promise<boolean>;

  // Imagens geradas
  saveImage(image: GeneratedImage): Promise<GeneratedImage>;
  listImages(userId: string): Promise<GeneratedImage[]>;
  getImage(id: string, userId: string): Promise<GeneratedImage | null>;
  deleteImage(id: string, userId: string): Promise<boolean>;

  // Tarefas
  createTask(input: CreateTaskInput): Promise<AgentTask>;
  getTask(id: string, userId?: string): Promise<AgentTask | null>;
  listTasks(userId?: string, status?: TaskStatus): Promise<AgentTask[]>;
  claimNextTask(nowIso: string): Promise<AgentTask | null>;
  updateTask(id: string, patch: Partial<Pick<AgentTask, "status" | "result" | "error" | "attempts" | "runAfter">>): Promise<AgentTask | null>;

  // Documentos indexados (busca por palavra-chave + semântica) — v0.2.0
  saveDocumentChunks(chunks: CreateChunkInput[]): Promise<DocumentChunk[]>;
  listDocumentChunks(userId: string): Promise<DocumentChunk[]>;
  deleteDocumentChunks(fileId: string, userId: string): Promise<void>;

  // Pesquisa web + memória + código (Fase 3)
  saveSearch(input: { userId: string; provider: string; query: string; resultsCount: number }): Promise<SearchRecord>;
  listSearches(userId: string, limit?: number): Promise<SearchRecord[]>;
  listAllSearches(limit?: number): Promise<(SearchRecord & { email: string })[]>;
  saveMemoryItem(input: { userId: string; project: string; kind: MemoryItem["kind"]; title: string; content: string }): Promise<MemoryItem>;
  listMemoryItems(userId: string, project?: string, kind?: MemoryItem["kind"]): Promise<MemoryItem[]>;
  deleteMemoryItem(id: string, userId: string): Promise<boolean>;
  saveCodeChunks(chunks: { userId: string; repo: string; path: string; chunkIndex: number; text: string; embedding: string | null }[]): Promise<CodeChunk[]>;
  listCodeChunks(userId: string, repo?: string): Promise<CodeChunk[]>;
  deleteCodeChunks(repo: string, userId: string): Promise<void>;

  // Agente desenvolvedor (estado persistente) — v0.2.0
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRun>;
  getAgentRun(id: string, userId?: string): Promise<AgentRun | null>;
  listAgentRuns(userId?: string): Promise<AgentRun[]>;
  updateAgentRun(id: string, patch: UpdateAgentRunPatch): Promise<AgentRun | null>;

  // Uso / auditoria / config
  logUsage(event: Omit<UsageEvent, "id" | "createdAt">): Promise<void>;
  countUsageSince(userId: string, kind: UsageEvent["kind"], sinceIso: string): Promise<number>;
  usageSummary(): Promise<{ total: number; byModel: Record<string, number>; byKind: Record<string, number> }>;
  /** Uso por dia + usuário + modelo (controle de cotas no painel admin). */
  usageBreakdown(days?: number): Promise<UsageBreakdownRow[]>;
  /** Contagem de registros por tabela (monitoramento). */
  tableCounts(): Promise<Record<string, number>>;
  /** Tamanho do banco em MB (null quando o driver não informa). */
  dbSizeMB(): Promise<number | null>;
  logAudit(entry: Omit<AuditLog, "id" | "createdAt">): Promise<void>;
  listAudit(limit?: number): Promise<AuditLog[]>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;
}

export function toPublicUser(r: UserRecord): User {
  const { passwordHash: _p, resetToken: _t, resetExpiresAt: _e, ...pub } = r;
  return pub;
}
