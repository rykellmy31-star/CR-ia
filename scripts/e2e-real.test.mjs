/**
 * E2E REAL (itens 4–5): Postgres de verdade + API compilada de verdade.
 * migrate → seed → boot → health → login → chat (HTTP real) → kill -9 →
 * reboot → persistência → pg_dump → restore isolado → contagens+md5 iguais.
 * Sem mocks e sem stubs: falha se qualquer elo quebrar.
 *
 * Requisitos (tudo ausente = SKIP honesto com o motivo):
 *   PG_E2E_URL   base admin no formato postgres://user:pass@host:5432/db
 *   psql/pg_dump/gzip no PATH
 *   apps/api/dist compilado (migrate.js, seed.js, server-node.js)
 *
 * Rode: PG_E2E_URL='postgres://...' npm run test:scripts
 * (docker/compose reais continuam exclusivos da VPS — documentado.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = join(ROOT, "apps", "api");
const BASE_URL = process.env.PG_E2E_URL || "";

function have(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}
function skipWhy() {
  if (!BASE_URL) return "PG_E2E_URL não definido";
  for (const c of ["psql", "pg_dump", "gzip"]) if (!have(c)) return `binário ausente: ${c}`;
  for (const f of ["dist/migrate.js", "dist/seed.js", "dist/server-node.js"]) {
    if (!existsSync(join(API, f))) return `API não compilada (falta ${f})`;
  }
  const r = spawnSync("psql", [BASE_URL, "-tAc", "SELECT 1"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.includes("1")) return `Postgres inacessível via PG_E2E_URL (${r.stderr.slice(0, 120)})`;
  return null;
}
const why = skipWhy();
if (why) {
  console.log(`SKIP e2e-real: ${why}.`);
  process.exit(0);
}

const dbUrl = (db) => BASE_URL.replace(/\/[^/]*$/, `/${db}`);
function psql(db, sql) {
  const r = spawnSync("psql", [dbUrl(db), "-tAc", sql], { encoding: "utf8" });
  assert.equal(r.status, 0, `psql falhou: ${r.stderr}`);
  return r.stdout;
}
function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}
async function waitHealth(port, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      const j = await r.json();
      if (j?.data?.status === "ok") return;
    } catch { /* ainda subindo */ }
    if (Date.now() - t0 > ms) throw new Error("API não respondeu /api/health a tempo");
    await new Promise((r) => setTimeout(r, 500));
  }
}
function baseEnv(db, port) {
  return {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    DB_DRIVER: "postgres",
    DATABASE_URL: dbUrl(db),
    JWT_SECRET: "jwt-e2e-real-com-mais-de-32-chars-ok",
    CREDENTIALS_SECRET: "cofre-e2e-real-com-32-chars-ok-12",
    ADMIN_PASSWORD: "Admin-E2E-real-forte-1",
    GUEST_PASSWORD: "Guest-E2E-real-forte-2",
    CHAT_PROVIDER: "mock",
    IMAGE_PROVIDER: "mock-svg",
    BLOCK_PAID_PROVIDERS: "true",
  };
}

