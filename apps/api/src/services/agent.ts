/**
 * CR IA v0.2.0 — agente desenvolvedor REAL (prioridade máxima).
 *
 * O que ele faz de verdade, em ambiente isolado (/agentwork, NUNCA no app):
 * clone autorizado → análise → aplica patch → roda testes → commit →
 * push (c/ aprovação) → abre PR (c/ aprovação) → lê checks do Actions →
 * merge (c/ aprovação). Estado persistente no banco; logs reais por fase.
 *
 * Garantias:
 * - Só atua nos repos de GITHUB_ALLOWED_REPOS (fail-closed).
 * - Push, PR e merge EXIGEM aprovação humana explícita (sempre ON).
 * - Nunca faz push na branch base/main/master; nunca roda deploy.
 * - Comandos do usuário passam por allowlist + denylist, sem shell.
 * - Produção, banco de produção e ações destrutivas: sempre bloqueados.
 */
import { execFile } from "node:child_process";
import { dockerAvailable, runUserCommand } from "./sandbox.js";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { AgentApprovalKind, AgentPhase, AgentRun, AgentStep } from "@cr-ia/shared";
import type { Env } from "../types.js";
import type { DbAdapter } from "../adapters/db/types.js";
import type { ModelRegistry } from "../adapters/ai/registry.js";
import { nowIso } from "../lib/ids.js";
import { assertRepoAllowed, githubCommitChecks, githubCreatePull, githubMergePull } from "./github.js";

export interface AgentDeps {
  env: Env;
  db: DbAdapter;
  models: ModelRegistry;
}

export class RequeueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequeueError";
  }
}

const PHASES: AgentPhase[] = ["validate", "clone", "analyze", "plan", "edit", "test", "commit", "push", "pr", "checks", "merge", "done"];
const MAX_LOG_CHARS = 12_000;
const PROTECTED_BRANCHES = new Set(["main", "master", "production", "prod", "stable"]);

