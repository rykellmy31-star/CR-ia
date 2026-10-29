/**
 * Adaptador Ollama — modelos abertos locais (VPS/Homelab).
 * Qwen3 4B/8B, Gemma 3, Qwen3-Coder etc. via API HTTP do Ollama.
 * Sem custo por chamada; custo = infraestrutura própria.
 */
import type { TextAdapter, ChatOptions, ChatResult } from "./types.js";
import { estimateTokens } from "./types.js";

interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

export class OllamaAdapter implements TextAdapter {
  readonly provider = "ollama";
  private baseUrl: string;
  private modelIds: string[];

  constructor(baseUrl = "http://localhost:11434", models: string[] = ["qwen3:4b"]) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.modelIds = models;
  }

  models(): string[] {
    return [...this.modelIds];
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: "GET", signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Modelos efetivamente baixados no servidor Ollama. */
  async installedModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name?: string }[] };
      return (data.models ?? []).map((m) => m.name ?? "").filter(Boolean);
    } catch {
      return [];
    }
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.7,
          num_predict: opts.maxTokens ?? 1024,
        },
      }),
      signal: opts.signal ?? AbortSignal.timeout(180000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`);
    }
    const data = (await res.json()) as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama: ${data.error}`);
    const content = data.message?.content ?? "";
    if (!content) throw new Error("Ollama retornou resposta vazia.");
    return {
      text: content,
      model: opts.model,
      tokensIn: data.prompt_eval_count ?? estimateTokens(opts.messages.map((m) => m.content).join("\n")),
      tokensOut: data.eval_count ?? estimateTokens(content),
      paid: false,
    };
  }
}
