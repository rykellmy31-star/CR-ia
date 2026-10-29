/**
 * Central de Atualizações — UPLOAD de ZIP pelo painel (§4 da missão).
 *
 * Fluxo: upload → valida (tamanho, formato, integridade, ZIP-slip, links,
 * arquivos perigosos) → assinatura minisign (origem confiável) → staging
 * isolado → verificações (+ testes opcionais) → aprovação humana → fila
 * para o serviço `updater` (privilégios separados) → histórico + rollback.
 *
 * A API NUNCA aplica arquivos no app e NUNCA tem socket Docker: ela só
 * prepara e enfileira. Quem aplica é o updater (container separado).
 */
import { createHash, createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Env } from "../types.js";
import { appendHistory, compareVersions, currentVersion, updatesDir, verifyMinisign } from "./updates.js";
import { getBool } from "../lib/config.js";

export interface UploadReport {
  version: string;
  topDir: string;
  files: number;
  bytes: number;
  sha256: string;
  migrations: string[];
  irreversibleDb: boolean;
  notes: string | null;
  warnings: string[];
  errors: string[];
}

export interface StagingChecks {
  passed: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  at: string;
}

function execAsync(file: string, args: string[], cwd: string, timeoutMs: number, input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
      resolve({ code: err ? 1 : 0, out });
    });
    if (input !== undefined) {
      child.stdin?.write(input);
      child.stdin?.end();
    }
  });
}

const PY_LIST = `import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
entries = []
for i in z.infolist():
    mode = (i.external_attr >> 16) & 0o170000
    entries.append({"name": i.filename, "size": i.file_size, "symlink": mode == 0o120000, "dir": i.is_dir()})
print(json.dumps({"bad": bad, "total": sum(e["size"] for e in entries), "entries": entries}))`;

const PY_READ = `import zipfile, sys
sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))`;

const PY_EXTRACT = `import zipfile, os, sys, stat
zp, dest = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(zp)
n = 0
for i in z.infolist():
    name = i.filename
    if i.is_dir() or name.endswith('/'):
        continue
    parts = name.replace(chr(92), '/').split('/')
    if name.startswith('/') or name.startswith(chr(92)) or '..' in parts or '' in parts:
        raise SystemExit('REJECT:' + name)
    if stat.S_ISLNK((i.external_attr >> 16)):
        raise SystemExit('SYMLINK:' + name)
    if '/__MACOSX/' in '/' + name or os.path.basename(name) == '.DS_Store':
        continue
    out = os.path.join(dest, *parts)
    if not os.path.realpath(out).startswith(os.path.realpath(dest) + os.sep):
        raise SystemExit('ESCAPE:' + name)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with z.open(i) as f, open(out, 'wb') as w:
        w.write(f.read())
    n += 1
print('EXTRACTED:' + str(n))`;

interface ZipEntry { name: string; size: number; symlink: boolean; dir: boolean }

async function listEntries(zipPath: string): Promise<{ bad: string | null; total: number; entries: ZipEntry[] }> {
  const r = await execAsync("python3", ["-c", PY_LIST, zipPath], "/tmp", 120_000);
  if (r.code !== 0) throw new Error(`ZIP ilegível/corrompido: ${r.out.slice(-300)}`);
  try {
    return JSON.parse(r.out) as { bad: string | null; total: number; entries: ZipEntry[] };
  } catch {
    throw new Error("Falha ao inspecionar o ZIP (saída inválida).");
  }
}

async function readEntry(zipPath: string, name: string, maxBytes = 100_000): Promise<string> {
  const r = await execAsync("python3", ["-c", PY_READ, zipPath, name], "/tmp", 30_000);
  if (r.code !== 0) throw new Error(`Não foi possível ler ${name} dentro do ZIP.`);
  if (r.out.length > maxBytes) throw new Error(`${name} grande demais dentro do ZIP.`);
  return r.out;
}

const DANGEROUS_NAME = [
  /(^|\/)\.env(\..*)?$/i, /(^|\/)[^/]*\.key$/i, /(^|\/)[^/]*\.pem$/i,
  /(^|\/)id_rsa/i, /(^|\/)[^/]*\.ppk$/i, /(^|\/)\.git(\/|$)/, /(^|\/)__MACOSX(\/|$)/,
];

