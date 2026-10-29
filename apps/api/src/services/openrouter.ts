/**
 * CR IA v0.3.0 — OpenRouter como provedor primário de IA.
 *
 * Descoberta dinâmica pelos endpoints oficiais (sem chave, sem custo):
 * - GET /models — catálogo geral (texto/multimodal + preços + modalidades)
 * - GET /images/models — modelos de imagem (+ parâmetros suportados)
 * Teste de chave (sem gasto): GET /auth/key.
 * Geração/edição de imagens: POST /images (ver openrouter-image.ts).
 *
 * Regras honestas:
 * - preço ausente NÃO é gratuidade (preço desconhecido = tratado como pago);
 * - "free" só quando há preços conhecidos e todos são zero;
 * - sync nunca toca nas preferências do admin (disabled/defaults/paidAck).
 */
import type { DbAdapter } from "../adapters/db/types.js";
import type { Env } from "../types.js";

export const OR_DEFAULT_BASE = "https://openrouter.ai/api/v1";
export const OR_APP_TITLE = "CR IA";
/** Referer padrão (seu domínio) quando OPENROUTER_REFERER não está no .env. */
export const OR_DEFAULT_REFERER = "https://ia.crjornada.com";

export const OR_CATALOG_KEY = "openrouter.catalog";
export const OR_REPORT_KEY = "openrouter.report";
export const OR_SYNC_KEY = "openrouter.sync";
export const OR_LAST_SYNC_KEY = "openrouter.lastSync";

export function orBase(env: Env): string {
  const v = (env.OPENROUTER_BASE_URL ?? "").trim().replace(/\/$/, "");
  return v || OR_DEFAULT_BASE;
}

export function orHeaders(env: Env, key = ""): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json", "X-Title": OR_APP_TITLE };
  const ref = (env.OPENROUTER_REFERER ?? "").trim() || OR_DEFAULT_REFERER;
  h["HTTP-Referer"] = ref;
  if (key) h["authorization"] = `Bearer ${key}`;
  return h;
}

export type OrFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Entrada normalizada do catálogo (compacta para guardar em settings). */
export interface OrCatalogEntry {
  id: string;
  name: string;
  /** Saída texto (chat/completions). */
  text: boolean;
  /** Saída imagem (POST /images). */
  image: boolean;
  /** Aceita imagem de entrada (edição image-to-image / visão). */
  imageInput: boolean;
  context: number | null;
  /** USD por 1M de tokens (quando divulgado). */
  priceIn1M: number | null;
  priceOut1M: number | null;
  free: boolean;
  priceKnown: boolean;
  /** Parâmetros de imagem declarados (supported_parameters). */
  imageParams?: string[];
}

export interface OrStoredCatalog {
  v: 1;
  at: string;
  models: OrCatalogEntry[];
}

export type OrSyncSource = "manual" | "auto" | "boot";