// ---------- política de comandos ----------
const BIN_ALLOW = new Set([
  "npm", "npx", "node", "pytest", "python", "python3", "go", "cargo",
  "composer", "php", "ls", "cat",
]);
const ARG_DENY = /[;&|`$><\n\r]|^-.*force|(^|\/)\.\.(\/|$)/;
const CMD_DENY = /\b(rm|mkfs|dd|shutdown|reboot|halt|poweroff|sudo|su|ssh|scp|curl|wget|docker|podman|systemctl|service|kill|pkill|chmod|chown|git|eval|exec|shutdown)\b/i;

/** Valida comando do usuário. Retorna [bin, args] ou lança erro explicativo. */
export function validateUserCommand(cmd: string): [string, string[]] {
  const clean = cmd.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Comando vazio.");
  if (clean.length > 500) throw new Error("Comando muito longo (máx. 500 chars).");
  if (CMD_DENY.test(clean)) throw new Error(`Comando bloqueado pela política de segurança: "${clean.slice(0, 80)}"`);
  const parts = clean.split(" ");
  const bin = parts[0];
  const base = bin.split("/").pop() ?? bin;
  if (!BIN_ALLOW.has(bin) && !BIN_ALLOW.has(base)) {
    throw new Error(`Binário "${bin}" fora da allowlist. Permitidos: ${[...BIN_ALLOW].join(", ")}.`);
  }
  for (const a of parts.slice(1)) {
    if (ARG_DENY.test(a)) throw new Error(`Argumento bloqueado: "${a.slice(0, 60)}"`);
  }
  // npm: só scripts de teste/build/install — nunca publish/login.
  if (base === "npm" && /^(publish|login|logout|owner|token|deprecate|unpublish)\b/.test(parts.slice(1).join(" "))) {
    throw new Error("Subcomando npm bloqueado (só teste/build/install).");
  }
  return [bin, parts.slice(1)];
}

function execCmd(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CI: "true", NO_COLOR: "1", HOME: process.env.HOME ?? "/tmp" },
    }, (error, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
      if (error && "killed" in error && (error as { killed?: boolean }).killed) {
        resolve({ code: 124, out: `${out}\n[TIMEOUT após ${timeoutMs}ms]` });
        return;
      }
      const code = typeof (error as { code?: unknown } | null)?.code === "number"
        ? ((error as { code: number }).code ?? 1)
        : error ? 1 : 0;
      resolve({ code, out: out.slice(-MAX_LOG_CHARS) });
    });
  });
}

// ---------- ambiente isolado ----------
export function agentWorkDir(env: Env): string {
  if (env.AGENT_WORK_DIR) return env.AGENT_WORK_DIR;
  if ((env.NODE_ENV ?? "development") === "test") return join(tmpdir(), "cr-ia-agent-test");
  return "./data/agentwork";
}

export function runDir(env: Env, runId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("runId inválido.");
  return join(agentWorkDir(env), runId);
}

export function isLocalRepo(repo: string): boolean {
  return repo.startsWith("local:");
}

/** Repositório autorizado (ou caminho local em modo teste automatizado). */
export function assertAgentRepo(env: Env, repo: string): void {
  if (isLocalRepo(repo)) {
    const allow = (env.AGENT_ALLOW_LOCAL_PATHS ?? "false").toLowerCase() === "true";
    const isTest = (env.NODE_ENV ?? "") === "test";
    if (!allow || !isTest) {
      throw new Error("Repositórios locais só são permitidos nos testes automatizados (AGENT_ALLOW_LOCAL_PATHS + NODE_ENV=test).");
    }
    return;
  }
  assertRepoAllowed(env, repo);
}

function approvalsRequired(): boolean {
  // Sempre ON: não existe flag para desligar aprovação de push/PR/merge.
  return true;
}

function timeoutMin(env: Env): number {
  const v = Number(env.AGENT_RUN_TIMEOUT_MIN ?? "20");
  return Number.isFinite(v) && v > 0 ? Math.min(v, 120) : 20;
}

function maxParallel(env: Env): number {
  const v = Number(env.AGENT_MAX_PARALLEL_RUNS ?? "1");
  return Number.isFinite(v) && v > 0 ? Math.min(v, 4) : 1;
}

// ---------- passos ----------
function getStep(run: AgentRun, phase: AgentPhase): AgentStep {
  let s = run.steps.find((x) => x.phase === phase);
  if (!s) {
    s = { phase, status: "pending", startedAt: null, finishedAt: null, log: "", awaitingApproval: null };
    run.steps.push(s);
  }
  return s;
}

function appendLog(step: AgentStep, text: string): void {
  step.log = `${step.log}${text}\n`.slice(-MAX_LOG_CHARS);
}

async function saveRun(db: DbAdapter, run: AgentRun): Promise<void> {
  await db.updateAgentRun(run.id, {
    status: run.status,
    currentPhase: run.currentPhase,
    steps: run.steps,
    approvals: run.approvals,
    prUrl: run.prUrl,
    checks: run.checks,
    result: run.result,
    error: run.error,
  });
}

function pauseForApproval(run: AgentRun, step: AgentStep, kind: AgentApprovalKind, msg: string): void {
  step.status = "running";
  step.awaitingApproval = kind;
  appendLog(step, `⏸️ ${msg}`);
  run.status = "awaiting_approval";
}

function localPath(repo: string): string {
  return repo.slice("local:".length);
}

// ---------- fases ----------
async function phaseValidate(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  // Entrada inválida primeiro (não vaza nada), autorização em seguida.
  if (PROTECTED_BRANCHES.has(run.workBranch) || run.workBranch === run.baseBranch) {
    throw new Error(`Branch de trabalho "${run.workBranch}" inválida: nunca usamos a branch base/protegida.`);
  }
  assertAgentRepo(deps.env, run.repo);
  for (const c of run.commands) validateUserCommand(c);
  const git = await execCmd("git", ["--version"], process.cwd(), 10_000);
  if (git.code !== 0) throw new Error("git não disponível no worker.");
  const runnable = await agentRunnable(deps.env);
  appendLog(step, `isolamento: ${runnable.detail}`);
  if (!runnable.runnable) throw new Error(`Agente DESATIVADO: ${runnable.reason}`);
  appendLog(step, `repo=${run.repo} base=${run.baseBranch} work=${run.workBranch}`);
  appendLog(step, `git: ${git.out.trim().slice(0, 80)}`);
  if (!isLocalRepo(run.repo) && !deps.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN não configurado — clone privado e PR exigem token.");
  }
  appendLog(step, "validação OK (repo autorizado, comandos permitidos, aprovações ON)");
}

async function phaseClone(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const dir = runDir(deps.env, run.id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(agentWorkDir(deps.env), { recursive: true });
  if (isLocalRepo(run.repo)) {
    const src = localPath(run.repo);
    const r = await execCmd("git", ["clone", "--depth", "50", src, dir], process.cwd(), 120_000);
    appendLog(step, r.out.slice(-3000));
    if (r.code !== 0) throw new Error(`Clone local falhou: ${r.out.slice(-500)}`);
  } else {
    const url = `https://github.com/${run.repo}.git`;
    const header = `http.extraHeader=Authorization: Bearer ${deps.env.GITHUB_TOKEN}`;
    const r = await execCmd("git", ["-c", header, "clone", "--depth", "50", "--branch", run.baseBranch, url, dir], process.cwd(), 300_000);
    appendLog(step, r.out.replace(/Bearer [^\s]+/g, "Bearer ***").slice(-3000));
    if (r.code !== 0) throw new Error(`Clone falhou (branch ${run.baseBranch}? token?): ${r.out.slice(-500)}`);
  }
  const co = await execCmd("git", ["checkout", "-b", run.workBranch], dir, 30_000);
  if (co.code !== 0) throw new Error(`Criar branch falhou: ${co.out.slice(-300)}`);
  appendLog(step, `clone OK em ${dir} + branch ${run.workBranch}`);
}

function listTree(dir: string, prefix: string, depth: number, out: string[]): void {
  if (depth > 4 || out.length > 400) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((e) => ![".git", "node_modules", "vendor", "__pycache__", ".next", "dist"].includes(e));
  } catch { return; }
  for (const e of entries.slice(0, 60)) {
    const p = join(dir, e);
    const rel = prefix ? `${prefix}/${e}` : e;
    try {
      out.push(statSync(p).isDirectory() ? `${rel}/` : rel);
      if (statSync(p).isDirectory()) listTree(p, rel, depth + 1, out);
    } catch { /* ignora */ }
  }
}

function readIfExists(dir: string, name: string, max = 4000): string | null {
  try {
    return readFileSync(join(dir, name), "utf-8").slice(0, max);
  } catch {
    return null;
  }
}

/**
 * Contexto da memória do projeto (exportado p/ testes): até 6 decisões/
 * correções do repo. "" = vazia/indisponível (nunca lança).
 */
export async function buildMemoryContext(
  db: Pick<AgentDeps, "db">["db"], userId: string, repo: string
): Promise<string> {
  try {
    const items = await db.listMemoryItems(userId, repo);
    const relevant = items.filter((m) => m.kind === "fix" || m.kind === "decision").slice(0, 6);
    if (!relevant.length) return "";
    return (
      `\n\nMEMÓRIA DO PROJETO (${relevant.length} registro(s) — respeite; não repita correções que falharam):\n` +
      relevant.map((m) => `- [${m.kind}] ${m.title}: ${m.content.slice(0, 400)}`).join("\n")
    );
  } catch {
    return "";
  }
}

