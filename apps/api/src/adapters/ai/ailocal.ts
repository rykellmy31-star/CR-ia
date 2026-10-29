/**
 * Adaptador ai-local — transcrição (Whisper) + embeddings (BGE-M3) locais.
 * Fala com o serviço `ai-local` (perfil "ai" do compose) em AI_LOCAL_URL.
 * Sem o serviço no ar, ping() = false e as chamadas falham com mensagem clara.
 */
import type { EmbeddingsAdapter, TranscriptionAdapter } from "./types.js";

export const WHISPER_MODEL_ID = "whisper-small";
export const EMBEDDING_MODEL_ID = "bge-m3";

export class AiLocalAdapter implements TranscriptionAdapter, EmbeddingsAdapter {
  /** Provedor "ai-local" (texto? não — voz/embeddings; expõe models p/ catálogo). */
  readonly provider = "ai-local";
  private baseUrl: string;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  models(): string[] {
    return this.baseUrl ? [WHISPER_MODEL_ID, EMBEDDING_MODEL_ID] : [];
  }

  capabilitiesOf(modelId: string): Array<"transcription" | "embeddings"> {
    if (modelId === WHISPER_MODEL_ID) return ["transcription"];
    if (modelId === EMBEDDING_MODEL_ID) return ["embeddings"];
    return [];
  }

  async ping(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const data = (await res.json()) as { status?: string };
      return data.status === "ok";
    } catch {
      return false;
    }
  }

  async transcribe(opts: {
    audio: Uint8Array;
    mime: string;
    fileName: string;
    language?: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; language: string; durationSec: number | null }> {
    if (!this.baseUrl) {
      throw new Error(
        "Transcrição indisponível: serviço ai-local não configurado. " +
        "Suba com: docker compose --profile ai up -d"
      );
    }
    const form = new FormData();
    form.append("audio", new Blob([opts.audio as unknown as BlobPart], { type: opts.mime }), opts.fileName);
    if (opts.language) form.append("language", opts.language);
    const res = await fetch(`${this.baseUrl}/transcribe`, {
      method: "POST",
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ai-local transcreveu com erro HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    const data = (await res.json()) as { text?: string; language?: string; duration_sec?: number | null };
    if (!data.text) throw new Error("ai-local retornou transcrição vazia.");
    return { text: data.text, language: data.language ?? "desconhecido", durationSec: data.duration_sec ?? null };
  }

  async embed(opts: {
    texts: string[];
    signal?: AbortSignal;
  }): Promise<{ embeddings: number[][]; model: string }> {
    if (!this.baseUrl) {
      throw new Error(
        "Embeddings indisponíveis: serviço ai-local não configurado. " +
        "Suba com: docker compose --profile ai up -d"
      );
    }
    if (!opts.texts.length) return { embeddings: [], model: EMBEDDING_MODEL_ID };
    const res = await fetch(`${this.baseUrl}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: opts.texts }),
      signal: opts.signal ?? AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ai-local embeddings erro HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
    }
    const data = (await res.json()) as { embeddings?: number[][]; model?: string };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== opts.texts.length) {
      throw new Error("ai-local retornou embeddings inconsistentes.");
    }
    return { embeddings: data.embeddings, model: data.model ?? EMBEDDING_MODEL_ID };
  }
}

/** Similaridade de cosseno (busca semântica feita no Node; escala de 2 usuários). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
