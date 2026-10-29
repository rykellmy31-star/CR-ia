/**
 * Provedores de IA por API (chave do admin) — IDs e preços REAIS pesquisados.
 *
 * IDs verificados em 22/10/2026 (fontes nas descrições do catálogo):
 * - OpenAI: gpt-5-mini, gpt-5 (docs + agregadores de preço, out/2026)
 * - Anthropic: claude-opus-4-6 (anthropic.com/news, 14/10/2026), claude-sonnet-4-6
 * - Google: gemini-3.8-flash, gemini-4-argon (Google Cloud docs, ciclo de vida)
 * - xAI: grok-4.7, grok-4.3 (docs.x.ai, 21/09/2026)
 * - DeepSeek: deepseek-chat, deepseek-reasoner (aliases oficiais estáveis)
 * - Mistral: mistral-large-latest, mistral-medium-latest (aliases oficiais)
 *
 * Listas sobrescrevíveis por env (<PROVIDER>_MODELS="id1,id2").
 * Preços: USD/1M tokens, SOMENTE onde há fonte sólida; servem para
 * ESTIMATIVA no painel — nunca como fatura. Ausente = sem dado confiável.
 */
import type { ModelProvider } from "@cr-ia/shared";

export type KeyedProvider = "openai" | "anthropic" | "google" | "xai" | "deepseek" | "mistral";

export const KEYED_PROVIDERS: KeyedProvider[] = ["openai", "anthropic", "google", "xai", "deepseek", "mistral"];

/**
 * Provedores GRATUITOS por chave (free-tier): $0 por token, mas com cotas
 * rígidas (RPM/RPD) e fila — NÃO são ilimitados. Exigem chave gratuita
 * (sem cartão) e NÃO são bloqueados por BLOCK_PAID_PROVIDERS (não há
 * caminho de cobrança: só listamos modelos grátis). O prompt sai do
 * servidor — não envie dados sensíveis. NUNCA misturar com KeyedProvider.
 */
export type FreeKeyedProvider = "groq" | "openrouter" | "nvidia";

export const FREE_KEYED_PROVIDERS: FreeKeyedProvider[] = ["groq", "openrouter", "nvidia"];

export interface ProviderDefaults {
  provider: KeyedProvider;
  label: string;
  /** Nome da env com a chave ("" = segunda opção aceita). */
  keyEnv: (keyof import("../../types.js").Env)[];
  modelsEnv: keyof import("../../types.js").Env;
  baseUrl: string;
  /** Sobrescrita da base (stub de teste / proxy próprio). */
  baseUrlEnv: keyof import("../../types.js").Env;
  models: string[];
  docsUrl: string;
  keyHint: string;
}

export const PROVIDER_DEFAULTS: Record<KeyedProvider, ProviderDefaults> = {
  openai: {
    provider: "openai",
    label: "OpenAI (ChatGPT API)",
    keyEnv: ["OPENAI_API_KEY"],
    modelsEnv: "OPENAI_MODELS",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    models: ["gpt-5-mini", "gpt-5"],
    docsUrl: "https://platform.openai.com/docs/models",
    keyHint: "sk-... (platform.openai.com → API keys)",
  },
  anthropic: {
    provider: "anthropic",
    label: "Anthropic (Claude API)",
    keyEnv: ["ANTHROPIC_API_KEY"],
    modelsEnv: "ANTHROPIC_MODELS",
    baseUrl: "https://api.anthropic.com/v1",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    models: ["claude-opus-4-6", "claude-sonnet-4-6"],
    docsUrl: "https://docs.anthropic.com/en/docs/models-overview",
    keyHint: "sk-ant-... (console.anthropic.com → API keys)",
  },
  google: {
    provider: "google",
    label: "Google (Gemini API)",
    keyEnv: ["GOOGLE_AI_KEY", "GEMINI_API_KEY"],
    modelsEnv: "GOOGLE_MODELS",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    baseUrlEnv: "GOOGLE_BASE_URL",
    models: ["gemini-3.8-flash", "gemini-4-argon"],
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    keyHint: "AIza... (aistudio.google.com → API keys)",
  },
  xai: {
    provider: "xai",
    label: "xAI (Grok API)",
    keyEnv: ["XAI_API_KEY"],
    modelsEnv: "XAI_MODELS",
    baseUrl: "https://api.x.ai/v1",
    baseUrlEnv: "XAI_BASE_URL",
    models: ["grok-4.7", "grok-4.3"],
    docsUrl: "https://docs.x.ai/overview",
    keyHint: "xai-... (console.x.ai → API keys)",
  },
  deepseek: {
    provider: "deepseek",
    label: "DeepSeek API",
    keyEnv: ["DEEPSEEK_API_KEY"],
    modelsEnv: "DEEPSEEK_MODELS",
    baseUrl: "https://api.deepseek.com",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    models: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://api-docs.deepseek.com/",
    keyHint: "sk-... (platform.deepseek.com → API keys)",
  },
  mistral: {
    provider: "mistral",
    label: "Mistral API",
    keyEnv: ["MISTRAL_API_KEY"],
    modelsEnv: "MISTRAL_MODELS",
    baseUrl: "https://api.mistral.ai/v1",
    baseUrlEnv: "MISTRAL_BASE_URL",
    models: ["mistral-large-latest", "mistral-medium-latest"],
    docsUrl: "https://docs.mistral.ai/getting-started/models/",
    keyHint: "... (console.mistral.ai → API keys)",
  },
};

