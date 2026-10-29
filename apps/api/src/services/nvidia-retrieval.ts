/** NVIDIA hosted trial Retriever endpoints (admin only; never scheduled). */
import type { Env } from "../types.js";

export const NVIDIA_EMBED_IDS = [
  "nvidia/nemotron-3.5-embed-1b",
  "nvidia/nemotron-3.5-embed-8b",
] as const;
export const NVIDIA_RERANK_ID = "nvidia/nemotron-3.5-rerank-8b";

async function trialJson(url: string, key: string, payload: unknown, fetchFn: typeof fetch): Promise<unknown> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("NVIDIA recusou a credencial/permissão para esta API.");
  if (res.status === 402) throw new Error("NVIDIA solicitou créditos. A CR IA não autoriza cobrança neste teste.");
  if (res.status === 429) throw new Error("Cota gratuita de testes NVIDIA atingida.");
  if (!res.ok) throw new Error(`Endpoint NVIDIA não disponível nesta conta (HTTP ${res.status}).`);
  if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("Resposta inesperada NVIDIA.");
  return res.json();
}

export async function nvidiaEmbed(
  env: Env, key: string, model: string, input: string, type: "query" | "passage",
  fetchFn: typeof fetch = fetch,
): Promise<{ model: string; dimensions: number; vector: number[] }> {
  if (!(NVIDIA_EMBED_IDS as readonly string[]).includes(model)) throw new Error("Embedding NVIDIA não suportado.");
  if (!key.trim()) throw new Error("NVIDIA API Key não configurada.");
  const base = (env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  const body = await trialJson(`${base}/embeddings`, key, {
    model, input: [input], input_type: type, truncate: "END", encoding_format: "float",
  }, fetchFn) as { data?: Array<{ embedding?: unknown }> };
  const v = body?.data?.[0]?.embedding;
  if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw new Error("NVIDIA retornou embedding inválido.");
  }
  return { model, dimensions: v.length, vector: v as number[] };
}

export async function nvidiaRerank(
  key: string, query: string, passages: string[], fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  if (!key.trim()) throw new Error("NVIDIA API Key não configurada.");
  const body = await trialJson(
    "https://ai.api.nvidia.com/v1/retrieval/nvidia/nemotron-3.5-rerank-8b/reranking",
    key,
    { model: NVIDIA_RERANK_ID, query: { text: query }, passages: passages.map((text) => ({ text })), truncate: "END" },
    fetchFn,
  );
  // No fabricated ranking: relay bounded structured response; never log user input.
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Resposta NVIDIA de ranking inválida.");
  return body;
}
