/**
 * Testes do make-release-zip.mjs (rode: npm run test:scripts).
 * Pula honestamente se zip/unzip não existirem no ambiente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "make-release-zip.mjs");

function has(cmd) {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

if (!has("zip") || !has("unzip")) {
  console.log("SKIP: zip/unzip ausentes neste ambiente.");
  process.exit(0);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cr-ia-ziptest-"));
  const w = (rel, content = "x") => {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  w("package.json", "{}");
  w("apps/api/index.ts", "ok");
  w("node_modules/x/y.js", "lixo");
  w("apps/api/dist/z.js", "build");
  w(".env", "SECRETO=1");
  w(".env.local", "SECRETO=2");
  w(".env.example", "EXEMPLO=1");
  w("scripts/x.sh", "#!/bin/bash\necho oi\n"); // nasce 644: o ZIP precisa gravar +x
  w("data/f.txt", "dado");
  w(".git/config", "git");
  w("logs/app.log", "log");
  return root;
}

describe("make-release-zip", () => {
  it("embala só o permitido (sem segredos, sem build, sem deps)", () => {
    const root = fixture();
    const out = join(root, "out.zip");
    const r = spawnSync("node", [SCRIPT, "--out", out, "--root", root], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /arquivos: 4/);
    assert.match(r.stdout, /sha256: [0-9a-f]{64}/);
    const list = spawnSync("unzip", ["-Z1", out], { encoding: "utf8" }).stdout;
    const lines = list.split("\n").filter(Boolean);
    assert.match(list, /package\.json/);
    assert.match(list, /apps\/api\/index\.ts/);
    assert.ok(lines.includes(".env.example"), ".env.example PRECISA estar no ZIP (instalador depende dele)");
    assert.ok(!lines.includes(".env"), ".env com segredos vazou para o ZIP");
    assert.ok(!lines.includes(".env.local"), ".env.local vazou para o ZIP");
    // Bit exec: extrai e confere modo + execução direta do .sh.
    const xdir = mkdtempSync(join(tmpdir(), "cr-ia-zipx-"));
    assert.equal(spawnSync("unzip", ["-q", out, "-d", xdir]).status, 0);
    const mode = statSync(join(xdir, "scripts", "x.sh")).mode;
    assert.ok(mode & 0o100, `scripts/*.sh sem bit exec no ZIP (modo ${mode.toString(8)})`);
    const xr = spawnSync(join(xdir, "scripts", "x.sh"), { encoding: "utf8" });
    assert.equal(xr.status, 0, "script extraído não executa");
    assert.match(xr.stdout, /oi/);
    for (const banned of ["node_modules", "dist", "data/", ".git", ".log", "out.zip"]) {
      assert.doesNotMatch(list, new RegExp(banned), `${banned} vazou para o ZIP`);
    }
  });

  it("ZIP real: contém todos os arquivos necessários à instalação (e nenhum segredo)", () => {
    const out = join(mkdtempSync(join(tmpdir(), "cr-ia-zipreal-")), "cr-ia-real.zip");
    const r = spawnSync("node", [SCRIPT, "--out", out, "--root", ROOT], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const lines = spawnSync("unzip", ["-Z1", out], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
    assert.ok(lines.length > 100, `ZIP real com poucos arquivos: ${lines.length}`);
    const required = [
      ".env.example", "docker-compose.yml", "package.json",
      "scripts/deploy-vps-pronta.sh", "scripts/install-vps.sh", "scripts/backup.sh",
      "scripts/restore.sh", "scripts/migrate-seed.sh", "scripts/update.sh",
      "scripts/ollama-setup.sh", "scripts/r2-lib.mjs",
      "apps/api/Dockerfile", "apps/worker/Dockerfile", "apps/web/Dockerfile",
      "apps/ai-local/Dockerfile", "apps/updater/Dockerfile",
      "apps/updater/updater-service.mjs",
      "docker/searxng/settings.yml",
      "docs/INSTALACAO.md", "docs/TUNEL-CLOUDFLARE.md",
    ];
    for (const f of required) assert.ok(lines.includes(f), `FALTA no ZIP: ${f}`);
    assert.ok(!lines.includes(".env"), ".env vazou para o ZIP real");
    // Scripts do ZIP real extraem executáveis e rodam direto (sem "Permission denied").
    const rdir = mkdtempSync(join(tmpdir(), "cr-ia-ziprealx-"));
    assert.equal(spawnSync("unzip", ["-q", out, "-d", rdir]).status, 0);
    for (const f of required.filter((x) => x.startsWith("scripts/") && x.endsWith(".sh"))) {
      assert.ok(statSync(join(rdir, f)).mode & 0o100, `${f} sem bit exec no ZIP real`);
    }
    const mig = spawnSync(join(rdir, "scripts", "migrate-seed.sh"), { encoding: "utf8", cwd: rdir });
    assert.notEqual(mig.status, 0, "migrate-seed.sh deveria falhar no guard do docker, não em permissão");
    assert.match(mig.stdout + mig.stderr, /serviço 'api' não está rodando/, "guarda do docker não executou");
    for (const l of lines) {
      assert.ok(!l.startsWith("node_modules/"), `vazou: ${l}`);
      assert.ok(!l.startsWith(".git/"), `vazou: ${l}`);
      assert.ok(!l.includes("/dist/") && !l.startsWith("dist/"), `vazou: ${l}`);
      assert.ok(!l.startsWith("data/") && !l.startsWith("backups/"), `vazou: ${l}`);
      assert.ok(!l.endsWith(".log"), `vazou: ${l}`);
    }
  });

  it("recusa sobrescrever sem --force; --force permite", () => {
    const root = fixture();
    const out = join(root, "out.zip");
    assert.equal(spawnSync("node", [SCRIPT, "--out", out, "--root", root]).status, 0);
    const r = spawnSync("node", [SCRIPT, "--out", out, "--root", root], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--force/);
    const f = spawnSync("node", [SCRIPT, "--out", out, "--root", root, "--force"], { encoding: "utf8" });
    assert.equal(f.status, 0, f.stderr);
  });
});
