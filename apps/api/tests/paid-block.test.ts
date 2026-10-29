/**
 * BLOCK_PAID_PROVIDERS=true (item 8 da auditoria): NENHUMA chamada que
 * possa gerar cobrança passa — chat pago, busca paga explícita e busca
 * automática caem no grátis ou falham com mensagem honesta. Pagos NUNCA
 * ativam sozinhos: autoSelect pula todos.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { Env } from "../src/types.js";

let stub: Server;
let stubBase = "";
let paidHit = 0;

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        return json(200, {
          results: [{ title: `SX: ${q}`, url: "https://exemplo.com/1", content: "t", engine: "sx" }],
        });
      }
      // Qualquer toque num pago = falha do teste (conta e responde).
      if (url.pathname.startsWith("/paid")) {
        paidHit++;
        return json(200, { web: { results: [] }, results: [], items: [] });
      }
      res.writeHead(404);
      res.end();
    });
    stub.listen(0, "127.0.0.1", () => {
      const a = stub.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "cr-ia-paidblock-"));
let app: ReturnType<typeof createApp>["app"];
let db: ReturnType<typeof createApp>["db"];
let models: ReturnType<typeof createApp>["models"];
let token = "";

async function api(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` };
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}
const postJson = (path: string, obj: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

beforeAll(async () => {
  stubBase = await startStub();
  const env: Env = {
    JWT_SECRET: "segredo-paidblock-com-mais-de-32-chars",
    CREDENTIALS_SECRET: "cofre-paidblock-com-32-chars-ok!!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "true",
    SEARXNG_URL: stubBase,
    // Pagos CONFIGURADOS DE PROPÓSITO (chave fake + base no stub):
    // o bloqueio precisa segurar mesmo com tudo pronto para cobrar.
    BRAVE_API_KEY: "BSA-falsa-paidblock",
    BRAVE_BASE_URL: `${stubBase}/paid-brave`,
    TAVILY_API_KEY: "tvly-falsa-paidblock",
    TAVILY_BASE_URL: `${stubBase}/paid-tavily`,
  };
  ({ app, db, models } = createApp(env));
  await db.init();
  await db.createUser({ email: "p@teste.com", name: "P", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "p@teste.com", password: "Senha123!" }),
  });
  token = ((await login.json()) as { data: { token: string } }).data.token;
  // Chave paga no cofre (OpenAI) — autoSelect deve ignorar.
  await postJson("/api/admin/credentials", { provider: "openai", key: "sk-falsa-paidblock-123" });
}, 60_000);

afterAll(async () => {
  await db?.close().catch(() => undefined);
  stub?.close();
});

describe("bloqueio de pagos (BLOCK=true)", () => {
  it("busca paga explícita é recusada (503 honesto)", async () => {
    for (const provider of ["brave", "tavily"]) {
      const r = await postJson("/api/ai/search", { q: "preço do café", provider });
      expect(r.status).toBe(503);
      expect(r.body.error).toMatch(/BLOCK_PAID/);
    }
  });

  it("busca auto pula os pagos e usa o SearXNG grátis", async () => {
    const r = await postJson("/api/ai/search", { q: "preço do café" });
    expect(r.status).toBe(200);
    expect((r.body.data as { provider: string }).provider).toBe("searxng");
  });

  it("busca automática do chat usa SearXNG (nunca pago)", async () => {
    const r = await postJson("/api/chat/completions", {
      messages: [{ role: "user", content: "qual o preço do café hoje?" }],
    });
    expect(r.status).toBe(200);
    expect((r.body.data as { webUsed: { provider: string } }).webUsed.provider).toBe("searxng");
  });

  it("chat pago explícito é recusado", async () => {
    const r = await postJson("/api/chat/completions", {
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "oi" }],
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/BLOCK_PAID/);
  });

  it("autoSelect NUNCA escolhe pago sozinho", async () => {
    expect(await models.autoSelectText("chat")).toBe("mock-cr-1");
    expect(await models.autoSelectImage()).toBe("local-svg-1");
  });

  it("NENHUM endpoint pago foi tocado (contador do stub)", () => {
    expect(paidHit).toBe(0);
  });

  it("uso web-search grátis sai com costFlag=false", async () => {
    const s = await api("/api/admin/usage?days=1");
    const rows = (s.body.data as { rows: { modelId: string; count: number }[] }).rows;
    const web = rows.filter((r) => r.modelId.startsWith("search:"));
    expect(web.length).toBeGreaterThan(0);
    expect(web.every((r) => r.modelId === "search:searxng")).toBe(true);
  });
});
