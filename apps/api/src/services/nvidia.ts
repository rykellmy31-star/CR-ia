/** Descoberta NVIDIA NIM: /v1/models enumera candidatos, NÃO certifica Free Endpoint.
 * Nunca ativa modelos automaticamente, não faz inferência, não usa créditos.
 * O administrador confere Free Endpoint no catálogo oficial antes de aprovar.
 */
import type { DbAdapter } from "../adapters/db/types.js";
import type { Env } from "../types.js";
export const NVIDIA_CATALOG_KEY = "nvidia.catalog";
export const NVIDIA_APPROVED_KEY = "nvidia.approved";
export const NVIDIA_DEFAULT_URL = "https://integrate.api.nvidia.com/v1";
export type NvidiaCatalog = { at: string; models: string[] };
export const normalizeNvidiaModels = (data: unknown): string[] => {
  if (!Array.isArray(data)) return [];
  return [...new Set(data.flatMap((item: unknown) => {
    const id = (item as { id?: unknown } | null)?.id;
    return typeof id === "string" && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(id) ? [id] : [];
  }))].sort();
};
export async function readNvidiaCatalog(db: DbAdapter): Promise<NvidiaCatalog | null> {
  try {
    const raw = await db.getSetting(NVIDIA_CATALOG_KEY);
    if (!raw) return null;
    const x = JSON.parse(raw) as NvidiaCatalog;
    if (x && typeof x.at === "string" && Array.isArray(x.models)) return x;
  } catch { /* nada */ }
  return null;
}
export async function readNvidiaApproved(db: DbAdapter): Promise<string[]> {
  try {
    const raw = await db.getSetting(NVIDIA_APPROVED_KEY);
    const x = raw ? JSON.parse(raw) : [];
    return Array.isArray(x) ? normalizeNvidiaModels(x.map((id: unknown) => ({ id }))) : [];
  } catch { return []; }
}
export async function discoverNvidia(
  env: Env, db: DbAdapter, key: string, fetchFn: typeof fetch = fetch,
): Promise<NvidiaCatalog> {
  if (!key.trim()) throw new Error("Configure a NVIDIA_API_KEY antes de sincronizar.");
  const base = (env.NVIDIA_BASE_URL || NVIDIA_DEFAULT_URL).replace(/\/$/, "");
  const res = await fetchFn(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(18000) });
  if (!res.ok) throw new Error(`Catálogo NVIDIA indisponível (HTTP ${res.status}).`);
  const body = await res.json() as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("Resposta inválida de /v1/models NVIDIA.");
  const catalog = { at: new Date().toISOString(), models: normalizeNvidiaModels(body.data) };
  await db.setSetting(NVIDIA_CATALOG_KEY, JSON.stringify(catalog));
  return catalog;
}
