/**
 * Fase 3: busca web multi-provedor, leitura de URL, memória, código e
 * busca automática no chat — contra STUBS HTTP reais (node:http), sem
 * rede externa. Chaves de busca vão pelo cofre (vault) como no painel.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import { runDir, buildMemoryContext } from "../src/services/agent.js";
import { extractReadableText } from "../src/services/urlreader.js";
import type { Env } from "../src/types.js";

let stub: Server;
let stubBase = "";

function startStub(): Promise<string> {
  return new Promise((resolve) => {
    stub = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const body = () =>
        new Promise<string>((done) => {
          let b = "";
          req.on("data", (c) => { b += c; });
          req.on("end", () => done(b));
        });
      // SearXNG
      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        return json(200, {
          results: [
            { title: `SearXNG: ${q}`, url: "https://exemplo.com/s1", content: "trecho searx", engine: "stub-searx", publishedDate: "2026-10-20" },
          ],
        });
      }
      // Brave
      if (url.pathname === "/brave/res/v1/web/search") {
        if (!req.headers["x-subscription-token"]) return json(401, { error: "no key" });
        const q = url.searchParams.get("q") ?? "";
        return json(200, {
          web: { results: [{ title: `Brave: ${q}`, url: "https://exemplo.com/b1", description: "trecho brave", age: "2 days ago" }] },
        });
      }
      // Tavily
      if (url.pathname === "/tavily/search" && req.method === "POST") {
        return void body().then((b) => {
          const p = JSON.parse(b) as { api_key?: string; query?: string };
          if (!p.api_key) return json(401, { error: "no key" });
          json(200, {
            results: [{ title: `Tavily: ${p.query}`, url: "https://exemplo.com/t1", content: "trecho tavily", published_date: "2026-10-21", score: 0.92 }],
          });
        });
      }
      // Google PSE
      if (url.pathname === "/gpse/customsearch/v1") {
        if (!url.searchParams.get("key") || !url.searchParams.get("cx")) return json(400, { error: "key/cx" });
        const q = url.searchParams.get("q") ?? "";
        return json(200, {
          items: [{
            title: `Google: ${q}`, link: "https://exemplo.com/g1", snippet: "trecho google",
            pagemap: { metatags: [{ "article:published_time": "2026-10-19" }] },
          }],
        });
      }
      if (url.pathname === "/health") return json(200, { status: "ok", whisper: "small", embeddings: "bge-m3" });
      if (url.pathname === "/embed" && req.method === "POST") {
        return void body().then((b) => {
          const n = (JSON.parse(b) as { texts: string[] }).texts.length;
          // Vetor constante: cosseno sempre 1,0 — testa o CAMINHO semântico
          // (embed chamado, similaridade calculada), não a qualidade do modelo.
          const embeddings = Array.from({ length: n }, () => Array(8).fill(1));
          json(200, { embeddings, model: "bge-m3" });
        });
      }
      if (url.pathname === "/page") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Página stub</title><script>var x=1;</script></head><body><h1>Oi</h1><p>conteúdo &amp; entidades</p></body></html>");
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

const dir = mkdtempSync(join(tmpdir(), "cr-ia-f3-"));
let app: ReturnType<typeof createApp>["app"];
let db: ReturnType<typeof createApp>["db"];
let env: Env;
let tokenA = "";
let tokenB = "";
let userAId = "";

async function api(path: string, init?: RequestInit, tk?: string) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>), authorization: `Bearer ${tk ?? tokenA}` };
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}
const postJson = (path: string, obj: unknown, tk?: string) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) }, tk);

async function login(email: string, password: string): Promise<string> {
  const r = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return ((await r.json()) as { data: { token: string } }).data.token;
}

beforeAll(async () => {
  stubBase = await startStub();
  env = {
    JWT_SECRET: "segredo-de-testes-fase3-com-mais-de-32-chars",
    CREDENTIALS_SECRET: "cofre-de-testes-fase3-com-32-chars-ok!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    AGENT_WORK_DIR: join(dir, "agent"),
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    // false AQUI porque esta suíte testa os pagos explicitamente (chaves falsas
    // no cofre, stubs locais — nenhuma cobrança real). O bloqueio em si é
    // provado em tests/paid-block.test.ts com BLOCK=true.
    BLOCK_PAID_PROVIDERS: "false",
    SEARXNG_URL: stubBase,
    BRAVE_BASE_URL: `${stubBase}/brave`,
    TAVILY_BASE_URL: `${stubBase}/tavily`,
    GOOGLE_PSE_BASE_URL: `${stubBase}/gpse`,
    AI_LOCAL_URL: stubBase,
  };
  ({ app, db } = createApp(env));
  await db.init();
  const u = await db.createUser({ email: "a@teste.com", name: "A", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  userAId = u.id;
  await db.createUser({ email: "b@teste.com", name: "B", role: "user", passwordHash: await hashPassword("Senha123!", 4) });
  tokenA = await login("a@teste.com", "Senha123!");
  tokenB = await login("b@teste.com", "Senha123!");
  // Chaves de busca via cofre (como o painel faz) — sem nada no .env.
  for (const p of ["brave", "tavily", "google-pse"]) {
    const r = await postJson("/api/admin/credentials", { provider: p, key: `chave-falsa-${p}-para-testes-123` });
    expect(r.status).toBe(200);
  }
  await postJson("/api/admin/settings", { key: "search.google_cx", value: "cx-falso-testes" });
}, 60_000);

afterAll(async () => {
  await db?.close().catch(() => undefined);
  stub?.close();
});

describe("busca web multi-provedor", () => {
  it("usa o SearXNG por padrão (grátis primeiro)", async () => {
    const r = await postJson("/api/ai/search", { q: "preço do café" });
    expect(r.status).toBe(200);
    const d = r.body.data as { real: boolean; provider: string; results: { title: string; publishedAt: string }[] };
    expect(d.real).toBe(true);
    expect(d.provider).toBe("searxng");
    expect(d.results[0].title).toContain("preço do café");
    expect(d.results[0].publishedAt).toBe("2026-10-20");
  });

  it("busca na Brave com chave do cofre", async () => {
    const r = await postJson("/api/ai/search", { q: "clima", provider: "brave" });
    expect(r.status).toBe(200);
    const d = r.body.data as { provider: string; results: { title: string; engine: string }[] };
    expect(d.provider).toBe("brave");
    expect(d.results[0].title).toContain("Brave: clima");
    expect(d.results[0].engine).toBe("brave");
  });

  it("busca na Tavily com score", async () => {
    const r = await postJson("/api/ai/search", { q: "câmbio", provider: "tavily" });
    expect(r.status).toBe(200);
    const d = r.body.data as { provider: string; results: { score: number; publishedAt: string }[] };
    expect(d.provider).toBe("tavily");
    expect(d.results[0].score).toBe(0.92);
    expect(d.results[0].publishedAt).toBe("2026-10-21");
  });

  it("busca no Google PSE com chave + CX", async () => {
    const r = await postJson("/api/ai/search", { q: "eleições", provider: "google-pse" });
    expect(r.status).toBe(200);
    const d = r.body.data as { provider: string; results: { publishedAt: string }[] };
    expect(d.provider).toBe("google-pse");
    expect(d.results[0].publishedAt).toBe("2026-10-19");
  });

  it("rejeita provedor desconhecido sem chamar nada", async () => {
    const r = await postJson("/api/ai/search", { q: "xx", provider: "bing-falso" });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/desconhecido/);
  });

  it("status lista os 4 provedores com configured", async () => {
    const r = await api("/api/ai/status");
    expect(r.status).toBe(200);
    const d = r.body.data as { webSearch: boolean; searchProviders: { id: string; configured: boolean; free: boolean }[] };
    expect(d.webSearch).toBe(true);
    expect(d.searchProviders.map((p) => p.id).sort()).toEqual(["brave", "google-pse", "searxng", "tavily"]);
    expect(d.searchProviders.every((p) => p.configured)).toBe(true);
    expect(d.searchProviders.find((p) => p.id === "searxng")?.free).toBe(true);
  });

  it("grava histórico e conta uso web-search", async () => {
    const h = await api("/api/ai/searches");
    expect(h.status).toBe(200);
    const items = (h.body.data as { items: { provider: string; query: string; resultsCount: number }[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items[0].resultsCount).toBeGreaterThanOrEqual(1);
    const stats = await api("/api/admin/stats");
    const kinds = (stats.body.data as { usage: { byKind: Record<string, number> } }).usage.byKind;
    expect(kinds["web-search"]).toBeGreaterThanOrEqual(4);
  });

  it("admin vê pesquisas de todos os usuários", async () => {
    const r = await api("/api/admin/searches");
    expect(r.status).toBe(200);
    const items = (r.body.data as { items: { email: string }[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(4);
    expect(items[0].email).toContain("@teste.com");
  });
});

describe("leitura de URL", () => {
  it("bloqueia host privado (SSRF) — até o stub local", async () => {
    const r = await postJson("/api/ai/read-url", { url: `${stubBase}/page` });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/privad|bloquead|loopback|reservado/i);
  });

  it("rejeita esquema não-http", async () => {
    const r = await postJson("/api/ai/read-url", { url: "ftp://exemplo.com/x" });
    expect(r.status).toBe(400);
  });

  it("extrai título e texto sem scripts (unitário)", () => {
    const r = extractReadableText(
      "<html><head><title>Página stub</title><script>var x=1;</script><style>p{}</style></head>" +
      "<body><nav>menu</nav><h1>Oi</h1><p>conteúdo &amp; entidades</p></body></html>"
    );
    expect(r.title).toBe("Página stub");
    expect(r.text).toContain("Oi");
    expect(r.text).toContain("conteúdo & entidades");
    expect(r.text).not.toContain("var x=1");
    expect(r.text).not.toContain("menu");
  });
});

describe("memória", () => {
  let memId = "";
  it("salva e lista com filtro", async () => {
    const s = await postJson("/api/memory", {
      project: "loja-site", kind: "fix",
      title: "tentativa X falhou", content: "detalhes da falha",
    });
    expect(s.status).toBe(201);
    memId = (s.body.data as { item: { id: string } }).item.id;
    await postJson("/api/memory", { project: "loja-site", kind: "note", title: "nota W", content: "só uma nota" });
    const all = await api("/api/memory");
    expect((all.body.data as { items: unknown[] }).items.length).toBe(2);
    const filtered = await api("/api/memory?project=loja-site&kind=fix");
    const items = (filtered.body.data as { items: { title: string }[] }).items;
    expect(items.length).toBe(1);
    expect(items[0].title).toBe("tentativa X falhou");
  });

  it("isola por usuário (B não vê nem apaga)", async () => {
    const b = await api("/api/memory", undefined, tokenB);
    expect((b.body.data as { items: unknown[] }).items.length).toBe(0);
    const del = await api(`/api/memory/${memId}`, { method: "DELETE" }, tokenB);
    expect(del.status).toBe(404);
  });

  it("dono apaga", async () => {
    const del = await api(`/api/memory/${memId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("agente monta contexto só com fix/decision do repo", async () => {
    await db.saveMemoryItem({ userId: userAId, project: "repo-x", kind: "fix", title: "FALHOU-Y", content: "não repetir Y" });
    await db.saveMemoryItem({ userId: userAId, project: "repo-x", kind: "decision", title: "usar Z", content: "decidido Z" });
    await db.saveMemoryItem({ userId: userAId, project: "repo-x", kind: "note", title: "NOTA-W", content: "só nota" });
    await db.saveMemoryItem({ userId: userAId, project: "outro", kind: "fix", title: "FALHOU-OUTRO", content: "outro repo" });
    const ctx = await buildMemoryContext(db, userAId, "repo-x");
    expect(ctx).toContain("FALHOU-Y");
    expect(ctx).toContain("usar Z");
    expect(ctx).not.toContain("NOTA-W");
    expect(ctx).not.toContain("FALHOU-OUTRO");
    expect(await buildMemoryContext(db, userAId, "repo-vazio")).toBe("");
  });
});

describe("código indexado", () => {
  let runId = "";
  it("indexa o clone de um run e busca (semântica via stub)", async () => {
    const run = await db.createAgentRun({
      userId: userAId, repo: "repo-x", baseBranch: "main",
      workBranch: "cr-ia/t1", goal: "tarefa de teste index",
    });
    runId = run.id;
    const repoDir = runDir(env, runId);
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFileSync(join(repoDir, "src", "login.ts"), "export function autenticarUsuario(senha: string) {\n  return verificarSenha(senha);\n}\n");
    writeFileSync(join(repoDir, "README.md"), "# repo-x\nProjeto de teste.\n");
    const idx = await postJson("/api/ai/code/index", { runId });
    expect(idx.status).toBe(200);
    const d = idx.body.data as { files: number; chunks: number; semantic: boolean };
    expect(d.files).toBe(2);
    expect(d.chunks).toBeGreaterThanOrEqual(2);
    expect(d.semantic).toBe(true);
    const s = await postJson("/api/ai/code/search", { q: "como autentica o usuário", repo: "repo-x" });
    expect(s.status).toBe(200);
    const sd = s.body.data as { semantic: boolean; matches: { path: string }[] };
    expect(sd.semantic).toBe(true);
    expect(sd.matches.length).toBeGreaterThanOrEqual(1);
    expect(sd.matches.some((m) => m.path.includes("login.ts"))).toBe(true);
  });

  it("não indexa run de outro usuário", async () => {
    const r = await postJson("/api/ai/code/index", { runId }, tokenB);
    expect([403, 404]).toContain(r.status);
  });

  it("run inexistente dá 404 e runId com ../ é rejeitado pelo resolvedor", async () => {
    const r = await postJson("/api/ai/code/index", { runId: "../fuga" });
    expect(r.status).toBe(404);
    expect(() => runDir(env, "../fuga")).toThrow(/inválido/);
    expect(() => runDir(env, "run-abc_123")).not.toThrow();
  });
});

describe("busca automática no chat", () => {
  it("anexa contexto web e avisa webUsed", async () => {
    const r = await postJson("/api/chat/completions", {
      messages: [{ role: "user", content: "qual o preço do café hoje?" }],
    });
    expect(r.status).toBe(200);
    const d = r.body.data as { webUsed: { provider: string; query: string } | null };
    expect(d.webUsed).not.toBeNull();
    expect(d.webUsed?.provider).toBe("searxng");
  });

  it("pergunta comum não dispara busca", async () => {
    const r = await postJson("/api/chat/completions", {
      messages: [{ role: "user", content: "escreva um poema sobre o mar" }],
    });
    expect(r.status).toBe(200);
    expect((r.body.data as { webUsed: unknown }).webUsed).toBeNull();
  });

  it("admin desliga a busca automática", async () => {
    const s = await postJson("/api/admin/settings", { key: "search.auto", value: "false" });
    expect(s.status).toBe(200);
    const r = await postJson("/api/chat/completions", {
      messages: [{ role: "user", content: "qual o preço do café hoje?" }],
    });
    expect((r.body.data as { webUsed: unknown }).webUsed).toBeNull();
    await postJson("/api/admin/settings", { key: "search.auto", value: "true" });
  });

  it("cliente que já buscou pula a automática (web:true)", async () => {
    const h0 = await api("/api/ai/searches");
    const n0 = ((h0.body.data as { items: unknown[] }).items ?? []).length;
    const r = await postJson("/api/chat/completions", {
      messages: [{ role: "user", content: "qual o preço do café hoje? [já com contexto]" }],
      web: true,
    });
    expect(r.status).toBe(200);
    expect((r.body.data as { webUsed: unknown }).webUsed).toBeNull();
    const h1 = await api("/api/ai/searches");
    expect(((h1.body.data as { items: unknown[] }).items ?? []).length).toBe(n0);
  });
});

describe("configurações de busca (admin)", () => {
  it("valida provedor e auto", async () => {
    expect((await postJson("/api/admin/settings", { key: "search.provider", value: "bing-falso" })).status).toBe(400);
    expect((await postJson("/api/admin/settings", { key: "search.auto", value: "talvez" })).status).toBe(400);
    expect((await postJson("/api/admin/settings", { key: "models.defaultChat", value: "x" })).status).toBe(400);
  });

  it("provedor preferido do painel altera a ordem", async () => {
    const g = await api("/api/admin/settings");
    expect((g.body.data as { settings: Record<string, string> }).settings["search.google_cx"]).toBe("cx-falso-testes");
    await postJson("/api/admin/settings", { key: "search.provider", value: "tavily" });
    const r = await postJson("/api/ai/search", { q: "ordem do painel" });
    expect((r.body.data as { provider: string }).provider).toBe("tavily");
    await postJson("/api/admin/settings", { key: "search.provider", value: "auto" });
    const r2 = await postJson("/api/ai/search", { q: "ordem auto" });
    expect((r2.body.data as { provider: string }).provider).toBe("searxng");
  });
});
