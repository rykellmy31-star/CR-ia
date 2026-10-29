/**
 * CR IA Fase 3 — busca web por provedores oficiais/autorizados.
 * - searxng: próprio (perfil "search" do compose; grátis, sem conta).
 * - brave: Brave Search API (chave; GET /res/v1/web/search).
 * - tavily: Tavily API (chave; POST /search).
 * - google-pse: Google Programmable Search (chave + CX; GET customsearch/v1).
 * Ordem padrão: searxng > brave > tavily > google-pse (grátis primeiro);
 * WEB_SEARCH_PROVIDER ou parâmetro força um provedor. Sem provedor
 * configurado, erro claro (nada simulado).
 */
import type { Env } from "../types.js";
import type { DbAdapter } from "../adapters/db/types.js";
import { openSecret, vaultSecret } from "../lib/vault.js";

export type SearchProviderId = "searxng" | "brave" | "tavily" | "google-pse";

export const SEARCH_PROVIDERS: SearchProviderId[] = ["searxng", "brave", "tavily", "google-pse"];

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  /** Data de publicação quando o provedor informa (ou null). */
  publishedAt: string | null;
  /** Relevância 0..1 quando o provedor informa. */
  score: number | null;
}

export interface WebSearchResponse {
  query: string;
  results: WebResult[];
  real: true;
  provider: SearchProviderId;
}

export function isSearchProvider(v: string): v is SearchProviderId {
  return (SEARCH_PROVIDERS as string[]).includes(v);
}

/** Chave de provedor de busca: env > cofre `cred.search.<p>`. "" = ausente. */
export async function searchKey(env: Env, db: DbAdapter, p: Exclude<SearchProviderId, "searxng">): Promise<string> {
  const fromEnv =
    p === "brave" ? (env.BRAVE_API_KEY ?? "")
    : p === "tavily" ? (env.TAVILY_API_KEY ?? "")
    : (env.GOOGLE_PSE_KEY ?? "");
  if (fromEnv.trim()) return fromEnv.trim();
  const packed = await db.getSetting(`cred.search.${p}`).catch(() => null);
  if (!packed) return "";
  try {
    return await openSecret(vaultSecret(env), packed);
  } catch {
    return "";
  }
}

/** CX do Google PSE: env > settings `search.google_cx`. */
export async function googleCx(env: Env, db: DbAdapter): Promise<string> {
  if ((env.GOOGLE_PSE_CX ?? "").trim()) return env.GOOGLE_PSE_CX!.trim();
  return (await db.getSetting("search.google_cx").catch(() => null))?.trim() ?? "";
}

export interface SearchProviderStatus {
  id: SearchProviderId;
  label: string;
  configured: boolean;
  free: boolean;
  detail: string;
}

/** Status de cada provedor (para o painel; sem expor chaves). */
export async function searchProviderStatus(env: Env, db: DbAdapter): Promise<SearchProviderStatus[]> {
  const searx = (env.SEARXNG_URL ?? "").trim();
  const brave = await searchKey(env, db, "brave");
  const tavily = await searchKey(env, db, "tavily");
  const gpse = await searchKey(env, db, "google-pse");
  const cx = gpse ? await googleCx(env, db) : "";
  return [
    {
      id: "searxng", label: "SearXNG próprio", free: true,
      configured: searx.length > 0,
      detail: searx ? `SEARXNG_URL configurado` : "Suba: docker compose --profile search up -d",
    },
    {
      id: "brave", label: "Brave Search (API)", free: false,
      configured: brave.length > 0,
      detail: brave ? "Chave configurada" : "BRAVE_API_KEY ou Administração → Credenciais",
    },
    {
      id: "tavily", label: "Tavily (API)", free: false,
      configured: tavily.length > 0,
      detail: tavily ? "Chave configurada" : "TAVILY_API_KEY ou Administração → Credenciais",
    },
    {
      id: "google-pse", label: "Google Programmable Search", free: false,
      configured: gpse.length > 0 && cx.length > 0,
      detail:
        gpse.length > 0 && cx.length > 0 ? "Chave + CX configurados"
        : gpse.length > 0 ? "Falta o CX (ID do mecanismo) em Administração → Pesquisa"
        : "GOOGLE_PSE_KEY + CX ou Administração → Credenciais",
    },
  ];
}

export async function searchConfigured(env: Env, db?: DbAdapter): Promise<boolean> {
  if ((env.SEARXNG_URL ?? "").trim()) return true;
  if (!db) {
    return Boolean((env.BRAVE_API_KEY ?? "").trim() || (env.TAVILY_API_KEY ?? "").trim() || (env.GOOGLE_PSE_KEY ?? "").trim());
  }
  const st = await searchProviderStatus(env, db);
  return st.some((s) => s.configured);
}