async function phaseAnalyze(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const dir = runDir(deps.env, run.id);
  const tree: string[] = [];
  listTree(dir, "", 0, tree);
  appendLog(step, `arquivos (${tree.length}):\n${tree.slice(0, 120).join("\n")}`);
  // Memória do projeto (§8): decisões e correções anteriores entram no contexto
  // para não repetir o que já falhou. Best-effort: nunca quebra a análise.
  const memoryContext = await buildMemoryContext(deps.db, run.userId, run.repo);
  appendLog(step, memoryContext
    ? `memória do projeto incluída no contexto.`
    : "memória do projeto vazia/indisponível — seguindo sem contexto extra.");
  const keyNames = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "composer.json", "Dockerfile", "README.md"];
  const keys: Record<string, string> = {};
  for (const k of keyNames) {
    const content = readIfExists(dir, k);
    if (content) {
      keys[k] = content;
      appendLog(step, `--- ${k} ---\n${content.slice(0, 800)}`);
    }
  }
  // Resumo por LLM (best-effort; heurística se falhar).
  try {
    const modelId = await deps.models.autoSelectText("code");
    const adapter = deps.models.findTextAdapter(modelId);
    if (adapter) {
      const r = await adapter.chat({
        model: modelId,
        messages: [{
          role: "user",
          content:
            `Analise este repositório para a tarefa: "${run.goal}"\n\nÁrvore:\n${tree.slice(0, 150).join("\n")}\n\n` +
            Object.entries(keys).map(([k, v]) => `--- ${k} ---\n${v.slice(0, 1500)}`).join("\n\n") +
            memoryContext +
            `\n\nResponda em português, curto: 1) stack detectada; 2) onde provavelmente fica o código da tarefa (arquivos); 3) comando de teste sugerido.`,
        }],
        maxTokens: 800,
      });
      appendLog(step, `--- análise (${modelId}) ---\n${r.text.slice(0, 3000)}`);
      await deps.db.logUsage({
        userId: run.userId, modelId, kind: "chat",
        tokensIn: r.tokensIn, tokensOut: r.tokensOut, costFlag: r.paid,
      });
    }
  } catch (e) {
    appendLog(step, `análise LLM indisponível (${e instanceof Error ? e.message : "erro"}) — seguindo com heurística.`);
  }
}

function detectTestCommand(dir: string): string | null {
  const pkg = readIfExists(dir, "package.json", 8000);
  if (pkg) {
    try {
      const scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {};
      if (scripts.test && !/watch|dev|start/i.test(scripts.test)) return "npm test";
      if (scripts.test) return "npm test"; // CI=true evita watch na maioria
    } catch { /* segue */ }
  }
  if (readIfExists(dir, "pyproject.toml", 500) || readIfExists(dir, "pytest.ini", 500)) return "pytest -q";
  if (readIfExists(dir, "go.mod", 500)) return "go test ./...";
  if (readIfExists(dir, "composer.json", 2000)) return "composer test";
  return null;
}

/**
 * Item 2 — autonomia real (modo "LLM decide + edita + testa").
 * COM patch humano (diff) → legado: aplica o diff, LLM só analisa.
 * SEM patch → o agente pede ao LLM um PLANO (arquivos) e gera/aplica o
 * conteúdo de cada um; depois testa, commita e aguarda aprovação humana
 * para push/PR/merge (inalterado). Tudo registrado no log (auditoria).
 */
export interface LlmPlanFile { path: string; action: "create" | "modify"; instr: string }
const planCache = new Map<string, LlmPlanFile[]>();
export function __clearPlanCache(): void { planCache.clear(); }
export function __getPlanCache(runId: string): LlmPlanFile[] | undefined {
  return planCache.get(runId);
}

/**
 * Gate de isolamento (§5): sem execução segura, o agente fica DESATIVADO
 * (fail-closed) com motivo claro — nunca finge funcionar.
 */
let runnableCache: { at: number; docker: boolean } | null = null;
export function __clearRunnableCache(): void { runnableCache = null; }
export interface AgentRunnable {
  runnable: boolean;
  engine: "docker" | "host" | "none";
  detail: string;
  reason: string;
}
export async function agentRunnable(env: Env, dockerCheck: (ms?: number) => Promise<boolean> = dockerAvailable): Promise<AgentRunnable> {
  const runner = (env.AGENT_RUNNER ?? "auto").toLowerCase();
  const hostAllowed = (env.AGENT_ALLOW_HOST_EXEC ?? "false").toLowerCase() === "true";
  const prod = (env.NODE_ENV ?? "development") === "production";
  if (runner === "host") {
    if (!hostAllowed) {
      return { runnable: false, engine: "none", detail: "host (não permitido)", reason: "AGENT_RUNNER=host exige AGENT_ALLOW_HOST_EXEC=true explícito." };
    }
    if (prod) {
      return { runnable: false, engine: "none", detail: "host (proibido em produção)", reason: "Execução no host é PROIBIDA em produção (sem isolamento). Monte o socket Docker no worker para ativar o sandbox." };
    }
    return { runnable: true, engine: "host", detail: "host (SEM isolamento — só dev/teste)", reason: "" };
  }
  const now = Date.now();
  let docker: boolean;
  if (runnableCache && now - runnableCache.at < 60_000) {
    docker = runnableCache.docker;
  } else {
    docker = await dockerCheck(8000).catch(() => false);
    runnableCache = { at: now, docker };
  }
  if (docker) return { runnable: true, engine: "docker", detail: "docker (contêiner descartável)", reason: "" };
  if (runner === "docker") {
    return { runnable: false, engine: "none", detail: "docker (indisponível)", reason: "Docker indisponível para o worker (socket não montado?). Monte o socket (ver compose/docs) ou desative o agente." };
  }
  if (hostAllowed && !prod) {
    return { runnable: true, engine: "host", detail: "host via fallback (dev/teste)", reason: "" };
  }
  return {
    runnable: false, engine: "none",
    detail: "auto (sem isolamento utilizável)",
    reason: "Sem Docker e sem permissão de host em produção: execução do agente DESATIVADA. Monte o socket Docker no worker (ver compose/docs) para ativar com segurança.",
  };
}

