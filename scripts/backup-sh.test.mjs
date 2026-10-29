/**
 * Guardas do backup/restore v0.2.0 (§10): fail-closed, anti-parcial e
 * verificação SHA — tudo antes de qualquer docker destrutivo.
 * Rode: npm run test:scripts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP = join(ROOT, "scripts", "backup.sh");
const RESTORE = join(ROOT, "scripts", "restore.sh");

function run(script, args, { input, env } = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: ROOT, encoding: "utf8", input,
    env: { ...process.env, ...env },
  });
}

describe("backup.sh (guardas)", () => {
  it("BACKUP_DIR=/ é recusado", () => {
    const r = run(BACKUP, [], { env: { BACKUP_DIR: "/" } });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /BACKUP_DIR inválido/);
  });

  it("BACKUP_DIR não-criável falha fechado", () => {
    const f = join(tmpdir(), `cr-ia-arquivo-${Date.now()}`);
    writeFileSync(f, "x");
    const r = run(BACKUP, [], { env: { BACKUP_DIR: join(f, "sub") } });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /não consigo criar/);
  });

  it("sem db rodando: erro honesto (nada é publicado)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-backup-"));
    const r = run(BACKUP, [], { env: { BACKUP_DIR: dir } });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /serviço 'db' não está rodando/);
  });
});

describe("Restic da VPS intacto (invariante)", () => {
  it("nenhum script do app invoca restic (só deposita dumps na árvore)", () => {
    for (const f of ["backup.sh", "restore.sh", "update.sh", "deploy-vps-pronta.sh", "migrate-seed.sh"]) {
      const src = readFileSync(join(ROOT, "scripts", f), "utf8");
      assert.doesNotMatch(src, /^\s*restic\s/m, `${f} invoca restic!`);
      assert.doesNotMatch(src, /[|`$]\(restic\s/, `${f} invoca restic!`);
    }
  });
});

describe("restore.sh (guardas + anti-parcial)", () => {
  it("sem argumento: lista conjuntos e sai 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-restore-"));
    const r = run(RESTORE, [], { env: { BACKUP_DIR: dir } });
    assert.equal(r.status, 1);
    assert.match(r.stdout + r.stderr, /Uso: .*restore\.sh <STAMP>/);
  });

  it("stamp sem manifest: conjunto incompleto", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-restore-"));
    const r = run(RESTORE, ["2099-01-01_000000"], { env: { BACKUP_DIR: dir } });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /sem manifest/);
  });

  it("manifest não-verificado: aborta antes de pedir confirmação", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-restore-"));
    writeFileSync(join(dir, "manifest-S1.json"), '{"stamp":"S1","verified":false}');
    const r = run(RESTORE, ["S1"], { env: { BACKUP_DIR: dir }, input: "RESTAURAR\n" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /não-verificado/);
  });

  it("confirmação errada: cancela sem alterar nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-restore-"));
    writeFileSync(join(dir, "manifest-S2.json"), '{"stamp":"S2","verified": true}');
    const r = run(RESTORE, ["S2"], { env: { BACKUP_DIR: dir }, input: "sim\n" });
    assert.equal(r.status, 0);
    assert.match(r.stdout + r.stderr, /Cancelado/);
  });

  it("SHA256 divergente: aborta antes de qualquer docker", () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-restore-"));
    writeFileSync(join(dir, "manifest-S3.json"),
      '{"stamp":"S3","verified": true,"files":[' +
      '{"name": "db-S3.sql.gz", "bytes": 1, "sha256": "0000000000000000000000000000000000000000000000000000000000000000"}]}');
    writeFileSync(join(dir, "db-S3.sql.gz"), "conteúdo-adulterado");
    const r = run(RESTORE, ["S3"], { env: { BACKUP_DIR: dir }, input: "RESTAURAR\n" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /SHA256.*NÃO confere/);
  });
});