function isDangerous(name: string): string | null {
  for (const re of DANGEROUS_NAME) {
    if (re.test(name)) return `arquivo perigoso/proibido: ${name}`;
  }
  return null;
}

/**
 * Valida o ZIP (sem extrair): formato, integridade, slip, links, perigosos,
 * package.json + versão, manifesto opcional, migrações. Não lança: devolve erros.
 */
export async function validateUploadZip(env: Env, zipPath: string, bytesLen: number, sha256: string): Promise<UploadReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const maxMb = Math.max(1, Number(env.UPDATE_MAX_ZIP_MB ?? 256) || 256);
  if (bytesLen > maxMb * 1024 * 1024) {
    errors.push(`ZIP com ${(bytesLen / 1024 / 1024).toFixed(1)} MB — limite ${maxMb} MB.`);
  }
  let listed: { bad: string | null; total: number; entries: ZipEntry[] };
  try {
    listed = await listEntries(zipPath);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : "ZIP ilegível.");
    return {
      version: "", topDir: "", files: 0, bytes: bytesLen, sha256,
      migrations: [], irreversibleDb: false, notes: null, warnings, errors,
    };
  }
  if (listed.bad) errors.push(`ZIP corrompido (CRC falhou em: ${listed.bad}).`);
  const files = listed.entries.filter((e) => !e.dir);
  if (files.length === 0) errors.push("ZIP vazio (sem arquivos).");
  if (files.length > 20_000) errors.push(`ZIP com arquivos demais (${files.length} > 20000).`);
  if (listed.total > 2 * 1024 * 1024 * 1024) errors.push("ZIP descomprime para mais de 2 GB (bomba suspeita).");
  for (const e of files) {
    const parts = e.name.replace(/\\/g, "/").split("/");
    if (e.name.startsWith("/") || e.name.startsWith("\\") || parts.includes("..") || parts.includes("")) {
      errors.push(`ZIP-slip bloqueado: ${e.name.slice(0, 120)}`);
    }
    if (e.symlink) errors.push(`Link simbólico bloqueado: ${e.name.slice(0, 120)}`);
    const danger = isDangerous(e.name);
    if (danger) errors.push(danger);
  }
  // package.json: raiz ou pasta única no topo.
  const tops = new Set(files.map((f) => f.name.split("/")[0]));
  let topDir = "";
  let pkgName = "package.json";
  if (!files.some((f) => f.name === "package.json")) {
    if (tops.size === 1) {
      const only = [...tops][0];
      if (files.some((f) => f.name === `${only}/package.json`)) {
        topDir = only;
        pkgName = `${only}/package.json`;
      }
    }
  }
  let version = "";
  if (!files.some((f) => f.name === pkgName)) {
    errors.push("ZIP sem package.json na raiz (ou pasta única no topo).");
  } else {
    try {
      const pkg = JSON.parse(await readEntry(zipPath, pkgName)) as { version?: unknown; name?: unknown };
      version = String(pkg.version ?? "");
      if (!/^\d+\.\d+\.\d+/.test(version)) errors.push(`Versão inválida no package.json: ${version.slice(0, 40) || "(ausente)"}.`);
      else if (compareVersions(version, currentVersion()) <= 0) {
        errors.push(`Versão ${version} não é mais nova que a instalada (${currentVersion()}).`);
      }
    } catch (e) {
      errors.push(`package.json ilegível: ${e instanceof Error ? e.message : e}`);
    }
  }
  // Manifesto opcional da atualização (notas + irreversibilidade do banco).
  let irreversibleDb = false;
  let notes: string | null = null;
  const manifestName = topDir ? `${topDir}/update-manifest.json` : "update-manifest.json";
  if (files.some((f) => f.name === manifestName)) {
    try {
      const m = JSON.parse(await readEntry(zipPath, manifestName)) as { notes?: unknown; irreversibleDb?: unknown };
      if (typeof m.notes === "string" && m.notes.trim()) notes = m.notes.trim().slice(0, 2000);
      irreversibleDb = m.irreversibleDb === true;
    } catch {
      warnings.push("update-manifest.json ilegível (ignorado).");
    }
  }
  const irrevName = topDir ? `${topDir}/MIGRATION-IRREVERSIBLE.txt` : "MIGRATION-IRREVERSIBLE.txt";
  if (files.some((f) => f.name === irrevName)) irreversibleDb = true;
  const migPrefix = topDir ? `${topDir}/apps/api/migrations/` : "apps/api/migrations/";
  const migrations = files.map((f) => f.name).filter((n) => n.startsWith(migPrefix) && n.endsWith(".sql"));
  if (files.length > 5000) warnings.push(`ZIP grande (${files.length} arquivos) — aplicação pode demorar.`);
  return { version, topDir, files: files.length, bytes: bytesLen, sha256, migrations, irreversibleDb, notes, warnings, errors };
}

