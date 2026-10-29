/**
 * ollama-setup.sh (item 2): pull + prova de geração com docker simulado
 * (shim no PATH); lógica do script (lista, trava de RAM, smoke test)
 * executa DE VERDADE. Ollama/docker reais só na VPS (documentado).
 * Rode: npm run test:scripts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "ollama-setup.sh");

// Shim docker: `ps` diz que ollama roda; pull/run registram e respondem.
const DOCKER_SHIM = `#!/bin/bash
if [[ "$1" == "ps" ]]; then echo "ollama"; exit 0; fi
if [[ "$*" == *"ollama list"* ]]; then echo -e "NAME\\tSIZE\\nqwen3:4b\\t2.5 GB"; exit 0; fi
if [[ "$*" == *"ollama pull"* ]]; then echo "pull $*" >> "$PULL_LOG"; exit 0; fi
if [[ "$*" == *"ollama run"* ]]; then
  echo "run $*" >> "$PULL_LOG"
  if [[ "\${RUN_FAIL:-0}" == "1" ]]; then echo "falha simulada" >&2; exit 1; fi
  echo "OK"; exit 0
fi
exit 0
`;

function setup() {
  const base = mkdtempSync(join(tmpdir(), "cr-ia-ollama-"));
  const shim = join(base, "shim");
  const work = join(base, "work");
  mkdirSync(shim, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(shim, "docker"), DOCKER_SHIM, { mode: 0o755 });
  return { base, shim, work, pullLog: join(base, "pull.log") };
}

function run(t, extraEnv = {}) {
  return spawnSync("bash", [SCRIPT], {
    cwd: t.work,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${t.shim}:${process.env.PATH}`,
      PULL_LOG: t.pullLog,
      ...extraEnv,
    },
  });
}

describe("ollama-setup.sh", () => {
  it("padrão: baixa qwen3:4b + prova de geração", () => {
    const t = setup();
    const r = run(t);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const log = readFileSync(t.pullLog, "utf8");
    assert.match(log, /pull .*qwen3:4b/);
    assert.match(log, /run .*qwen3:4b/);
    assert.match(r.stdout, /respondeu: OK/);
  });

  it("lista com vírgula/espaços: baixa todos", () => {
    const t = setup();
    const r = run(t, { OLLAMA_TEXT_MODELS: "qwen3:4b, qwen3:8b" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const log = readFileSync(t.pullLog, "utf8");
    assert.match(log, /pull .*qwen3:4b/);
    assert.match(log, /pull .*qwen3:8b/);
  });

  it("modelo >=14B é recusado ANTES de baixar (trava de 12 GB)", () => {
    const t = setup();
    const r = run(t, { OLLAMA_TEXT_MODELS: "qwen3:32b" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /excede o orçamento de 12 GB/);
    assert.ok(!existsSync(t.pullLog), "nada poderia ter sido baixado");
  });

  it("ALLOW_HEAVY_MODEL=1 libera modelo pesado (decisão do dono)", () => {
    const t = setup();
    const r = run(t, { OLLAMA_TEXT_MODELS: "qwen3:32b", ALLOW_HEAVY_MODEL: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(t.pullLog, "utf8"), /pull .*qwen3:32b/);
  });

  it("falha na geração: erro honesto com o nome do modelo", () => {
    const t = setup();
    const r = run(t, { RUN_FAIL: "1" });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /qwen3:4b.*não gerou resposta/);
  });
});
