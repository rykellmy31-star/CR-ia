/**
 * Provedores GRATUITOS por chave (Groq + OpenRouter): contratos OpenAI-
 * compatíveis contra STUBS HTTP reais — headers, cotas (429), 402,
 * status "limited", imunidade ao BLOCK_PAID e ordem de seleção.
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
let seenReferer = "";
let seenTitle = "";

const GROQ_KEY = "K-GROQ-TESTES-123";
const OR_KEY = "K-OR-TESTES-12345";

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      };
      const body = () =>
        new Promise<string>((done) => {
          let b = "";
          req.on("data", (c) => { b += c; });
          req.on("end", () => done(b));
        });
      // ---- Groq fake ----
      if (url.pathname === "/groq/models") {
        if (req.headers.authorization !== `Bearer ${GROQ_KEY}`) return json(401, { error: "bad key" });
        return json(200, { data: [{ id: "openai/gpt-oss-20b" }] });
      }
      if (url.pathname === "/groq/chat/completions" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${GROQ_KEY}`) return json(401, { error: "bad key" });
        return void body().then((b) => {
          const m = (JSON.parse(b) as { model?: string }).model ?? "";
          if (m === "rate-limited") return json(429, { error: "slow down" }, { "retry-after": "7" });
          json(200, {
            choices: [{ message: { content: `groq responde (${m})` } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        });
      }
      // ---- OpenRouter fake ----
      if (url.pathname === "/or/models") {
        seenReferer = String(req.headers["http-referer"] ?? "");
        seenTitle = String(req.headers["x-title"] ?? "");
        if (req.headers.authorization !== `Bearer ${OR_KEY}`) return json(401, { error: "bad key" });
        return json(200, { data: [{ id: "x/y:free" }] });
      }
      if (url.pathname === "/or/chat/completions" && req.method === "POST") {
        seenReferer = String(req.headers["http-referer"] ?? "");
        seenTitle = String(req.headers["x-title"] ?? "");
        if (req.headers.authorization !== `Bearer ${OR_KEY}`) return json(401, { error: "bad key" });
        return void body().then((b) => {
          const m = (JSON.parse(b) as { model?: string }).model ?? "";
          if (m === "broke-model") return json(402, { error: "insufficient credits" });
          if (m === "gone:free") return json(404, { error: "no such model" });
          json(200, {
            choices: [{ message: { content: `openrouter responde (${m})` } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          });
        });
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

const dir = mkdtempSync(join(tmpdir(), "cr-ia-free-"));
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
    JWT_SECRET: "segredo-testes-free-com-mais-de-32-chars",
    CREDENTIALS_SECRET: "cofre-testes-free-com-32-chars-ok!!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "true",
    GROQ_BASE_URL: `${stubBase}/groq`,
    OPENROUTER_BASE_URL: `${stubBase}/or`,
    OPENROUTER_MODELS: "x/y:free",
  };
  ({ app, db, models } = createApp(env));
  await db.init();
  await db.createUser({ email: "f@teste.com", name: "F", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "f@teste.com", password: "Senha123!" }),
  });
  token = ((await login.json()) as { data: { token: string } }).data.token;
}, 60_000);

afterAll(async () => {
  await db?.close().catch(() => undefined);
  stub?.close();
});

describe("credenciais grátis (cofre)", () => {
  it("status separa free de paid e mostra cotas", async () => {
    const r = await api("/api/admin/credentials");
    expect(r.status).toBe(200);
    const d = r.body.data as {
      credentials: { provider: string }[];
      free: { provider: string; configured: boolean; limits: string; masked: string | null }[];
    };
    expect(d.credentials.map((c) => c.provider)).toContain("openai");
    expect(d.free.map((c) => c.provider).sort()).toEqual(["groq", "nvidia", "openrouter"]);
    expect(d.free.every((c) => !c.configured)).toBe(true);
    expect(d.free.some((c) => c.limits.includes("req/min"))).toBe(true);
  });

  it("guarda chave grátis CIFRADA (banco nunca tem o texto puro)", async () => {
    const s = await postJson("/api/admin/credentials", { provider: "groq", key: GROQ_KEY });
    expect(s.status).toBe(200);
    expect((s.body.data as { masked: string }).masked).not.toContain(GROQ_KEY);
    const raw = await db.getSetting("cred.groq");
    expect(raw).toBeTruthy();
    expect(raw).not.toContain(GROQ_KEY);
    // E resolve de volta para a chamada real.
    const st = await api("/api/admin/credentials");
    const g = ((st.body.data as { free: { provider: string; configured: boolean }[] }).free)
      .find((c) => c.provider === "groq");
    expect(g?.configured).toBe(true);
  });
});

describe("Groq (stub OpenAI-compatível)", () => {
  it("chat funciona e NÃO marca custo (paid=false)", async () => {
    const r = await postJson("/api/chat/completions", {
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: "oi" }],
    });
    expect(r.status).toBe(200);
    const d = r.body.data as { message: { content: string }; usage: { paid: boolean } };
    expect(d.message.content).toContain("groq responde");
    expect(d.usage.paid).toBe(false);
  });

  it("status é 'limited' com cotas (não 'installed')", async () => {
    const r = await api("/api/models");
    const list = (r.body.data as { models: { id: string; status: string; cost: string; paid: boolean; limits?: string }[] }).models;
    const g = list.find((m) => m.id === "openai/gpt-oss-20b")!;
    expect(g.status).toBe("limited");
    expect(g.cost).toBe("free-tier");
    expect(g.limits).toContain("req/min");
    expect(g.paid).toBe(false);
  });

  it("429 vira erro de cota (não quebra como 500)", async () => {
    const a = models.findTextAdapter("openai/gpt-oss-20b")!;
    await expect(a.chat({ model: "rate-limited", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(/Limite do provedor groq/);
  });

  it("BLOCK_PAID_PROVIDERS=true NÃO bloqueia o grátis", () => {
    expect(models.blockPaid()).toBe(true);
    expect(models.isPaidModel("openai/gpt-oss-20b")).toBe(false);
    expect(() => models.assertUsable("openai/gpt-oss-20b")).not.toThrow();
    expect(models.isPaidModel("gpt-5-mini")).toBe(true);
    expect(() => models.assertUsable("gpt-5-mini")).toThrow(/BLOCK_PAID/);
  });
});

describe("OpenRouter (stub + headers)", () => {
  it("envia HTTP-Referer e X-Title e responde $0", async () => {
    await postJson("/api/admin/credentials", { provider: "openrouter", key: OR_KEY });
    const r = await postJson("/api/chat/completions", {
      model: "x/y:free",
      messages: [{ role: "user", content: "oi" }],
    });
    expect(r.status).toBe(200);
    expect((r.body.data as { usage: { paid: boolean } }).usage.paid).toBe(false);
    expect(seenReferer).toContain("http");
    expect(seenTitle).toBe("CR IA");
  });

  it("402 explica créditos sem culpar a CR IA", async () => {
    const a = models.findTextAdapter("x/y:free")!;
    await expect(a.chat({ model: "broke-model", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(/402.*nunca compra créditos/);
  });

  it("404 de modelo retirado dá mensagem de ID inválido", async () => {
    const a = models.findTextAdapter("x/y:free")!;
    await expect(a.chat({ model: "gone:free", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(/não existe/);
  });

  it("modelo :free do env aparece limited; genérico documenta o rotativo", async () => {
    const r = await api("/api/models");
    const list = (r.body.data as { models: { id: string; status: string; cost: string; requirements?: string }[] }).models;
    expect(list.find((m) => m.id === "x/y:free")?.status).toBe("limited");
    expect(list.find((m) => m.id === "x/y:free")?.cost).toBe("free-tier");
    const gen = list.find((m) => m.id === "openrouter-free");
    expect(gen?.status).toBe("unavailable");
    expect(gen?.requirements).toContain("OPENROUTER_MODELS");
  });
});

describe("ordem de seleção automática", () => {
  it("prefere grátis-com-chave a pago-com-chave (BLOCK ligado)", async () => {
    await postJson("/api/admin/credentials", { provider: "openai", key: "sk-falsa-testes-123" });
    const id = await models.autoSelectText("chat");
    // Ollama fora do ar neste teste; Groq (grátis) ganha da OpenAI (paga/bloqueada).
    expect(id).toBe("openai/gpt-oss-20b");
  });
});