export function fixAttemptsMax(env: Env): number {
  const n = Number(env.AGENT_FIX_ATTEMPTS ?? 2);
  return Number.isFinite(n) ? Math.min(5, Math.max(0, Math.floor(n))) : 2;
}

const EDIT_DENY = [/\.env(\.|$)/i, /\.pem$/i, /\.key$/i, /credentials/i, /secret/i, /id_rsa/i];
function assertEditablePath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new Error(`Caminho recusado (fora do clone): ${path.slice(0, 80)}`);
  }
  const low = path.toLowerCase();
  if (low.startsWith(".git/") || low.startsWith("node_modules/") || low === ".cr-ia.patch") {
    throw new Error(`Caminho recusado (área interna): ${path.slice(0, 80)}`);
  }
  for (const re of EDIT_DENY) {
    if (re.test(low)) throw new Error(`Caminho recusado (possível segredo): ${path.slice(0, 80)}`);
  }
}

async function chatOnce(deps: AgentDeps, run: AgentRun, system: string, user: string, maxTokens: number): Promise<string> {
  const modelId = await deps.models.autoSelectText("code");
  const adapter = deps.models.findTextAdapter(modelId);
  if (!adapter) throw new Error("nenhum adaptador de texto disponível.");
  const r = await adapter.chat({
    model: modelId,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    maxTokens,
  });
  await deps.db.logUsage({
    userId: run.userId, modelId, kind: "chat",
    tokensIn: r.tokensIn, tokensOut: r.tokensOut, costFlag: r.paid,
  });
  return r.text;
}

/** Valida o plano do LLM: ≤8 arquivos, só create/modify, caminhos seguros. */
export function parsePlanJson(text: string): LlmPlanFile[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("resposta sem JSON.");
  const obj = JSON.parse(text.slice(start, end + 1)) as { files?: Array<{ path?: unknown; action?: unknown; instr?: unknown }> };
  if (!obj || !Array.isArray(obj.files) || obj.files.length === 0) {
    throw new Error("JSON sem lista \"files\".");
  }
  if (obj.files.length > 8) throw new Error("plano com arquivos demais (máx 8).");
  return obj.files.map((f) => {
    const path = String(f?.path ?? "");
    const action = String(f?.action ?? "");
    const instr = String(f?.instr ?? "").slice(0, 500);
    if (action !== "create" && action !== "modify") {
      throw new Error(`ação recusada (só create/modify): ${action.slice(0, 20)}`);
    }
    if (!instr.trim()) throw new Error(`instrução vazia para ${path.slice(0, 60)}.`);
    assertEditablePath(path);
    return { path, action, instr };
  });
}

/** Gera o plano via LLM (fase plan; reutilizado na fase edit). */
async function generatePlan(deps: AgentDeps, run: AgentRun, dir: string, tree: string[]): Promise<LlmPlanFile[]> {
  const cached = planCache.get(run.id);
  if (cached) return cached;
  const memoryContext = await buildMemoryContext(deps.db, run.userId, run.repo);
  const keys: string[] = [];
  for (const k of ["package.json", "pyproject.toml", "requirements.txt", "go.mod"]) {
    const c = readIfExists(dir, k);
    if (c) keys.push(`--- ${k} ---\n${c.slice(0, 1200)}`);
  }
  const text = await chatOnce(
    deps, run,
    "Você é o planejador do agente CR IA. Responda SOMENTE com JSON válido, sem markdown, sem explicações.",
    `Tarefa: "${run.goal}"\n\nÁrvore do repositório:\n${tree.slice(0, 150).join("\n")}\n\n${keys.join("\n\n")}${memoryContext}\n\n` +
    `Decida quais arquivos criar/alterar (máx 8; NUNCA .env, chaves, segredos ou arquivos fora do repo). ` +
    `Retorne SOMENTE este JSON: {"files":[{"path":"caminho/relativo","action":"create ou modify","instr":"o que fazer neste arquivo"}]}`,
    1200,
  );
  const plan = parsePlanJson(text);
  planCache.set(run.id, plan);
  return plan;
}

/** Extrai o conteúdo novo: dentro de ```cerca```, ou o texto cru. */
export function extractFenced(text: string): string {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  return (m ? m[1] : text).replace(/^\n+/, "").replace(/\s+$/, "") + "\n";
}

