/**
 * Voz, embeddings e busca web contra STUBS HTTP reais (node:http).
 * Prova o caminho de código real (rotas → adaptadores → HTTP), sem rede externa.
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

/** Stub fiel aos contratos: SearXNG /search + ai-local /health,/transcribe,/embed. */
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
          results: [
            { title: `Resultado para ${q}`, url: "https://exemplo.com/1", content: "trecho um", engine: "stub" },
            { title: "Outro", url: "https://exemplo.com/2", content: "trecho dois", engine: "stub" },
          ],
        });
      }
      if (url.pathname === "/health") return json(200, { status: "ok", whisper: "small", embeddings: "bge-m3" });
      if (url.pathname === "/transcribe" && req.method === "POST") {
        req.resume();
        req.on("end", () => json(200, { text: "olá mundo transcrito", language: "pt", duration_sec: 3 }));
        return;
      }
      if (url.pathname === "/embed" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const n = (JSON.parse(body) as { texts: string[] }).texts.length;
          // Vetores determinísticos por índice (normais o bastante p/ cosseno).
          const embeddings = Array.from({ length: n }, (_, i) =>
            Array.from({ length: 8 }, (_, j) => Math.sin(i * 3 + j)));
          json(200, { embeddings, model: "bge-m3" });
        });
        return;
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

const dir = mkdtempSync(join(tmpdir(), "cr-ia-ai-"));
// Env montado após o stub subir (URLs dinâmicas)
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
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "true",
    SEARXNG_URL: stubBase,
    AI_LOCAL_URL: stubBase,
  };
  ({ app, db } = createApp(env));
  await db.init();
  await db.createUser({ email: "u@teste.com", name: "U", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "u@teste.com", password: "Senha123!" }),
  });
  token = ((await login.json()) as { data: { token: string } }).data.token;
});

afterAll(async () => {
  await db?.close().catch(() => undefined);
  stub?.close();
});

describe("busca web (stub SearXNG)", () => {
  it("retorna resultados reais do buscador", async () => {
    const r = await api("/api/ai/search", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "preço do café" }),
    });
    expect(r.status).toBe(200);
    const data = r.body.data as { real: boolean; provider: string; results: { title: string }[] };
    expect(data.real).toBe(true);
    expect(data.provider).toBe("searxng");
    expect(data.results.length).toBe(2);
    expect(data.results[0].title).toContain("preço do café");
  });
});

describe("transcrição (stub ai-local)", () => {
  it("transcreve áudio via multipart e registra uso", async () => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/wav" }), "a.wav");
    const r = await api("/api/ai/transcribe", { method: "POST", body: form });
    expect(r.status).toBe(200);
    expect((r.body.data as { text: string }).text).toBe("olá mundo transcrito");
    const admin = await api("/api/admin/stats");
    expect((admin.body.data as { usage: { byKind: Record<string, number> } }).usage.byKind.transcription).toBe(1);
  });

  it("rejeita tipo não-áudio", async () => {
    const form = new FormData();
    form.append("audio", new Blob(["x"], { type: "image/png" }), "a.png");
    const r = await api("/api/ai/transcribe", { method: "POST", body: form });
    expect(r.status).toBe(415);
  });
});

describe("documentos: index + busca", () => {
  it("upload indexa e busca semântica encontra", async () => {
    const form = new FormData();
    form.append("file", new Blob(["O contrato de aluguel vence em dezembro. Multa de 10%."], { type: "text/plain" }), "contrato.txt");
    const up = await api("/api/files", { method: "POST", body: form });
    expect(up.status).toBe(201);
    const fileId = (up.body.data as { file: { id: string } }).file.id;
    expect((up.body.data as { indexed: { chunks: number; semantic: boolean } }).indexed.semantic).toBe(true);

    const s = await api("/api/documents/search".replace("/api/documents", "/api/ai/documents"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "quando vence o aluguel?" }),
    });
    expect(s.status).toBe(200);
    const data = s.body.data as { method: string; semantic: boolean; matches: { excerpt: string }[] };
    expect(data.method).toBe("semantic");
    expect(data.semantic).toBe(true);
    expect(data.matches.length).toBeGreaterThan(0);
    expect(data.matches[0].excerpt).toContain("aluguel");
    void fileId;
  });
});
