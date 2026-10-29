#!/usr/bin/env node
/**
 * CR IA — gera o ZIP de release/entrega de forma reproduzível (item 6).
 *
 * Uso: node scripts/make-release-zip.mjs --out /tmp/cr-ia-vX.zip [--root .] [--force]
 *
 * - Empacota arquivos relativos ao --root (sem pasta wrapper; a Central de
 *   Atualizações aceita com ou sem pasta única no topo).
 * - Zipa a partir de uma CÓPIA em staging com `chmod 755 scripts/*.sh`
 *   garantido: scripts sempre extraem executáveis no Linux, mesmo se a
 *   árvore de origem perdeu o bit exec (ex.: checkout no Windows).
 * - SEMPRE exclui: .git, node_modules, dist/build, coverage, backups, data,
 *   __pycache__, .env e .env.* (segredos e lixo nunca entram no ZIP).
 * - SEMPRE inclui .env.example (o instalador depende dele; não tem segredos).
 * - Recusa sobrescrever --out existente sem --force.
 * - Imprime contagem de arquivos + sha256 (confira na entrega).
 * - Requer o comando `zip` (sudo apt install zip).
 *
 * Pastas de runtime (data/, backups/) são recriadas no deploy; não vão no ZIP.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? "") : ""; };
const root = resolve(val("--root") || ".");
const out = val("--out");
if (!out) {
  console.error("Uso: node scripts/make-release-zip.mjs --out <arquivo.zip> [--root <dir>] [--force]");
  process.exit(2);
}
const outAbs = resolve(out);
if (existsSync(outAbs) && !args.includes("--force")) {
  console.error(`ERRO: ${outAbs} já existe (use --force para sobrescrever).`);
  process.exit(1);
}

const EXCLUDE_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "coverage",
  "backups", "data", "__pycache__", ".venv", "venv",
]);
const EXCLUDE_FILES = [/\.log$/i, /\.tsbuildinfo$/, /^\.DS_Store$/];
function isExcludedFile(name) {
  if (name === ".env") return true; // segredos reais: NUNCA no ZIP
  if (name === ".env.example") return false; // instalador precisa: SEMPRE no ZIP
  if (name.startsWith(".env.")) return true; // .env.local, .env.production...
  return EXCLUDE_FILES.some((re) => re.test(name));
}

function walk(dir, base, found) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.has(e.name)) walk(full, rel, found);
    } else if (e.isFile()) {
      if (isExcludedFile(e.name)) continue;
      if (resolve(full) === outAbs) continue; // nunca embala o próprio ZIP
      found.push(rel);
    }
  }
}

const files = [];
walk(root, "", files);
files.sort();
if (!files.length) { console.error("ERRO: nenhum arquivo encontrado."); process.exit(1); }

// Staging: cópia hermética com bit exec garantido nos .sh.
const stage = mkdtempSync(join(tmpdir(), "cr-ia-zipstage-"));
try {
  for (const f of files) {
    const dest = join(stage, f);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, f), dest);
    if (f === "scripts/make-release-zip.mjs") continue;
    if (f.startsWith("scripts/") && f.endsWith(".sh")) chmodSync(dest, 0o755);
  }
} catch (e) {
  console.error(`ERRO no staging: ${e.message}`);
  process.exit(1);
}

try {
  execFileSync("zip", ["-q", "-X", "-9", outAbs, "-@"], {
    cwd: stage, input: files.join("\n") + "\n", stdio: ["pipe", "pipe", "pipe"],
  });
} catch {
  console.error("ERRO: comando `zip` falhou ou não existe (instale: sudo apt install zip).");
  process.exit(1);
}

try { rmSync(stage, { recursive: true, force: true }); } catch { /* best-effort */ }
const hash = createHash("sha256").update(readFileSync(outAbs)).digest("hex");
console.log(`ZIP: ${outAbs}`);
console.log(`arquivos: ${files.length}`);
console.log(`sha256: ${hash}`);
