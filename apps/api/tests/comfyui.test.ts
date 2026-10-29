/**
 * GPU externa (ComfyUI) contra STUB HTTP fiel ao protocolo real:
 * /system_stats, /upload, /prompt, /history/{id} e /view.
 * Prova o caminho de código real (fila→poll→download) sem GPU.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import { ComfyImageAdapter } from "../src/adapters/ai/comfyui.js";
import { comfyConfig, comfyPing, fillWorkflow } from "../src/services/comfyui.js";
import type { Env } from "../src/types.js";

// PNG 1x1 mínimo + padding para passar do piso de 1024 bytes
const PNG_HEAD = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);
const PNG = Buffer.concat([PNG_HEAD, Buffer.alloc(2048)]);

let stub: Server;
let base = "";
let historyCalls = 0;
let lastWorkflow: Record<string, unknown> | null = null;

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (url.pathname === "/system_stats") {
        return json(200, { system: { comfyui_version: "0.3-stub", os: "posix" } });
      }
      if (url.pathname === "/upload" && req.method === "POST") {
        req.resume();
        req.on("end", () => json(200, { name: "up.png", subfolder: "", type: "input" }));
        return;
      }
      if (url.pathname === "/prompt" && req.method === "POST") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          lastWorkflow = (JSON.parse(body) as { prompt: Record<string, unknown> }).prompt;
          historyCalls = 0;
          json(200, { prompt_id: "p1", number: 1 });
        });
        return;
      }
      if (url.pathname === "/history/p1") {
        historyCalls++;
        // 1ª consulta: ainda processando; 2ª: concluído com imagem.
        if (historyCalls < 2) return json(200, {});
        // Formato real do ComfyUI: { id: { outputs: { nodeId: { images } }, status } }
        return json(200, {
          p1: {
            outputs: { "9": { images: [{ filename: "out_001.png", subfolder: "", type: "output" }] } },
            status: { status_str: "success", completed: true },
          },
        });
      }
      if (url.pathname === "/view") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(PNG);
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

const dir = mkdtempSync(join(tmpdir(), "cr-ia-comfy-"));
let app: ReturnType<typeof createApp>["app"];
let token = "";

beforeAll(async () => {
  base = await startStub();
  const env: Env = {
    JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "external-gpu",
    BLOCK_PAID_PROVIDERS: "true",
    EXTERNAL_GPU_URL: base,
    COMFY_TIMEOUT_MIN: "1",
  };
  ({ app } = createApp(env));
  const { db } = createApp(env);
  await db.init();
  await db.createUser({ email: "c@t.com", name: "C", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  // NB: createApp cria db próprio; usamos o app do 1º (mesmo JSON por path).
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "c@t.com", password: "Senha123!" }),
  });
  token = ((await login.json()) as { data: { token: string } }).data.token;
});

afterAll(() => { stub?.close(); });

async function api(path: string, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` };
  const res = await app.request(path, { ...init, headers });
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body: body as { ok: boolean; data?: Record<string, unknown>; error?: string } };
}

describe("cliente ComfyUI (stub)", () => {
  it("ping detecta versão", async () => {
    const cfg = comfyConfig({ EXTERNAL_GPU_URL: base } as Env)!;
    expect(await comfyPing(cfg)).toBe(true);
    expect(await comfyPing({ baseUrl: "http://127.0.0.1:9", apiKey: "", timeoutMin: 1 })).toBe(false);
  });

  it("fillWorkflow escapa prompt e numera dimensões", () => {
    const wf = fillWorkflow(
      '{"a":{"text":"{{POSITIVE}}"},"b":{"width":{{WIDTH}},"seed":{{SEED}}}}',
      { POSITIVE: 'diz "oi"\nquebra' }, { WIDTH: 1024, SEED: 7 }
    ) as { a: { text: string }; b: { width: number; seed: number } };
    expect(wf.a.text).toBe('diz "oi"\nquebra');
    expect(wf.b.width).toBe(1024);
    expect(wf.b.seed).toBe(7);
    expect(() => fillWorkflow('{"x":"{{FALTA}}"}', {}, {})).toThrow("não preenchido");
  });

  it("generate enfileira, aguarda e baixa a imagem", async () => {
    const adapter = new ComfyImageAdapter({ EXTERNAL_GPU_URL: base, COMFY_TIMEOUT_MIN: "1" } as Env);
    expect(await adapter.ping()).toBe(true);
    const r = await adapter.generate({ model: "flux.1-schnell", prompt: "um farol", format: "1:1", width: 512, height: 512, seed: 42 });
    expect(r.mime).toBe("image/png");
    expect(r.data.byteLength).toBeGreaterThan(1024);
    // O workflow enviado contém o prompt (prova que não foi simulado por dentro)
    expect(JSON.stringify(lastWorkflow)).toContain("um farol");
  }, 60_000);

  it("edit faz upload e referencia a imagem remota", async () => {
    const adapter = new ComfyImageAdapter({ EXTERNAL_GPU_URL: base, COMFY_TIMEOUT_MIN: "1" } as Env);
    const r = await adapter.edit({
      model: "qwen-image-edit", prompt: "troque o céu", format: "1:1", width: 512, height: 512,
      image: new Uint8Array(PNG), imageName: "orig.png",
    });
    expect(r.data.byteLength).toBeGreaterThan(1024);
    expect(JSON.stringify(lastWorkflow)).toContain("up.png");
    expect(JSON.stringify(lastWorkflow)).toContain("troque o céu");
  }, 60_000);
});

describe("rota /images/edit (E2E stub)", () => {
  it("edita um upload próprio e salva na biblioteca", async () => {
    const form = new FormData();
    form.append("file", new Blob([PNG as unknown as BlobPart], { type: "image/png" }), "orig.png");
    const up = await api("/api/files", { method: "POST", body: form });
    expect(up.status).toBe(201);
    const fileId = (up.body.data as { file: { id: string } }).file.id;

    const ed = await api("/api/images/edit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId, prompt: "adicione um pássaro", model: "qwen-image-edit" }),
    });
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    const img = (ed.body.data as { image: { id: string; prompt: string; modelId: string } }).image;
    expect(img.modelId).toBe("qwen-image-edit");
    expect(img.prompt).toContain("adicione um pássaro");

    const lib = await api("/api/images");
    expect((lib.body.data as { images: unknown[] }).images.length).toBe(1);
  }, 90_000);
});
