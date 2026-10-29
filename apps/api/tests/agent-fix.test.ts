/**
 * Item 5 — correção iterativa REAL: se o teste falha após a edição do
 * LLM, o agente pede ao LLM para corrigir o arquivo (≤ AGENT_FIX_ATTEMPTS,
 * só no modo autônomo) e roda o teste de novo. git/teste reais; LLM = stub.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileAdapter } from "../src/adapters/db/json-file.js";
import { __clearPlanCache, advanceAgentRun, runDir } from "../src/services/agent.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-agentfix-"));
const env: Env = {
  NODE_ENV: "test",
  DB_DRIVER: "json",
  JSON_DB_PATH: join(dir, "db.json"),
  AGENT_WORK_DIR: join(dir, "agentwork"),
  AGENT_ALLOW_LOCAL_PATHS: "true",
  AGENT_RUNNER: "host",
  AGENT_ALLOW_HOST_EXEC: "true",
  AGENT_MAX_PARALLEL_RUNS: "1",
  AGENT_RUN_TIMEOUT_MIN: "20",
  AGENT_FIX_ATTEMPTS: "2",
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
};
const db = new JsonFileAdapter(env.JSON_DB_PATH!);

/**
 * Stub de LLM com 3 papéis: planejador (modify app.js), editor (conteúdo
 * inicial — pode estar ERRADO) e corretor (conteúdo de correção).
 */
function makeStub(editorBody: string, fixBody: string) {
  const calls: string[] = [];
  const models = {
    autoSelectText: async () => "stub-code",
    findTextAdapter: () => ({
      chat: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
        const sys = messages.find((m) => m.role === "system")?.content ?? "";
        calls.push(sys.slice(0, 20));
        if (sys.includes("planejador")) {
          return {
            text: `{"files":[{"path":"app.js","action":"modify","instr":"mudar v para 42"}]}\n`,
            tokensIn: 10, tokensOut: 10, paid: false,
          };
        }
        const body = sys.includes("corretor") ? fixBody : editorBody;
        return { text: "```js\n" + body + "\n```\n", tokensIn: 10, tokensOut: 10, paid: false };
      },
    }),
  };
  return { calls, models };
}

/** Fixture cujo teste SÓ passa quando app.js exporta v=42. */
function makeFixFixture(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "cr-ia-fixrepo-"));
  writeFileSync(join(repoDir, "package.json"), JSON.stringify({
    name: "fixture-fix", version: "1.0.0",
    scripts: { test: "node ./check.js" },
  }, null, 2));
  writeFileSync(join(repoDir, "check.js"),
    "const m = require('./app.js');\n" +
    "if (m.v !== 42) { console.error('esperado v=42, obtido ' + m.v); process.exit(1); }\n" +
    "console.log('check-ok');\n");
  writeFileSync(join(repoDir, "app.js"), "module.exports = { v: 1 };\n");
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" });
  git(["init", "-b", "main"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"]);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);
  return repoDir;
}

let userId = "";
beforeAll(async () => {
  await db.init();
  const u = await db.createUser({ email: "fix@teste.com", name: "Fix", role: "admin", passwordHash: "h" });
  userId = u.id;
});

describe("correção iterativa após teste falhar", () => {
  it("editor erra (v=7) → corretor acerta (v=42) → done", async () => {
    __clearPlanCache();
    const { calls, models } = makeStub("module.exports = { v: 7 };", "module.exports = { v: 42 };");
    const fixture = makeFixFixture();
    const run = await db.createAgentRun({
      userId, repo: `local:${fixture}`, baseBranch: "main", workBranch: "cr-ia/fix-1",
      goal: "mudar app.js para v 42 com correção automática", commands: ["npm test"],
    });
    const out = await advanceAgentRun({ env, db, models: models as never }, run.id);
    expect(out.status).toBe("done");

    const final = (await db.getAgentRun(run.id))!;
    const byPhase = Object.fromEntries(final.steps.map((s) => [s.phase, s]));
    expect(byPhase.test.status).toBe("done");
    expect(byPhase.test.log).toContain("tentativa de correção 1/2");
    expect(byPhase.test.log).toContain("correção 1 resolveu");
    expect(byPhase.test.log).toContain("check-ok");
    // Arquivo REAL corrigido no clone isolado
    expect(readFileSync(join(runDir(env, run.id), "app.js"), "utf8")).toBe("module.exports = { v: 42 };\n");
    expect(byPhase.commit.status).toBe("done");
    // O corretor foi consultado
    expect(calls.join("|")).toContain("corretor");
  }, 120_000);

  it("corretor sempre erra → falha HONESTA após o limite (1/1)", async () => {
    __clearPlanCache();
    const { models } = makeStub("module.exports = { v: 7 };", "module.exports = { v: 7 };");
    const fixture = makeFixFixture();
    const run = await db.createAgentRun({
      userId, repo: `local:${fixture}`, baseBranch: "main", workBranch: "cr-ia/fix-2",
      goal: "tentativa que nunca acerta o valor", commands: ["npm test"],
    });
    const env1: Env = { ...env, AGENT_FIX_ATTEMPTS: "1" };
    const out = await advanceAgentRun({ env: env1, db, models: models as never }, run.id);
    expect(out.status).toBe("failed");

    const final = (await db.getAgentRun(run.id))!;
    const byPhase = Object.fromEntries(final.steps.map((s) => [s.phase, s]));
    expect(byPhase.test.status).toBe("failed");
    expect(byPhase.test.log).toContain("tentativa de correção 1/1");
    expect(byPhase.test.log).toMatch(/Limite de correções esgotado \(1\/1\)/);
    expect(byPhase.commit?.status ?? "skipped").toBe("skipped");
  }, 120_000);
});