function clean(s: unknown, max: number, fb = ""): string {
  return typeof s === "string" && s.trim() ? s.trim().slice(0, max) : fb;
}

async function searchSearxng(base: string, q: string, limit: number): Promise<WebResult[]> {
  const url = `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json&language=pt-BR`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "cr-ia/0.2 (+self-hosted)" },
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`SearXNG respondeu HTTP ${res.status}. Tente de novo.`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; engine?: string; publishedDate?: string }>;
  };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: clean(r.title, 200, "(sem título)"),
    url: clean(r.url, 500),
    snippet: clean(r.content, 600),
    engine: clean(r.engine, 60, "searxng"),
    publishedAt: clean(r.publishedDate, 40) || null,
    score: null,
  }));
}

async function searchBrave(base: string, key: string, q: string, limit: number): Promise<WebResult[]> {
  const url = `${base.replace(/\/$/, "")}/res/v1/web/search?q=${encodeURIComponent(q)}&count=${limit}&search_lang=pt-br`;
  const res = await fetch(url, {
    headers: { accept: "application/json", "X-Subscription-Token": key },
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Chave Brave rejeitada (HTTP 401/403). Confira a credencial.");
  if (res.status === 429) throw new Error("Limite da Brave Search atingido (HTTP 429). Aguarde e tente de novo.");
  if (!res.ok) throw new Error(`Brave Search falhou (HTTP ${res.status}).`);
  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
  };
  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: clean(r.title, 200, "(sem título)"),
    url: clean(r.url, 500),
    snippet: clean(r.description, 600),
    engine: "brave",
    publishedAt: clean(r.age, 40) || null,
    score: null,
  }));
}

