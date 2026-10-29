/**
 * Item 2 — autonomia REAL do agente: sem patch humano, o LLM planeja
 * (lista de arquivos), gera o conteúdo, o agente aplica, testa e commita.
 * LLM aqui = stub determinístico (contrato chat), git/teste = reais.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileAdapter } from "../src/adapters/db/json-file.js";
import {
  __clearPlanCache, advanceAgentRun, extractFenced, parsePlanJson, runDir,
} from "../src/services/agent.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-autonomy-"));
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
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
};
const db = new JsonFileAdapter(env.JSON_DB_PATH!);

/** Stub de LLM: planejador retorna plano fixo; editor retorna conteúdo fixo. */
const calls: string[] = [];
const stubModels = {
  autoSelectText: async () => "stub-code",
  findTextAdapter: () => ({
    chat: async ({ messages }: { messages: Array<{ role: string; content: string }> }) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      calls.push(sys.slice(0, 20));
      if (sys.includes("planejador")) {
        return {
          text: `Aqui está o plano:\n{"files":[` +
            `{"path":"hello.txt","action":"create","instr":"criar saudação em pt-BR"},` +
            `{"path":"app.js","action":"modify","instr":"mudar v para 42"}` +
            `]}\n`,
          tokensIn: 10, tokensOut: 10, paid: false,
        };
      }
      if (sys.includes("editor")) {
        const user = messages.find((m) => m.role === "user")?.content ?? "";
        const target = user.match(/^Arquivo: (\S+)/m)?.[1] ?? "";
        const body = target === "hello.txt" ? "saudação do agente" : "module.exports = { v: 42 };";
        return { text: `\`\`\`\n${body}\n\`\`\`\n`, tokensIn: 10, tokensOut: 10, paid: false };
      }
      return { text: "análise stub", tokensIn: 1, tokensOut: 1, paid: false };
    },
  }),
};

function makeFixtureRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), "cr-ia-autofix-"));
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

let userId = "";
beforeAll(async () => {
  await db.init();
  const u = await db.createUser({ email: "auto@teste.com", name: "Auto", role: "admin", passwordHash: "h" });
  userId = u.id;
});

describe("parsePlanJson (validação do plano do LLM)", () => {
  it("aceita plano válido, tolerando texto ao redor", () => {
    const plan = parsePlanJson('texto antes {"files":[{"path":"a.txt","action":"create","instr":"criar"}]} texto depois');
    expect(plan).toEqual([{ path: "a.txt", action: "create", instr: "criar" }]);
  });

  it("recusa: sem JSON, sem files, ação delete, >8 arquivos", () => {
    expect(() => parsePlanJson("sem json aqui")).toThrow();
    expect(() => parsePlanJson('{"files":[]}')).toThrow(/files/);
    expect(() => parsePlanJson('{"files":[{"path":"a","action":"delete","instr":"x"}]}')).toThrow(/ação recusada/);
    const many = Array.from({ length: 9 }, (_, i) => `{"path":"f${i}.txt","action":"create","instr":"x"}`).join(",");
    expect(() => parsePlanJson(`{"files":[${many}]}`)).toThrow(/demais/);
  });

  it("recusa caminhos perigosos: traversal, absoluto, .env, segredos", () => {
    for (const p of ["../fora.txt", "/etc/x", ".env", "a/.env.local", "k.pem", "id_rsa", "lib/credentials.json", ".git/x"]) {
      expect(() => parsePlanJson(`{"files":[{"path":"${p}","action":"create","instr":"x"}]}`), p).toThrow(/recusado/);
    }
  });
});

describe("extractFenced", () => {
  it("extrai bloco cercado ou usa texto cru", () => {
    expect(extractFenced("```js\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractFenced("cru")).toBe("cru\n");
  });
});

describe("ciclo AUTÔNOMO real (sem patch humano)", () => {
  it("planeja, edita, testa e commita com o stub de LLM", async () => {
    __clearPlanCache();
    calls.length = 0;
    const fixture = makeFixtureRepo();
    const run = await db.createAgentRun({
      userId, repo: `local:${fixture}`, baseBranch: "main", workBranch: "cr-ia/auto-1",
      goal: "criar hello.txt e mudar app.js para v 42", commands: ["npm test"],
    });
    const out = await advanceAgentRun({ env, db, models: stubModels as never }, run.id);
    expect(out.status).toBe("done");

    const final = (await db.getAgentRun(run.id))!;
    const byPhase = Object.fromEntries(final.steps.map((s) => [s.phase, s]));
    // Plano do LLM registrado (auditoria)
    expect(byPhase.plan.log).toContain("plano do LLM (2 arquivo(s))");
    expect(byPhase.plan.log).toContain("hello.txt");
    // Edições aplicadas pelo agente
    expect(byPhase.edit.status).toBe("done");
    expect(byPhase.edit.log).toContain("app.js");
    // Arquivos REAIS no clone isolado
    const clone = runDir(env, run.id);
    expect(readFileSync(join(clone, "hello.txt"), "utf8")).toBe("saudação do agente\n");
    expect(readFileSync(join(clone, "app.js"), "utf8")).toBe("module.exports = { v: 42 };\n");
    // Teste real passou e commit foi criado
    expect(byPhase.test.status).toBe("done");
    expect(byPhase.test.log).toContain("fixture-ok");
    expect(byPhase.commit.status).toBe("done");
    // O LLM foi consultado como planejador E editor
    expect(calls.join("|")).toContain("planejador");
    expect(calls.join("|")).toContain("editor");
  }, 120_000);

  it("sem LLM útil: cai para análise/testes sem alterar nada (honesto)", async () => {
    __clearPlanCache();
    const dumb = {
      autoSelectText: async () => { throw new Error("sem provedor"); },
      findTextAdapter: () => null,
    };
    const fixture = makeFixtureRepo();
    const run = await db.createAgentRun({
      userId, repo: `local:${fixture}`, baseBranch: "main", workBranch: "cr-ia/auto-2",
      goal: "tarefa sem LLM", commands: ["npm test"],
    });
    const out = await advanceAgentRun({ env, db, models: dumb as never }, run.id);
    expect(out.status).toBe("done");
    const final = (await db.getAgentRun(run.id))!;
    const byPhase = Object.fromEntries(final.steps.map((s) => [s.phase, s]));
    expect(byPhase.plan.log).toContain("SOMENTE com análise/testes");
    expect(byPhase.edit.status).toBe("skipped");
  }, 120_000);
});
