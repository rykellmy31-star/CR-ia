/**
 * Testes do updater-service (§4): fila approved/rollback com docker + rsync
 * simulados (shims no PATH) e health HTTP real. O que é NOSSO (fila, cópia,
 * snapshot, rollback automático, histórico) executa de verdade; docker/rsync
 * reais rodam só na VPS (documentado).
 * Rode: npm run test:scripts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = join(ROOT, "apps", "updater", "updater-service.mjs");

// Shim rsync em node: copia de verdade (excludes simples + --delete).
const RSYNC_SHIM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const excludes = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--exclude") { excludes.push(args[i + 1]); i++; }
}
const src = args[args.length - 2].replace(/\\/$/, "");
const dest = args[args.length - 1].replace(/\\/$/, "");
const skip = (rel) => excludes.some((e) => {
  const e2 = e.replace(/\\/$/, "");
  if (e2.includes("*")) {
    const rx = new RegExp("^" + e2.split("*").map((s) => s.replace(/[.+?^\${}()|[\\]\\\\]/g, "\\\\$&")).join(".*") + "$");
    return rx.test(rel) || rx.test(rel.split("/")[0]);
  }
  return rel === e2 || rel.startsWith(e2 + "/");
});
function copyDir(s, d, base) {
  fs.mkdirSync(d, { recursive: true });
  for (const e of fs.readdirSync(s)) {
    const rel = base ? base + "/" + e : e;
    if (skip(rel)) continue;
    const fs_ = join(s, e), fd = join(d, e);
    const st = fs.statSync(fs_);
    if (st.isDirectory()) copyDir(fs_, fd, rel);
    else { fs.mkdirSync(path.dirname(fd), { recursive: true }); fs.copyFileSync(fs_, fd); }
  }
}
function join(a, b) { return a + "/" + b; }
fs.mkdirSync(dest, { recursive: true });
copyDir(src, dest, "");
if (args.includes("--delete")) {
  const walk = (d, base) => {
    for (const e of fs.readdirSync(d)) {
      const rel = base ? base + "/" + e : e;
      const fd = join(d, e), fs_ = join(src, rel);
      if (skip(rel)) continue;
      if (!fs.existsSync(fs_)) { fs.rmSync(fd, { recursive: true, force: true }); continue; }
      if (fs.statSync(fd).isDirectory()) walk(fd, rel);
    }
  };
  walk(dest, "");
}
`;

// Shim docker em bash: registra chamadas; migrate falha sob demanda.
const DOCKER_SHIM = `#!/bin/bash
echo "docker $*" >> "$DOCKER_LOG"
if [[ "$*" == *"migrate.js"* ]]; then exit "\${MIGRATE_EXIT:-0}"; fi
exit 0
`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), "cr-ia-updsvc-"));
  const app = join(base, "app");
  const updates = join(base, "updates");
  const shim = join(base, "shim");
  mkdirSync(join(app, "apps", "api"), { recursive: true });
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(updates, "queue"), { recursive: true });
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(app, "apps", "api", "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(app, "docker-compose.yml"), "name: test\n");
  writeFileSync(join(app, "app.txt"), "v1-original\n");
  writeFileSync(join(app, "scripts", "backup.sh"), `#!/bin/bash\necho ok > "$BACKUP_MARKER"\n`);
  chmodSync(join(app, "scripts", "backup.sh"), 0o755);
  writeFileSync(join(shim, "rsync"), RSYNC_SHIM);
  chmodSync(join(shim, "rsync"), 0o755);
  writeFileSync(join(shim, "docker"), DOCKER_SHIM);
  chmodSync(join(shim, "docker"), 0o755);
  return { base, app, updates, shim };
}

function stageV2(updates, { receipt = true, checksPassed = true } = {}) {
  const stage = join(updates, "pending-2.0.0");
  mkdirSync(join(stage, "apps", "api"), { recursive: true });
  writeFileSync(join(stage, "apps", "api", "package.json"), JSON.stringify({ version: "2.0.0" }));
  writeFileSync(join(stage, "docker-compose.yml"), "name: test\n");
  writeFileSync(join(stage, "app.txt"), "v2-nova\n");
  if (receipt) {
    writeFileSync(join(stage, ".cr-ia-receipt.json"), JSON.stringify({
      version: "2.0.0", sha256: "x", keynum: "y", source: "upload", files: 3,
      migrations: [], irreversibleDb: false, stagedAt: new Date().toISOString(),
    }));
  }
  if (checksPassed !== null) {
    writeFileSync(join(stage, ".cr-ia-checks.json"), JSON.stringify({
      passed: checksPassed, checks: [], at: new Date().toISOString(),
    }));
  }
  return stage;
}

const TEST_SECRET = "segredo-fila-updater-teste-1";

// Espelho do contrato API→updater: sha da árvore + HMAC do pedido.
function treeSha(dir) {
  const entries = [];
  const walk = (d, base) => {
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n);
      const rel = base ? `${base}/${n}` : n;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`symlink: ${rel}`);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) entries.push(`${rel}\0${st.size}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}
function signPayload(payload, secret = TEST_SECRET) {
  const canon = JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((k) => [k, payload[k]])));
  return createHmac("sha256", secret).update(canon).digest("hex");
}
function queueApproved(t, stage, version = "2.0.0") {
  const payload = { kind: "approved", version, stagedDir: stage, sha: treeSha(stage), by: "admin", at: new Date().toISOString() };
  const name = `approved-${version}-${Date.now()}.json`;
  writeFileSync(join(t.updates, "queue", name), JSON.stringify({ ...payload, hmac: signPayload(payload) }));
  return name;
}
function queueRollback(t, target) {
  const payload = { kind: "rollback", target, by: "admin", at: new Date().toISOString() };
  const name = `rollback-${Date.now()}.json`;
  writeFileSync(join(t.updates, "queue", name), JSON.stringify({ ...payload, hmac: signPayload(payload) }));
  return name;
}
function queuedState(t) {
  const q = join(t.updates, "queue");
  return {
    pending: readdirSync(q).filter((f) => f.endsWith(".json")),
    done: existsSync(join(q, "done")) ? readdirSync(join(q, "done")) : [],
    failed: existsSync(join(q, "failed")) ? readdirSync(join(q, "failed")) : [],
  };
}

async function withHealth(ok, fn) {
  const server = createServer((_req, res) => {
    res.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
    res.end(ok ? '{"ok":true,"status":"ok"}' : '{"ok":false}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  try {
    await fn(url);
  } finally {
    server.close();
  }
}

function runOnce(t, healthUrl, extra = {}) {
  // spawn ASSÍNCRONO: o servidor de health do teste precisa do event loop.
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVICE], {
      env: {
      ...process.env,
      APP_DIR: t.app,
      UPDATES_DIR: t.updates,
      HEALTH_URL: healthUrl,
      UPDATER_PROJECT: "testproj",
      UPDATER_ONCE: "1",
      UPDATER_HEALTH_WAIT_MS: "12000",
      UPDATER_QUEUE_SECRET: TEST_SECRET,
      PATH: `${t.shim}:${process.env.PATH}`,
      DOCKER_LOG: join(t.base, "docker.log"),
      BACKUP_MARKER: join(t.base, "backup.marker"),
      ...extra,
      },
    });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function history(t) {
  const p = join(t.updates, "history.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("updater-service", () => {
  it("approved: backup → snapshot → aplica → health → histórico", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v2-nova\n");
    assert.ok(existsSync(join(t.base, "backup.marker")), "backup.sh executado");
    const releases = readdirSync(join(t.updates, "releases"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name);
    assert.equal(releases.length, 1);
    const snap = join(t.updates, "releases", releases[0]);
    assert.equal(readFileSync(join(snap, "app.txt"), "utf8"), "v1-original\n");
    assert.equal(JSON.parse(readFileSync(join(snap, ".cr-ia-release.json"), "utf8")).version, "1.0.0");
    assert.equal(JSON.parse(readFileSync(join(t.updates, "releases", "current.json"), "utf8")).version, "2.0.0");
    assert.ok(readdirSync(join(t.updates, "queue", "done")).length === 1);
    assert.match(history(t), /"action":"applied"/);
    const dlog = readFileSync(join(t.base, "docker.log"), "utf8");
    assert.match(dlog, /compose up -d --build/);
    assert.match(dlog, /migrate\.js/);
  });

  it("migrate falha → rollback automático restaura arquivos", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url, { MIGRATE_EXIT: "1" });
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v1-original\n", "arquivos revertidos");
    assert.ok(readdirSync(join(t.updates, "queue", "failed")).length === 1);
    assert.match(history(t), /apply-auto-rollback/);
  });

  it("rollback: restaura release + avisa banco irreversível", async () => {
    const t = setup();
    const rel = join(t.updates, "releases", "rel-old");
    mkdirSync(join(rel, "apps", "api"), { recursive: true });
    writeFileSync(join(rel, "apps", "api", "package.json"), JSON.stringify({ version: "0.9.0" }));
    writeFileSync(join(rel, "app.txt"), "v0-antiga\n");
    writeFileSync(join(rel, ".cr-ia-release.json"), JSON.stringify({ version: "0.9.0", at: "x", kind: "previous" }));
    writeFileSync(join(t.updates, "releases", "current.json"), JSON.stringify({ version: "1.0.0", irreversibleDb: true }));
    queueRollback(t, "rel-old");
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v0-antiga\n");
    assert.match(history(t), /"action":"rolled-back"/);
    assert.match(history(t), /"dbWarning":true/);
    assert.ok(readdirSync(join(t.updates, "queue", "done")).length === 1);
  });

  it("staging sem recibo: recusa sem tocar em nada", async () => {
    const t = setup();
    const stage = stageV2(t.updates, { receipt: false });
    queueApproved(t, stage);
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v1-original\n");
    assert.ok(!existsSync(join(t.base, "backup.marker")), "sem backup: nada foi feito");
    assert.ok(readdirSync(join(t.updates, "queue", "failed")).length === 1);
  });

  it("staging adulterado pós-aprovação: recusa SEM chamar docker", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    writeFileSync(join(stage, "app.txt"), "v2-ADULTERADA\n"); // troca após assinar
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    const st = queuedState(t);
    assert.equal(st.failed.length, 1);
    assert.equal(st.done.length, 0);
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v1-original\n");
    assert.ok(!existsSync(join(t.base, "docker.log")), "docker NUNCA foi chamado");
    assert.ok(!existsSync(join(t.base, "backup.marker")), "nem backup rodou");
    assert.match(history(t), /DIVERGE/);
  });

  it("pedido forjado (sem HMAC / HMAC de outro segredo): recusa sem tocar em nada", async () => {
    for (const forge of ["none", "wrong-secret"]) {
      const t = setup();
      const stage = stageV2(t.updates);
      const payload = { kind: "approved", version: "2.0.0", stagedDir: stage, sha: treeSha(stage), by: "admin", at: "x" };
      const body = forge === "none" ? payload : { ...payload, hmac: signPayload(payload, "segredo-errado-123456") };
      writeFileSync(join(t.updates, "queue", "approved-2.0.0-1.json"), JSON.stringify(body));
      await withHealth(true, async (url) => {
        const r = await runOnce(t, url);
        assert.equal(r.status, 0, r.stderr + r.stdout);
      });
      assert.equal(queuedState(t).failed.length, 1, forge);
      assert.ok(!existsSync(join(t.base, "docker.log")), `docker chamado em ${forge}`);
      assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v1-original\n");
    }
  });

  it("path traversal (stagedDir/target fora): recusa sem executar nada", async () => {
    const evil = join(tmpdir(), "cr-ia-evil-fora");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "x.txt"), "mal");
    for (const badDir of [evil, join("..", "evil")]) {
      const t = setup();
      stageV2(t.updates);
      const payload = { kind: "approved", version: "2.0.0", stagedDir: badDir, sha: "0".repeat(64), by: "a", at: "x" };
      writeFileSync(join(t.updates, "queue", "approved-2.0.0-1.json"), JSON.stringify({ ...payload, hmac: signPayload(payload) }));
      await withHealth(true, async (url) => { await runOnce(t, url); });
      assert.equal(queuedState(t).failed.length, 1, badDir);
      assert.ok(!existsSync(join(t.base, "docker.log")));
    }
    for (const badTarget of ["..", "../x", "a/b", ""]) {
      const t = setup();
      const payload = { kind: "rollback", target: badTarget, by: "a", at: "x" };
      writeFileSync(join(t.updates, "queue", "rollback-1.json"), JSON.stringify({ ...payload, hmac: signPayload(payload) }));
      await withHealth(true, async (url) => { await runOnce(t, url); });
      assert.equal(queuedState(t).failed.length, 1, JSON.stringify(badTarget));
      assert.ok(!existsSync(join(t.base, "docker.log")));
    }
  });

  it("symlink plantado no staging: recusa", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    symlinkSync(join(stage, "app.txt"), join(stage, "atalho.txt")); // plantado pós-aprovação
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(queuedState(t).failed.length, 1);
    assert.ok(!existsSync(join(t.base, "docker.log")));
    assert.match(history(t), /symlink/);
  });

  it("sem UPDATER_QUEUE_SECRET: serviço nem sobe (fail-closed no boot)", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url, { UPDATER_QUEUE_SECRET: "" });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /UPDATER_QUEUE_SECRET/);
    });
    const st = queuedState(t);
    assert.equal(st.pending.length, 1, "pedido intacto na fila");
    assert.equal(st.done.length + st.failed.length, 0);
  });

  it("trava ocupada: segunda instância pula sem consumir a fila", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    const holder = spawn("node", ["--input-type=module", "-e",
      `import { acquireLock } from ${JSON.stringify(join(ROOT, "scripts", "r2-lib.mjs"))};` +
      ` const r = acquireLock("updater-apply"); if (!r) process.exit(2); setTimeout(() => {}, 15000);`],
      { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 800));
    try {
      await withHealth(true, async (url) => {
        const r = await runOnce(t, url);
        assert.equal(r.status, 0, r.stderr + r.stdout);
        assert.match(r.stdout, /outra aplicação em andamento/);
      });
      const st = queuedState(t);
      assert.equal(st.pending.length, 1, "fila intacta");
      assert.equal(st.done.length + st.failed.length, 0);
    } finally {
      holder.kill("SIGKILL");
      await new Promise((r) => holder.on("close", r));
    }
  });

  it("morte no meio do apply (SIGKILL): fila intacta e re-execução conclui", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    queueApproved(t, stage);
    // docker que dorme no `compose up` para dar tempo do SIGKILL.
    const fastDocker = readFileSync(join(t.shim, "docker"), "utf8");
    writeFileSync(join(t.shim, "docker"),
      `#!/bin/bash\necho "docker $*" >> "$DOCKER_LOG"\n` +
      `if [[ "$*" == *"compose up"* ]]; then sleep 10; fi\n` +
      `if [[ "$*" == *"migrate.js"* ]]; then exit "\${MIGRATE_EXIT:-0}"; fi\nexit 0\n`);
    const child = spawn("node", [SERVICE], {
      env: {
        ...process.env, APP_DIR: t.app, UPDATES_DIR: t.updates,
        HEALTH_URL: "http://127.0.0.1:9/none", UPDATER_PROJECT: "testproj",
        UPDATER_ONCE: "1", UPDATER_HEALTH_WAIT_MS: "12000",
        UPDATER_QUEUE_SECRET: TEST_SECRET,
        PATH: `${t.shim}:${process.env.PATH}`,
        DOCKER_LOG: join(t.base, "docker.log"), BACKUP_MARKER: join(t.base, "backup.marker"),
      },
    });
    const t0 = Date.now();
    for (;;) {
      const log = existsSync(join(t.base, "docker.log")) ? readFileSync(join(t.base, "docker.log"), "utf8") : "";
      if (log.includes("compose up")) break;
      if (Date.now() - t0 > 20000) { child.kill("SIGKILL"); throw new Error("updater não chegou ao compose up"); }
      await new Promise((r) => setTimeout(r, 200));
    }
    child.kill("SIGKILL");
    await new Promise((r) => child.on("close", r));
    const mid = queuedState(t);
    assert.equal(mid.pending.length, 1, "pedido continua na fila após a morte");
    assert.equal(mid.done.length + mid.failed.length, 0);
    // Re-execução com docker rápido conclui (trava do morto é re-colhida).
    writeFileSync(join(t.shim, "docker"), fastDocker);
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v2-nova\n");
    assert.equal(queuedState(t).done.length, 1);
    assert.match(history(t), /"action":"crash-recovered"/, "recuperação registrada");
    assert.ok(existsSync(join(t.base, "backup.marker")), "backup rodou na re-execução");
  });

  it("marcador de interrupção forjado: recusa sem executar nada", async () => {
    const t = setup();
    const stage = stageV2(t.updates);
    const name = queueApproved(t, stage);
    writeFileSync(join(t.updates, "queue", name + ".applying"), JSON.stringify({ snapshot: "/tmp/evil", hmac: "0".repeat(64) }));
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    assert.equal(queuedState(t).failed.length, 1);
    assert.ok(!existsSync(join(t.base, "docker.log")));
    assert.equal(readFileSync(join(t.app, "app.txt"), "utf8"), "v1-original\n");
  });

  it("heartbeat: serviço vivo escreve sinal fresco p/ o painel", async () => {
    const t = setup();
    await withHealth(true, async (url) => {
      const r = await runOnce(t, url);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    });
    const hb = join(t.updates, "heartbeat.json");
    assert.ok(existsSync(hb), "heartbeat.json escrito");
    const beat = JSON.parse(readFileSync(hb, "utf8"));
    assert.ok(beat.at, "tem timestamp");
    assert.ok(Date.now() - new Date(beat.at).getTime() < 60_000, "sinal fresco (<60s)");
  });
});