async function searchTavily(base: string, key: string, q: string, limit: number): Promise<WebResult[]> {
  const res = await fetch(`${base.replace(/\/$/, "")}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: key, query: q, max_results: limit, include_answer: false }),
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 401 || res.status === 403) throw new Error("Chave Tavily rejeitada (HTTP 401/403). Confira a credencial.");
  if (res.status === 429) throw new Error("Limite da Tavily atingido (HTTP 429). Aguarde e tente de novo.");
  if (!res.ok) throw new Error(`Tavily falhou (HTTP ${res.status}).`);
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string; score?: number }>;
  };
  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: clean(r.title, 200, "(sem título)"),
    url: clean(r.url, 500),
    snippet: clean(r.content, 600),
    engine: "tavily",
    publishedAt: clean(r.published_date, 40) || null,
    score: typeof r.score === "number" ? r.score : null,
  }));
}

async function searchGooglePse(base: string, key: string, cx: string, q: string, limit: number): Promise<WebResult[]> {
  const url =
    `${base.replace(/\/$/, "")}/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${Math.min(limit, 10)}&lr=lang_pt`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(25_000),
  });
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new Error(`Google PSE rejeitou a chamada (HTTP ${res.status}). Confira chave e CX.`);
  }
  if (res.status === 429) throw new Error("Limite do Google PSE atingido (HTTP 429). Aguarde e tente de novo.");
  if (!res.ok) throw new Error(`Google PSE falhou (HTTP ${res.status}).`);
  const data = (await res.json()) as {
    items?: Array<{
      title?: string; link?: string; snippet?: string;
      pagemap?: { metatags?: Array<Record<string, string>> };
    }>;
  };
  return (data.items ?? []).slice(0, limit).map((r) => {
    const tags = r.pagemap?.metatags?.[0] ?? {};
    const date = tags["article:published_time"] ?? tags.datepublished ?? tags.publishdate ?? tags["og:updated_time"] ?? "";
    return {
      title: clean(r.title, 200, "(sem título)"),
      url: clean(r.link, 500),
      snippet: clean(r.snippet, 600),
      engine: "google-pse",
      publishedAt: clean(date, 40) || null,
      score: null,
    };
  });
}

export interface WebSearchOpts {
  /** Força um provedor (ou "auto"). */
  provider?: string;
  /**
   * true = BLOCK_PAID_PROVIDERS: provedores pagos (brave/tavily/google-pse)
   * são pulados no modo auto e recusados quando pedidos explicitamente.
   * SearXNG próprio (grátis) continua funcionando.
   */
  paidBlocked?: boolean;
}

const PAID_SEARCH: SearchProviderId[] = ["brave", "tavily", "google-pse"];

/**
 * Busca real. Ordem: provedor explícito > WEB_SEARCH_PROVIDER > primeiro
 * configurado (searxng, brave, tavily, google-pse). Erro claro se nenhum.
 */
export async function webSearch(
  env: Env, db: DbAdapter, query: string, limit = 8, opts: WebSearchOpts = {}
): Promise<WebSearchResponse> {
  const q = query.trim().slice(0, 300);
  if (!q) throw new Error("Informe o termo da busca.");
  const lim = Math.max(1, Math.min(limit, 20));
  // Precedência: parâmetro explícito > painel (search.provider) > env > auto.
  const paidBlocked = opts.paidBlocked ?? false;
  const explicit = (opts.provider ?? "").trim().toLowerCase();
  if (explicit && PAID_SEARCH.includes(explicit as SearchProviderId) && paidBlocked) {
    throw new Error(
      `Busca via "${explicit}" pode gerar custo e está bloqueada pela política BLOCK_PAID_PROVIDERS. ` +
      `Use o SearXNG próprio (grátis) ou libere no painel (Administração → Modelos).`
    );
  }
  if (explicit && explicit !== "auto" && !isSearchProvider(explicit)) {
    throw new Error(`Provedor de busca desconhecido: "${explicit}". Use: ${SEARCH_PROVIDERS.join(", ")}.`);
  }
  let wanted = explicit;
  if (!wanted || wanted === "auto") {
    const fromSetting = ((await db.getSetting("search.provider").catch(() => null)) ?? "").trim().toLowerCase();
    const fromEnv = (env.WEB_SEARCH_PROVIDER ?? "").trim().toLowerCase();
    const pick = fromSetting && fromSetting !== "auto" ? fromSetting
      : fromEnv && fromEnv !== "auto" ? fromEnv : "auto";
    wanted = isSearchProvider(pick) ? pick : "auto";
  }
  const order: SearchProviderId[] =
    wanted && wanted !== "auto"
      ? [wanted as SearchProviderId]
      : SEARCH_PROVIDERS.filter((p) => !paidBlocked || !PAID_SEARCH.includes(p));

  const tried: string[] = [];
  for (const p of order) {
    if (p === "searxng") {
      const base = (env.SEARXNG_URL ?? "").trim();
      if (!base) {
        tried.push("searxng (SEARXNG_URL ausente)");
        continue;
      }
      return { query: q, results: await searchSearxng(base, q, lim), real: true, provider: p };
    }
    const key = await searchKey(env, db, p);
    if (!key) {
      tried.push(`${p} (sem chave)`);
      continue;
    }
    if (p === "brave") {
      const base = (env.BRAVE_BASE_URL ?? "").trim() || "https://api.search.brave.com";
      return { query: q, results: await searchBrave(base, key, q, lim), real: true, provider: p };
    }
    if (p === "tavily") {
      const base = (env.TAVILY_BASE_URL ?? "").trim() || "https://api.tavily.com";
      return { query: q, results: await searchTavily(base, key, q, lim), real: true, provider: p };
    }
    const cx = await googleCx(env, db);
    if (!cx) {
      tried.push("google-pse (sem CX)");
      continue;
    }
    const base = (env.GOOGLE_PSE_BASE_URL ?? "").trim() || "https://www.googleapis.com";
    return { query: q, results: await searchGooglePse(base, key, cx, q, lim), real: true, provider: p };
  }
  throw new Error(
    `Busca web desligada: nenhum provedor configurado (${tried.join("; ") || "nada tentado"}). ` +
    `Suba o SearXNG (docker compose --profile search up -d) ou cadastre uma chave em Administração → Credenciais.`
  );
}

/**
 * Formata resultados como contexto para o chat: citações numeradas, datas e
 * a distinção OBRIGATÓRIA entre fatos da web e conhecimento interno.
 */
export function formatResultsForChat(resp: WebSearchResponse): string {
  if (!resp.results.length) return "Busca web sem resultados.";
  const today = new Date().toISOString().slice(0, 10);
  const lines = resp.results.map((r, i) => {
    const date = r.publishedAt ? ` (publicado: ${r.publishedAt})` : " (data não informada)";
    return `[${i + 1}] ${r.title}${date}\n${r.url}\n${r.snippet}`;
  });
  return (
    `Resultados REAIS da busca web por "${resp.query}" via ${resp.provider} (hoje: ${today}).\n` +
    `REGRAS: fatos destes resultados DEVEM citar as fontes como [1], [2]...; ` +
    `informe a data da fonte quando relevante e avise se puder estar desatualizada; ` +
    `o que NÃO estiver nestes resultados é conhecimento interno (diga isso claramente).\n\n` +
    lines.join("\n\n")
  );
}

/** Heurística de busca automática: pergunta depende de informação recente? */
export function needsWebSearch(text: string): boolean {
  return /\b(hoje|ontem|amanh[ãa]|essa semana|este m[êe]s|atual(mente|izado)?|atualiza|[uú]ltimas? not[íi]cias?|not[íi]cia|pre[çc]o|pre[çc]os|cota[çc][ãa]o|quem ganhou|resultado|placar|lan[çc]ou|lan[çc]amento|anunci|an[úu]ncio|elei[çc][ãa]o|jogo|partida|clima|tempo agora|trending|em alta|breaking|2026|próximos? dias)\b/i.test(
    text.slice(0, 500)
  );
}
