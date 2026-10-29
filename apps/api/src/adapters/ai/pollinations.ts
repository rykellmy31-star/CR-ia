/**
 * Adaptador Pollinations — geração REAL de imagens via nuvem gratuita (FLUX).
 *
 * LIMITES REAIS da camada gratuita clássica (verificados na APIDOCS, out/2026):
 * - 1 imagem por vez, mínimo ~45s entre pedidos por IP;
 * - além do limite: HTTP 402 + cabeçalho Retry-After;
 * - sem SLA (best-effort), JPEG com logo, URLs públicas com cache;
 * - filtros de segurança; termos de uso e privacidade do serviço se aplicam.
 * Uma chave de enter.pollinations.ai remove o limite por IP e o logo.
 *
 * Este adaptador respeita os limites de verdade:
 * - espaçamento mínimo de 60s entre chamadas (sem chave);
 * - honra Retry-After em 402/429 (aguarda e tenta 1x);
 * - nunca finge que a imagem demo (SVG) é IA real — o fallback é explícito.
 *
 * PRIVACIDADE: o prompt é enviado ao serviço externo. Vem DESLIGADO por
 * padrão no código; o deploy ativa via ENABLE_POLLINATIONS=true
 * (consentimento do administrador no .env). Não envie dados sensíveis.
 */
import type { ImageAdapter, ImageGenOptions, ImageGenResult } from "./types.js";

export const POLLINATIONS_MODEL_ID = "pollinations-flux";
const MODELS_URL = "https://image.pollinations.ai/models";
const PING_CACHE_MS = 120_000;
const MIN_INTERVAL_MS = 60_000;
const MAX_WAIT_MS = 120_000;

let pingCache: { at: number; ok: boolean } | null = null;
let lastGenerateAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Erro com tempo de espera sugerido pelo provedor (para a UI exibir). */
export class RateLimitError extends Error {
  retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Zera o estado interno (uso em testes). */
export function __resetPollinationsState(): void {
  pingCache = null;
  lastGenerateAt = 0;
}

export class PollinationsImageAdapter implements ImageAdapter {
  readonly provider = "pollinations";
  private enabled: boolean;
  private model: string;
  private apiKey: string;

  constructor(enabled = false, model = "flux", apiKey = "") {
    this.enabled = enabled;
    this.model = model;
    this.apiKey = apiKey;
  }

  models(): string[] {
    return this.enabled ? [POLLINATIONS_MODEL_ID] : [];
  }

  /** Disponibilidade REAL: consulta a lista de modelos (leve, com cache). */
  async ping(): Promise<boolean> {
    if (!this.enabled) return false;
    const now = Date.now();
    if (pingCache && now - pingCache.at < PING_CACHE_MS) return pingCache.ok;
    try {
      const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(8000) });
      const ok = res.ok;
      pingCache = { at: now, ok };
      return ok;
    } catch {
      pingCache = { at: now, ok: false };
      return false;
    }
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (!this.enabled) {
      throw new Error(
        "Geração externa desligada: o administrador desativou ENABLE_POLLINATIONS. " +
        "Use o modelo local-svg-1 (demonstração) ou ative um provedor de imagens."
      );
    }

    // Espaçamento mínimo entre chamadas (camada gratuita, sem chave).
    if (!this.apiKey) {
      const wait = MIN_INTERVAL_MS - (Date.now() - lastGenerateAt);
      if (wait > 0) await sleep(Math.min(wait, MAX_WAIT_MS));
    }

    const attempt = async (): Promise<Response> => {
      const seed = opts.seed ?? Math.floor(Math.random() * 1_000_000_000);
      // Sem chave: a camada gratuita inclui logo — não pedimos nologo (honesto).
      // URLs iguais retornam a mesma imagem (cache público); o seed varia.
      const url =
        `https://image.pollinations.ai/prompt/${encodeURIComponent(opts.prompt)}` +
        `?width=${opts.width}&height=${opts.height}&seed=${seed}` +
        `&model=${encodeURIComponent(this.model)}` +
        (this.apiKey ? "&nologo=true&private=true" : "&private=true");
      const headers: Record<string, string> = {
        "user-agent": "cr-ia/0.2 (+self-hosted)",
        accept: "image/*",
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      return fetch(url, {
        headers,
        signal: opts.signal ?? AbortSignal.timeout(180_000),
      });
    };

    let res = await attempt();
    // 402/429 com Retry-After: espera o tempo pedido e tenta UMA vez.
    if (res.status === 402 || res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "60");
      const waitSec = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 180) : 60;
      await sleep(waitSec * 1000);
      res = await attempt();
      if (res.status === 402 || res.status === 429) {
        const again = Number(res.headers.get("retry-after") ?? String(waitSec));
        throw new RateLimitError(
          `Limite gratuito da nuvem de imagens atingido (HTTP ${res.status}). ` +
          `Aguarde ~${Math.ceil(Number.isFinite(again) ? again : waitSec)}s e tente de novo — ` +
          `ou use outra imagem/modelo.`,
          Math.ceil(Number.isFinite(again) ? again : waitSec)
        );
      }
    }
    lastGenerateAt = Date.now();

    if (!res.ok) {
      throw new Error(`Provedor de imagens HTTP ${res.status}. Tente de novo em instantes.`);
    }
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) {
      throw new Error(`Provedor retornou conteúdo inesperado (${mime || "desconhecido"}).`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength < 1024) {
      throw new Error("Provedor retornou imagem vazia.");
    }
    return { data: buf, mime, model: POLLINATIONS_MODEL_ID, paid: false };
  }
}