export interface OrSyncReport {
  at: string;
  source: OrSyncSource;
  total: number;
  text: number;
  image: number;
  free: number;
  paidOrUnknown: number;
  added: string[];
  updated: string[];
  removed: string[];
  imageErrors: string[];
  durationMs: number;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Preços do /models vêm por token (string). Converte para USD por 1M. */
function per1M(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n * 1_000_000;
}

/**
 * Classificação honesta de gratuidade a partir do bloco `pricing`:
 * - algum preço conhecido > 0 → pago;
 * - ≥1 preço conhecido e todos zero → free;
 * - nenhum preço conhecido → desconhecido (o chamador trata como pago).
 */
export function freeFromPricing(pricing: unknown): { free: boolean; known: boolean } {
  if (!pricing || typeof pricing !== "object") return { free: false, known: false };
  const p = pricing as Record<string, unknown>;
  const vals = [num(p.prompt), num(p.completion), num(p.request), num(p.image)]
    .filter((n): n is number => n !== null);
  if (vals.length === 0) return { free: false, known: false };
  return { free: vals.every((n) => n === 0), known: true };
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

/** Normaliza GET /models → entradas (texto/multimodal). */
export function normalizeTextModels(data: unknown): OrCatalogEntry[] {
  if (!Array.isArray(data)) return [];
  const out: OrCatalogEntry[] = [];
  for (const r of data) {
    const m = r as Record<string, unknown>;
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const arch = (m.architecture ?? {}) as { input_modalities?: unknown; output_modalities?: unknown };
    const outp = strList(arch.output_modalities);
    const inp = strList(arch.input_modalities);
    const pricing = m.pricing as Record<string, unknown> | undefined;
    const { free, known } = freeFromPricing(pricing);
    out.push({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      // Sem modalidades declaradas: assume chat (modelos legados de texto).
      text: outp.length === 0 ? true : outp.includes("text"),
      image: outp.includes("image"),
      imageInput: inp.includes("image"),
      context: num(m.context_length),
      priceIn1M: per1M(pricing?.prompt),
      priceOut1M: per1M(pricing?.completion),
      free,
      priceKnown: known,
    });
  }
  return out;
}

/**
 * Mescla GET /images/models: marca image=true, registra parâmetros e
 * corrige o flag de texto (image-only não faz chat). Modelos só de imagem
 * ausentes do /models entram como desconhecidos (tratados como pagos).
 */
export function mergeImageModels(entries: OrCatalogEntry[], data: unknown): OrCatalogEntry[] {
  if (!Array.isArray(data)) return entries;
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const r of data) {
    const m = r as Record<string, unknown>;
    if (!m || typeof m.id !== "string" || !m.id) continue;
    const arch = (m.architecture ?? {}) as { input_modalities?: unknown; output_modalities?: unknown };
    const outp = strList(arch.output_modalities);
    const inp = strList(arch.input_modalities);
    const params = m.supported_parameters && typeof m.supported_parameters === "object"
      ? Object.keys(m.supported_parameters as Record<string, unknown>)
      : [];
    const e = byId.get(m.id);
    if (e) {
      e.image = true;
      e.imageParams = params;
      if (inp.includes("image")) e.imageInput = true;
      if (outp.length > 0 && !outp.includes("text")) e.text = false;
    } else {
      byId.set(m.id, {
        id: m.id,
        name: typeof m.name === "string" && m.name ? m.name : m.id,
        text: outp.includes("text"),
        image: true,
        imageInput: inp.includes("image"),
        context: null,
        priceIn1M: null,
        priceOut1M: null,
        free: false,
        priceKnown: false,
        imageParams: params,
      });
    }
  }
  return [...byId.values()];
}

async function getJson(
  fetchFn: OrFetch, url: string, headers: Record<string, string>, timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { headers, signal: ctrl.signal });
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

export async function loadCatalog(db: DbAdapter): Promise<OrStoredCatalog | null> {
  const raw = await db.getSetting(OR_CATALOG_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as OrStoredCatalog;
    if (p && p.v === 1 && Array.isArray(p.models)) return p;
    return null;
  } catch {
    return null;
  }
}

export interface OrSyncConfig {
  auto: boolean;
  intervalHours: number;
}

export async function loadSyncConfig(db: DbAdapter): Promise<OrSyncConfig> {
  try {
    const raw = await db.getSetting(OR_SYNC_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrSyncConfig>;
      return {
        auto: p.auto !== false,
        intervalHours: Math.min(168, Math.max(1, Number(p.intervalHours) || 24)),
      };
    }
  } catch {
    /* padrão seguro abaixo */
  }
  return { auto: true, intervalHours: 24 };
}

export function syncDue(cfg: OrSyncConfig, lastSyncIso: string | null, nowMs = Date.now()): boolean {
  if (!cfg.auto) return false;
  if (!lastSyncIso) return true;
  const at = new Date(lastSyncIso).getTime();
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= cfg.intervalHours * 3600_000;
}

/**
 * Sincroniza o catálogo com a OpenRouter oficial e persiste em settings.
 * Nunca altera preferências do admin (disabled/defaults/paidAck).
 */
export async function syncCatalog(
  env: Env, db: DbAdapter,
  opts: { fetchFn?: OrFetch; source?: OrSyncSource; timeoutMs?: number } = {},
): Promise<OrSyncReport> {
  const fetchFn = opts.fetchFn ?? fetch;
  const source = opts.source ?? "manual";
  const timeoutMs = opts.timeoutMs ?? 20000;
  const t0 = Date.now();
  const base = orBase(env);
  const headers = orHeaders(env); // descoberta é pública (sem chave)

  const prev = await loadCatalog(db);
  const prevById = new Map((prev?.models ?? []).map((e) => [e.id, e]));

  let modelsJson: unknown;
  try {
    const r = await getJson(fetchFn, `${base}/models`, headers, timeoutMs);
    const data = (r.json as { data?: unknown } | null)?.data;
    if (r.status < 200 || r.status >= 300 || !Array.isArray(data)) {
      throw new Error(`GET /models → HTTP ${r.status}`);
    }
    modelsJson = data;
  } catch (e) {
    throw new Error(`Falha ao buscar catálogo OpenRouter: ${e instanceof Error ? e.message : e}`);
  }

  let entries = normalizeTextModels(modelsJson);
  const imageErrors: string[] = [];
  try {
    const r = await getJson(fetchFn, `${base}/images/models`, headers, timeoutMs);
    const data = (r.json as { data?: unknown } | null)?.data;
    if (r.status >= 200 && r.status < 300 && Array.isArray(data)) {
      entries = mergeImageModels(entries, data);
    } else {
      imageErrors.push(`GET /images/models → HTTP ${r.status}`);
    }
  } catch (e) {
    imageErrors.push(`images/models: ${e instanceof Error ? e.message : e}`);
  }

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    seen.add(e.id);
    const p = prevById.get(e.id);
    if (!p) {
      added.push(e.id);
      continue;
    }
    if (
      p.free !== e.free || p.text !== e.text || p.image !== e.image ||
      p.priceIn1M !== e.priceIn1M || p.priceOut1M !== e.priceOut1M || p.name !== e.name
    ) {
      updated.push(e.id);
    }
  }
  for (const id of prevById.keys()) {
    if (!seen.has(id)) removed.push(id);
  }

