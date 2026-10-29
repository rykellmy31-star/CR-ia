/**
 * Fluxo COMPLETO de atualização: upload assinado → checks → aprovação HMAC →
 * aplicação (updater real spawnado) → rollback. Prova também a preservação:
 * .env, data/, backups/, node_modules passam INTACTOS pelo apply E rollback.
 *
 * O que é NOSSO executa de verdade (rotas, HMAC, fila, cópia rsync,
 * snapshots, histórico); docker é shim (sem Docker no sandbox) e o health
 * é HTTP real. Nenhum byte do ZIP é executado.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import { canonicalQueue, signQueue } from "../src/services/update-upload.js";
import type { Env } from "../src/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SERVICE = join(ROOT, "apps", "updater", "updater-service.mjs");
const SECRET = "segredo-fila-testes-32-chars-ok!";
const VERSION = "9.9.9";

// Shim rsync em python: copia de verdade com --exclude + --delete.
const RSYNC_SHIM = `#!/usr/bin/env python3
import fnmatch, os, shutil, sys
args = sys.argv[1:]
excludes = []
i = 0
while i < len(args):
    if args[i] == "--exclude":
        excludes.append(args[i + 1].rstrip("/")); i += 2
    else:
        i += 1
src = args[-2].rstrip("/") or "/"
dest = args[-1].rstrip("/") or "/"
do_delete = "--delete" in args
def skip(rel):
    for e in excludes:
        if "*" in e:
            if fnmatch.fnmatch(rel, e) or fnmatch.fnmatch(rel.split("/")[0], e):
                return True
        elif rel == e or rel.startswith(e + "/"):
            return True
    return False
copied = []
for base, dirs, files in os.walk(src):
    rel = os.path.relpath(base, src)
    if rel == ".":
        rel = ""
    dirs[:] = [d for d in dirs if not skip((rel + "/" + d).strip("/"))]
    for f in files:
        r = (rel + "/" + f).strip("/")
        if skip(r):
            continue
        d = os.path.join(dest, r)
        os.makedirs(os.path.dirname(d) or dest, exist_ok=True)
        shutil.copy2(os.path.join(base, f), d)
        copied.append(r)
if do_delete:
    keep = set(copied)
    for base, dirs, files in os.walk(dest, topdown=False):
        rel = os.path.relpath(base, dest)
        if rel == ".":
            rel = ""
        for f in files:
            r = (rel + "/" + f).strip("/")
            if r not in keep and not skip(r):
                os.remove(os.path.join(base, f))
print(f"RSYNC-SHIM: {len(copied)} arquivos")
`;

const DOCKER_SHIM = `#!/bin/sh
echo "docker $*" >> "$DOCKER_LOG"
exit 0
`;

const PY_MKZIP = `
import sys, zipfile
out, version = sys.argv[1], sys.argv[2]
files = {
  "package.json": '{"name":"cr-ia-test","version":"%s"}' % version,
  "docker-compose.yml": "name: test\\n",
  "apps/api/package.json": '{"version":"%s"}' % version,
  "apps/api/migrations/0099_test_flow.sql": "-- migracao de teste (nao vazia)\\n",
  "app.txt": "v2-nova\\n",
  "scripts/backup.sh": '#!/bin/bash\\necho ok > "$BACKUP_MARKER"\\n',
  "update-manifest.json": '{"notes":"fluxo e2e"}',
}
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name, content in files.items():
        z.writestr(name, content)
print("ZIP-OK")
`;

const base = mkdtempSync(join(tmpdir(), "cr-ia-updflow-"));
const APP = join(base, "app");
const UPDATES = join(base, "updates");
const SHIM = join(base, "shim");
const DOCKER_LOG = join(base, "docker.log");
const BACKUP_MARKER = join(base, "backup.marker");

const PRESERVED: Array<[string, string]> = [
  [".env", "SECRET_V1=nao-mexer\nUPDATER_QUEUE_SECRET=x\n"],
  ["data/keep.txt", "dados-do-usuario\n"],
  ["backups/keep.txt", "backup-antigo\n"],
  ["node_modules/keep.txt", "deps\n"],
];

let app: ReturnType<typeof createApp>["app"];
let db: ReturnType<typeof createApp>["db"];
let token = "";
let healthUrl = "";
let healthServer: ReturnType<typeof createServer> | null = null;
let pubSingleLine = "";
let privKey: ReturnType<typeof generateKeyPairSync>["privateKey"] | null = null;
let keynum: Buffer = Buffer.alloc(0);

async function api(path: string, init?: RequestInit) {
  const res = await app.request(path, {
    ...init,
    headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}
const postJson = (path: string, obj: unknown) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

function runUpdaterOnce(): Promise<{ status: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [SERVICE], {
      env: {
        ...process.env, APP_DIR: APP, UPDATES_DIR: UPDATES, HEALTH_URL: healthUrl,
        UPDATER_PROJECT: "testproj", UPDATER_ONCE: "1", UPDATER_HEALTH_WAIT_MS: "15000",
        UPDATER_QUEUE_SECRET: SECRET, PATH: `${SHIM}:${process.env.PATH}`,
        DOCKER_LOG, BACKUP_MARKER,
      },
    });
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { out += d.toString(); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? 1, out }));
  });
}

function expectPreserved(): void {
  for (const [rel, content] of PRESERVED) {
    expect(readFileSync(join(APP, rel), "utf8"), `preservado: ${rel}`).toBe(content);
  }
}

beforeAll(async () => {
  // App v1 (instalada) com arquivos que DEVEM sobreviver.
  mkdirSync(join(APP, "apps", "api"), { recursive: true });
  mkdirSync(join(APP, "scripts"), { recursive: true });
  writeFileSync(join(APP, "apps", "api", "package.json"), JSON.stringify({ version: "0.3.0" }));
  writeFileSync(join(APP, "docker-compose.yml"), "name: test\n");
  writeFileSync(join(APP, "app.txt"), "v1-original\n");
  writeFileSync(join(APP, "scripts", "backup.sh"), `#!/bin/bash\necho ok > "$BACKUP_MARKER"\n`);
  chmodSync(join(APP, "scripts", "backup.sh"), 0o755);
  for (const [rel, content] of PRESERVED) {
    mkdirSync(dirname(join(APP, rel)), { recursive: true });
    writeFileSync(join(APP, rel), content);
  }
  mkdirSync(join(UPDATES, "queue"), { recursive: true });
  mkdirSync(SHIM, { recursive: true });
  writeFileSync(join(SHIM, "rsync"), RSYNC_SHIM);
  chmodSync(join(SHIM, "rsync"), 0o755);
  writeFileSync(join(SHIM, "docker"), DOCKER_SHIM);
  chmodSync(join(SHIM, "docker"), 0o755);

  healthServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "ok" }));
  });
  await new Promise<void>((resolve) => {
    healthServer!.listen(0, "127.0.0.1", () => {
      const a = healthServer!.address();
      healthUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/api/health`;
      resolve();
    });
  });

  // Par minisign de TESTE (formato padrão, igual ao sign-release.mjs).
  keynum = randomBytes(8);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  privKey = privateKey;
  const pubRaw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12);
  pubSingleLine = Buffer.concat([Buffer.from("Ed"), keynum, pubRaw]).toString("base64");

  const env: Env = {
    JWT_SECRET: "segredo-testes-updflow-com-32-chars-ok",
    CREDENTIALS_SECRET: "cofre-testes-updflow-com-32-chars!",
    NODE_ENV: "test",
    DB_DRIVER: "json",
    JSON_DB_PATH: join(base, "db.json"),
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_DIR: join(base, "uploads"),
    UPDATES_DIR: UPDATES,
    UPDATER_QUEUE_SECRET: SECRET,
    UPDATE_SIGNING_PUBLIC_KEY: pubSingleLine,
  };
  ({ app, db } = createApp(env));
  await db.init();
  await db.createUser({ email: "a@teste.com", name: "A", role: "admin", passwordHash: await hashPassword("Senha123!", 4) });
  const login = await app.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@teste.com", password: "Senha123!" }),
  });
  token = ((await login.json()) as { data: { token: string } }).data.token;
}, 60_000);

afterAll(async () => {
  healthServer?.close();
  await db?.close().catch(() => undefined);
});

describe("fluxo completo: upload → aprovação → aplicação → rollback", () => {
  it("upload assinado prepara staging + checks passam", async () => {
    const zipPath = join(base, "rel-999.zip");
    execFileSync("python3", ["-c", PY_MKZIP, zipPath, VERSION]);
    const bytes = readFileSync(zipPath);
    const sig = sign(null, createHash("blake2b512").update(bytes).digest(), privKey!);
    const sigB64 = Buffer.concat([Buffer.from("ED"), keynum, sig]).toString("base64");
    const trusted = "fixture CR IA";
    const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privKey!);
    const form = new FormData();
    form.set("zip", new File([new Uint8Array(bytes)], "rel-999.zip", { type: "application/zip" }));
    form.set("signature", `untrusted comment: teste fluxo\n${sigB64}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`);
    const r = await api("/api/admin/updates/upload", { method: "POST", body: form });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = r.body.data as { version: string; checks: { passed: boolean } };
    expect(d.version).toBe(VERSION);
    expect(d.checks.passed).toBe(true);
    expect(existsSync(join(UPDATES, `pending-${VERSION}`, ".cr-ia-receipt.json"))).toBe(true);
  });

  it("aprovação enfileira pedido com HMAC válido", async () => {
    const r = await postJson("/api/admin/updates/approve", { version: VERSION });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const queued = (r.body.data as { queued: string }).queued;
    expect(queued.startsWith("approved-")).toBe(true);
    const raw = JSON.parse(readFileSync(join(UPDATES, "queue", queued), "utf8")) as Record<string, unknown>;
    const { hmac, ...payload } = raw as { hmac: string } & Record<string, unknown>;
    expect(raw.kind).toBe("approved");
    expect(hmac).toBe(signQueue(SECRET, payload)); // HMAC confere (recomputado aqui)
    expect(canonicalQueue(payload)).toContain(`"version":"${VERSION}"`);
  });

  it("updater aplica: v2 no ar + .env/dados intactos + snapshot v1", async () => {
    const r = await runUpdaterOnce();
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(APP, "app.txt"), "utf8")).toBe("v2-nova\n");
    expect(readFileSync(join(APP, "apps", "api", "package.json"), "utf8")).toContain(VERSION);
    expectPreserved(); // .env, data/, backups/, node_modules byte-idênticos
    expect(existsSync(BACKUP_MARKER)).toBe(true); // backup.sh rodou ANTES
    const releases = readdirSync(join(UPDATES, "releases")).filter((n) => n.endsWith("-v0.3.0"));
    expect(releases).toHaveLength(1);
    expect(readFileSync(join(UPDATES, "releases", releases[0], "app.txt"), "utf8")).toBe("v1-original\n");
    expect(JSON.parse(readFileSync(join(UPDATES, "releases", "current.json"), "utf8")).version).toBe(VERSION);
    expect(readdirSync(join(UPDATES, "queue", "done"))).toHaveLength(1);
    expect(readFileSync(join(UPDATES, "history.jsonl"), "utf8")).toMatch(/"action":"applied"/);
    const dlog = readFileSync(DOCKER_LOG, "utf8");
    expect(dlog).toMatch(/compose up -d --build/);
    expect(dlog).toMatch(/migrate\.js/);
  }, 120_000);

  it("rollback: volta v1 + preservados intactos + pré-rollback guardado", async () => {
    const rel = await api("/api/admin/updates/releases");
    expect(rel.status).toBe(200);
    const items = (rel.body.data as { releases: { name: string; kind: string }[] }).releases;
    const prev = items.find((x) => x.kind === "previous");
    expect(prev, JSON.stringify(items)).toBeTruthy();
    const rb = await postJson("/api/admin/updates/rollback", { target: prev!.name });
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    const r = await runUpdaterOnce();
    expect(r.status, r.out).toBe(0);
    expect(readFileSync(join(APP, "app.txt"), "utf8")).toBe("v1-original\n");
    expectPreserved();
    expect(JSON.parse(readFileSync(join(UPDATES, "releases", "current.json"), "utf8")).version).toBe("0.3.0");
    const names = readdirSync(join(UPDATES, "releases"));
    expect(names.some((n) => n.startsWith("pre-rollback-"))).toBe(true);
    expect(readFileSync(join(UPDATES, "history.jsonl"), "utf8")).toMatch(/rollback/);
  }, 120_000);
});
