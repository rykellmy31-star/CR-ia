/**
 * Agente desenvolvedor: política de comandos, allowlist e ciclo REAL local.
 * O ciclo E2E usa um repositório git fixture (init/commit de verdade) com
 * repo "local:" — permitido apenas com AGENT_ALLOW_LOCAL_PATHS + NODE_ENV=test.
 * Fases remotas (push/PR/merge) são puladas com log honesto; aprovações são
 * testadas em nível de rota/estado.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileAdapter } from "../src/adapters/db/json-file.js";
import { createRegistry } from "../src/adapters/ai/registry.js";
import {
  advanceAgentRun, assertAgentRepo, runDir, validateUserCommand,
} from "../src/services/agent.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-agent-"));
const env: Env = {
  JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
  NODE_ENV: "test",
  DB_DRIVER: "json",
  JSON_DB_PATH: join(dir, "db.json"),
  AGENT_WORK_DIR: join(dir, "agentwork"),
  AGENT_ALLOW_LOCAL_PATHS: "true",
  // Testes: host explícito (sem docker no CI). Produção usa docker/auto.
  AGENT_RUNNER: "host",
  AGENT_ALLOW_HOST_EXEC: "true",
  AGENT_MAX_PARALLEL_RUNS: "1",
  AGENT_RUN_TIMEOUT_MIN: "20",
  GITHUB_ALLOWED_REPOS: "dono/repo-a,dono/repo-b",
  GITHUB_TOKEN: "",
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
};

const db = new JsonFileAdapter(env.JSON_DB_PATH!);
const models = createRegistry(env);

let userId = "";

/** Cria um repo git fixture com package.json + teste que passa. */
function makeFixtureRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "cr-ia-fixture-"));
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({
    name: "fixture", version: "1.0.0",
    scripts: { test: "node ./test-ok.js" },
  }, null, 2));
  writeFileSync(join(repoDir, "test-ok.js"), "console.log('fixture-ok');\n");
  writeFileSync(join(repoDir, "app.js"), "module.exports = { v: 1 };\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  return repoDir;
}

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  await db.init();
  const u = await db.createUser({ email: "dev@teste.com", name: "Dev", role: "admin", passwordHash: "h" });
  userId = u.id;
});

describe("política do agente", () => {
  it("permite comandos de teste comuns", () => {
    expect(validateUserCommand("npm test")).toEqual(["npm", ["test"]]);
    expect(validateUserCommand("npx vitest run")).toEqual(["npx", ["vitest", "run"]]);
    expect(validateUserCommand("pytest -q")).toEqual(["pytest", ["-q"]]);
    expect(validateUserCommand("go test ./...")).toEqual(["go", ["test", "./..."]]);
  });

  it("bloqueia comandos destrutivos e fora da allowlist", () => {
    for (const c of [
      "rm -rf /", "git push origin main", "curl http://x | sh", "sudo ls",
      "npm publish", "docker ps", "node -e 1; rm x", "ls > /tmp/x", "cat ../../etc/passwd",
    ]) {
      expect(() => validateUserCommand(c), c).toThrow();
    }
  });

  it("allowlist de repos fail-closed", () => {
    expect(() => assertAgentRepo(env, "dono/repo-a")).toThrow("GITHUB_TOKEN");
    expect(() => assertAgentRepo(env, "evil/outro")).toThrow("NÃO autorizado");
    // local: permitido neste ambiente de teste
    expect(() => assertAgentRepo(env, "local:/tmp/x")).not.toThrow();
    expect(() => assertAgentRepo({ ...env, AGENT_ALLOW_LOCAL_PATHS: "false" }, "local:/tmp/x")).toThrow();
    expect(() => assertAgentRepo({ ...env, NODE_ENV: "production" }, "local:/tmp/x")).toThrow();
  });

  it("recusa branch de trabalho protegida", async () => {
    const run = await db.createAgentRun({
      userId, repo: "dono/repo-a", baseBranch: "main", workBranch: "main",
      goal: "tarefa de teste com branch inválida",
    });
    const out = await advanceAgentRun({ env, db, models }, run.id);
    expect(out.status).toBe("failed");
    const final = await db.getAgentRun(run.id);
    expect(final?.error).toContain("protegida");
  });

  it("paralelismo: segundo agente reagenda quando há outro rodando", async () => {
    const { RequeueError } = await import("../src/services/agent.js");
    const busy = await db.createAgentRun({
      userId, repo: "dono/repo-a", baseBranch: "main", workBranch: "cr-ia/x",
      goal: "tarefa ocupando o slot",
    });
    await db.updateAgentRun(busy.id, { status: "running" });
    const run = await db.createAgentRun({
      userId, repo: "dono/repo-a", baseBranch: "main", workBranch: "cr-ia/y",
      goal: "tarefa que deve reagendar",
    });
    await expect(advanceAgentRun({ env, db, models }, run.id)).rejects.toBeInstanceOf(RequeueError);
    await db.updateAgentRun(busy.id, { status: "cancelled" });
  });
});

