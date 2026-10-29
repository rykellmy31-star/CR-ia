/**
 * Instalador por ZIP (bloco 2): deploy-vps-pronta.sh SEM Git, porta 3000,
 * segredos gerados sem exposição. Docker/cloudflared = shims no PATH;
 * cópia de arquivos + .env + validações executam DE VERDADE num diretório
 * temporário sem .git. Docker real só na VPS (documentado).
 * Rode: npm run test:scripts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "deploy-vps-pronta.sh");

const SHIMS = {
  // docker mínimo: info + compose version OK.
  docker: `#!/bin/bash\nif [[ "$1" == "info" ]]; then echo "Server: shim"; exit 0; fi\nif [[ "$1" == "compose" ]]; then echo "2.99.0"; exit 0; fi\nif [[ "$1" == "--version" ]]; then echo "Docker version 99-shim"; exit 0; fi\nexit 0\n`,
  cloudflared: `#!/bin/bash\necho "cloudflared-shim"; exit 0\n`,
  pgrep: `#!/bin/bash\nexit 0\n`,
  ss: `#!/bin/bash\nexit 0\n`,
};

function makeShims() {
  const dir = mkdtempSync(join(tmpdir(), "cr-ia-depshim-"));
  for (const [name, content] of Object.entries(SHIMS)) {
    writeFileSync(join(dir, name), content, { mode: 0o755 });
  }
  return dir;
}

/** Origem simulando o ZIP extraído (SEM .git): .env.example + compose + arquivo. */
function makeSource({ admin = "Forte-Admin-9x7q2!", guest = "Forte-Guest-4k8m1!" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cr-ia-zipsrc-"));
  writeFileSync(join(dir, ".env.example"),
    `NODE_ENV=\nJWT_SECRET=\nCREDENTIALS_SECRET=\nPOSTGRES_PASSWORD=\nADMIN_PASSWORD=${admin}\nGUEST_PASSWORD=${guest}\nUPDATER_QUEUE_SECRET=\nPUBLIC_API_URL=\nCORS_ORIGINS=\n`);
  writeFileSync(join(dir, "docker-compose.yml"), "name: fixture-zip\n");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "migrate-seed.sh"), "#!/bin/bash\necho seeded\n", { mode: 0o644 });
  writeFileSync(join(dir, "app-marker.txt"), "conteudo-do-zip\n");
  return dir;
}

function run(args, { source, appDir, shims, extraEnv = {} } = {}) {
  const env = { ...process.env, ...extraEnv };
  if (shims) env.PATH = `${shims}:${process.env.PATH}`;
  if (source) env.CRIA_SOURCE_DIR = source;
  if (appDir) env.APP_DIR = appDir;
  return spawnSync("bash", [SCRIPT, ...args], { cwd: tmpdir(), encoding: "utf8", env });
}

