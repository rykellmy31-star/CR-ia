/** Leitura tipada e segura das variáveis de ambiente. */
import type { Env } from "../types.js";

export function getEnv(c: { env: Env }, key: keyof Env, fallback = ""): string {
  const v = c.env?.[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

export function getBool(c: { env: Env }, key: keyof Env, fallback = false): boolean {
  const v = getEnv(c, key, "");
  if (v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function getNum(c: { env: Env }, key: keyof Env, fallback: number): number {
  const raw = getEnv(c, key, "");
  if (raw === "") return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export function csv(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

export function requireJwtSecret(env: Env): string {
  const s = env.JWT_SECRET;
  if (!s || s.length < 16) {
    throw new Error("JWT_SECRET ausente ou fraco: defina um segredo com 32+ caracteres.");
  }
  return s;
}
