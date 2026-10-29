/**
 * Homologação SearXNG REAL (item 10 da auditoria): roda SOMENTE com
 * LIVE_SEARXNG_URL apontando para um SearXNG de verdade
 * (ex.: LIVE_SEARXNG_URL=http://127.0.0.1:8888).
 * Prova o caminho completo: rota → websearch → HTTP → SearXNG real.
 * Pulado por padrão (CI/sandbox sem SearXNG).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { Env } from "../src/types.js";

const LIVE_URL = (process.env.LIVE_SEARXNG_URL ?? "").trim();
const LIVE = LIVE_URL.length > 0;

describe.runIf(LIVE)("SearXNG ao vivo (LIVE_SEARXNG_URL)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cr-ia-live-sx-"));
  let app: ReturnType<typeof createApp>["app"];
  let db: ReturnType<typeof createApp>["db"];
  let token = "";

  beforeAll(async () => {
    const env: Env = {
      JWT_SECRET: "segredo-live-searxng-com-mais-de-32-chars",
      NODE_ENV: "test",
      DB_DRIVER: "json",
      JSON_DB_PATH: join(dir, "db.json"),
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: join(dir, "uploads"),
      CHAT_PROVIDER: "mock",
      IMAGE_PROVIDER: "mock-svg",
      BLOCK_PAID_PROVIDERS: "true",
      SEARXNG_URL: LIVE_URL,
    };
    ({ app, db } = createApp(env));
    await db.init();
    await db.createUser({ email: "live@teste.com", name: "L", role: "user", passwordHash: await hashPassword("Senha123!", 4) });
    const login = await app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "live@teste.com", password: "Senha123!" }),
    });
    token = ((await login.json()) as { data: { token: string } }).data.token;
  });

  afterAll(async () => {
    await db?.close().catch(() => undefined);
  });

  it("busca informação atual e devolve resultados com fonte", async () => {
    const res = await app.request("/api/ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ q: "cotação dólar hoje", limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { real: boolean; provider: string; results: { title: string; url: string; engine: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.real).toBe(true);
    expect(body.data.provider).toBe("searxng");
    expect(body.data.results.length).toBeGreaterThan(0);
    expect(body.data.results[0].url).toMatch(/^https?:\/\//);
    expect(body.data.results[0].engine.length).toBeGreaterThan(0);
  }, 90_000);

  it("status mostra o SearXNG configurado", async () => {
    const res = await app.request("/api/ai/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as {
      data: { webSearch: boolean; searchProviders: { id: string; configured: boolean }[] };
    };
    expect(body.data.webSearch).toBe(true);
    expect(body.data.searchProviders.find((p) => p.id === "searxng")?.configured).toBe(true);
  }, 30_000);
});

describe.skipIf(LIVE)("SearXNG ao vivo (pulando — sem LIVE_SEARXNG_URL)", () => {
  it("placeholder documenta como homologar", () => {
    expect("LIVE_SEARXNG_URL=http://127.0.0.1:8888 npm test -- live-searxng").toContain("LIVE_SEARXNG_URL");
  });
});
