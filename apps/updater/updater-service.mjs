#!/usr/bin/env node
/**
 * CR IA — serviço de aplicação de atualizações (§4).
 *
 * Container SEPARADO (sem portas, sem acesso externo). A API pública NUNCA
 * tem socket Docker: ela só valida uploads e escreve pedidos em
 * <UPDATES_DIR>/queue/. Este serviço lê a fila e aplica:
 *   approved-*.json → backup → snapshot → rsync → rebuild → migrate →
 *                     healthcheck → histórico (falha => rollback automático)
 *   rollback-*.json → backup → snapshot pre-rollback → restaura → rebuild →
 *                     healthcheck → histórico (+ aviso de banco irreversível)
 *
 * Env: APP_DIR, UPDATES_DIR, HEALTH_URL, UPDATER_PROJECT, POLL_MS,
 *       UPDATER_QUEUE_SECRET (obrigatório — sem ele o serviço nem sobe),
 *       UPDATER_ONCE=1 (processa a fila uma vez e sai — p/ testes).
 */
import { spawn } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { acquireLock } from "../../scripts/r2-lib.mjs";

const APP_DIR = process.env.APP_DIR || "/app";
const UPDATES_DIR = process.env.UPDATES_DIR || join(APP_DIR, "data", "updates");
const HEALTH_URL = process.env.HEALTH_URL || "http://web/api/health";
const PROJECT = process.env.UPDATER_PROJECT || "cr-ia";
const POLL_MS = Number(process.env.POLL_MS || 15000);
const ONCE = process.env.UPDATER_ONCE === "1";
const HEALTH_WAIT_MS = Number(process.env.UPDATER_HEALTH_WAIT_MS || 180_000);
const QUEUE_SECRET = process.env.UPDATER_QUEUE_SECRET || "";
if (QUEUE_SECRET.length < 16) {
  console.error("[updater] FATAL: UPDATER_QUEUE_SECRET ausente/curto — sem ele, nenhum pedido é confiável. Abortando.");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(PROJECT)) {
  console.error("[updater] FATAL: UPDATER_PROJECT inválido.");
  process.exit(1);
}

const RSYNC_EXCLUDES = [
  ".env", ".env.*", ".git/", "data/", "backups/", "node_modules/",
  "releases/", ".cr-ia-receipt.json", ".cr-ia-checks.json",
];