function readEnv(appDir) {
  const out = {};
  for (const line of readFileSync(join(appDir, ".env"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe("deploy-vps-pronta.sh --check", () => {
  it("--check passa com pré-requisitos (shims) e não altera nada", () => {
    const source = makeSource(), shims = makeShims();
    const before = statSync(join(source, "app-marker.txt")).mtimeMs;
    const r = run(["--check"], { source, shims });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /diagnóstico concluído, nada foi alterado/);
    assert.match(r.stdout, /ZIP extraído/);
    assert.equal(statSync(join(source, "app-marker.txt")).mtimeMs, before, "check não modifica arquivos da origem");
  });

  it("--check falha honestamente sem Docker (ambiente real, sem shim)", () => {
    const r = run(["--check"], { source: makeSource() });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Docker ausente ou sem permissão/);
  });

  it("--check recusa origem sem .env.example/docker-compose.yml", () => {
    const empty = mkdtempSync(join(tmpdir(), "cr-ia-vazio-"));
    const r = run(["--check"], { source: empty, shims: makeShims() });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /Origem inválida/);
  });
});
function readdirCount(d) {
  return spawnSync("ls", [d], { encoding: "utf8" }).stdout.split("\n").length;
}

describe("deploy-vps-pronta.sh --apply (CRIA_SKIP_DOCKER=1)", () => {
  it("copia arquivos + gera segredos SEM imprimi-los", () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "cr-ia-app-")), "app");
    const r = run(["--apply"], {
      source: makeSource(), appDir, shims: makeShims(),
      extraEnv: { CRIA_SKIP_DOCKER: "1", DOMAIN: "ia.crjornada.com" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readFileSync(join(appDir, "app-marker.txt"), "utf8"), "conteudo-do-zip\n");
    // Instalador garante +x mesmo se a origem perdeu o bit exec.
    const mmode = statSync(join(appDir, "scripts", "migrate-seed.sh")).mode;
    assert.ok(mmode & 0o100, "migrate-seed.sh sem bit exec após instalação");
    const e = readEnv(appDir);
    assert.equal(e.NODE_ENV, "production");
    assert.match(e.JWT_SECRET, /^[0-9a-f]{64}$/);
    assert.match(e.CREDENTIALS_SECRET, /^[0-9a-f]{64}$/);
    assert.match(e.POSTGRES_PASSWORD, /^[0-9a-f]{48}$/);
    assert.match(e.UPDATER_QUEUE_SECRET, /^[0-9a-f]{64}$/);
    assert.equal(e.PUBLIC_API_URL, "https://ia.crjornada.com/api");
    assert.equal(e.CORS_ORIGINS, "https://ia.crjornada.com");
    // Nenhum valor secreto aparece na saída.
    for (const v of [e.JWT_SECRET, e.CREDENTIALS_SECRET, e.POSTGRES_PASSWORD, e.UPDATER_QUEUE_SECRET]) {
      assert.ok(!r.stdout.includes(v), "segredo vazou na saída!");
    }
  });

  it("segunda execução preserva segredos existentes (nunca regenera)", () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "cr-ia-app-")), "app");
    const base = { source: makeSource(), appDir, shims: makeShims(), extraEnv: { CRIA_SKIP_DOCKER: "1" } };
    assert.equal(run(["--apply"], base).status, 0);
    const first = readEnv(appDir);
    assert.equal(run(["--apply"], base).status, 0);
    const second = readEnv(appDir);
    for (const k of ["JWT_SECRET", "CREDENTIALS_SECRET", "POSTGRES_PASSWORD", "UPDATER_QUEUE_SECRET"]) {
      assert.equal(second[k], first[k], `${k} foi regenerado!`);
    }
    assert.notEqual(first.JWT_SECRET, first.CREDENTIALS_SECRET, "segredos distintos");
  });

  it(".env pré-existente no destino NUNCA é sobrescrito pela cópia", () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "cr-ia-app-")), "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, ".env"), "JWT_SECRET=fixo-do-dono\nADMIN_PASSWORD=Forte-Admin-9x7q2!\nGUEST_PASSWORD=Forte-Guest-4k8m1!\n");
    const r = run(["--apply"], {
      source: makeSource(), appDir, shims: makeShims(), extraEnv: { CRIA_SKIP_DOCKER: "1" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const e = readEnv(appDir);
    assert.equal(e.JWT_SECRET, "fixo-do-dono");
    assert.match(e.CREDENTIALS_SECRET, /^[0-9a-f]{64}$/, "faltante foi preenchido");
  });

  it("recusa ADMIN/GUEST padrão (Trocar123!) antes de qualquer Docker", () => {
    const appDir = join(mkdtempSync(join(tmpdir(), "cr-ia-app-")), "app");
    const r = run(["--apply"], {
      source: makeSource({ admin: "Trocar123!", guest: "Trocar123!" }), appDir,
      shims: makeShims(), extraEnv: { CRIA_SKIP_DOCKER: "1" },
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /ADMIN_PASSWORD ainda é o padrão/);
  });
});

describe("deploy-vps-pronta.sh estático (sem Git, porta 3000)", () => {
  it("não referencia git clone / REPO_URL / porta 8080", () => {
    const src = readFileSync(SCRIPT, "utf8");
    assert.doesNotMatch(src, /git clone/);
    assert.doesNotMatch(src, /REPO_URL/);
    assert.doesNotMatch(src, /8080/);
    assert.ok(src.includes("3000"), "porta 3000 do Tunnel");
    assert.ok(src.includes("CREDENTIALS_SECRET"), "preenche CREDENTIALS_SECRET");
    assert.ok(src.includes("UPDATER_QUEUE_SECRET"), "preenche UPDATER_QUEUE_SECRET");
  });
});
