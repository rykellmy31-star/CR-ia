/** Rotas de autenticação: login, sessão, troca e recuperação de senha. */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { hashPassword, opaqueToken, signToken, verifyPassword } from "../lib/crypto.js";
import { fail, ok } from "../lib/respond.js";
import { toPublicUser } from "../adapters/db/types.js";
import { bumpTokenVersion, currentTokenVersion, requireAuth } from "../middleware/auth.js";
import { authRateLimit, recoverRateLimit } from "../middleware/security.js";
import { getNum } from "../lib/config.js";

export const authRoutes = new Hono<{ Bindings: Env }>();

const loginSchema = z.object({
  email: z.string().email("E-mail inválido."),
  password: z.string().min(1, "Informe a senha."),
});

authRoutes.post("/login", authRateLimit, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const rec = await db.getUserByEmail(parsed.data.email);
  if (!rec || !(await verifyPassword(parsed.data.password, rec.passwordHash))) {
    await db.logAudit({ userId: null, action: "auth.login.failed", detail: parsed.data.email });
    return fail(c, "E-mail ou senha incorretos.", 401, "BAD_CREDENTIALS");
  }
  if (rec.blocked) return fail(c, "Conta bloqueada. Fale com o administrador.", 403, "BLOCKED");

  const token = await signToken(
    { id: rec.id, email: rec.email, name: rec.name, role: rec.role },
    c.env.JWT_SECRET,
    c.env.JWT_EXPIRES_IN ?? "12h",
    await currentTokenVersion(db)
  );
  await db.logAudit({ userId: rec.id, action: "auth.login", detail: rec.email });
  return ok(c, { token, user: toPublicUser(rec) });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  return ok(c, { user });
});

authRoutes.post("/change-password", requireAuth, async (c) => {
  const schema = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8, "A nova senha deve ter ao menos 8 caracteres."),
  });
  const body = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const user = c.get("user");
  const rec = await db.getUserById(user.id);
  if (!rec || !(await verifyPassword(parsed.data.currentPassword, rec.passwordHash))) {
    return fail(c, "Senha atual incorreta.", 401);
  }
  const cost = getNum(c, "BCRYPT_COST", 10);
  await db.updateUser(user.id, { passwordHash: await hashPassword(parsed.data.newPassword, cost) });
  // Troca de senha invalida todas as sessões (inclusive em outros aparelhos).
  await bumpTokenVersion(db);
  await db.logAudit({ userId: user.id, action: "auth.password_changed", detail: user.email });
  return ok(c, { changed: true, reLoginRequired: true });
});

const recoverSchema = z.object({ email: z.string().email("E-mail inválido.") });

authRoutes.post("/recover", recoverRateLimit, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = recoverSchema.safeParse(body);
  if (!parsed.success) return fail(c, "E-mail inválido.", 400);

  const db = c.get("db");
  const rec = await db.getUserByEmail(parsed.data.email);
  // Resposta genérica anti-enumeração (não revela se o e-mail existe).
  // O token substitui qualquer anterior (uso único) e dura 1h.
  let emailed = false;
  if (rec) {
    const token = opaqueToken();
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.updateUser(rec.id, { resetToken: token, resetExpiresAt: expires });
    await db.logAudit({ userId: rec.id, action: "auth.recover.requested", detail: `expira=${expires}` });
    // SMTP configurado → envia link real. Sem SMTP → fallback documentado
    // (token no log + painel admin), apenas fora de produção.
    const { recoveryMail, sendMail, smtpConfigured } = await import("../services/mail.js");
    if (smtpConfigured(c.env)) {
      const base = (c.env.PUBLIC_API_URL ?? "").replace(/\/api\/?$/, "") || "https://ia.crjornada.com";
      const resetUrl = `${base}/recuperar?email=${encodeURIComponent(rec.email)}&token=${encodeURIComponent(token)}`;
      const mail = recoveryMail(rec.name, resetUrl);
      try {
        emailed = await sendMail(c.env, { to: rec.email, ...mail });
      } catch (e) {
        console.error("[CR IA] SMTP falhou:", e instanceof Error ? e.message : e);
      }
      if (!emailed) {
        console.error(`[CR IA] SMTP configurado mas falhou para ${rec.email} — token no painel admin.`);
        await db.logAudit({ userId: rec.id, action: "auth.recover.smtp_failed", detail: `token=${token}` });
      }
    } else {
      await db.logAudit({ userId: rec.id, action: "auth.recover.token_issued", detail: `token=${token} expira=${expires}` });
      console.log(`[CR IA] Recuperação de acesso para ${rec.email}: token=${token} (válido 1h; SMTP não configurado)`);
    }
  }
  return ok(c, {
    sent: true,
    hint: emailed
      ? "Se o e-mail existir, enviamos um link de recuperação (válido 1h)."
      : "Se o e-mail existir, um token de recuperação foi gerado. Sem SMTP configurado, o administrador informa o token (ver logs do servidor).",
  });
});

const resetSchema = z.object({
  email: z.string().email(),
  token: z.string().min(8),
  newPassword: z.string().min(8, "A nova senha deve ter ao menos 8 caracteres."),
});

authRoutes.post("/reset", recoverRateLimit, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const rec = await db.getUserByEmail(parsed.data.email);
  if (
    !rec || !rec.resetToken || rec.resetToken !== parsed.data.token ||
    !rec.resetExpiresAt || rec.resetExpiresAt < new Date().toISOString()
  ) {
    await db.logAudit({ userId: null, action: "auth.recover.failed", detail: parsed.data.email });
    return fail(c, "Token inválido ou expirado.", 400, "BAD_RESET_TOKEN");
  }
  const cost = getNum(c, "BCRYPT_COST", 10);
  await db.updateUser(rec.id, {
    passwordHash: await hashPassword(parsed.data.newPassword, cost),
    resetToken: null,
    resetExpiresAt: null,
  });
  // Recuperação concluída = possível comprometimento: derruba todas as sessões.
  await bumpTokenVersion(db);
  await db.logAudit({ userId: rec.id, action: "auth.recover.completed", detail: rec.email });
  return ok(c, { reset: true });
});