/** Aplica as edições do plano: pede o conteúdo novo ao LLM e grava. */
async function applyLlmEdits(deps: AgentDeps, run: AgentRun, dir: string, step: AgentStep, plan: LlmPlanFile[]): Promise<void> {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  for (const f of plan) {
    assertEditablePath(f.path); // revalida (defesa em profundidade)
    const full = join(dir, f.path);
    if (!full.startsWith(dir + sep)) throw new Error(`Caminho escapou do clone: ${f.path}`);
    const current = f.action === "modify" ? readIfExists(dir, f.path, 20_000) : null;
    if (f.action === "modify" && current === null) {
      throw new Error(`Arquivo do plano não existe para modify: ${f.path}`);
    }
    const text = await chatOnce(
      deps, run,
      "Você é o editor do agente CR IA. Responda SOMENTE com o conteúdo completo do arquivo, dentro de um bloco ``` único. Sem explicações fora do bloco.",
      `Tarefa: "${run.goal}"\nArquivo: ${f.path} (ação: ${f.action})\nInstrução: ${f.instr}\n` +
      (current !== null ? `\nConteúdo atual:\n${current}\n` : `\nArquivo novo — crie do zero.\n`) +
      `\nRetorne o conteúdo COMPLETO e final do arquivo.`,
      4000,
    );
    const content = extractFenced(text);
    if (content.length > 100_000) throw new Error(`Conteúdo recusado (grande demais): ${f.path}`);
    if (content.includes("\0")) throw new Error(`Conteúdo recusado (binário): ${f.path}`);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    appendLog(step, `  ✎ ${f.action} ${f.path} (${content.length} chars)`);
  }
  const status = await execCmd("git", ["status", "--short"], dir, 15_000);
  appendLog(step, `edições do LLM aplicadas. Alterados:\n${status.out.slice(-2000)}`);
}

async function phasePlan(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const dir = runDir(deps.env, run.id);
  const auto = detectTestCommand(dir);
  const plan = [
    `objetivo: ${run.goal}`,
    `patch: ${run.patch ? `fornecido (${run.patch.length} chars)` : "não (modo autônomo via LLM, se disponível)"}`,
    `comandos do usuário: ${run.commands.length ? run.commands.join(" | ") : "nenhum"}`,
    `teste detectado: ${auto ?? "nenhum (rode comandos manuais ou cancele)"}`,
    `aprovações exigidas: push → PR → merge (todas humanas, nesta ordem)`,
  ];
  appendLog(step, plan.join("\n"));
  if (!run.patch?.trim()) {
    // Modo autônomo: o LLM decide o que alterar (registrado p/ auditoria).
    // Se o LLM falhar, cai para análise/testes (nada é alterado).
    try {
      const tree: string[] = [];
      listTree(dir, "", 0, tree);
      const files = await generatePlan(deps, run, dir, tree);
      appendLog(step, `plano do LLM (${files.length} arquivo(s)):`);
      for (const f of files) appendLog(step, `  - ${f.action} ${f.path}: ${f.instr.slice(0, 160)}`);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "erro";
      appendLog(step, `planejamento LLM indisponível (${reason}) — seguindo SOMENTE com análise/testes; nada será alterado.`);
    }
  }
}

async function phaseEdit(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const dir = runDir(deps.env, run.id);
  if (!run.patch?.trim()) {
    // Modo autônomo: aplica o plano do LLM (ou pula se não houve plano).
    let plan = __getPlanCache(run.id);
    if (!plan) {
      try {
        const tree: string[] = [];
        listTree(dir, "", 0, tree);
        plan = await generatePlan(deps, run, dir, tree);
      } catch (e) {
        const reason = e instanceof Error ? e.message : "erro";
        appendLog(step, `sem plano do LLM (${reason}) — nenhuma edição aplicada (fase de testes/análise).`);
        step.status = "skipped";
        return;
      }
    }
    appendLog(step, `aplicando plano do LLM (${plan.length} arquivo(s)):`);
    await applyLlmEdits(deps, run, dir, step, plan);
    return;
  }
  const patchPath = join(dir, ".cr-ia.patch");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(patchPath, run.patch);
  const check = await execCmd("git", ["apply", "--check", ".cr-ia.patch"], dir, 30_000);
  appendLog(step, check.out.slice(-2000));
  if (check.code !== 0) throw new Error(`Patch não aplica limpamente: ${check.out.slice(-500)}`);
  const apply = await execCmd("git", ["apply", ".cr-ia.patch"], dir, 30_000);
  if (apply.code !== 0) throw new Error(`git apply falhou: ${apply.out.slice(-500)}`);
  const status = await execCmd("git", ["status", "--short"], dir, 15_000);
  appendLog(step, `patch aplicado. Alterados:\n${status.out.slice(-2000)}`);
}

/**
 * Correção iterativa (§5): se os testes falham no modo autônomo (plano do
 * LLM), o agente tenta corrigir (limitado a AGENT_FIX_ATTEMPTS, máx 5) e
 * roda os testes de novo. Tudo registrado no log.
 */
async function applyLlmFix(deps: AgentDeps, run: AgentRun, dir: string, step: AgentStep, plan: LlmPlanFile[], failure: string, attempt: number): Promise<void> {
  const { writeFileSync } = await import("node:fs");
  appendLog(step, `tentativa de correção ${attempt}: pedindo revisão ao LLM...`);
  for (const f of plan) {
    assertEditablePath(f.path);
    const full = join(dir, f.path);
    if (!full.startsWith(dir + sep)) throw new Error(`Caminho escapou do clone: ${f.path}`);
    const current = readIfExists(dir, f.path, 20_000) ?? "(arquivo ainda não existe)";
    const text = await chatOnce(
      deps, run,
      "Você é o corretor do agente CR IA. Responda SOMENTE com o conteúdo completo do arquivo, dentro de um bloco ``` único. Sem explicações fora do bloco.",
      `Tarefa: "${run.goal}"\nArquivo: ${f.path}\nOs testes FALHARAM:\n${failure.slice(0, 3000)}\n\nConteúdo atual:\n${current}\n\nCorrija o arquivo para os testes passarem. Retorne o conteúdo COMPLETO.`,
      4000,
    );
    const content = extractFenced(text);
    if (content.length > 100_000) throw new Error(`Conteúdo recusado (grande demais): ${f.path}`);
    if (content.includes("\0")) throw new Error(`Conteúdo recusado (binário): ${f.path}`);
    writeFileSync(full, content);
    appendLog(step, `  ✎ corrigido ${f.path}`);
  }
}

