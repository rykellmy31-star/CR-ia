/**
 * Provedores por API (Fase 2): stubs HTTP fiéis aos contratos oficiais +
 * cofre de credenciais + status needs-credentials + fallback + preferência.
 * NENHUMA chamada externa real: sem chave válida, nada sai do servidor.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { Env } from "../src/types.js";
import { sealSecret, openSecret } from "../src/lib/vault.js";
import { OpenAICompatTextAdapter } from "../src/adapters/ai/openai-compatible.js";
import { estimateCostUSD } from "../src/adapters/ai/providers.js";

let stub: Server;
let stubBase = "";

const KEYS: Record<string, string> = {
  oai: "stub-key-oai",
  ant: "stub-key-ant",
  gem: "stub-key-gem",
  xai: "stub-key-xai",
};

/** Stub fiel aos 3 formatos: OpenAI-compat, Anthropic Messages, Gemini. */
function startStub(): Promise<string> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const readBody = () =>
        new Promise<string>((done) => {
          let b = "";
          req.on("data", (c) => { b += c; });
          req.on("end", () => done(b));
        });
      const parts = url.pathname.split("/").filter(Boolean); // [prov, ...]
      const prov = parts[0];
      if (!KEYS[prov]) {
        res.writeHead(404);
        res.end();
        return;
      }
      const want = KEYS[prov];
      const authed =
        prov === "ant"
          ? req.headers["x-api-key"] === want && req.headers["anthropic-version"] === "2023-06-01"
          : prov === "gem"
            ? url.searchParams.get("key") === want
            : req.headers["authorization"] === `Bearer ${want}`;
      if (!authed) return json(401, { error: { message: "invalid key" } });

      // --- GET models (ping) ---
      if (req.method === "GET" && (parts[1] === "models" || url.pathname.endsWith("/models"))) {
        return json(200, { data: [{ id: "x" }] });
      }
      // --- OpenAI-compat chat ---
      if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
        return readBody().then((b) => {
          const body = JSON.parse(b) as { model: string; messages: { content: string }[] };
          const last = body.messages[body.messages.length - 1]?.content ?? "";
          json(200, {
            choices: [{ message: { content: `OK-${prov.toUpperCase()}:${last.slice(0, 12)}` } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          });
        });
      }
      // --- Anthropic Messages ---
      if (req.method === "POST" && url.pathname.endsWith("/messages")) {
        return readBody().then((b) => {
          const body = JSON.parse(b) as { model: string; system?: string; messages: { content: string }[] };
          if (!body.model || !Array.isArray(body.messages)) return json(400, { error: { message: "bad shape" } });
          json(200, {
            content: [{ type: "text", text: `OK-ANT:${body.messages.length}msgs` }],
            usage: { input_tokens: 7, output_tokens: 3 },
          });
        });
      }
      // --- Gemini generateContent ---
      if (req.method === "POST" && url.pathname.includes(":generateContent")) {
        return readBody().then((b) => {
          const body = JSON.parse(b) as { contents: { role: string; parts: { text: string }[] }[] };
          if (!Array.isArray(body.contents)) return json(400, { error: { message: "bad shape" } });
          const n = body.contents.reduce((a, c) => a + c.parts.length, 0);
          json(200, {
            candidates: [{ content: { parts: [{ text: `OK-GEMINI:${n}parts` }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
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

const dir = mkdtempSync(join(tmpdir(), "cr-ia-prov-"));
let app: ReturnType<typeof createApp>["app"];
let db: ReturnType<typeof createApp>["db"];
let token = "";

async function api(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` };
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}

beforeAll(async () => {
  stubBase = await startStub();
  const env: Env = {
    JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
    CREDENTIALS_SECRET: "cofre-de-testes-com-mais-de-32-chars!!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "false", // testes precisam chamar os stubs pagos
    OPENAI_API_KEY: KEYS.oai,
    OPENAI_BASE_URL: `${stubBase}/oai`,
    OPENAI_MODELS: "gpt-5-mini",
    ANTHROPIC_API_KEY: KEYS.ant,
    ANTHROPIC_BASE_URL: `${stubBase}/ant`,
    ANTHROPIC_MODELS: "claude-opus-4-6",
    GOOGLE_AI_KEY: KEYS.gem,
    GOOGLE_BASE_URL: `${stubBase}/gem`,
    GOOGLE_MODELS: "gemini-3.8-flash",
    XAI_BASE_URL: `${stubBase}/xai`, // SEM chave: entra via cofre no teste
    XAI_MODELS: "grok-4.7",
    DEEPSEEK_API_KEY: "stub-key-down",
    DEEPSEEK_BASE_URL: "http://127.0.0.1:9", // porta fechada: provedor fora do ar
    DEEPSEEK_MODELS: "deepseek-chat",
    // mistral: sem chave e sem base => needs-credentials puro
  };
  ({ app, db } = createApp(env));
  await db.init();
  await db.createUser({ email: "p@teste.com", name: "P", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "p@teste.com", password: "Senha123!" }),
  });
  token = ((await login.json()) as { data: { token: string } }).data.token;
});

afterAll(async () => {
  await db?.close().catch(() => undefined);
  stub?.close();
});

describe("cofre (vault AES-GCM)", () => {
  it("cifra/decifra; adulteração e segredo errado falham", async () => {
    const s = "cofre-de-testes-com-mais-de-32-chars!!";
    const packed = await sealSecret(s, "sk-secreta-123");
    expect(packed.startsWith("v1:")).toBe(true);
    expect(await openSecret(s, packed)).toBe("sk-secreta-123");
    const tampered = packed.slice(0, -2) + (packed.endsWith("AA") ? "BB" : "AA");
    await expect(openSecret(s, tampered)).rejects.toThrow();
    await expect(openSecret("outro-segredo-com-mais-de-32-chars!!", packed)).rejects.toThrow();
  });
});

describe("lista de modelos: status honestos", () => {
  it("com chave no stub => installed + paid + external + preço", async () => {
    const r = await api("/api/models");
    expect(r.status).toBe(200);
    const models = (r.body.data as { models: Record<string, unknown>[] }).models;
    const gpt = models.find((m) => m.id === "gpt-5-mini")!;
    expect(gpt.status).toBe("installed");
    expect(gpt.paid).toBe(true);
    expect(gpt.external).toBe(true);
    expect(gpt.available).toBe(true);
    expect(gpt.pricePer1M).toEqual({ in: 0.25, out: 2, asOf: "2026-10-22" });
  });
  it("sem chave => needs-credentials com requirements (nunca disponível)", async () => {
    const r = await api("/api/models");
    const models = (r.body.data as { models: Record<string, unknown>[] }).models;
    for (const id of ["grok-4.7", "mistral-large-latest", "mistral-medium-latest"]) {
      const m = models.find((x) => x.id === id)!;
      expect(m.status).toBe("needs-credentials");
      expect(m.available).toBe(false);
      expect(String(m.requirements)).toContain("Credenciais");
    }
  });
  it("com chave mas provedor fora do ar => unavailable", async () => {
    const r = await api("/api/models");
    const models = (r.body.data as { models: Record<string, unknown>[] }).models;
    const ds = models.find((x) => x.id === "deepseek-chat")!;
    expect(ds.status).toBe("unavailable");
  });
});

describe("teste real de inferência (/models/test)", () => {
  it("OpenAI-compat: mapeia choices + usage", async () => {
    const r = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini" }),
    });
    expect(r.status).toBe(200);
    const d = r.body.data as { ok: boolean; sample: string; tokensIn: number; tokensOut: number; provider: string };
    expect(d.ok).toBe(true);
    expect(d.provider).toBe("openai");
    expect(d.sample).toContain("OK-OAI");
    expect(d.tokensIn).toBe(5);
    expect(d.tokensOut).toBe(2);
  });
  it("Anthropic: mapeia content blocks + usage", async () => {
    const r = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-opus-4-6" }),
    });
    expect(r.status).toBe(200);
    const d = r.body.data as { sample: string; tokensIn: number; tokensOut: number };
    expect(d.sample).toContain("OK-ANT");
    expect(d.tokensIn).toBe(7);
    expect(d.tokensOut).toBe(3);
  });
  it("Gemini: mapeia candidates + usageMetadata", async () => {
    const r = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gemini-3.8-flash" }),
    });
    expect(r.status).toBe(200);
    const d = r.body.data as { sample: string; tokensIn: number; tokensOut: number };
    expect(d.sample).toContain("OK-GEMINI");
    expect(d.tokensIn).toBe(9);
    expect(d.tokensOut).toBe(4);
  });
  it("sem chave => 400 Configurar API (não tenta rede)", async () => {
    const r = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mistral-large-latest" }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Configurar API");
  });
});

describe("adaptadores: erros honestos", () => {
  it("sem chave => chat lança 'Configurar API'", async () => {
    const a = new OpenAICompatTextAdapter({
      provider: "openai", baseUrl: `${stubBase}/oai`, models: ["gpt-5-mini"],
      getKey: async () => "", keyLabel: "OpenAI",
    });
    expect(await a.hasKey()).toBe(false);
    expect(await a.ping()).toBe(false);
    await expect(a.chat({ model: "gpt-5-mini", messages: [{ role: "user", content: "oi" }] }))
      .rejects.toThrow("Configurar API");
  });
  it("chave errada => ping false + 'rejeitada'", async () => {
    const a = new OpenAICompatTextAdapter({
      provider: "openai", baseUrl: `${stubBase}/oai`, models: ["gpt-5-mini"],
      getKey: async () => "chave-errada", keyLabel: "OpenAI",
    });
    expect(await a.ping()).toBe(false);
    await expect(a.chat({ model: "gpt-5-mini", messages: [{ role: "user", content: "oi" }] }))
      .rejects.toThrow("rejeitada");
  });
});

describe("credenciais (admin)", () => {
  it("lista status sem expor chaves", async () => {
    const r = await api("/api/admin/credentials");
    expect(r.status).toBe(200);
    const creds = (r.body.data as { credentials: Record<string, unknown>[] }).credentials;
    expect(creds.length).toBe(6);
    const oai = creds.find((c) => c.provider === "openai")!;
    expect(oai.configured).toBe(true);
    expect(oai.source).toBe("env");
    expect(String(oai.masked)).toContain("••••");
    expect(JSON.stringify(r.body)).not.toContain("stub-key-oai");
    const xai = creds.find((c) => c.provider === "xai")!;
    expect(xai.configured).toBe(false);
  });
  it("salva chave no cofre => modelo vira installed; apaga => volta", async () => {
    const save = await api("/api/admin/credentials", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "xai", key: KEYS.xai }),
    });
    expect(save.status).toBe(200);
    let r = await api("/api/models");
    let models = (r.body.data as { models: Record<string, unknown>[] }).models;
    expect(models.find((m) => m.id === "grok-4.7")!.status).toBe("installed");
    // chave no banco está cifrada (não em claro)
    const packed = await db.getSetting("cred.xai");
    expect(packed!.startsWith("v1:")).toBe(true);
    expect(packed).not.toContain(KEYS.xai);

    const del = await api("/api/admin/credentials/xai", { method: "DELETE" });
    expect(del.status).toBe(200);
    r = await api("/api/models");
    models = (r.body.data as { models: Record<string, unknown>[] }).models;
    expect(models.find((m) => m.id === "grok-4.7")!.status).toBe("needs-credentials");
  });
  it("provedor desconhecido => 400", async () => {
    const r = await api("/api/admin/credentials", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "arena", key: "x".repeat(16) }),
    });
    expect(r.status).toBe(400);
  });
});

describe("chat: preferência + fallback", () => {
  it("preferência do usuário vale no modo auto", async () => {
    const set = await api("/api/models/preference", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultChat: "gpt-5-mini" }),
    });
    expect(set.status).toBe(200);
    const get = await api("/api/models/preference");
    expect((get.body.data as { defaultChat: string }).defaultChat).toBe("gpt-5-mini");
    const chat = await api("/api/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "diga ok" }] }),
    });
    expect(chat.status).toBe(200);
    expect((chat.body.data as { model: string }).model).toBe("gpt-5-mini");
    await api("/api/models/preference", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaultChat: null }),
    });
  });
  it("provedor fora do ar => fallback avisado para outro modelo", async () => {
    const r = await api("/api/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "oi" }] }),
    });
    expect(r.status).toBe(200);
    const d = r.body.data as { model: string; fallback: { from: string; to: string; reason: string } };
    expect(d.fallback.from).toBe("deepseek-chat");
    expect(d.fallback.to).not.toBe("deepseek-chat");
    expect(d.model).toBe(d.fallback.to);
  });
  it("modelo sem chave => erro Configurar API (sem troca silenciosa)", async () => {
    const r = await api("/api/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mistral-large-latest", messages: [{ role: "user", content: "oi" }] }),
    });
    expect(r.status).toBe(412); // sem chave = pré-condição (412), não erro de gateway
    expect(r.body.error).toContain("Configurar API");
  });
});

describe("estimativa de custo", () => {
  it("calcula USD por tokens onde há preço; null onde não há", () => {
    expect(estimateCostUSD("gpt-5-mini", 1_000_000, 1_000_000)).toBeCloseTo(2.25, 6);
    expect(estimateCostUSD("grok-4.7", 500_000, 100_000)).toBeCloseTo(1.6, 6);
    expect(estimateCostUSD("claude-opus-4-6", 100, 100)).toBeNull();
    expect(estimateCostUSD("qwen3:4b", 100, 100)).toBeNull();
  });
});
