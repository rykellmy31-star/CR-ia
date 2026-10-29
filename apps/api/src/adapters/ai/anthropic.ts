/**
 * Adaptador Anthropic Claude — Messages API oficial.
 * POST /v1/messages (+ GET /v1/models no ping). Chave via env ou cofre.
 * Docs: https://docs.anthropic.com/en/api/messages
 */
import type { ChatOptions, ChatResult, TextAdapter } from "./types.js";
import { estimateTokens } from "./types.js";
import { RateLimitError } from "./pollinations.js";
import type { KeyedAdapter } from "./openai-compatible.js";

const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicTextAdapter implements KeyedAdapter {
  readonly provider = "anthropic";
  readonly needsKey = true as const;
  private modelIds: string[];
  private getKey: () => Promise<string>;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { baseUrl?: string; models: string[]; getKey: () => Promise<string>; timeoutMs?: number }) {
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.modelIds = [...opts.models];
    this.getKey = opts.getKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  models(): string[] {
    return [...this.modelIds];
  }

  async hasKey(): Promise<boolean> {
    return (await this.getKey().catch(() => "")).trim().length > 0;
  }

  async ping(): Promise<boolean> {
    const key = await this.getKey().catch(() => "");
    if (!key.trim()) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
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
      throw new Error("Indisponível — Configurar API: informe a chave Anthropic (sk-ant-...) em Administração → Credenciais.");
    }
    const system = opts.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const messages = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: opts.maxTokens ?? 1024,
          ...(system ? { system } : {}),
          temperature: opts.temperature ?? 0.7,
          messages,
        }),
        signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(`Anthropic inacessível (${e instanceof Error ? e.message : "rede"}).`);
    }
    await this.assertOk(res, opts.model);
    const data = (await res.json()) as AnthropicResponse;
    const text = (data.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("").trim();
    if (!text) throw new Error(`Anthropic (${opts.model}) retornou resposta vazia.`);
    const promptText = opts.messages.map((m) => m.content).join("\n");
    return {
      text,
      model: opts.model,
      tokensIn: data.usage?.input_tokens ?? estimateTokens(promptText),
      tokensOut: data.usage?.output_tokens ?? estimateTokens(text),
      paid: true,
    };
  }

  private async assertOk(res: Response, model: string): Promise<void> {
    if (res.ok) return;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Chave Anthropic rejeitada (HTTP ${res.status}). Confira a credencial.`);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "60");
      throw new RateLimitError("Limite da Anthropic atingido.", Number.isFinite(retry) ? retry : 60);
    }
    if (res.status === 404) {
      throw new Error(`Modelo "${model}" não existe na Anthropic (HTTP 404). Verifique o ID no console.`);
    }
    const body = await res.text().catch(() => "").then((t) => t.slice(0, 200));
    throw new Error(`Anthropic falhou (HTTP ${res.status}): ${body || res.statusText}`);
  }
}

export type { TextAdapter, ChatOptions, ChatResult };
