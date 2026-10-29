/**
 * CR IA — tipos compartilhados entre API, Web e Worker.
 * Fonte única de verdade para contratos de dados.
 */

// ---------- Usuários ----------
export type UserRole = "admin" | "guest" | "user";

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  blocked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicUser extends User {}

// ---------- Conversas / Chat ----------
export interface Conversation {
  id: string;
  userId: string;
  title: string;
  modelId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  modelId: string | null;
  tokensIn: number;
  tokensOut: number;
  createdAt: string;
}

// ---------- Modelos ----------
export type ModelCapability =
  | "chat"
  | "reasoning"
  | "code"
  | "image-gen"
  | "image-edit"
  | "transcription"
  | "embeddings";

export type ModelProvider =
  | "mock"
  | "ollama"
  | "workers-ai"
  | "local-svg"
  | "pollinations"
  | "ai-local"
  | "external-gpu"
  | "openai"
  | "anthropic"
  | "google"
  | "xai"
  | "deepseek"
  | "mistral"
  | "groq"
  | "openrouter"
  | "nvidia";

/**
 * Estado operacional do modelo (v0.2.0):
 * - installed: pronto para uso neste servidor (pesos locais ou serviço ativo)
 * - available: provedor acessível, mas o modelo precisa ser baixado/ativado
 * - limited: API gratuita com chave OK, mas com cotas (RPM/dia) — use com moderação
 * - unavailable: provedor fora do ar, não configurado ou sem recursos (ex.: GPU)
 * - testing: um teste real de inferência está em execução neste momento
 * - needs-credentials: API por chave — o admin ainda não configurou a credencial
 * - incompatible: não roda nesta infraestrutura (ex.: exige GPU na VPS)
 */
export type ModelStatus = "installed" | "available" | "limited" | "unavailable" | "testing" | "needs-credentials" | "incompatible";

/**
 * Custo por chamada:
 * - free: $0, sem cota de provedor (local/demo) ou cota generosa documentada
 * - free-tier: $0 por token, MAS com cotas rígidas (RPM/RPD) e fila — não é ilimitado
 * - paid: pode gerar cobrança (bloqueável por BLOCK_PAID_PROVIDERS)
 */
export type ModelCost = "free" | "free-tier" | "paid";

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  at: string;
  detail?: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: ModelProvider;
  capabilities: ModelCapability[];
  /** true quando o provedor está configurado e acessível */
  available: boolean;
  enabled: boolean;
  /** true quando a chamada pode gerar custo (bloqueável por política) */
  paid: boolean;
  /** true quando o prompt sai do seu servidor (serviço externo; exige consentimento do admin) */
  external: boolean;
  description: string;
  contextLength?: number;
  // ---- v0.2.0: centro multimodelo ----
  /** Estado operacional (installed/available/unavailable/testing). */
  status: ModelStatus;
  /** Custo por chamada: free | paid. */
  cost: ModelCost;
  /** Licença verificada (ex.: "Apache-2.0", "MIT", "Llama 3.x Community"). */
  license: string;
  licenseUrl?: string;
  /** true = roda no seu servidor/VPS (nada sai da máquina). */
  local: boolean;
  /** Nota de recursos (ex.: "~2,5 GB RAM", "exige GPU externa"). */
  sizeNote?: string;
  /** Cotas do plano gratuito (ex.: "30 req/min · 1.000 req/dia"). Só free-tier. */
  limits?: string;
  /** O que falta para usar (ex.: "rode ./scripts/ollama-setup.sh"). */
  requirements?: string;
  /** Último teste real de inferência (/models/test), se houver. */
  lastTest?: ModelTestResult | null;
  /**
   * Preço estimado por 1M de tokens (USD) — tabela pesquisada em `asOf`.
   * Ausente = sem dado confiável (consulte o provedor). Nunca é fatura real.
   */
  pricePer1M?: { in: number; out: number; asOf: string };
  /** true = aceita edição image-to-image (upload + instrução). */
  supportsEdit?: boolean;
}

// ---------- Imagens ----------
export type ImageFormat = "1:1" | "4:5" | "9:16" | "16:9";

export const IMAGE_DIMENSIONS: Record<ImageFormat, { w: number; h: number }> = {
  "1:1": { w: 1024, h: 1024 },
  "4:5": { w: 1024, h: 1280 },
  "9:16": { w: 768, h: 1365 },
  "16:9": { w: 1365, h: 768 },
};

export interface GeneratedImage {
  id: string;
  userId: string;
  prompt: string;
  negativePrompt?: string;
  format: ImageFormat;
  modelId: string;
  fileId: string;
  url: string;
  width: number;
  height: number;
  createdAt: string;
}