/** Extrai com defesa em profundidade (revalida slip/links na escrita). */
export async function extractZipSafe(zipPath: string, destDir: string): Promise<number> {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  const r = await execAsync("python3", ["-c", PY_EXTRACT, zipPath, destDir], "/tmp", 300_000);
  const m = r.out.match(/EXTRACTED:(\d+)/);
  if (r.code !== 0 || !m) {
    rmSync(destDir, { recursive: true, force: true });
    throw new Error(`Extração recusada: ${r.out.slice(-300) || "falha desconhecida"}`);
  }
  return Number(m[1]);
}

function sha256Bytes(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * Pipeline do upload: assinatura PRIMEIRO, validação, extração p/ staging.
 * Qualquer falha apaga rastros e lança erro claro (nada fica semi-pronto).
 */
export async function stageUploadedZip(env: Env, bytes: Uint8Array, signatureText: string): Promise<{ version: string; dir: string; report: UploadReport }> {
  const pubkey = env.UPDATE_SIGNING_PUBLIC_KEY?.trim();
  if (!pubkey) {
    throw new Error("UPDATE_SIGNING_PUBLIC_KEY não configurada — recuso ZIP sem verificação de origem.");
  }
  const sig = signatureText.trim();
  if (!sig.includes("untrusted comment")) {
    throw new Error("Assinatura ausente/inválida: envie a assinatura minisign (.minisig) do ZIP.");
  }
  const hash = sha256Bytes(bytes);
  const { keynum } = verifyMinisign(bytes, sig, pubkey);
  const dir = updatesDir(env);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `tmp-upload-${Date.now()}-${Math.floor(Math.random() * 1e6)}.zip`);
  writeFileSync(tmp, bytes);
  try {
    const report = await validateUploadZip(env, tmp, bytes.length, hash);
    if (report.errors.length) {
      throw new Error(`ZIP rejeitado:\n- ${report.errors.slice(0, 12).join("\n- ")}`);
    }
    const stagePath = join(dir, `pending-${report.version}`);
    await extractZipSafe(tmp, stagePath);
    writeFileSync(join(stagePath, ".cr-ia-receipt.json"), JSON.stringify({
      version: report.version, sha256: hash, keynum, source: "upload",
      files: report.files, migrations: report.migrations,
      irreversibleDb: report.irreversibleDb, notes: report.notes,
      stagedAt: new Date().toISOString(),
    }, null, 2));
    appendHistory(env, { action: "upload-staged", version: report.version, files: report.files, ok: true });
    return { version: report.version, dir: stagePath, report };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Verificações do staging (obrigatórias antes de aprovar). */
export async function runStagingChecks(env: Env, version: string): Promise<StagingChecks> {
  const stagePath = join(updatesDir(env), `pending-${version}`);
  const checks: StagingChecks["checks"] = [];
  const receipt = join(stagePath, ".cr-ia-receipt.json");
  if (!existsSync(receipt)) {
    return { passed: false, checks: [{ name: "recibo", ok: false, detail: "Sem recibo de verificação." }], at: new Date().toISOString() };
  }
  const rec = JSON.parse(readFileSync(receipt, "utf8")) as { version?: string };
  const root = join(stagePath, "package.json");
  const sub = readdirSync(stagePath).find((d) => {
    try { return !d.startsWith(".") && existsSync(join(stagePath, d, "package.json")); } catch { return false; }
  });
  const appRoot = existsSync(root) ? stagePath : sub ? join(stagePath, sub) : null;
  checks.push({ name: "raiz-da-versão", ok: appRoot !== null, detail: appRoot ?? "package.json não encontrado no staging." });
  if (appRoot) {
    try {
      const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { version?: string };
      checks.push({
        name: "versão", ok: pkg.version === version && pkg.version === rec.version,
        detail: `staging=${pkg.version ?? "?"} recibo=${rec.version ?? "?"} instalada=${currentVersion()}`,
      });
    } catch {
      checks.push({ name: "versão", ok: false, detail: "package.json ilegível no staging." });
    }
    for (const req of ["docker-compose.yml", "apps/api/package.json"]) {
      const ok = existsSync(join(appRoot, req));
      checks.push({ name: `arquivo:${req}`, ok, detail: ok ? "presente" : "AUSENTE" });
    }
    const migDir = join(appRoot, "apps/api/migrations");
    try {
      const migs = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")) : [];
      const empty = migs.filter((f) => readFileSync(join(migDir, f), "utf8").trim().length === 0);
      checks.push({
        name: "migrations", ok: empty.length === 0,
        detail: migs.length ? `${migs.length} .sql${empty.length ? ` (${empty.length} VAZIOS)` : ""}` : "nenhuma (ok)",
      });
    } catch {
      checks.push({ name: "migrations", ok: false, detail: "pasta ilegível" });
    }
  }
  const passed = checks.every((c) => c.ok);
  const result: StagingChecks = { passed, checks, at: new Date().toISOString() };
  writeFileSync(join(stagePath, ".cr-ia-checks.json"), JSON.stringify(result, null, 2));
  appendHistory(env, { action: "staging-checks", version, ok: passed });
  return result;
}

/**
 * Testes completos no staging (opt-in via UPDATE_RUN_TESTS=true):
 * npm ci + suíte da API dentro da nova versão. Demorado (minutos).
 */
export async function runStagingTests(env: Env, version: string): Promise<{ ran: boolean; passed: boolean; tail: string }> {
  const stagePath = join(updatesDir(env), `pending-${version}`);
  if (!getBool({ env } as { env: Env }, "UPDATE_RUN_TESTS", false)) {
    return { ran: false, passed: false, tail: "UPDATE_RUN_TESTS não está ativado (verificações estáticas já aplicadas)." };
  }
  const receipt = join(stagePath, ".cr-ia-receipt.json");
  if (!existsSync(receipt)) throw new Error("Sem staging verificado para testar.");
  const root = existsSync(join(stagePath, "package.json")) ? stagePath : join(stagePath, readdirSync(stagePath).find((d) => !d.startsWith(".")) ?? "");
  const ci = await execAsync("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], root, 420_000);
  if (ci.code !== 0) {
    const tail = `npm ci falhou:\n${ci.out.slice(-2000)}`;
    appendHistory(env, { action: "staging-tests", version, ok: false, tail: tail.slice(-300) });
    return { ran: true, passed: false, tail };
  }
  const t = await execAsync("npm", ["run", "test:scripts"], root, 300_000);
  const tail = `${t.out.slice(-3000)}`;
  appendHistory(env, { action: "staging-tests", version, ok: t.code === 0, tail: tail.slice(-300) });
  return { ran: true, passed: t.code === 0, tail };
}

/**
 * Segredo HMAC que autentica os pedidos API → updater. Fail-closed: sem
 * segredo (mín. 16 chars), NADA é enfileirado. O updater rejeita pedidos
 * sem HMAC válido — upload/approve forjado nunca vira comando root.
 */
export function queueSecret(env: Env): string {
  const s = (env.UPDATER_QUEUE_SECRET ?? "").trim();
  if (s.length < 16) {
    throw new Error("UPDATER_QUEUE_SECRET não configurado (mín. 16 caracteres) — aprovação bloqueada.");
  }
  return s;
}

/**
 * SHA256 canônico da árvore do staging (caminhos ordenados, "rel\0size\0sha").
 * Symlink = erro (defesa em profundidade; a extração já bloqueia, mas o hash
 * garante que o updater aplica EXATAMENTE o que foi aprovado).
 */
export function hashStagedTree(dir: string): string {
  const entries: string[] = [];
  const walk = (d: string, base: string): void => {
    for (const n of readdirSync(d).sort()) {
      const full = join(d, n);
      const rel = base ? `${base}/${n}` : n;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new Error(`Staging inválido: symlink detectado (${rel}).`);
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) {
        entries.push(`${rel}\0${st.size}\0${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** JSON canônico (chaves ordenadas) para o HMAC do pedido. */
export function canonicalQueue(payload: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((k) => [k, payload[k]])));
}

export function signQueue(secret: string, payload: Record<string, unknown>): string {
  return createHmac("sha256", secret).update(canonicalQueue(payload)).digest("hex");
}

/** Aprovação humana: enfileira para o serviço updater (não aplica aqui). */
export async function approveStaged(env: Env, version: string, userId: string): Promise<{ version: string; queued: string }> {
  const stagePath = join(updatesDir(env), `pending-${version}`);
  const receipt = join(stagePath, ".cr-ia-receipt.json");
  if (!existsSync(receipt)) throw new Error(`Versão ${version} não está preparada/verificada.`);
  const checksPath = join(stagePath, ".cr-ia-checks.json");
  if (!existsSync(checksPath)) throw new Error("Rode as verificações do staging antes de aprovar.");
  const checks = JSON.parse(readFileSync(checksPath, "utf8")) as StagingChecks;
  if (!checks.passed) throw new Error("Verificações do staging FALHARAM — aprovação recusada.");
  if (compareVersions(version, currentVersion()) <= 0) {
    throw new Error(`Versão ${version} não é mais nova que a instalada.`);
  }
  const sha = hashStagedTree(stagePath);
  const payload = { kind: "approved", version, stagedDir: stagePath, sha, by: userId, at: new Date().toISOString() };
  const queue = join(updatesDir(env), "queue");
  mkdirSync(queue, { recursive: true });
  const name = `approved-${version}-${Date.now()}.json`;
  writeFileSync(join(queue, name), JSON.stringify({ ...payload, hmac: signQueue(queueSecret(env), payload) }, null, 2));
  appendHistory(env, { action: "approved", version, by: userId });
  return { version, queued: name };
}

export interface ReleaseInfo { name: string; version: string; at: string; kind: "current" | "previous" | "pre-rollback" }

/** Releases guardados (snapshots p/ rollback). */
export function listReleases(env: Env): ReleaseInfo[] {
  const rel = join(updatesDir(env), "releases");
  if (!existsSync(rel)) return [];
  const out: ReleaseInfo[] = [];
  for (const d of readdirSync(rel)) {
    const meta = join(rel, d, ".cr-ia-release.json");
    if (!existsSync(meta)) continue;
    try {
      const m = JSON.parse(readFileSync(meta, "utf8")) as { version?: string; at?: string; kind?: ReleaseInfo["kind"] };
      out.push({ name: d, version: m.version ?? "?", at: m.at ?? "?", kind: m.kind ?? "previous" });
    } catch { /* ignora corrompido */ }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/** Pede reversão: enfileira para o updater (com aviso de banco irreversível). */
export function requestRollback(env: Env, target: string, userId: string): { target: string; queued: string; dbWarning: boolean } {
  if (!/^[\w][\w.\-]*$/.test(target)) throw new Error("Alvo de rollback inválido.");
  const meta = join(updatesDir(env), "releases", target, ".cr-ia-release.json");
  if (!existsSync(meta)) throw new Error(`Release ${target} não encontrado.`);
  const m = JSON.parse(readFileSync(meta, "utf8")) as { irreversibleDb?: boolean; version?: string };
  const queue = join(updatesDir(env), "queue");
  mkdirSync(queue, { recursive: true });
  const payload = { kind: "rollback", target, by: userId, at: new Date().toISOString() };
  const name = `rollback-${Date.now()}.json`;
  writeFileSync(join(queue, name), JSON.stringify({ ...payload, hmac: signQueue(queueSecret(env), payload) }, null, 2));
  appendHistory(env, { action: "rollback-requested", target, by: userId });
  return { target, queued: name, dbWarning: m.irreversibleDb === true };
}

/** Histórico (linhas JSON mais recentes primeiro). */
export function readHistory(env: Env, limit = 100): Array<Record<string, unknown>> {
  const p = join(updatesDir(env), "history.jsonl");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-limit);
  const out: Array<Record<string, unknown>> = [];
  for (const l of lines.reverse()) {
    try { out.push(JSON.parse(l) as Record<string, unknown>); } catch { /* pula */ }
  }
  return out;
}
