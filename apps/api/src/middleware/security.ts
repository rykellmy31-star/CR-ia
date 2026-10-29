/**
 * Segurança HTTP: cabeçalhos + rate limiting.
 * - Cabeçalhos: defesa em profundidade (a API só serve JSON/arquivos).
 * - Rate limit: em memória por instância. Suficiente para VPS single-instance;
 *   em múltiplas réplicas, complemente com o rate limit da Cloudflare (WAF).
 */
import { createMiddleware } from "hono/factory";

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  const nodeEnv = ((c.env ?? {}) as { NODE_ENV?: string }).NODE_ENV ?? "";
  if (nodeEnv === "production") {
    // Produção opera sempre sob HTTPS (Caddy/Cloudflare).
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
});

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  /** Janela em ms. */
  windowMs: number;
  /** Máximo de requisições por IP+janela. */
  max: number;
  keyPrefix: string;
}

/** Limite por IP (respeita X-Real-IP/X-Forwarded-For do Nginx/Caddy). */
export function rateLimit(opts: RateLimitOptions) {
  return createMiddleware(async (c, next) => {
    const fwd = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = c.req.header("x-real-ip")?.trim() || fwd || "unknown";
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now >= b.resetAt) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;

    // Limpeza oportunista para não crescer sem limite
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (v.resetAt < now) buckets.delete(k);
      }
    }

    c.header("X-RateLimit-Remaining", String(Math.max(0, opts.max - b.count)));
    if (b.count > opts.max) {
      return c.json(
        { ok: false, error: "Muitas tentativas. Aguarde um pouco e tente de novo.", code: "RATE_LIMITED" },
        429
      );
    }
    await next();
  });
}

/** Limites padrão das rotas sensíveis de autenticação. */
export const authRateLimit = rateLimit({ windowMs: 60_000, max: 20, keyPrefix: "auth" });
export const recoverRateLimit = rateLimit({ windowMs: 3_600_000, max: 5, keyPrefix: "recover" });

/** Uso em testes: zera os contadores. */
export function _resetRateLimits(): void {
  buckets.clear();
}