async function phaseTestWithFix(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const max = fixAttemptsMax(deps.env);
  try {
    await phaseTest(deps, run, step);
    return;
  } catch (e) {
    const plan = __getPlanCache(run.id);
    if (!plan?.length || run.patch?.trim() || max <= 0) throw e;
    let last: unknown = e;
    for (let i = 1; i <= max; i++) {
      appendLog(step, `teste falhou (tentativa de correção ${i}/${max})`);
      const dir = runDir(deps.env, run.id);
      const failure = `${last instanceof Error ? last.message : "erro"}\n${step.log.slice(-2000)}`;
      await applyLlmFix(deps, run, dir, step, plan, failure, i);
      try {
        await phaseTest(deps, run, step);
        appendLog(step, `correção ${i} resolveu — testes passando.`);
        return;
      } catch (e2) {
        last = e2;
      }
    }
    const msg = last instanceof Error ? last.message : "erro desconhecido";
    throw new Error(`Limite de correções esgotado (${max}/${max}) — última falha: ${msg}`);
  }
}

async function phaseTest(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const dir = runDir(deps.env, run.id);
  const cmds = [...run.commands];
  const auto = detectTestCommand(dir);
  if (!cmds.length && auto) cmds.push(auto);
  if (!cmds.length) throw new Error("Nenhum comando de teste (informe commands ou adicione script de teste ao repo).");
  for (const c of cmds) {
    // Isolado por padrão: contêiner descartável (ver services/sandbox.ts).
    const r = await runUserCommand({ env: deps.env, dir, command: c, timeoutMs: 600_000 });
    appendLog(step, `[motor: ${r.engine}] ${r.detail}`);
    if (r.out) appendLog(step, r.out.slice(-6000));
    if (r.engine === "skipped") {
      throw new Error(`Testes NÃO executados — ${r.detail}`);
    }
    appendLog(step, `→ exit ${r.code}`);
    if (r.code !== 0) throw new Error(`Teste falhou (exit ${r.code}): ${c.slice(0, 100)}`);
  }
  appendLog(step, "todos os testes passaram.");
}

async function phaseCommit(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  const dir = runDir(deps.env, run.id);
  const diff = await execCmd("git", ["status", "--short"], dir, 15_000);
  if (!diff.out.trim() || diff.out.trim() === "?? .cr-ia.patch") {
    appendLog(step, "nada para commitar (sem alterações) — commit pulado.");
    step.status = "skipped";
    return;
  }
  await execCmd("git", ["add", "-A", ":!.cr-ia.patch"], dir, 30_000);
  const msg = `cr-ia: ${run.goal.slice(0, 100)}\n\nExecução ${run.id} (agente CR IA, branch ${run.workBranch}).`;
  const ci = await execCmd("git", [
    "-c", "user.name=cr-ia-agent", "-c", "user.email=agent@cr-ia.local",
    "commit", "-m", msg,
  ], dir, 60_000);
  appendLog(step, ci.out.slice(-2000));
  if (ci.code !== 0) throw new Error(`Commit falhou: ${ci.out.slice(-300)}`);
  appendLog(step, "commit criado.");
}

