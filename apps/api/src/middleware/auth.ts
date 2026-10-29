/** Autenticação JWT + guardas de papel (admin), usuário ativo e versão do token. */
import { createMiddleware } from "hono/factory";
import type { AuthUser, Env } from "../types.js";
import { verifyToken } from "../lib/crypto.js";
import type { DbAdapter } from "../adapters/db/types.js";

declare module "hono" {
  interface ContextVariableMap {
    user: AuthUser;
    db: DbAdapter;
  }
}

export const TOKEN_VERSION_KEY = "auth.tokenVersion";

export async function currentTokenVersion(db: DbAdapter): Promise<number> {
  const raw = await db.getSetting(TOKEN_VERSION_KEY);
  const v = Number(raw ?? 1);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

/** Invalida TODAS as sessões (incrementa a versão global). */
export async function bumpTokenVersion(db: DbAdapter): Promise<number> {
  const next = (await currentTokenVersion(db)) + 1;
  await db.setSetting(TOKEN_VERSION_KEY, String(next));
  return next;
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const token = bearerToken(c.req.header("authorization"));
  if (!token) return c.json({ ok: false, error: "Não autenticado. Faça login.", code: "UNAUTHENTICATED" }, 401);
  const user = await verifyToken(token, c.env.JWT_SECRET);
  if (!user) return c.json({ ok: false, error: "Sessão inválida ou expirada. Faça login novamente.", code: "BAD_TOKEN" }, 401);

  const db = c.get("db") as DbAdapter;

  // Revogação global de sessões (ex.: após incidente ou troca de senha)
  const current = await currentTokenVersion(db);
  if (user.tokenVersion !== current) {
    return c.json({ ok: false, error: "Sessão revogada. Faça login novamente.", code: "SESSION_REVOKED" }, 401);
  }

  const rec = await db.getUserById(user.id);
  if (!rec || rec.blocked) {
    return c.json({ ok: false, error: "Conta bloqueada ou inexistente. Fale com o administrador.", code: "BLOCKED" }, 403);
  }
  c.set("user", { id: rec.id, email: rec.email, name: rec.name, role: rec.role });
  await next();
});

export const requireAdmin = createMiddleware(async (c, next) => {
  const user = c.get("user") as AuthUser;
  if (user.role !== "admin") {
    return c.json({ ok: false, error: "Acesso restrito ao administrador.", code: "FORBIDDEN" }, 403);
  }
  await next();
});
