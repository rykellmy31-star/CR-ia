/** Controle de uso por modelo+usuário, monitoramento e e-mail de recuperação. */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import { recoveryMail, sendMail, smtpConfigured } from "../src/services/mail.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-usage-"));
const env: Env = {
  JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
  NODE_ENV: "test",
  DB_DRIVER: "json",
  JSON_DB_PATH: join(dir, "db.json"),
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: join(dir, "uploads"),
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
  DAILY_LIMIT_CHAT: "2",
  DAILY_LIMIT_IMAGES: "50",
};

const { app, db } = createApp(env);
let adminToken = "";
let guestToken = "";

async function api(path: string, init?: RequestInit, token?: string) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}

beforeAll(async () => {
  await db.init();
  await db.createUser({ email: "a@t.com", name: "A", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  await db.createUser({ email: "g@t.com", name: "G", role: "guest", passwordHash: await hashPassword("Senha123!", 4) });
  for (const [email, set] of [["a@t.com", (t: string) => { adminToken = t; }], ["g@t.com", (t: string) => { guestToken = t; }]] as const) {
    const r = await api("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Senha123!" }),
    });
    set((r.body.data as { token: string }).token);
  }
});

describe("cotas e breakdown de uso", () => {
  it("limite diário de chat é imposto por usuário", async () => {
    const msg = { messages: [{ role: "user", content: "oi" }] };
    const h = { "content-type": "application/json" };
    expect((await api("/api/chat/completions", { method: "POST", headers: h, body: JSON.stringify(msg) }, guestToken)).status).toBe(200);
    expect((await api("/api/chat/completions", { method: "POST", headers: h, body: JSON.stringify(msg) }, guestToken)).status).toBe(200);
    const third = await api("/api/chat/completions", { method: "POST", headers: h, body: JSON.stringify(msg) }, guestToken);
    expect(third.status).toBe(429);
    expect(third.body.error).toContain("Limite diário");
    // Outro usuário não é afetado
    expect((await api("/api/chat/completions", { method: "POST", headers: h, body: JSON.stringify(msg) }, adminToken)).status).toBe(200);
  });

  it("/admin/usage mostra breakdown por usuário+modelo e consumo de hoje", async () => {
    const r = await api("/api/admin/usage", undefined, adminToken);
    expect(r.status).toBe(200);
    const data = r.body.data as {
      limits: { chat: number };
      rows: { email: string; modelId: string; kind: string; count: number }[];
      todayUsage: Record<string, { email: string; chat: number }>;
    };
    expect(data.limits.chat).toBe(2);
    const guest = data.rows.find((x) => x.email === "g@t.com" && x.kind === "chat");
    expect(guest?.count).toBe(2);
    const today = Object.values(data.todayUsage).find((x) => x.email === "g@t.com");
    expect(today?.chat).toBe(2);
  });

  it("/admin/usage exige admin", async () => {
    expect((await api("/api/admin/usage", undefined, guestToken)).status).toBe(403);
  });
});

describe("monitoramento", () => {
  it("/admin/system retorna métricas reais do processo/SO/banco", async () => {
    const r = await api("/api/admin/system", undefined, adminToken);
    expect(r.status).toBe(200);
    const s = r.body.data as {
      node: { version: string; heapUsedMB: number };
      os: { totalMemMB: number; freeMemMB: number };
      database: { driver: string; tables: Record<string, number> };
    };
    expect(s.node.version).toBe(process.version);
    expect(s.node.heapUsedMB).toBeGreaterThan(0);
    expect(s.os.totalMemMB).toBeGreaterThan(0);
    expect(s.database.driver).toBe("json");
    expect(s.database.tables.users).toBe(2);
  });
});

describe("e-mail de recuperação", () => {
  it("sem SMTP: sendMail retorna false (fallback) e recover gera token", async () => {
    expect(smtpConfigured(env)).toBe(false);
    expect(await sendMail(env, { to: "a@t.com", subject: "x", text: "y" })).toBe(false);
    const r = await api("/api/auth/recover", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@t.com" }),
    });
    expect(r.status).toBe(200);
    const rec = await db.getUserByEmail("a@t.com");
    expect(rec?.resetToken).toBeTruthy();
  });

  it("recoveryMail monta link com token", () => {
    const m = recoveryMail("Ana", "https://x/recuperar?email=a&token=ABC");
    expect(m.subject).toContain("recuperação");
    expect(m.text).toContain("ABC");
    expect(m.html).toContain("https://x/recuperar");
  });
});
