/**
 * Adaptador Google Gemini — generateContent oficial (chave via query `key=`).
 * POST /v1beta/models/{model}:generateContent (+ GET /v1beta/models no ping).
 * Docs: https://ai.google.dev/gemini-api/docs/models
 */
import type { KeyedAdapter } from "./openai-compatible.js";
import { estimateTokens } from "./types.js";
import { RateLimitError } from "./pollinations.js";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

export class GoogleTextAdapter implements KeyedAdapter {
  readonly provider = "google";
  readonly needsKey = true as const;
  private modelIds: string[];
  private getKey: () => Promise<string>;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(opts: { baseUrl?: string; models: string[]; getKey: () => Promise<string>; timeoutMs?: number }) {
    this.baseUrl = (opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
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
      const res = await fetch(`${this.baseUrl}/models?pageSize=1&key=${encodeURIComponent(key)}`, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async chat(opts: import("./types.js").ChatOptions): Promise<import("./types.js").ChatResult> {
    const key = await this.getKey().catch(() => "");
    if (!key.trim()) {
      throw new Error("Indisponível — Configurar API: informe a chave Gemini (AIza...) em Administração → Credenciais.");
    }
    const system = opts.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const contents = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(opts.model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig: { temperature: opts.temperature ?? 0.7, maxOutputTokens: opts.maxTokens ?? 1024 },
        }),
        signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new Error(`Gemini inacessível (${e instanceof Error ? e.message : "rede"}).`);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new Error(`Chave Gemini rejeitada ou modelo inválido (HTTP ${res.status}). Confira credencial e ID.`);
    }
    if (res.status === 429) {
      throw new RateLimitError("Limite do Gemini atingido.", 60);
    }
    if (res.status === 404) {
      throw new Error(`Modelo "${opts.model}" não existe no Gemini (HTTP 404). Verifique o ID.`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "").then((t) => t.slice(0, 200));
      throw new Error(`Gemini falhou (HTTP ${res.status}): ${body || res.statusText}`);
    }
    const data = (await res.json()) as GeminiResponse;
    if (data.promptFeedback?.blockReason) {
      throw new Error(`Gemini bloqueou a solicitação (${data.promptFeedback.blockReason}). Reformule o pedido.`);
    }
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    if (!text) throw new Error(`Gemini (${opts.model}) retornou resposta vazia.`);
    const promptText = opts.messages.map((m) => m.content).join("\n");
    return {
      text,
      model: opts.model,
      tokensIn: data.usageMetadata?.promptTokenCount ?? estimateTokens(promptText),
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
      paid: true,
    };
  }
}
