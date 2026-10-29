/**
 * Adaptador OpenAI-compatível (chat): OpenAI, xAI, DeepSeek, Mistral (pagos)
 * + Groq e OpenRouter (free-tier, $0 com cotas). POST {base}/chat/completions
 * + GET {base}/models (ping valida a chave).
 * A chave resolve na hora da chamada (env ou cofre) — nunca em log.
 */
import type { ChatOptions, ChatResult, TextAdapter } from "./types.js";
import { estimateTokens } from "./types.js";
import type { FreeKeyedProvider, KeyedProvider } from "./providers.js";
import { RateLimitError } from "./pollinations.js";

export interface KeyedAdapter extends TextAdapter {
  readonly needsKey: true;
  hasKey(): Promise<boolean>;
}

export interface OpenAICompatConfig {
  provider: KeyedProvider | FreeKeyedProvider;
  baseUrl: string;
  chatPath?: string;
  modelsPath?: string;
  models: string[];
  getKey: () => Promise<string>;
  keyLabel: string;
  timeoutMs?: number;
  /** Headers extras (ex.: OpenRouter exige HTTP-Referer + X-Title). */
  extraHeaders?: Record<string, string>;
  /** false = free-tier: resultado sai com paid=false (sem costFlag). */
  paidResult?: boolean;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; code?: string };
}

export class OpenAICompatTextAdapter implements KeyedAdapter {
  readonly needsKey = true as const;
  readonly provider: string;
  private baseUrl: string;
  private chatPath: string;
  private modelsPath: string;
  private modelIds: string[];
  private getKey: () => Promise<string>;
  private keyLabel: string;
  private timeoutMs: number;
  private extraHeaders: Record<string, string>;
  private paidResult: boolean;
  /** Classificação pago/grátis por modelo (OpenRouter dinâmico; null = paidResult). */
  paidFor: ((model: string) => boolean) | null = null;

  constructor(cfg: OpenAICompatConfig) {
    this.provider = cfg.provider;
    this.baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.chatPath = cfg.chatPath ?? "/chat/completions";
    this.modelsPath = cfg.modelsPath ?? "/models";
    this.modelIds = [...cfg.models];
    this.getKey = cfg.getKey;
    this.keyLabel = cfg.keyLabel;
    this.timeoutMs = cfg.timeoutMs ?? 60_000;
    this.extraHeaders = { ...(cfg.extraHeaders ?? {}) };
    this.paidResult = cfg.paidResult ?? true;
  }

  models(): string[] {
    return [...this.modelIds];
  }

  setModels(models: string[]): void {
    this.modelIds = [...models];
  }

  async hasKey(): Promise<boolean> {
    return (await this.getKey().catch(() => "")).trim().length > 0;
  }

  /** Ping REAL: lista modelos com a chave (200 = chave válida). */
  async ping(): Promise<boolean> {
    const key = await this.getKey().catch(() => "");
    if (!key.trim()) return false;
    try {
      const res = await fetch(`${this.baseUrl}${this.modelsPath}`, {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, ...this.extraHeaders },
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const key = await this.getKey().catch(() => "");
    if (!key.trim()) {
      throw new Error(`Indisponível — Configurar API: informe a chave ${this.keyLabel} em Administração → Credenciais.`);
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${this.chatPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}`, ...this.extraHeaders },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: opts.temperature ?? 0.7,
          max_tokens: opts.maxTokens ?? 1024,
        }),
        signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(`Provedor ${this.provider} inacessível (${e instanceof Error ? e.message : "rede"}).`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Chave ${this.keyLabel} rejeitada pelo provedor (HTTP ${res.status}). Confira a credencial.`);
    }
    if (res.status === 402) {
      throw new Error(
        `Provedor ${this.provider} recusou por créditos (HTTP 402): saldo negativo também bloqueia ` +
        `modelos grátis. Regularize no painel do provedor — a CR IA nunca compra créditos sozinha.`
      );
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "60");
      throw new RateLimitError(`Limite do provedor ${this.provider} atingido.`, Number.isFinite(retry) ? retry : 60);
    }
    if (res.status === 404) {
      throw new Error(`Modelo "${opts.model}" não existe em ${this.provider} (HTTP 404). Verifique o ID no console do provedor.`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "").then((t) => t.slice(0, 200));
      throw new Error(`Provedor ${this.provider} falhou (HTTP ${res.status}): ${body || res.statusText}`);
    }
    const data = (await res.json()) as OpenAIChatResponse;
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) throw new Error(`Provedor ${this.provider} (${opts.model}) retornou resposta vazia.`);
    const promptText = opts.messages.map((m) => m.content).join("\n");
    return {
      text,
      model: opts.model,
      tokensIn: data.usage?.prompt_tokens ?? estimateTokens(promptText),
      tokensOut: data.usage?.completion_tokens ?? estimateTokens(text),
      paid: this.paidFor ? this.paidFor(opts.model) : this.paidResult,
    };
  }
}