  const at = new Date().toISOString();
  const report: OrSyncReport = {
    at,
    source,
    total: entries.length,
    text: entries.filter((e) => e.text).length,
    image: entries.filter((e) => e.image).length,
    free: entries.filter((e) => e.free).length,
    paidOrUnknown: entries.filter((e) => !e.free).length,
    added,
    updated,
    removed,
    imageErrors,
    durationMs: Date.now() - t0,
  };
  await db.setSetting(OR_CATALOG_KEY, JSON.stringify({ v: 1, at, models: entries }));
  await db.setSetting(OR_REPORT_KEY, JSON.stringify(report));
  await db.setSetting(OR_LAST_SYNC_KEY, at);
  return report;
}

/** Último relatório de sync (para o painel exibir adicionados/atualizados/removidos). */
export async function loadReport(db: DbAdapter): Promise<OrSyncReport | null> {
  const raw = await db.getSetting(OR_REPORT_KEY).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrSyncReport;
  } catch {
    return null;
  }
}

export interface OrKeyInfo {
  ok: boolean;
  label: string | null;
  usage: number | null;
  limit: number | null;
  isFreeTier: boolean | null;
  error?: string;
  http?: number;
}

const KEY_FAIL = (error: string, http?: number): OrKeyInfo =>
  ({ ok: false, label: null, usage: null, limit: null, isFreeTier: null, error, http });

/** Testa a chave via GET /auth/key (oficial, sem gasto, sem gerar nada). */
export async function testKey(
  env: Env, key: string, fetchFn: OrFetch = fetch, timeoutMs = 15000,
): Promise<OrKeyInfo> {
  if (!key || key.length < 8) return KEY_FAIL("Chave vazia.");
  try {
    const r = await getJson(fetchFn, `${orBase(env)}/auth/key`, orHeaders(env, key), timeoutMs);
    if (r.status === 401) return KEY_FAIL("Chave inválida ou revogada (HTTP 401).", 401);
    if (r.status === 402) return KEY_FAIL("Sem créditos/saldo na conta (HTTP 402).", 402);
    if (r.status === 429) return KEY_FAIL("Limite de requisições atingido (HTTP 429) — aguarde e tente de novo.", 429);
    if (r.status < 200 || r.status >= 300 || !r.json) {
      return KEY_FAIL(`Falha na verificação (HTTP ${r.status}).`, r.status);
    }
    const d = ((r.json as { data?: unknown }).data ?? r.json) as Record<string, unknown>;
    return {
      ok: true,
      label: typeof d.label === "string" ? d.label : null,
      usage: num(d.usage),
      limit: num(d.limit ?? d.credit_limit),
      isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
    };
  } catch (e) {
    const abort = e instanceof Error && e.name === "AbortError";
    return KEY_FAIL(abort ? "Tempo esgotado ao contatar a OpenRouter." : `Rede: ${e instanceof Error ? e.message : e}`);
  }
}

/** Máscara segura: mostra só início + fim (nunca a chave inteira). */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "••••••";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

// Guarda anti-duplicação do sync automático (por processo).
let autoSyncInflight = false;
let lastAutoAttempt = 0;

/**
 * Roda o sync automático quando devido (config + intervalo). Barato quando
 * não é devido (2 leituras de settings) e nunca roda em paralelo.
 */
export async function maybeAutoSync(
  env: Env, db: DbAdapter, apply: (entries: OrCatalogEntry[], at: string | null) => void,
): Promise<OrSyncReport | null> {
  const now = Date.now();
  if (autoSyncInflight || now - lastAutoAttempt < 60_000) return null;
  const [cfg, lastSync] = await Promise.all([
    loadSyncConfig(db),
    db.getSetting(OR_LAST_SYNC_KEY).catch(() => null),
  ]);
  if (!syncDue(cfg, lastSync)) return null;
  autoSyncInflight = true;
  lastAutoAttempt = now;
  try {
    const report = await syncCatalog(env, db, { source: "auto" });
    const cat = await loadCatalog(db);
    apply(cat?.models ?? [], cat?.at ?? report.at);
    return report;
  } catch {
    return null;
  } finally {
    autoSyncInflight = false;
  }
}
