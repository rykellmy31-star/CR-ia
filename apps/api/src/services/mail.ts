/**
 * CR IA v0.2.0 — e-mail transacional (recuperação de senha).
 * Usa o SMTP do cliente (nodemailer). Sem SMTP configurado, retorna null e
 * o chamador usa o fallback documentado (token no log + painel admin).
 */
import type { Env } from "../types.js";

export interface MailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export function smtpConfigured(env: Env): boolean {
  return Boolean((env.SMTP_HOST ?? "").trim());
}

/** Envia e-mail. Retorna true se enviou, false se SMTP ausente (fallback). */
export async function sendMail(env: Env, input: MailInput): Promise<boolean> {
  const host = (env.SMTP_HOST ?? "").trim();
  if (!host) return false;
  const port = Number(env.SMTP_PORT ?? "587") || 587;
  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? "" } : undefined,
  });
  await transporter.sendMail({
    from: env.SMTP_FROM ?? "CR IA <nao-responda@crjornada.com>",
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  return true;
}

export function recoveryMail(name: string, resetUrl: string): { subject: string; text: string; html: string } {
  return {
    subject: "CR IA — recuperação de acesso",
    text:
      `Olá, ${name}!\n\n` +
      `Você pediu para recuperar o acesso à CR IA. Use o link abaixo (válido por 1 hora, uso único):\n\n` +
      `${resetUrl}\n\n` +
      `Se não foi você, ignore esta mensagem e avise o administrador.\n`,
    html:
      `<p>Olá, <strong>${escapeHtml(name)}</strong>!</p>` +
      `<p>Você pediu para recuperar o acesso à <strong>CR IA</strong>. ` +
      `Clique no link abaixo (válido por 1 hora, uso único):</p>` +
      `<p><a href="${escapeHtml(resetUrl)}">Definir nova senha</a></p>` +
      `<p>Se não foi você, ignore esta mensagem e avise o administrador.</p>`,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
}