function log(msg) {
  const line = `[updater ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(UPDATES_DIR, { recursive: true });
    appendFileSync(join(UPDATES_DIR, "updater.log"), line.replace(/Bearer\s+\S+/g, "Bearer ***") + "\n");
  } catch { /* log best-effort */ }
}

function history(entry) {
  try {
    mkdirSync(UPDATES_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(UPDATES_DIR, "history.jsonl"), line.replace(/Bearer\s+\S+/g, "Bearer ***") + "\n");
  } catch { /* histórico best-effort */ }
}

function run(cmd, args, { cwd = APP_DIR, timeoutMs = 600_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs });
    let out = "";
    const push = (d) => { out += d.toString(); if (out.length > 1_000_000) out = out.slice(-1_000_000); };
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    child.on("error", (e) => resolve({ code: 1, out: out + `\n[spawn] ${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

async function healthOk() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes('"ok"') || text.includes('"status"');
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

async function waitHealthy(totalMs = HEALTH_WAIT_MS) {
  const start = Date.now();
  let good = 0;
  while (Date.now() - start < totalMs) {
    if (await healthOk()) {
      good++;
      if (good >= 2) return true;
    } else {
      good = 0;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

/**
 * Verificação rígida do pedido ANTES de qualquer docker/backup/cópia:
 * 1. HMAC-SHA256 (timing-safe) — pedido forjado/adulterado = lixo;
 * 2. stagedDir confinado a <UPDATES_DIR>/pending-* (anti path-traversal);
 * 3. hash da árvore idêntico ao aprovado (anti troca pós-aprovação);
 * 4. symlinks = recusa (nunca seguimos link de upload).
 * Falhar aqui = pedido vai para failed/ SEM tocar em docker, arquivos ou banco.
 */
function canonicalQueue(payload) {
  const { hmac: _h, ...rest } = payload;
  return JSON.stringify(Object.fromEntries(Object.keys(rest).sort().map((k) => [k, rest[k]])));
}

function verifyHmac(req) {
  if (typeof req.hmac !== "string" || !/^[0-9a-f]{64}$/.test(req.hmac)) {
    throw new Error("Pedido sem HMAC válido — recuso aplicar.");
  }
  const want = createHmac("sha256", QUEUE_SECRET).update(canonicalQueue(req)).digest("hex");
  if (!timingSafeEqual(Buffer.from(req.hmac, "hex"), Buffer.from(want, "hex"))) {
    throw new Error("HMAC inválido — pedido forjado ou adulterado.");
  }
}

function hashTree(dir) {
  const entries = [];
  const walk = (d, base) => {
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n);
      const rel = base ? `${base}/${n}` : n;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Staging inválido: symlink detectado (${rel}).`);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) {
        entries.push(`${rel}\0${st.size}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

function assertStagedDir(p) {
  if (typeof p !== "string" || !p) throw new Error("Pedido sem stagedDir — recuso aplicar.");
  const r = resolve(p);
  const root = resolve(UPDATES_DIR);
  if (dirname(r) !== root || !/^pending-[\w][\w.\-]*$/.test(basename(r))) {
    throw new Error("stagedDir fora do diretório de updates — recuso aplicar.");
  }
  return r;
}

function assertTarget(t) {
  if (typeof t !== "string" || !/^[\w][\w.\-]*$/.test(t)) {
    throw new Error("Alvo de rollback inválido — recuso aplicar.");
  }
  const rel = resolve(join(UPDATES_DIR, "releases", t));
  if (rel !== resolve(join(UPDATES_DIR, "releases")) && !rel.startsWith(resolve(join(UPDATES_DIR, "releases")) + sep)) {
    throw new Error("Alvo de rollback fora das releases — recuso aplicar.");
  }
  return rel;
}

function assertTreeSha(dir, want) {
  const got = hashTree(dir);
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want) ||
      !timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(got, "hex"))) {
    throw new Error("Conteúdo do staging DIVERGE do aprovado (troca pós-aprovação?) — recuso aplicar.");
  }
}

/** Raiz real dos arquivos (staging pode ter pasta única no topo). */
function appRootOf(dir) {
  if (existsSync(join(dir, "package.json"))) return dir;
  for (const d of readdirSync(dir)) {
    if (!d.startsWith(".") && existsSync(join(dir, d, "package.json"))) return join(dir, d);
  }
  return dir;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

async function rsyncCopy(src, dest) {
  const args = ["-a", "--delete", ...RSYNC_EXCLUDES.flatMap((e) => ["--exclude", e]), src.replace(/\/?$/, "/"), dest.replace(/\/?$/, "/")];
  return run("rsync", args, { timeoutMs: 600_000 });
}

async function composeUp() {
  return run("docker", ["compose", "up", "-d", "--build"], { timeoutMs: 1_200_000 });
}

async function migrate() {
  return run("docker", ["compose", "exec", "-T", "api", "node", "apps/api/dist/migrate.js"], { timeoutMs: 600_000 });
}

async function fixVolumeOwners() {
  const r = await run("docker", ["run", "--rm", `-v`, `${PROJECT}_apidata:/d`, "-v", `${PROJECT}_agentwork:/w`,
    "alpine", "sh", "-c", "chown -R 1000:1000 /d /w"], { timeoutMs: 120_000 });
  if (r.code !== 0) log(`aviso: chown dos volumes falhou (best-effort): ${r.out.slice(-200)}`);
}

function currentVersion() {
  try {
    return readJson(join(APP_DIR, "apps/api/package.json")).version ?? "?";
  } catch {
    return "?";
  }
}

async function doBackup() {
  const r = await run("bash", ["scripts/backup.sh"], { timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new Error(`Backup FALHOU — aplicação abortada antes de tocar em arquivos:\n${r.out.slice(-1500)}`);
  log("backup OK.");
}

async function doApply(req, queueFile) {
  verifyHmac(req);
  const stagePath = assertStagedDir(req.stagedDir);
  assertTreeSha(stagePath, req.sha);
  const receiptPath = join(stagePath, ".cr-ia-receipt.json");
  const checksPath = join(stagePath, ".cr-ia-checks.json");
  if (!existsSync(receiptPath)) throw new Error("Staging sem recibo — recuso aplicar.");
  const checks = existsSync(checksPath) ? readJson(checksPath) : null;
  if (!checks?.passed) throw new Error("Staging sem verificações aprovadas — recuso aplicar.");
  const receipt = readJson(receiptPath);
  const src = appRootOf(stagePath);
  const from = currentVersion();
  log(`aplicando ${receipt.version} (instalada: ${from})...`);

  await doBackup();

  // Snapshot da versão atual (base do rollback).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snap = join(UPDATES_DIR, "releases", `${stamp}-v${from}`);
  mkdirSync(snap, { recursive: true });
  const snapR = await rsyncCopy(APP_DIR + "/", snap);
  // (rsync exclui releases/ do próprio APP_DIR; o snapshot vive no volume.)
  if (snapR.code !== 0) throw new Error(`Snapshot falhou: ${snapR.out.slice(-500)}`);
  writeFileSync(join(snap, ".cr-ia-release.json"), JSON.stringify({
    version: from, at: new Date().toISOString(), kind: "previous",
  }, null, 2));
  log(`snapshot: ${basename(snap)}`);
  // Marcador de crash: se o processo morrer no meio do apply, a próxima
  // execução restaura este snapshot ANTES de tentar de novo (idempotência).
  const marker = queueFile + ".applying";
  const markPayload = { snapshot: snap, version: receipt.version, at: new Date().toISOString() };
  writeFileSync(marker, JSON.stringify({ ...markPayload, hmac: createHmac("sha256", QUEUE_SECRET).update(canonicalQueue(markPayload)).digest("hex") }));

  const applySteps = async () => {
    const cp = await rsyncCopy(src + "/", APP_DIR + "/");
    if (cp.code !== 0) throw new Error(`Cópia dos arquivos falhou: ${cp.out.slice(-500)}`);
    await fixVolumeOwners();
    const up = await composeUp();
    if (up.code !== 0) throw new Error(`Rebuild falhou:\n${up.out.slice(-1500)}`);
    const mg = await migrate();
    if (mg.code !== 0) throw new Error(`MIGRAÇÃO falhou (rollback automático):\n${mg.out.slice(-1500)}`);
    const healthy = await waitHealthy();
    if (!healthy) throw new Error("Healthcheck NÃO respondeu após aplicar (rollback automático).");
  };

  const clearMarker = () => { try { rmSync(queueFile + ".applying", { force: true }); } catch { /* best-effort */ } };
  try {
    await applySteps();
    clearMarker();
  } catch (e) {
    log(`FALHA: ${e.message} — revertendo arquivos automaticamente...`);
    const rb = await rsyncCopy(snap + "/", APP_DIR + "/");
    const up2 = await composeUp();
    const healthy2 = await waitHealthy(Math.min(120_000, HEALTH_WAIT_MS));
    history({ action: "apply-auto-rollback", version: receipt.version, ok: rb.code === 0 && up2.code === 0 && healthy2 });
    if (rb.code !== 0 || up2.code !== 0 || !healthy2) {
      writeFileSync(join(UPDATES_DIR, "queue", "ALERT-apply-failed.txt"),
        `${new Date().toISOString()} apply ${receipt.version} FALHOU e o rollback automático também. INTERVENÇÃO MANUAL. Snapshot: ${snap}\n`);
      clearMarker(); // estado desconhecido: o ALERT acima guarda o snapshot p/ o humano
      throw new Error(`${e.message}\nROLLBACK AUTOMÁTICO TAMBÉM FALHOU — intervenção manual (snapshot em ${snap}).`);
    }
    clearMarker();
    throw new Error(`${e.message}\nArquivos revertidos automaticamente para ${from}.`);
  }

  writeFileSync(join(UPDATES_DIR, "releases", "current.json"), JSON.stringify({
    version: receipt.version, at: new Date().toISOString(), kind: "current",
    irreversibleDb: receipt.irreversibleDb === true,
  }, null, 2));
  history({ action: "applied", version: receipt.version, from, ok: true });
  log(`✅ ${receipt.version} aplicada.`);
}

async function doRollback(req, queueFile) {
  verifyHmac(req);
  const relDir = assertTarget(req.target);
  const metaPath = join(relDir, ".cr-ia-release.json");
  if (!existsSync(metaPath)) throw new Error(`Release ${req.target} não encontrado.`);
  const meta = readJson(metaPath);
  let dbWarning = false;
  try {
    dbWarning = readJson(join(UPDATES_DIR, "releases", "current.json")).irreversibleDb === true;
  } catch { /* sem marcador */ }
  log(`revertendo para ${req.target} (v${meta.version})...`);
  if (dbWarning) {
    log("⚠️ ATENÇÃO: a versão atual marcou migração de banco IRREVERSÍVEL — arquivos serão revertidos, o BANCO precisa de revisão manual.");
  }

  await doBackup();

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pre = join(UPDATES_DIR, "releases", `pre-rollback-${stamp}`);
  mkdirSync(pre, { recursive: true });
  const preR = await rsyncCopy(APP_DIR + "/", pre);
  if (preR.code !== 0) throw new Error(`Snapshot pré-rollback falhou: ${preR.out.slice(-500)}`);
  writeFileSync(join(pre, ".cr-ia-release.json"), JSON.stringify({
    version: currentVersion(), at: new Date().toISOString(), kind: "pre-rollback",
  }, null, 2));
  const rbMarker = queueFile + ".applying";
  const rbPayload = { snapshot: pre, version: meta.version, at: new Date().toISOString() };
  writeFileSync(rbMarker, JSON.stringify({ ...rbPayload, hmac: createHmac("sha256", QUEUE_SECRET).update(canonicalQueue(rbPayload)).digest("hex") }));
  const clearRbMarker = () => { try { rmSync(rbMarker, { force: true }); } catch { /* best-effort */ } };

  const cp = await rsyncCopy(relDir + "/", APP_DIR + "/");
  if (cp.code !== 0) throw new Error(`Restauração falhou: ${cp.out.slice(-500)}`);
  const up = await composeUp();
  if (up.code !== 0) throw new Error(`Rebuild pós-rollback falhou:\n${up.out.slice(-1000)}`);
  const mg = await migrate();
  if (mg.code !== 0) {
    // Schema pode ter divergido: restaura o pré-rollback para não deixar meio-termo.
    log("migração pós-rollback falhou — restaurando pré-rollback...");
    await rsyncCopy(pre + "/", APP_DIR + "/");
    await composeUp();
    clearRbMarker();
    throw new Error(`Migração pós-rollback falhou (pré-rollback restaurado):\n${mg.out.slice(-1000)}`);
  }
  const healthy = await waitHealthy();
  if (!healthy) {
    await rsyncCopy(pre + "/", APP_DIR + "/");
    await composeUp();
    clearRbMarker();
    throw new Error("Healthcheck falhou pós-rollback (pré-rollback restaurado).");
  }
  writeFileSync(join(UPDATES_DIR, "releases", "current.json"), JSON.stringify({
    version: meta.version, at: new Date().toISOString(), kind: "current",
    rolledBackFrom: currentVersion(), irreversibleDb: false,
  }, null, 2));
  clearRbMarker();
  history({ action: "rolled-back", target: req.target, version: meta.version, ok: true, dbWarning });
  log(`✅ reversão para ${req.target} concluída.${dbWarning ? " (revisar BANCO manualmente)" : ""}`);
}

/**
 * Recuperação de interrupção: se uma tentativa anterior morreu no meio do
 * apply/rollback (só resta o marcador, o pedido continua na fila), restaura o
 * snapshot da tentativa ANTES de recomeçar — retry sempre parte do estado
 * pré-tentativa. Marcador forjado/corrompido = pedido para failed/, sem docker.
 */
async function recoverInterrupted(queueFile) {
  const m = queueFile + ".applying";
  if (!existsSync(m)) return;
  let mark;
  try {
    mark = readJson(m);
  } catch {
    throw new Error("Marcador de interrupção corrompido — recuso continuar.");
  }
  verifyHmac(mark);
  const releasesRoot = resolve(join(UPDATES_DIR, "releases"));
  const snap = typeof mark.snapshot === "string" ? resolve(mark.snapshot) : "";
  if (!snap.startsWith(releasesRoot + sep) || !existsSync(join(snap, ".cr-ia-release.json"))) {
    throw new Error("Snapshot da recuperação inválido/ausente — recuso continuar.");
  }
  log(`recuperação: restaurando snapshot ${basename(snap)} de uma tentativa interrompida...`);
  const r = await rsyncCopy(snap + "/", APP_DIR + "/");
  if (r.code !== 0) throw new Error(`Recuperação falhou: ${r.out.slice(-500)}`);
  rmSync(m, { force: true });
  history({ action: "crash-recovered", snapshot: basename(snap), ok: true });
}

async function processOnce() {
  const queue = join(UPDATES_DIR, "queue");
  mkdirSync(queue, { recursive: true });
  mkdirSync(join(queue, "done"), { recursive: true });
  mkdirSync(join(queue, "failed"), { recursive: true });
  const files = readdirSync(queue).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const full = join(queue, f);
    let req;
    try {
      req = readJson(full);
    } catch {
      renameSync(full, join(queue, "failed", f));
      continue;
    }
    const release = acquireLock("updater-apply");
    if (!release) {
      log("outra aplicação em andamento — tento na próxima volta.");
      return;
    }
    try {
      await recoverInterrupted(full);
      if (req.kind === "approved") await doApply(req, full);
      else if (req.kind === "rollback") await doRollback(req, full);
      else throw new Error(`Pedido desconhecido: ${req.kind}`);
      renameSync(full, join(queue, "done", f));
    } catch (e) {
      log(`pedido ${f} FALHOU: ${e.message}`);
      history({ action: "queue-failed", file: f, ok: false, error: String(e.message).slice(0, 500) });
      try {
        writeFileSync(full + ".error.txt", `${new Date().toISOString()}\n${e.message}\n`);
      } catch { /* ignore */ }
      renameSync(full, join(queue, "failed", f));
    } finally {
      release();
    }
  }
}

function beat() {
  // Sinal de vida p/ o painel (API lê <UPDATES_DIR>/heartbeat.json).
  try {
    mkdirSync(UPDATES_DIR, { recursive: true });
    writeFileSync(join(UPDATES_DIR, "heartbeat.json"), JSON.stringify({ at: new Date().toISOString(), once: ONCE }));
  } catch (e) {
    log(`aviso: sem heartbeat (${e.message})`);
  }
}

async function main() {
  log(`iniciado (APP_DIR=${APP_DIR} HEALTH=${HEALTH_URL} ONCE=${ONCE})`);
  if (ONCE) {
    beat();
    await processOnce();
    return;
  }
  for (;;) {
    beat();
    try {
      await processOnce();
    } catch (e) {
      log(`erro no loop: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error(`[updater] falha fatal: ${e.message}`);
  process.exit(1);
});
