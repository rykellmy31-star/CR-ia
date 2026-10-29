/**
 * Item 5 — comando /agente no chat (admin): sintaxe posicional
 * "/agente <repo> <tarefa…>", cria execução REAL via createAgentRunAndTask
 * (mesmo caminho do POST /runs, com allowlist + gate de isolamento).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import { createAgentRunAndTask, parseAgentCommand } from "../src/services/agent.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-agentcmd-"));
let app: ReturnType<typeof createApp>["app"];
let db: ReturnType<typeof createApp>["db"];
let adminToken = "";
let guestToken = "";
let fixture = "";

function makeFixtureRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "cr-ia-cmdfix-"));
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({
    name: "fixture-cmd", version: "1.0.0", scripts: { test: "node -e \"console.log('cmd-ok')\"" },
  }, null, 2));
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  return repoDir;
}

async function api(path: string, token: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}`,
  };
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}
const postJson = (path: string, token: string, obj: unknown) =>
  api(path, token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

beforeAll(async () => {
  fixture = makeFixtureRepo();
  const env: Env = {
    JWT_SECRET: "segredo-agentcmd-com-mais-de-32-chars",
    CREDENTIALS_SECRET: "cofre-agentcmd-com-32-chars-ok!!!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(dir, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(dir, "uploads"),
    AGENT_WORK_DIR: join(dir, "agentwork"),
    AGENT_ALLOW_LOCAL_PATHS: "true",
    AGENT_RUNNER: "host",
    AGENT_ALLOW_HOST_EXEC: "true",
    GITHUB_ALLOWED_REPOS: "owner/repo",
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "true",
  };
  ({ app, db } = createApp(env));
  await db.init();
  await db.createUser({ email: "a@teste.com", name: "A", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  await db.createUser({ email: "g@teste.com", name: "G", role: "guest", passwordHash: await hashPassword("Senha123!", 4) });
  const login = async (email: string) => {
    const r = await app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "Senha123!" }),
    });
    return ((await r.json()) as { data: { token: string } }).data.token;
  };
  adminToken = await login("a@teste.com");
  guestToken = await login("g@teste.com");
}, 60_000);

afterAll(async () => {
  await db?.close().catch(() => undefined);
});

describe("parseAgentCommand (posicional: /agente <repo> <tarefa…>)", () => {
  it("repo remoto + tarefa", () => {
    expect(parseAgentCommand("/agente owner/repo criar a tela de login completa")).toEqual({
      repo: "owner/repo", goal: "criar a tela de login completa",
    });
  });

  it("repo local (testes) + tarefa", () => {
    expect(parseAgentCommand("/agente local:/tmp/x corrigir o bug do totalizador")).toEqual({
      repo: "local:/tmp/x", goal: "corrigir o bug do totalizador",
    });
  });

  it("recusa: sem repo/tarefa, tarefa curta, tarefa longa", () => {
    expect(() => parseAgentCommand("/agente")).toThrow(/Uso:/);
    expect(() => parseAgentCommand("/agente owner/repo curto")).toThrow(/10 caracteres/);
    expect(() => parseAgentCommand(`/agente owner/repo ${"x".repeat(2001)}`)).toThrow(/longa demais/);
  });
});

describe("POST /api/chat/completions com /agente", () => {
  it("admin cria execução REAL (run no banco + branch cr-ia/)", async () => {
    const r = await postJson("/api/chat/completions", adminToken, {
      messages: [{ role: "user", content: `/agente local:${fixture} validar o comando de chat do agente` }],
    });
    expect(r.status).toBe(200);
    const msg = (r.body.data as { message: { content: string } }).message;
    expect(msg.content).toContain("Agente iniciado");
    const runId = msg.content.match(/execução `([^`]+)`/)?.[1];
    expect(runId).toBeTruthy();
    const run = await db.getAgentRun(runId!);
    expect(run?.repo).toBe(`local:${fixture}`);
    expect(run?.workBranch.startsWith("cr-ia/")).toBe(true);
    expect(["pending", "queued", "running"]).toContain(run?.status);
  });

  it("guest é recusado (403)", async () => {
    const r = await postJson("/api/chat/completions", guestToken, {
      messages: [{ role: "user", content: `/agente local:${fixture} tentativa de convidado qualquer` }],
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/restrito ao administrador/);
  });

  it("sintaxe inválida é 400 (não cria nada)", async () => {
    const r = await postJson("/api/chat/completions", adminToken, {
      messages: [{ role: "user", content: "/agente sozinho" }],
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Uso:/);
  });

  it("repo fora da allowlist é 403", async () => {
    const r = await postJson("/api/chat/completions", adminToken, {
      messages: [{ role: "user", content: "/agente evil/outro objetivo com tamanho suficiente" }],
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/NÃO autorizado/);
  });
});

describe("gates na criação (createAgentRunAndTask)", () => {
  it("recusa quando o agente está DESATIVADO (sem isolamento)", async () => {
    const me = await db.createUser({ email: "x@teste.com", name: "X", role: "admin", passwordHash: "h" });
    const blockedEnv = {
      NODE_ENV: "test", GITHUB_TOKEN: "K-TESTE-12345", GITHUB_ALLOWED_REPOS: "owner/repo",
      AGENT_RUNNER: "host", // sem AGENT_ALLOW_HOST_EXEC → host bloqueado
    } as Env;
    await expect(createAgentRunAndTask(
      { env: blockedEnv, db }, me.id, { repo: "owner/repo", goal: "objetivo com tamanho suficiente" },
    )).rejects.toThrow(/DESATIVADO/);
  });

  it("repo remoto sem GITHUB_TOKEN: recusa antes de qualquer rede", async () => {
    const me = await db.createUser({ email: "y@teste.com", name: "Y", role: "admin", passwordHash: "h" });
    const noToken = {
      NODE_ENV: "test", GITHUB_ALLOWED_REPOS: "owner/repo",
      AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true",
    } as Env;
    await expect(createAgentRunAndTask(
      { env: noToken, db }, me.id, { repo: "owner/repo", goal: "objetivo com tamanho suficiente" },
    )).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it("repo local sem AGENT_ALLOW_LOCAL_PATHS: recusa", async () => {
    const me = await db.createUser({ email: "z@teste.com", name: "Z", role: "admin", passwordHash: "h" });
    const noLocal = {
      NODE_ENV: "test", GITHUB_TOKEN: "K-TESTE-12345", GITHUB_ALLOWED_REPOS: "owner/repo",
      AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true",
    } as Env;
    await expect(createAgentRunAndTask(
      { env: noLocal, db }, me.id, { repo: "local:/tmp/x", goal: "objetivo com tamanho suficiente" },
    )).rejects.toThrow(/só são permitidos/);
  });

  it("GET /policy expõe runnable/engine honestos", async () => {
    const r = await api("/api/agent/policy", adminToken);
    expect(r.status).toBe(200);
    const p = r.body.data as Record<string, unknown>;
    expect(p.runnable).toBe(true);
    expect(p.engine).toBe("host");
    expect(p.allowedRepos).toContain("owner/repo");
  });
});
