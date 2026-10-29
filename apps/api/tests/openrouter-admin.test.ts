/**
 * Rotas admin OpenRouter (v0.3.0): chave mascarada, teste sem gasto, sync
 * manual, paidAck ponta a ponta (bloqueio → ativação → chat/imagem OK) e
 * custo real no consumo. Fetch global stub — sem rede, sem gasto.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import type { Env } from "../src/types.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { OrFetch } from "../src/services/openrouter.js";

const OR_KEY = "K-OR-TESTES-99999";
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const OR_MODELS = [
  { id: "a/free", name: "Free", context_length: 8000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0" } },
  { id: "paid/pro", name: "Pro", context_length: 64000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015" } },
];
const OR_IMAGE_MODELS = [
  { id: "img/fast", name: "Fast",
    architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", "16:9"] } } },
];

let authKeyStatus = 200;
const realFetch = globalThis.fetch;

function installStub(): void {
  const stub: OrFetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    const body = (b: unknown, status = 200) => ({
      status, ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(b), json: async () => b,
    }) as Response;
    if (u.pathname === "/api/v1/models" && (!init?.method || init.method === "GET")) {
      return body({ data: OR_MODELS });
    }
    if (u.pathname === "/api/v1/images/models") return body({ data: OR_IMAGE_MODELS });
    if (u.pathname === "/api/v1/auth/key") {
      return authKeyStatus === 200
        ? body({ data: { label: "teste", usage: 2.5, limit: 10 } })
        : body({ error: "bad" }, authKeyStatus);
    }
    if (u.pathname === "/api/v1/chat/completions") {
      return body({ choices: [{ message: { content: "ok pago" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    }
    if (u.pathname === "/api/v1/images") {
      return body({ data: [{ b64_json: PNG_1X1, media_type: "image/png" }], usage: { cost: 0.04 } });
    }
    return body({ error: "rota não stubada" }, 404);
  }) as OrFetch;
  (globalThis as { fetch: OrFetch }).fetch = stub;
}

const dir = mkdtempSync(join(tmpdir(), "cr-ia-oradm-"));
let app: ReturnType<typeof createApp>["app"];
let db: ReturnType<typeof createApp>["db"];
let adminToken = "";
let userToken = "";

async function api(path: string, token: string, init?: RequestInit) {
  const res = await app.request(path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}
const postJson = (path: string, token: string, obj: unknown) =>
  api(path, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

async function loginAs(email: string, password: string): Promise<string> {
  const r = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return ((await r.json()) as { data: { token: string } }).data.token;
}

beforeAll(async () => {
  installStub();
  const env: Env = {
    JWT_SECRET: "segredo-testes-oradm-com-mais-de-32-chars",
    CREDENTIALS_SECRET: "cofre-testes-oradm-com-32-chars-ok!!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "true",
    OPENROUTER_BASE_URL: "https://or.test/api/v1",
  };
  ({ app, db } = createApp(env));
  await db.init();
  // Semente: catálogo vazio sincronizado (evita o boot-sync de fundo; testes disparam sync explícito).
  await db.setSetting("openrouter.catalog", JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", models: [] }));
  await db.setSetting("openrouter.lastSync", new Date().toISOString());
  await db.createUser({ email: "a@teste.com", name: "A", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  await db.createUser({ email: "u@teste.com", name: "U", role: "user", passwordHash: await hashPassword("Senha123!", 4) });
  adminToken = await loginAs("a@teste.com", "Senha123!");
  userToken = await loginAs("u@teste.com", "Senha123!");
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await db?.close().catch(() => undefined);
});

describe("autorização", () => {
  it("não-admin recebe 403 (nunca a chave)", async () => {
    for (const [m, p] of [["GET", "/api/admin/openrouter/status"], ["POST", "/api/admin/openrouter/sync"]] as const) {
      const r = await api(p, userToken, m === "POST" ? { method: "POST" } : {});
      expect(r.status).toBe(403);
    }
    const k = await postJson("/api/admin/openrouter/key", userToken, { key: OR_KEY });
    expect(k.status).toBe(403);
  });
});

describe("chave (cofre + máscara + teste)", () => {
  it("salva no cofre; status mostra máscara e fonte, nunca o valor", async () => {
    const s = await postJson("/api/admin/openrouter/key", adminToken, { key: OR_KEY });
    expect(s.status).toBe(200);
    const masked = (s.body.data as { masked: string }).masked;
    expect(masked).not.toContain(OR_KEY);
    expect(masked.length).toBeLessThan(OR_KEY.length);
    const st = await api("/api/admin/openrouter/status", adminToken);
    expect(st.status).toBe(200);
    const raw = JSON.stringify(st.body);
    expect(raw).not.toContain(OR_KEY);
    const d = st.body.data as { key: { configured: boolean; source: string; masked: string }; ping: { ok: boolean; usage: number; limit: number } };
    expect(d.key.configured).toBe(true);
    expect(d.key.source).toBe("vault");
    expect(d.ping.ok).toBe(true);
    expect(d.ping.usage).toBe(2.5);
    expect(d.ping.limit).toBe(10);
  });
  it("testa chave informada sem salvar (ok e 401)", async () => {
    const ok = await postJson("/api/admin/openrouter/key/test", adminToken, { key: "K-PROVIDA-12345" });
    expect((ok.body.data as { info: { ok: boolean } }).info.ok).toBe(true);
    authKeyStatus = 401;
    try {
      const bad = await postJson("/api/admin/openrouter/key/test", adminToken, { key: "K-RUIM-12345" });
      const info = (bad.body.data as { info: { ok: boolean; error: string } }).info;
      expect(info.ok).toBe(false);
      expect(info.error).toMatch(/inválida/);
    } finally {
      authKeyStatus = 200;
    }
  });
});

describe("sync manual + paidAck ponta a ponta", () => {
  it("sync adiciona modelos, preserva disabled e expõe em /models", async () => {
    await postJson("/api/models/select", adminToken, { disabled: ["a/free"] });
    const s = await postJson("/api/admin/openrouter/sync", adminToken, {});
    expect(s.status).toBe(200);
    const report = (s.body.data as { report: { total: number; added: string[]; text: number; image: number; free: number } }).report;
    expect(report.total).toBe(3);
    expect(report.added.sort()).toEqual(["a/free", "img/fast", "paid/pro"]);
    expect(report.text).toBe(2);
    expect(report.image).toBe(1);
    const list = await api("/api/models", adminToken);
    const models = (list.body.data as { models: { id: string; enabled: boolean; paid: boolean; status: string }[] }).models;
    expect(models.find((m) => m.id === "a/free")?.enabled).toBe(false); // pref preservada
    expect(models.find((m) => m.id === "paid/pro")?.paid).toBe(true);
    expect(models.find((m) => m.id === "paid/pro")?.status).toBe("available");
    expect(models.find((m) => m.id === "img/fast")?.paid).toBe(true); // sem preço = pago
  });
  it("chat pago bloqueado (403) → paidAck → 200 (stub, sem gasto)", async () => {
    const blocked = await postJson("/api/chat/completions", adminToken, {
      model: "paid/pro", messages: [{ role: "user", content: "oi" }],
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toMatch(/BLOCK_PAID/);
    const sel = await postJson("/api/models/select", adminToken, { paidAck: ["paid/pro"] });
    expect(sel.status).toBe(200);
    const allowed = await postJson("/api/chat/completions", adminToken, {
      model: "paid/pro", messages: [{ role: "user", content: "oi" }],
    });
    expect(allowed.status).toBe(200);
    const list = await api("/api/models", adminToken);
    const models = (list.body.data as { models: { id: string; status: string }[] }).models;
    expect(models.find((m) => m.id === "paid/pro")?.status).toBe("installed");
  });
  it("imagem paga: ack → gera de verdade (bytes PNG) + custo 0.04 no consumo", async () => {
    await postJson("/api/models/select", adminToken, { paidAck: ["paid/pro", "img/fast"] });
    const g = await postJson("/api/images/generate", adminToken, {
      prompt: "um farol à noite", format: "16:9", model: "img/fast",
    });
    expect(g.status).toBe(200);
    const u = await api("/api/admin/usage?days=30", adminToken);
    const rows = (u.body.data as { rows: { modelId: string; costUsd: number; kind: string }[] }).rows;
    const row = rows.find((r) => r.modelId === "img/fast");
    expect(row?.kind).toBe("image");
    expect(row?.costUsd).toBeCloseTo(0.04, 6);
  });
  it("sync-config valida e persiste", async () => {
    const bad = await postJson("/api/admin/openrouter/sync-config", adminToken, { auto: true, intervalHours: 999 });
    expect(bad.status).toBe(400);
    const good = await postJson("/api/admin/openrouter/sync-config", adminToken, { auto: false, intervalHours: 12 });
    expect(good.status).toBe(200);
    const st = await api("/api/admin/openrouter/status", adminToken);
    expect((st.body.data as { sync: { auto: boolean; intervalHours: number } }).sync).toMatchObject({ auto: false, intervalHours: 12 });
  });
});

describe("boot-sync", () => {
  it("primeiro boot sem catálogo sincroniza sozinho (stub)", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "cr-ia-orboot-"));
    const env2: Env = {
      JWT_SECRET: "segredo-testes-orboot-com-mais-de-32-chars",
      CREDENTIALS_SECRET: "cofre-testes-orboot-com-32-chars-ok!",
      NODE_ENV: "test",
      DB_DRIVER: "json",
      JSON_DB_PATH: join(dir2, "db.json"),
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: join(dir2, "uploads"),
      CHAT_PROVIDER: "mock",
      IMAGE_PROVIDER: "mock-svg",
      BLOCK_PAID_PROVIDERS: "true",
      OPENROUTER_BASE_URL: "https://or.test/api/v1",
    };
    const second = createApp(env2);
    await second.db.init();
    await second.db.createUser({ email: "b@teste.com", name: "B", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
    const t = await (async () => {
      const r = await second.app.request("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "b@teste.com", password: "Senha123!" }),
      });
      return ((await r.json()) as { data: { token: string } }).data.token;
    })();
    // Boot-sync é em background: aguarda o catálogo aparecer (até 5s).
    let cat: string | null = null;
    for (let i = 0; i < 50 && !cat; i++) {
      await new Promise((r) => setTimeout(r, 100));
      cat = await second.db.getSetting("openrouter.catalog");
    }
    expect(cat).toBeTruthy();
    expect(JSON.parse(cat!).models).toHaveLength(3);
    const list = await second.app.request("/api/models", { headers: { authorization: `Bearer ${t}` } });
    const body = (await list.json()) as { data: { models: { id: string }[] } };
    expect(body.data.models.map((m) => m.id)).toContain("paid/pro");
    await second.db.close().catch(() => undefined);
  }, 30_000);
});