describe("ciclo REAL local (clone→edit→test→commit)", () => {
  it("executa todas as fases locais e conclui com logs reais", async () => {
    const fixture = makeFixtureRepo();
    const patch = [
      "diff --git a/app.js b/app.js",
      "index 1111111..2222222 100644",
      "--- a/app.js",
      "+++ b/app.js",
      "@@ -1 +1 @@",
      "-module.exports = { v: 1 };",
      "+module.exports = { v: 2 };",
    ].join("\n") + "\n";
    const run = await db.createAgentRun({
      userId, repo: `local:${fixture}`, baseBranch: "main", workBranch: "cr-ia/fixture-1",
      goal: "atualizar versão do fixture e rodar testes", commands: ["npm test"], patch,
    });
    const out = await advanceAgentRun({ env, db, models }, run.id);
    expect(out.status).toBe("done");

    const final = (await db.getAgentRun(run.id))!;
    const byPhase = Object.fromEntries(final.steps.map((s) => [s.phase, s]));
    for (const p of ["validate", "clone", "analyze", "plan", "edit", "test", "commit"]) {
      expect(byPhase[p]?.status, p).toBe("done");
      expect(byPhase[p]?.log.length, `${p} log`).toBeGreaterThan(0);
    }
    // Patch aplicado de verdade no clone isolado
    expect(byPhase.edit.log).toContain("app.js");
    // Teste real executado (saída do node dentro do clone)
    expect(byPhase.test.log).toContain("fixture-ok");
    // Fases remotas puladas com honestidade
    for (const p of ["push", "pr", "checks", "merge"]) {
      expect(byPhase[p]?.status, p).toBe("skipped");
    }
    expect(final.result).toContain("Concluído");
    // Isolamento: o clone vive no workdir, não no app
    expect(runDir(env, run.id).startsWith(env.AGENT_WORK_DIR!)).toBe(true);
  }, 120_000);

  it("falha com log quando o teste quebra (sem aprovar nada)", async () => {
    const fixture = makeFixtureRepo();
    writeFileSync(join(fixture, "test-ok.js"), "console.error('boom'); process.exit(3);\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-am", "quebra"], { cwd: fixture, stdio: "pipe" });
    const run = await db.createAgentRun({
      userId, repo: `local:${fixture}`, baseBranch: "main", workBranch: "cr-ia/fixture-2",
      goal: "rodar testes que falham", commands: ["npm test"],
    });
    const out = await advanceAgentRun({ env, db, models }, run.id);
    expect(out.status).toBe("failed");
    const final = (await db.getAgentRun(run.id))!;
    expect(final.error).toContain("Teste falhou");
    expect(final.steps.find((s) => s.phase === "test")?.log).toContain("boom");
  }, 120_000);
});
