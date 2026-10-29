/**
 * Central de Atualizações — UPLOAD de ZIP (§4): validação, assinatura,
 * staging, aprovação e rollback. App Hono real + ZIPs reais + ed25519 real.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/index.js";
import { hashPassword } from "../src/lib/crypto.js";
import {
  approveStaged, hashStagedTree, queueSecret, requestRollback, signQueue, validateUploadZip,
} from "../src/services/update-upload.js";
import { createMinisignKey, minisignFor, makeZip, makeZipRaw } from "./helpers/zip-fixture.js";
import type { Env } from "../src/types.js";

const dir = mkdtempSync(join(tmpdir(), "cr-ia-updupload-"));
// Chave "oficial" deste teste: o .env confia nela; ZIPs válidos a usam.
const TESTKEY = createMinisignKey();

const env: Env = {
  JWT_SECRET: "segredo-de-testes-com-mais-de-32-chars",
  DB_DRIVER: "json",
  JSON_DB_PATH: join(dir, "db.json"),
  STORAGE_DRIVER: "local",
  LOCAL_STORAGE_DIR: join(dir, "uploads"),
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
  UPDATES_DIR: join(dir, "updates"),
  UPDATE_SIGNING_PUBLIC_KEY: TESTKEY.pub,
  UPDATE_MAX_ZIP_MB: "64",
  UPDATER_QUEUE_SECRET: "segredo-fila-testes-12345",
};

const { app, db } = createApp(env);

async function api(path: string, init?: RequestInit, token?: string) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(path, { ...init, headers });
  const body = (await res.json()) as { ok: boolean; data?: Record<string, unknown>; error?: string };
  return { status: res.status, body };
}

function validFiles(version = "9.9.9"): Record<string, string> {
  return {
    "package.json": JSON.stringify({ name: "cr-ia", version }),
    "docker-compose.yml": "name: cr-ia\n",
    "apps/api/package.json": JSON.stringify({ version }),
    "apps/api/migrations/0001_init_postgres.sql": "SELECT 1;\n",
  };
}



let adminToken = "";
beforeAll(async () => {
  await db.init();
  await db.createUser({ email: "a@t.com", name: "A", role: "admin", passwordHash: await hashPassword("Admin123!", 4) });
  const r = await api("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@t.com", password: "Admin123!" }),
  });
  adminToken = (r.body.data as { token: string }).token;
});

describe("upload de ZIP (rota)", () => {
  it("rejeita sem assinatura e com assinatura errada", async () => {
    const bytes = makeZip(validFiles());
    const f1 = new FormData();
    f1.set("zip", new File([bytes], "r.zip", { type: "application/zip" }));
    const r1 = await api("/api/admin/updates/upload", { method: "POST", body: f1 }, adminToken);
    expect(r1.status).toBe(422);
    expect(String(r1.body.error)).toMatch(/Assinatura/);

    const other = minisignFor(new Uint8Array([7, 7, 7]));
    const f2 = new FormData();
    f2.set("zip", new File([bytes], "r.zip", { type: "application/zip" }));
    f2.set("signature", other.sig);
    const r2 = await api("/api/admin/updates/upload", { method: "POST", body: f2 }, adminToken);
    expect(r2.status).toBe(422);
    expect(String(r2.body.error)).toMatch(/INVÁLIDA|keynum/);
  });

  it("fluxo válido: assinatura real → staging + checks automáticos", async () => {
    const bytes = makeZip(validFiles());
    const f = new FormData();
    f.set("zip", new File([bytes], "r.zip", { type: "application/zip" }));
    f.set("signature", TESTKEY.sign(bytes));
    const r = await api("/api/admin/updates/upload", { method: "POST", body: f }, adminToken);
    expect(r.status).toBe(201);
    expect(r.body.data?.version).toBe("9.9.9");
    expect((r.body.data?.report as { files: number }).files).toBe(4);
    expect((r.body.data?.checks as { passed: boolean }).passed).toBe(true);
    expect(existsSync(join(dir, "updates", "pending-9.9.9", ".cr-ia-receipt.json"))).toBe(true);
    // E aprova (checks passaram) → fila para o updater.
    const a = await api("/api/admin/updates/approve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "9.9.9" }),
    }, adminToken);
    expect(a.status).toBe(200);
  });
});

describe("validateUploadZip (conteúdo)", () => {
  function writeTmp(bytes: Buffer): string {
    const p = join(dir, `z-${Date.now()}-${Math.floor(Math.random() * 1e6)}.zip`);
    writeFileSync(p, bytes);
    return p;
  }

  it("aceita ZIP válido e detecta migrações", async () => {
    const bytes = makeZip(validFiles());
    const rep = await validateUploadZip(env, writeTmp(bytes), bytes.length, "x".repeat(64));
    expect(rep.errors).toEqual([]);
    expect(rep.version).toBe("9.9.9");
    expect(rep.migrations).toEqual(["apps/api/migrations/0001_init_postgres.sql"]);
    expect(rep.irreversibleDb).toBe(false);
  });

  it("marca banco irreversível via manifesto ou marcador", async () => {
    const b1 = makeZip({ ...validFiles(), "update-manifest.json": JSON.stringify({ notes: "n", irreversibleDb: true }) });
    const r1 = await validateUploadZip(env, writeTmp(b1), b1.length, "x".repeat(64));
    expect(r1.errors).toEqual([]);
    expect(r1.irreversibleDb).toBe(true);
    expect(r1.notes).toBe("n");
    const b2 = makeZip({ ...validFiles(), "MIGRATION-IRREVERSIBLE.txt": "motivo" });
    const r2 = await validateUploadZip(env, writeTmp(b2), b2.length, "x".repeat(64));
    expect(r2.irreversibleDb).toBe(true);
  });

  it("rejeita: corrompido, slip, absoluto, link, perigoso, sem pkg, velho", async () => {
    const bad = Buffer.from("não é zip");
    const r0 = await validateUploadZip(env, writeTmp(bad), bad.length, "x".repeat(64));
    expect(r0.errors.join("|")).toMatch(/ilegível|corrompido|vazio/);

    const slip = makeZipRaw([{ name: "../../evil.sh", content: "x" }, { name: "package.json", content: "{}" }]);
    const r1 = await validateUploadZip(env, writeTmp(slip), slip.length, "x".repeat(64));
    expect(r1.errors.join("|")).toMatch(/ZIP-slip/);

    const abs = makeZipRaw([{ name: "/etc/evil", content: "x" }, { name: "package.json", content: "{}" }]);
    const r2 = await validateUploadZip(env, writeTmp(abs), abs.length, "x".repeat(64));
    expect(r2.errors.join("|")).toMatch(/ZIP-slip/);

    const lnk = makeZipRaw([{ name: "ligacao", content: "/etc", symlink: true }, { name: "package.json", content: "{}" }]);
    const r3 = await validateUploadZip(env, writeTmp(lnk), lnk.length, "x".repeat(64));
    expect(r3.errors.join("|")).toMatch(/simbólico/);

    const envFile = makeZip({ ...validFiles(), ".env": "SECRETO=1" });
    const r4 = await validateUploadZip(env, writeTmp(envFile), envFile.length, "x".repeat(64));
    expect(r4.errors.join("|")).toMatch(/perigoso/);

    const nopkg = makeZip({ "a.txt": "x" });
    const r5 = await validateUploadZip(env, writeTmp(nopkg), nopkg.length, "x".repeat(64));
    expect(r5.errors.join("|")).toMatch(/package\.json/);

    const old = makeZip(validFiles("0.0.1"));
    const r6 = await validateUploadZip(env, writeTmp(old), old.length, "x".repeat(64));
    expect(r6.errors.join("|")).toMatch(/mais nova/);
  });

  it("rejeita acima do teto (bytes declarados)", async () => {
    const bytes = makeZip(validFiles());
    const rep = await validateUploadZip(env, writeTmp(bytes), 999 * 1024 * 1024, "x".repeat(64));
    expect(rep.errors.join("|")).toMatch(/limite 64 MB/);
  });
});

describe("aprovação e rollback (gates)", () => {
  it("aprova só com staging verificado + checks aprovados", async () => {
    await expect(approveStaged(env, "1.2.3", "u1")).rejects.toThrow(/preparada/);
    const pend = join(dir, "updates", "pending-1.2.3");
    mkdirSync(pend, { recursive: true });
    writeFileSync(join(pend, ".cr-ia-receipt.json"), JSON.stringify({ version: "1.2.3" }));
    await expect(approveStaged(env, "1.2.3", "u1")).rejects.toThrow(/verificações/);
    writeFileSync(join(pend, ".cr-ia-checks.json"), JSON.stringify({ passed: false, checks: [] }));
    await expect(approveStaged(env, "1.2.3", "u1")).rejects.toThrow(/FALHARAM/);
    writeFileSync(join(pend, ".cr-ia-checks.json"), JSON.stringify({ passed: true, checks: [] }));
    const out = await approveStaged(env, "1.2.3", "u1");
    expect(out.version).toBe("1.2.3");
    expect(existsSync(join(dir, "updates", "queue", out.queued))).toBe(true);
    // Pedido assinado: HMAC + hash da árvore (o updater revalida tudo).
    const q = JSON.parse(readFileSync(join(dir, "updates", "queue", out.queued), "utf8")) as Record<string, string>;
    expect(q.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(q.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(q.sha).toBe(hashStagedTree(join(dir, "updates", "pending-1.2.3")));
    expect(readdirSync(join(dir, "updates", "queue")).length).toBeGreaterThan(0);
  });

  it("sem UPDATER_QUEUE_SECRET: aprovar e rollback são bloqueados", async () => {
    const noSecret = { ...env, UPDATER_QUEUE_SECRET: "" } as Env;
    expect(() => queueSecret(noSecret)).toThrow(/UPDATER_QUEUE_SECRET/);
    await expect(approveStaged(noSecret, "1.2.3", "u1")).rejects.toThrow(/UPDATER_QUEUE_SECRET/);
    const relS = join(dir, "updates", "releases", "rel-secret");
    mkdirSync(relS, { recursive: true });
    writeFileSync(join(relS, ".cr-ia-release.json"), JSON.stringify({ version: "0.8.0" }));
    expect(() => requestRollback(noSecret, "rel-secret", "u1")).toThrow(/UPDATER_QUEUE_SECRET/);
    // Segredo curto também bloqueia.
    expect(() => queueSecret({ ...env, UPDATER_QUEUE_SECRET: "curto" } as Env)).toThrow(/UPDATER_QUEUE_SECRET/);
  });

  it("hashStagedTree: determinístico, sente troca de conteúdo e recusa symlink", () => {
    const d = mkdtempSync(join(tmpdir(), "cr-ia-treehash-"));
    mkdirSync(join(d, "sub"), { recursive: true });
    writeFileSync(join(d, "a.txt"), "um");
    writeFileSync(join(d, "sub", "b.txt"), "dois");
    expect(hashStagedTree(d)).toBe(hashStagedTree(d));
    writeFileSync(join(d, "sub", "b.txt"), "dois-adulterado");
    const tampered = hashStagedTree(d);
    writeFileSync(join(d, "sub", "b.txt"), "dois");
    expect(hashStagedTree(d)).not.toBe(tampered);
    symlinkSync(join(d, "a.txt"), join(d, "link.txt"));
    expect(() => hashStagedTree(d)).toThrow(/symlink/);
  });

  it("signQueue: HMAC muda com qualquer campo do pedido", () => {
    const a = { kind: "approved", version: "1.0.0" };
    expect(signQueue("segredo-fila-testes-12345", a)).toBe(signQueue("segredo-fila-testes-12345", { ...a }));
    expect(signQueue("segredo-fila-testes-12345", a)).not.toBe(signQueue("outro-segredo-123456", a));
    expect(signQueue("segredo-fila-testes-12345", a)).not.toBe(
      signQueue("segredo-fila-testes-12345", { ...a, version: "9.9.9" }));
  });

  it("rollback: alvo inválido, ausente e válido", async () => {
    expect(() => requestRollback(env, "../x", "u1")).toThrow(/inválido/);
    expect(() => requestRollback(env, "inexistente", "u1")).toThrow(/não encontrado/);
    const rel = join(dir, "updates", "releases", "rel-a");
    mkdirSync(rel, { recursive: true });
    writeFileSync(join(rel, ".cr-ia-release.json"), JSON.stringify({ version: "0.9.0", irreversibleDb: true }));
    const out = requestRollback(env, "rel-a", "u1");
    expect(out.dbWarning).toBe(true);
    expect(existsSync(join(dir, "updates", "queue", out.queued))).toBe(true);
  });

  it("rotas de releases/history exigem admin e respondem", async () => {
    expect((await api("/api/admin/updates/releases")).status).toBe(401);
    const r = await api("/api/admin/updates/releases", undefined, adminToken);
    expect(r.status).toBe(200);
    expect(Array.isArray((r.body.data as { releases: unknown[] }).releases)).toBe(true);
    const h = await api("/api/admin/updates/history", undefined, adminToken);
    expect(h.status).toBe(200);
  });
});