async function phasePush(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<boolean> {
  if (isLocalRepo(run.repo)) {
    appendLog(step, "modo teste local: sem push (skipped).");
    step.status = "skipped";
    return true;
  }
  if (approvalsRequired() && !run.approvals.push) {
    pauseForApproval(run, step, "push", `Push de ${run.workBranch} para origin aguarda sua aprovação.`);
    return false;
  }
  if (PROTECTED_BRANCHES.has(run.workBranch)) throw new Error("Push em branch protegida: bloqueado.");
  const dir = runDir(deps.env, run.id);
  const header = `http.extraHeader=Authorization: Bearer ${deps.env.GITHUB_TOKEN}`;
  const r = await execCmd("git", ["-c", header, "push", "origin", run.workBranch], dir, 300_000);
  appendLog(step, r.out.replace(/Bearer [^\s]+/g, "Bearer ***").slice(-3000));
  if (r.code !== 0) throw new Error(`Push falhou: ${r.out.slice(-500)}`);
  appendLog(step, `push OK: origin/${run.workBranch}`);
  return true;
}

async function phasePr(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<boolean> {
  if (isLocalRepo(run.repo)) {
    appendLog(step, "modo teste local: sem PR (skipped).");
    step.status = "skipped";
    return true;
  }
  if (run.prUrl) {
    appendLog(step, `PR já existe: ${run.prUrl}`);
    return true;
  }
  if (approvalsRequired() && !run.approvals.pr) {
    pauseForApproval(run, step, "pr", "Criação do PR aguarda sua aprovação.");
    return false;
  }
  const testLog = run.steps.find((s) => s.phase === "test")?.log.slice(-1500) ?? "";
  const pr = await githubCreatePull(deps.env, run.repo, {
    title: `cr-ia: ${run.goal.slice(0, 100)}`,
    body:
      `## Tarefa\n${run.goal}\n\n` +
      `## Branch\n\`${run.workBranch}\` → \`${run.baseBranch}\`\n\n` +
      `## Testes (executados pelo agente)\n\`\`\`\n${testLog}\n\`\`\`\n\n` +
      `---\nCriado pelo agente CR IA (execução ${run.id}) após aprovação humana. ` +
      `Merge exige nova aprovação.`,
    head: run.workBranch,
    base: run.baseBranch,
  });
  run.prUrl = pr.url;
  appendLog(step, `PR criado: ${pr.url} (#${pr.number})`);
  return true;
}

async function phaseChecks(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<void> {
  if (isLocalRepo(run.repo) || !run.prUrl) {
    appendLog(step, "sem PR remoto — checks pulados.");
    step.status = "skipped";
    return;
  }
  const m = run.prUrl.match(/\/pull\/(\d+)/);
  if (!m) {
    appendLog(step, "URL do PR irreconhecível — checks pulados.");
    step.status = "skipped";
    return;
  }
  // Lê o head SHA do PR (1 chamada) e consulta checks (até 3 tentativas espaçadas).
  const infoRes = await fetch(`https://api.github.com/repos/${run.repo}/pulls/${m[1]}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${deps.env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "cr-ia/0.2",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!infoRes.ok) throw new Error(`GitHub: não foi possível ler o PR #${m[1]}.`);
  const info = (await infoRes.json()) as { head?: { sha?: string } };
  const sha = info.head?.sha ?? "";
  if (!sha) throw new Error("GitHub: PR sem head SHA.");
  let checks = await githubCommitChecks(deps.env, run.repo, sha);
  for (let i = 0; i < 2 && checks.some((c) => c.status !== "completed" && c.conclusion === null); i++) {
    await new Promise((r) => setTimeout(r, 20_000));
    checks = await githubCommitChecks(deps.env, run.repo, sha);
  }
  run.checks = checks;
  if (!checks.length) {
    appendLog(step, "nenhum check/status retornado (repo sem Actions ou ainda enfileirando).");
    return;
  }
  for (const c of checks) appendLog(step, `- ${c.name}: ${c.status}${c.conclusion ? ` (${c.conclusion})` : ""}`);
  const failed = checks.filter((c) => c.conclusion === "failure" || c.conclusion === "failed" || c.conclusion === "error");
  if (failed.length) appendLog(step, `⚠️ ${failed.length} check(s) falharam — o merge será recusado até corrigir.`);
}

async function phaseMerge(deps: AgentDeps, run: AgentRun, step: AgentStep): Promise<boolean> {
  if (isLocalRepo(run.repo) || !run.prUrl) {
    appendLog(step, "sem PR remoto — merge pulado.");
    step.status = "skipped";
    return true;
  }
  if (approvalsRequired() && !run.approvals.merge) {
    pauseForApproval(run, step, "merge", `Merge do PR ${run.prUrl} aguarda sua aprovação explícita.`);
    return false;
  }
  const failed = run.checks.filter((c) => c.conclusion === "failure" || c.conclusion === "failed" || c.conclusion === "error");
  if (failed.length) {
    throw new Error(`Merge recusado: ${failed.length} check(s) falharam (${failed.map((f) => f.name).join(", ")}). Corrija e rode de novo.`);
  }
  const m = run.prUrl.match(/\/pull\/(\d+)/);
  if (!m) throw new Error("URL do PR irreconhecível.");
  const r = await githubMergePull(deps.env, run.repo, Number(m[1]), "merge");
  appendLog(step, r.merged ? `✅ PR #${m[1]} merged. ${r.message}` : `Merge não concluído: ${r.message}`);
  if (!r.merged) throw new Error(`GitHub recusou o merge: ${r.message || "verifique o PR"}`);
  return true;
}

/** Sintaxe: /agente <owner/repo> <tarefa com 10+ caracteres> */
export function parseAgentCommand(text: string): { repo: string; goal: string } {
  const m = text.trim().match(/^\/agente\s+(\S+)\s+([\s\S]+)$/);
  if (!m) {
    throw new Error("Uso: /agente owner/repo sua tarefa aqui (ex.: /agente dono/proj analisar erros e corrigir testes).");
  }
  const goal = m[2].trim();
  if (goal.length < 10) throw new Error("Descreva a tarefa com ao menos 10 caracteres após o repo.");
  if (goal.length > 2000) throw new Error("Tarefa longa demais (máx 2000 caracteres).");
  return { repo: m[1], goal };
}

export function slugBranch(goal: string): string {
  const slug = goal.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "tarefa";
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 7);
  return `cr-ia/${stamp}-${slug}-${rand}`;
}

export interface CreateAgentRunInput {
  repo: string;
  baseBranch?: string;
  goal: string;
  commands?: string[];
  patch?: string | null;
}

/** Cria execução + tarefa (usado pela rota POST /runs e pelo /agente). */
export async function createAgentRunAndTask(
  deps: { env: Env; db: DbAdapter },
  userId: string,
  input: CreateAgentRunInput,
): Promise<{ run: AgentRun; taskId: string }> {
  const { env, db } = deps;
  const repo = input.repo.trim();
  assertAgentRepo(env, repo);
  for (const cmd of input.commands ?? []) validateUserCommand(cmd);
  const runnable = await agentRunnable(env);
  if (!runnable.runnable) throw new Error(`Agente DESATIVADO: ${runnable.reason}`);
  let baseBranch = input.baseBranch?.trim();
  if (!baseBranch && !isLocalRepo(repo)) {
    try {
      const { githubRepoInfo } = await import("./github.js");
      const info = await githubRepoInfo(env, repo);
      baseBranch = typeof info.default_branch === "string" ? info.default_branch : "main";
    } catch {
      baseBranch = "main";
    }
  }
  baseBranch = baseBranch || "main";
  const run = await db.createAgentRun({
    userId, repo, baseBranch,
    workBranch: slugBranch(input.goal),
    goal: input.goal.trim(),
    commands: input.commands ?? [],
    patch: input.patch ?? null,
  });
  const task = await db.createTask({
    userId, type: "agent-run",
    title: `Agente: ${repo} — ${input.goal.slice(0, 80)}`,
    payload: { runId: run.id },
    maxAttempts: 1, // o agente controla o próprio ciclo; sem retry cego
  });
  await db.updateAgentRun(run.id, { taskId: task.id });
  if (env.TASKS) {
    await env.TASKS.send({ taskId: task.id }).catch(() => undefined);
  }
  await db.logAudit({ userId, action: "agent.created", detail: `${run.id} ${repo}` });
  const full = await db.getAgentRun(run.id);
  if (!full) throw new Error("Falha ao ler a execução criada.");
  return { run: full, taskId: task.id };
}

// ---------- motor ----------
export interface AdvanceResult {
  status: AgentRun["status"];
  /** true = pausou aguardando aprovação (worker deve parar de processar). */
  paused: boolean;
}

export async function advanceAgentRun(deps: AgentDeps, runId: string): Promise<AdvanceResult> {
  const { db } = deps;
  const run = await db.getAgentRun(runId);
  if (!run) throw new Error(`Execução ${runId} não encontrada.`);
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    return { status: run.status, paused: false };
  }

  // Paralelismo: evita 2 agentes disputando CPU/RAM (só conta quem está
  // executando de fato; "pending" é fila e "awaiting_approval" está pausado).
  const active = (await db.listAgentRuns()).filter((r) =>
    r.id !== run.id && r.status === "running");
  if (run.status !== "awaiting_approval" && active.length >= maxParallel(deps.env)) {
    throw new RequeueError(`Outro agente em execução (${active.length}). Tentando de novo em 1 min.`);
  }

  // Timeout global da execução.
  const ageMin = (Date.now() - new Date(run.updatedAt).getTime()) / 60000;
  if (ageMin > timeoutMin(deps.env) && run.status !== "awaiting_approval") {
    run.status = "failed";
    run.error = `Tempo limite excedido (${timeoutMin(deps.env)} min sem concluir).`;
    await saveRun(db, run);
    await db.logAudit({ userId: run.userId, action: "agent.timeout", detail: run.id });
    return { status: "failed", paused: false };
  }

  if (run.status === "pending" || run.status === "awaiting_approval") {
    run.status = "running";
  }

  try {
    for (let guard = 0; guard < PHASES.length + 2; guard++) {
      const phase = run.currentPhase;
      const step = getStep(run, phase);
      if (step.status === "pending" || (run.status === "running" && step.awaitingApproval && run.approvals[step.awaitingApproval])) {
        step.status = "running";
        step.startedAt = step.startedAt ?? nowIso();
        if (step.awaitingApproval && run.approvals[step.awaitingApproval]) {
          appendLog(step, `✅ aprovação "${step.awaitingApproval}" concedida — retomando.`);
          step.awaitingApproval = null;
        }
      } else if (step.status === "running" && !step.awaitingApproval) {
        // retomada após reinício do worker no meio da fase: reexecuta a fase
        appendLog(step, "retomando fase interrompida...");
      }
      await saveRun(db, run);

      let proceed = true;
      switch (phase) {
        case "validate": await phaseValidate(deps, run, step); break;
        case "clone": await phaseClone(deps, run, step); break;
        case "analyze": await phaseAnalyze(deps, run, step); break;
        case "plan": await phasePlan(deps, run, step); break;
        case "edit": await phaseEdit(deps, run, step); break;
        case "test": await phaseTestWithFix(deps, run, step); break;
        case "commit": await phaseCommit(deps, run, step); break;
        case "push": proceed = await phasePush(deps, run, step); break;
        case "pr": proceed = await phasePr(deps, run, step); break;
        case "checks": await phaseChecks(deps, run, step); break;
        case "merge": proceed = await phaseMerge(deps, run, step); break;
        case "done": {
          step.status = "done";
          step.finishedAt = nowIso();
          run.status = "done";
          run.result = run.prUrl
            ? `Concluído. PR: ${run.prUrl}`
            : "Concluído (análise/testes locais, sem PR remoto).";
          await saveRun(db, run);
          await db.logAudit({ userId: run.userId, action: "agent.done", detail: `${run.id} ${run.repo}` });
          return { status: "done", paused: false };
        }
      }

      if (!proceed) {
        await saveRun(db, run);
        await db.logAudit({
          userId: run.userId, action: "agent.awaiting_approval",
          detail: `${run.id} :: ${step.awaitingApproval}`,
        });
        return { status: "awaiting_approval", paused: true };
      }
      if (step.status === "running") {
        step.status = "done";
        step.finishedAt = nowIso();
      }
      const next = PHASES[PHASES.indexOf(phase) + 1] ?? "done";
      run.currentPhase = next;
      await saveRun(db, run);
    }
    throw new Error("Motor do agente excedeu o número de fases (bug interno).");
  } catch (e) {
    if (e instanceof RequeueError) throw e;
    const msg = e instanceof Error ? e.message : "Erro desconhecido";
    const step = getStep(run, run.currentPhase);
    step.status = "failed";
    step.finishedAt = nowIso();
    appendLog(step, `❌ ${msg}`);
    run.status = "failed";
    run.error = msg;
    await saveRun(db, run);
    await db.logAudit({ userId: run.userId, action: "agent.failed", detail: `${run.id} :: ${msg.slice(0, 300)}` });
    return { status: "failed", paused: false };
  }
}

/** Remove o diretório isolado da execução (chamado no cancelamento). */
export function cleanupRunDir(env: Env, runId: string): void {
  try {
    rmSync(runDir(env, runId), { recursive: true, force: true });
  } catch { /* best-effort */ }
}