// ---------- Arquivos ----------
export interface StoredFile {
  id: string;
  userId: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

// ---------- Tarefas / agentes ----------
export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed";

export type TaskType =
  | "echo"
  | "chat"
  | "image-batch"
  | "github-inspect"
  | "github-fix-proposal"
  | "agent-run";

/** Fases de uma execução do agente desenvolvedor (ordem fixa). */
export type AgentPhase =
  | "validate"
  | "clone"
  | "analyze"
  | "plan"
  | "edit"
  | "test"
  | "commit"
  | "push"
  | "pr"
  | "checks"
  | "merge"
  | "done";

export type AgentRunStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "done"
  | "failed"
  | "cancelled";

/** Aprovações exigidas antes de ações sensíveis. */
export type AgentApprovalKind = "push" | "pr" | "merge" | "destructive";

export interface AgentStep {
  phase: AgentPhase;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  startedAt: string | null;
  finishedAt: string | null;
  /** Log real de execução (stdout/stderr resumidos). */
  log: string;
  /** Quando preenchido, a execução pausou aguardando esta aprovação. */
  awaitingApproval: AgentApprovalKind | null;
}

export interface AgentRun {
  id: string;
  userId: string;
  /** slug owner/repo (allowlist) ou caminho local de teste */
  repo: string;
  baseBranch: string;
  workBranch: string;
  /** Descrição da tarefa dada pelo usuário. */
  goal: string;
  /** Comandos extras permitidos (allowlist) pedidos pelo usuário. */
  commands: string[];
  /** Patch unificado aplicado na fase edit (opcional). */
  patch: string | null;
  status: AgentRunStatus;
  currentPhase: AgentPhase;
  steps: AgentStep[];
  approvals: Partial<Record<AgentApprovalKind, { by: string; at: string }>>;
  /** URL do PR criado (quando houver). */
  prUrl: string | null;
  /** Checks do PR (quando consultados). */
  checks: Array<{ name: string; status: string; conclusion: string | null; url: string | null }>;
  result: string | null;
  error: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Trecho de documento indexado para busca (texto + embedding). */
export interface DocumentChunk {
  id: string;
  fileId: string;
  userId: string;
  fileName: string;
  chunkIndex: number;
  text: string;
  /** Embedding serializado (JSON) — nulo quando indexado só por palavra-chave. */
  embedding: string | null;
  createdAt: string;
}

/** Trecho de código de repositório indexado (isolado por usuário + repo). */
export interface CodeChunk {
  id: string;
  userId: string;
  repo: string;
  path: string;
  chunkIndex: number;
  text: string;
  embedding: string | null;
  createdAt: string;
}

/** Item de memória do usuário/projeto: decisão técnica, correção ou nota. */
export interface MemoryItem {
  id: string;
  userId: string;
  /** Projeto (ex.: "owner/repo") ou "" para geral. */
  project: string;
  kind: "decision" | "fix" | "note";
  title: string;
  content: string;
  createdAt: string;
}

/** Registro de pesquisa web (histórico por usuário). */
export interface SearchRecord {
  id: string;
  userId: string;
  provider: string;
  query: string;
  resultsCount: number;
  createdAt: string;
}

export interface UsageBreakdownRow {
  day: string;
  userId: string;
  email: string;
  modelId: string;
  kind: UsageEvent["kind"];
  count: number;
  tokensIn: number;
  tokensOut: number;
  /** Soma dos custos reais informados (USD). 0 = nenhum custo reportado. */
  costUsd: number;
  costFlag: boolean;
}

export interface SystemStatus {
  time: string;
  uptimeSec: number;
  node: { version: string; heapUsedMB: number; heapTotalMB: number; rssMB: number };
  os: { platform: string; arch: string; load1: number; load5: number; totalMemMB: number; freeMemMB: number };
  disk: { path: string; totalMB: number | null; freeMB: number | null } | null;
  database: { driver: string; sizeMB: number | null; tables: Record<string, number> | null };
}

export interface AgentTask {
  id: string;
  userId: string;
  type: TaskType;
  title: string;
  status: TaskStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  runAfter: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- Uso / auditoria ----------
export interface UsageEvent {
  id: string;
  userId: string;
  modelId: string;
  kind: "chat" | "image" | "transcription" | "embedding" | "web-search";
  tokensIn: number;
  tokensOut: number;
  costFlag: boolean;
  /** Custo real em USD informado pelo provedor (OpenRouter usage.cost). Ausente = desconhecido. */
  costUsd?: number | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  userId: string | null;
  action: string;
  detail: string;
  createdAt: string;
}

// ---------- API envelopes ----------
export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: string;
  code?: string;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;
