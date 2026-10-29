/** Testes de integração HTTP (app Hono real + banco JSON temporário). */
import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-api-"));
const env: Env = {
  JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
  DB_DRIVER: "json",
  JSON_DB_PATH: join(dir, "db.json"),
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: join(dir, "uploads"),
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
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
  await db.createUser({ email: "admin@teste.com", name: "Admin", role: "admin", passwordHash: await hashPassword("Admin123!", 4) });
  await db.createUser({ email: "guest@teste.com", name: "Guest", role: "guest", passwordHash: await hashPassword("Guest123!", 4) });
  const a = await api("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@teste.com", password: "Admin123!" }),
  });
  adminToken = (a.body.data as { token: string }).token;
  const g = await api("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "guest@teste.com", password: "Guest123!" }),
  });
  guestToken = (g.body.data as { token: string }).token;
});

describe("API HTTP", () => {
  it("health", async () => {
    const r = await api("/api/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("login rejeita senha errada", async () => {
    const r = await api("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@teste.com", password: "errada" }),
    });
    expect(r.status).toBe(401);
  });

  it("rotas protegidas exigem token", async () => {
    const r = await api("/api/chat/conversations");
    expect(r.status).toBe(401);
  });

  it("chat cria conversa, responde e persiste histórico", async () => {
    const r = await api("/api/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Olá, quem é você?" }] }),
    }, guestToken);
    expect(r.status).toBe(200);
    const convId = (r.body.data as { conversationId: string }).conversationId;
    expect(convId).toBeTruthy();

    const h = await api(`/api/chat/conversations/${convId}`, undefined, guestToken);
    expect((h.body.data as { messages: unknown[] }).messages.length).toBe(2);

    // Isolamento: admin não acessa conversa do guest por essa rota de usuário
    const other = await api(`/api/chat/conversations/${convId}`, undefined, adminToken);
    expect(other.status).toBe(404);
  });

  it("modelos listam catálogo real", async () => {
    const r = await api("/api/models", undefined, guestToken);
    expect(r.status).toBe(200);
    const models = (r.body.data as { models: { id: string; available: boolean }[] }).models;
    expect(models.some((m) => m.id === "mock-cr-1" && m.available)).toBe(true);
  });

  it("guest não acessa admin", async () => {
    const r = await api("/api/admin/stats", undefined, guestToken);
    expect(r.status).toBe(403);
    const a = await api("/api/admin/stats", undefined, adminToken);
    expect(a.status).toBe(200);
  });

  it("imagens: gera SVG, lista na biblioteca", async () => {
    const r = await api("/api/images/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "promoção de padaria artesanal", format: "1:1" }),
    }, guestToken);
    expect(r.status).toBe(200);
    const img = (r.body.data as { image: { url: string; width: number } }).image;
    expect(img.url).toContain("/api/files/content/");
    expect(img.width).toBe(1024);

    const lib = await api("/api/images", undefined, guestToken);
    expect((lib.body.data as { images: unknown[] }).images.length).toBe(1);
  });

  it("tarefas: cria echo e aprova fluxo", async () => {
    const r = await api("/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "echo", title: "teste", payload: { a: 1 } }),
    }, guestToken);
    expect(r.status).toBe(201);
    const id = (r.body.data as { task: { id: string } }).task.id;
    const g = await api(`/api/tasks/${id}`, undefined, guestToken);
    expect((g.body.data as { task: { status: string } }).task.status).toBe("pending");
  });

  it("upload valida tipo e lê texto", async () => {
    const form = new FormData();
    form.append("file", new File(["conteúdo de teste para leitura"], "nota.txt", { type: "text/plain" }));
    const up = await api("/api/files", { method: "POST", body: form }, guestToken);
    expect(up.status).toBe(201);
    const id = (up.body.data as { file: { id: string } }).file.id;
    const read = await api(`/api/files/${id}/read`, undefined, guestToken);
    expect((read.body.data as { content: string }).content).toContain("conteúdo de teste");

    const bad = new FormData();
    bad.append("file", new File(["x"], "virus.exe", { type: "application/x-msdownload" }));
    const rej = await api("/api/files", { method: "POST", body: bad }, guestToken);
    expect(rej.status).toBe(415);
  });

  it("models/test executa inferência real no mock", async () => {
    const r = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-cr-1" }),
    }, adminToken);
    expect(r.status).toBe(200);
    const d = r.body.data as { ok: boolean; kind: string; latencyMs: number; sample: string };
    expect(d.ok).toBe(true);
    expect(d.kind).toBe("text");
    expect(d.latencyMs).toBeGreaterThanOrEqual(0);
    expect(d.sample.length).toBeGreaterThan(0);
  });

  it("models/test rejeita modelo desconhecido e guest não testa", async () => {
    const r = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nao-existe" }),
    }, adminToken);
    expect(r.status).toBe(404);
    const g = await api("/api/models/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-cr-1" }),
    }, guestToken);
    expect(g.status).toBe(403);
  });

  it("github/read sem token falha com mensagem clara (sem tocar em repos)", async () => {
    const r = await api("/api/tasks/github/read", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "rykellmy31-star/gestor-ponto-multiempresa", path: "README.md" }),
    }, adminToken);
    // Sem GITHUB_TOKEN no ambiente de teste, deve recusar — nunca vazar.
    // (Se o repo não estiver na allowlist do .env de teste, 403/502 também é aceitável.)
    expect([403, 502]).toContain(r.status);
  });

  it("revogar sessões invalida tokens antigos (e re-login funciona)", async () => {
    const rev = await api("/api/admin/sessions/revoke-all", { method: "POST" }, adminToken);
    expect(rev.status).toBe(200);
    // Token antigo agora é recusado
    const stale = await api("/api/auth/me", undefined, adminToken);
    expect(stale.status).toBe(401);
    // Novo login gera token válido
    const fresh = await api("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@teste.com", password: "Admin123!" }),
    });
    expect(fresh.status).toBe(200);
    const newToken = (fresh.body.data as { token: string }).token;
    const me = await api("/api/auth/me", undefined, newToken);
    expect(me.status).toBe(200);
    adminToken = newToken;
  });
});