describe("e2e real (postgres + api compilada + backup/restore)", () => {
  it("migrate→seed→login→chat→restart→persistência→dump→restore idêntico", async () => {
    const tag = `${Date.now().toString(36)}${process.pid.toString(36)}`;
    const dbA = `cr_e2e_a_${tag}`.replace(/[^a-z0-9_]/g, "_");
    const dbB = `cr_e2e_b_${tag}`.replace(/[^a-z0-9_]/g, "_");
    const port = await freePort();
    const work = mkdtempSync(join(tmpdir(), "cr-ia-e2ereal-"));
    let api = null;
    const killApi = async () => {
      if (!api) return;
      api.kill("SIGKILL");
      await new Promise((r) => api.on("close", r));
      api = null;
    };
    try {
      // 1. banco + migrate + seed (produção, senhas fortes).
      let mk = spawnSync("psql", [BASE_URL, "-tAc", `DROP DATABASE IF EXISTS ${dbA};`, "-tAc", `CREATE DATABASE ${dbA};`], { encoding: "utf8" });
      assert.equal(mk.status, 0, `criar banco e2e falhou: ${mk.stderr}`);
      const urlA = dbUrl(dbA);
      let r = spawnSync("node", ["dist/migrate.js"], { cwd: API, encoding: "utf8", env: { ...process.env, DATABASE_URL: urlA } });
      assert.equal(r.status, 0, `migrate falhou: ${r.stderr}`);
      assert.match(r.stdout, /0003.*aplicado/, "migração 0003 não aplicada");
      r = spawnSync("node", ["dist/seed.js"], { cwd: API, encoding: "utf8", env: baseEnv(dbA, port) });
      assert.equal(r.status, 0, `seed falhou: ${r.stderr}`);
      assert.match(r.stdout, /admin@cr-ia\.local/);

      // 2. boot + health + login + chat (HTTP real).
      api = spawn("node", ["dist/server-node.js"], { cwd: API, env: baseEnv(dbA, port), stdio: "ignore" });
      await waitHealth(port);
      const login = await (await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@cr-ia.local", password: "Admin-E2E-real-forte-1" }),
      })).json();
      assert.equal(login.ok, true, `login falhou: ${JSON.stringify(login).slice(0, 200)}`);
      const token = login.data.token;
      assert.ok(token.length > 100, "token JWT ausente");
      const chat = await (await fetch(`http://127.0.0.1:${port}/api/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ messages: [{ role: "user", content: "Ping e2e automatizado" }] }),
      })).json();
      assert.equal(chat.ok, true, `chat falhou: ${JSON.stringify(chat).slice(0, 300)}`);
      assert.ok(chat.data.conversationId, "sem conversationId");
      assert.ok(chat.data.message.content.length > 0, "resposta vazia");
      const convId = chat.data.conversationId;

      // 3. kill -9 + reboot + persistência (mesmo token, mesmos dados).
      await killApi();
      api = spawn("node", ["dist/server-node.js"], { cwd: API, env: baseEnv(dbA, port), stdio: "ignore" });
      await waitHealth(port);
      const convs = await (await fetch(`http://127.0.0.1:${port}/api/chat/conversations`, {
        headers: { authorization: `Bearer ${token}` },
      })).json();
      assert.equal(convs.ok, true);
      assert.ok(convs.data.conversations.some((c) => c.id === convId), "conversa sumiu após restart");
      const full = await (await fetch(`http://127.0.0.1:${port}/api/chat/conversations/${convId}`, {
        headers: { authorization: `Bearer ${token}` },
      })).json();
      assert.equal(full.data.messages.length, 2, "mensagens não persistiram");
      await killApi();

      // 4. pg_dump consistente → restore isolado → idêntico (contagens + md5).
      const dump = join(work, "db-e2e.sql.gz");
      r = spawnSync("bash", ["-c", `pg_dump '${urlA}' --clean --if-exists | gzip > '${dump}'`], { encoding: "utf8" });
      assert.equal(r.status, 0, `pg_dump falhou: ${r.stderr}`);
      r = spawnSync("gzip", ["-t", dump]);
      assert.equal(r.status, 0, "dump corrompido (gzip -t)");
      const sha = createHash("sha256").update(readFileSync(dump)).digest("hex");
      assert.match(sha, /^[0-9a-f]{64}$/);
      spawnSync("psql", [BASE_URL, "-tAc", `DROP DATABASE IF EXISTS ${dbB};`, "-tAc", `CREATE DATABASE ${dbB};`], { encoding: "utf8" });
      r = spawnSync("bash", ["-c", `gunzip -c '${dump}' | psql '${dbUrl(dbB)}' -q -v ON_ERROR_STOP=1`], { encoding: "utf8" });
      assert.equal(r.status, 0, `restore falhou: ${r.stderr.slice(-500)}`);
      const snap = (db) => psql(db,
        `SELECT count(*) FROM users; SELECT count(*) FROM conversations; SELECT count(*) FROM messages; ` +
        `SELECT md5(string_agg(content, '|' ORDER BY created_at)) FROM messages;`).trim();
      assert.equal(snap(dbB), snap(dbA), "restaurado diverge do original");
      console.log(`e2e-real OK (db ${dbA} → ${dbB}, dump sha256 ${sha.slice(0, 12)}…, conversa ${convId.slice(0, 12)}…)`);
    } finally {
      await killApi().catch(() => undefined);
      spawnSync("psql", [BASE_URL, "-tAc", `DROP DATABASE IF EXISTS ${dbA};`, "-tAc", `DROP DATABASE IF EXISTS ${dbB};`]);
    }
  });
});
