/**
 * CR IA — ambiente e contexto compartilhado da API.
 * Funciona em Node (VPS/dev) e Cloudflare Workers a partir do mesmo código.
 */
import type { DbAdapter } from "./adapters/db/types.js";
import type { StorageAdapter } from "./adapters/storage/types.js";
import type { ModelRegistry } from "./adapters/ai/registry.js";

export interface Env {
  NODE_ENV?: string;
  JWT_SECRET: string;
  JWT_EXPIRES_IN?: string;
  BCRYPT_COST?: string;
  CORS_ORIGINS?: string;

  DB_DRIVER?: "json" | "postgres" | "d1";
  JSON_DB_PATH?: string;
  DATABASE_URL?: string;

  STORAGE_DRIVER?: "local" | "r2";
  LOCAL_STORAGE_DIR?: string;
  MAX_UPLOAD_MB?: string;
  ALLOWED_UPLOAD_MIME?: string;

  CHAT_PROVIDER?: string;
  AUTO_MODEL_SELECT?: string;
  OLLAMA_URL?: string;
  OLLAMA_TEXT_MODELS?: string;
  IMAGE_PROVIDER?: string;
  WORKERS_AI_IMAGE_MODEL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_AI_API_TOKEN?: string;
  ENABLE_POLLINATIONS?: string;
  POLLINATIONS_TEXT_MODEL?: string;
  POLLINATIONS_IMAGE_MODEL?: string;
  POLLINATIONS_API_KEY?: string;
  EXTERNAL_GPU_URL?: string;
  EXTERNAL_GPU_API_KEY?: string;
  COMFY_WORKFLOW_T2I?: string;
  COMFY_WORKFLOW_EDIT?: string;
  COMFY_TIMEOUT_MIN?: string;

  // Voz + embeddings locais (serviço ai-local)
  AI_LOCAL_URL?: string;

  // Busca web (SearXNG próprio; chaves pagas só com autorização)
  SEARXNG_URL?: string;
  WEB_SEARCH_PROVIDER?: string;
  TAVILY_API_KEY?: string;
  TAVILY_BASE_URL?: string;
  BRAVE_API_KEY?: string;
  BRAVE_BASE_URL?: string;
  GOOGLE_PSE_KEY?: string;
  GOOGLE_PSE_CX?: string;
  GOOGLE_PSE_BASE_URL?: string;

  // E-mail transacional (recuperação de senha)
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  PUBLIC_API_URL?: string;

  GITHUB_TOKEN?: string;
  GITHUB_ALLOWED_REPOS?: string;
  GITHUB_REQUIRE_APPROVAL?: string;
  SEARCH_API_KEY?: string;

  // Agente desenvolvedor (isolado; aprovações sempre obrigatórias p/ push/PR/merge)
  AGENT_WORK_DIR?: string;
  AGENT_REQUIRE_APPROVAL?: string;
  AGENT_MAX_PARALLEL_RUNS?: string;
  AGENT_RUN_TIMEOUT_MIN?: string;
  /** Testes automatizados: permite clones file:// locais (NUNCA em produção). */
  AGENT_ALLOW_LOCAL_PATHS?: string;
  AGENT_RUNNER?: string;
  AGENT_ALLOW_HOST_EXEC?: string;
  /** Tentativas de correção do agente após teste falhar (0–5). Padrão 2. */
  AGENT_FIX_ATTEMPTS?: string;
  AGENT_SANDBOX_NETWORK?: string;
  UPDATES_DIR?: string;
  /** URL do manifesto de atualizações (JSON). Sem ela, a Central informa "não configurado". */
  UPDATES_MANIFEST_URL?: string;
  /** HMAC dos pedidos API → updater (fail-closed; mín. 16 chars). */
  UPDATER_QUEUE_SECRET?: string;
  /** Chave pública minisign (conteúdo do .pub) que assina os ZIPs. Sem ela, stage é recusado. */
  UPDATE_SIGNING_PUBLIC_KEY?: string;
  /** Teto do ZIP de atualização via upload (MB). Padrão 256. */
  UPDATE_MAX_ZIP_MB?: string;
  /** "true" = roda npm ci + testes no staging (lento, opt-in). */
  UPDATE_RUN_TESTS?: string;

  BLOCK_PAID_PROVIDERS?: string;
  DAILY_LIMIT_CHAT?: string;
  DAILY_LIMIT_IMAGES?: string;

  // Provedores por API (chave do admin; vazios = "Indisponível — Configurar API")
  CREDENTIALS_SECRET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODELS?: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODELS?: string;
  ANTHROPIC_BASE_URL?: string;
  GOOGLE_AI_KEY?: string;
  GEMINI_API_KEY?: string;
  GOOGLE_MODELS?: string;
  GOOGLE_BASE_URL?: string;
  XAI_API_KEY?: string;
  XAI_MODELS?: string;
  XAI_BASE_URL?: string;
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODELS?: string;
  DEEPSEEK_BASE_URL?: string;
  MISTRAL_API_KEY?: string;
  MISTRAL_MODELS?: string;
  MISTRAL_BASE_URL?: string;
  // APIs gratuitas com chave (free-tier, cotas rígidas — ver providers.ts)
  GROQ_API_KEY?: string;
  GROQ_MODELS?: string;
  GROQ_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODELS?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_REFERER?: string;
  /** NVIDIA NIM Developer endpoints: apenas prototipagem; nunca habilitar em produção SaaS. */
  NVIDIA_API_KEY?: string;
  NVIDIA_MODELS?: string;
  NVIDIA_BASE_URL?: string;

  // Bindings Cloudflare (existem apenas no Workers)
  DB?: D1DatabaseLike;
  FILES?: R2BucketLike;
  AI?: AiBindingLike;
  TASKS?: QueueProducerLike;
}

/** Subconjunto da API D1 usado pelo adaptador (evita dependência de @cloudflare/workers-types). */
export interface D1DatabaseLike {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

export interface R2BucketLike {
  put(key: string, data: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size: number } | null>;
  delete(key: string): Promise<void>;
}

export interface AiBindingLike {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface QueueProducerLike {
  send(message: unknown): Promise<void>;
}

export interface AppContext {
  env: Env;
  db: DbAdapter;
  storage: StorageAdapter;
  models: ModelRegistry;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "guest" | "user";
}