export interface FreeProviderDefaults {
  provider: FreeKeyedProvider;
  label: string;
  keyEnv: (keyof import("../../types.js").Env)[];
  modelsEnv: keyof import("../../types.js").Env;
  baseUrl: string;
  baseUrlEnv: keyof import("../../types.js").Env;
  models: string[];
  docsUrl: string;
  keyHint: string;
  /** Cotas do grátis (texto exibido no painel; verificado em out/2026). */
  limits: string;
}

/**
 * Padrões dos provedores GRATUITOS (verificados em 23/10/2026):
 * - Groq: OpenAI-compatível; grátis sem cartão; Llama saiu do free em
 *   ago/2026 — free atual: openai/gpt-oss-120b e openai/gpt-oss-20b
 *   (30 req/min, 1.000 req/dia, 8K tok/min, 200K tok/dia por org).
 * - OpenRouter: OpenAI-compatível + headers Referer/Title; modelos :free
 *   ROTATIVOS (20 req/min, 50 req/dia — 1.000 após $10 vitalícios);
 *   data policy varia por host (alguns treinam) — nada sensível.
 */
export const FREE_PROVIDER_DEFAULTS: Record<FreeKeyedProvider, FreeProviderDefaults> = {
  nvidia: {
    provider: "nvidia",
    label: "NVIDIA NIM (Free Endpoint — SOMENTE testes)",
    keyEnv: ["NVIDIA_API_KEY"],
    modelsEnv: "NVIDIA_MODELS",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    baseUrlEnv: "NVIDIA_BASE_URL",
    models: [], // Nenhum modelo é autorizado só por aparecer em GET /models.
    docsUrl: "https://build.nvidia.com/models",
    keyHint: "nvapi-... (build.nvidia.com → Get API Key)",
    limits: "Free Endpoint para protótipos; disponibilidade/cotas variáveis. NÃO liberado para uso comercial na CR IA.",
  },
  groq: {
    provider: "groq",
    label: "Groq (grátis, sem cartão)",
    keyEnv: ["GROQ_API_KEY"],
    modelsEnv: "GROQ_MODELS",
    baseUrl: "https://api.groq.com/openai/v1",
    baseUrlEnv: "GROQ_BASE_URL",
    models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
    docsUrl: "https://console.groq.com/docs/rate-limits",
    keyHint: "gsk-... (console.groq.com → API Keys, grátis sem cartão)",
    limits: "30 req/min · 1.000 req/dia · 200K tok/dia (plano grátis, out/2026)",
  },
  openrouter: {
    provider: "openrouter",
    label: "OpenRouter Free (grátis, rotativo)",
    keyEnv: ["OPENROUTER_API_KEY"],
    modelsEnv: "OPENROUTER_MODELS",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    // Elenco :free gira sem aviso — o admin informa os IDs atuais.
    models: [],
    docsUrl: "https://openrouter.ai/docs/api-reference/limits",
    keyHint: "sk-or-v1-... (openrouter.ai/keys, grátis sem cartão)",
    limits: "20 req/min · 50 req/dia (1.000 após $10 vitalícios; out/2026)",
  },
};

export interface PriceEntry {
  in: number;
  out: number;
  asOf: string;
  source: string;
}

/**
 * Tabela de ESTIMATIVA (USD/1M tokens). Somente entradas com fonte sólida
 * em 22/10/2026. Modelos sem entrada NÃO exibem estimativa.
 */
export const PRICE_TABLE: Record<string, PriceEntry> = {
  "gpt-5-mini": { in: 0.25, out: 2.0, asOf: "2026-10-22", source: "openai docs + agregadores" },
  "gpt-5": { in: 1.25, out: 10.0, asOf: "2026-10-22", source: "openai docs + agregadores" },
  "gemini-3.8-flash": { in: 0.75, out: 3.75, asOf: "2026-10-22", source: "google cloud docs (ciclo de vida)" },
  "gemini-4-argon": { in: 2.0, out: 10.0, asOf: "2026-10-22", source: "google cloud docs (ciclo de vida)" },
  "grok-4.7": { in: 2.0, out: 6.0, asOf: "2026-10-22", source: "docs.x.ai" },
};

/** Custo estimado em USD para um volume de tokens (null = sem dado). */
export function estimateCostUSD(modelId: string, tokensIn: number, tokensOut: number): number | null {
  const p = PRICE_TABLE[modelId];
  if (!p) return null;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export function isKeyedProvider(p: string): p is KeyedProvider {
  return (KEYED_PROVIDERS as string[]).includes(p);
}

export function isFreeKeyedProvider(p: string): p is FreeKeyedProvider {
  return (FREE_KEYED_PROVIDERS as string[]).includes(p);
}

export function keyedProviderOf(provider: ModelProvider): KeyedProvider | null {
  return isKeyedProvider(provider) ? provider : null;
}
