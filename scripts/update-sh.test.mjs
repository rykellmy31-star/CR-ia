/**
 * Guardas do scripts/update.sh --zip (fail-closed, antes de qualquer docker).
 * Rode: npm run test:scripts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "update.sh");

function run(...args) {
  return spawnSync("bash", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
}

describe("update.sh --zip (guardas)", () => {
  it("sem diretório: erro de uso", () => {
    const r = run("--zip");
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /informe o diretório staging/);
  });

  it("diretório inexistente: erro", () => {
    const r = run("--zip", join(tmpdir(), "cr-ia-inexistente-xyz"));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /informe o diretório staging/);
  });

  it("sem recibo de verificação: recusa aplicar", () => {
    const r = run("--zip", mkdtempSync(join(tmpdir(), "cr-ia-semrecibo-")));
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /sem recibo de verificação/);
  });
});
