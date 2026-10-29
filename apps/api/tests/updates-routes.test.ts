/**
 * Rotas da Central de Atualizações: admin-only, status sem manifesto,
 * stage/apply fail-closed. App Hono real + banco JSON temporário.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-updroutes-"));
const env: Env = {
  JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
  DB_DRIVER: "json",
  JSON_DB_PATH: join(dir, "db.json"),
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: join(dir, "uploads"),
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
  UPDATES_DIR: join(dir, "updates"),
};

const { app, db } = createApp(env);

async function api(path: string, init?: RequestInit, token?: string) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}

let adminToken = "";
let guestToken = "";
beforeAll(async () => {
  await db.init();
  await db.createUser({ email: "a@t.com", name: "A", role: "admin", passwordHash: await hashPassword("Admin123!", 4) });
  await db.createUser({ email: "g@t.com", name: "G", role: "guest", passwordHash: await hashPassword("Guest123!", 4) });
  const login = async (email: string, password: string) =>
    (await api("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })).body.data as { token: string };
  adminToken = (await login("a@t.com", "Admin123!")).token;
  guestToken = (await login("g@t.com", "Guest123!")).token;
});

describe("rotas /admin/updates", () => {
  it("exigem admin (guest e anônimo barrados)", async () => {
    expect((await api("/api/admin/updates/status")).status).toBe(401);
    expect((await api("/api/admin/updates/status", undefined, guestToken)).status).toBe(403);
    const r = await api("/api/admin/updates/apply", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "x" }),
    }, guestToken);
    expect(r.status).toBe(403);
  });

  it("status sem manifesto: configured=false honesto", async () => {
    const r = await api("/api/admin/updates/status", undefined, adminToken);
    expect(r.status).toBe(200);
    expect(r.body.data?.configured).toBe(false);
    expect(r.body.data?.current).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("stage sem manifesto: 400; apply sem recibo: 500 com motivo", async () => {
    const s = await api("/api/admin/updates/stage", { method: "POST" }, adminToken);
    expect(s.status).toBe(400);
    const a = await api("/api/admin/updates/apply", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "9.9.9" }),
    }, adminToken);
    expect(a.status).toBe(500);
    expect(String(a.body.error)).toMatch(/NÃO está preparada/);
  });
});
