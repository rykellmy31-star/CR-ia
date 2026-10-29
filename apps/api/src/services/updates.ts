/**
 * CR IA — Central de Atualizações (item 4).
 *
 * Fluxo: VERIFICAR (manifesto) → BAIXAR (zip) → CONFERIR (sha256 + assinatura
 * minisign) → PREPARAR (extrai p/ staging) → APLICAR (só com aprovação humana
 * explícita, via scripts/update.sh --zip, que faz backup antes).
 *
 * Segurança: ZIP sem sha256 correspondente ou sem assinatura válida é
 * RECUSADO (fail-closed). Nunca executa nada baixado antes de conferir.
 * Serviço restrito: rotas só de admin; worker só VERIFICA (nunca aplica).
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Env } from "../types.js";
import { redactSecrets } from "../lib/redact.js";

export interface UpdateManifest {
  version: string;
  notes?: string;
  zipUrl: string;
  sha256: string;
  /** Assinatura minisign oficial completa (4 linhas) do ZIP. */
  signature: string;
}

export interface UpdateStatus {
  configured: boolean;
  current: string;
  latest: string | null;
  notes: string | null;
  updateAvailable: boolean;
  staged: string | null;
  checkedAt: string | null;
  error: string | null;
}

/** Versão instalada (lida do package.json da API). */
export function currentVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Compara versões "a.b.c" (numérico por parte; sufixo ignorado). >0 se a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function updatesDir(env: Env): string {
  return env.UPDATES_DIR?.trim() || "/tmp/cr-ia-updates";
}

/**
 * Verifica um arquivo .minisig OFICIAL (4 linhas) com Node/Ed25519.
 * Para 'ED' verifica o BLAKE2b-512 dos dados (padrão minisign);
 * para 'Ed' aceita a variante legacy sem prehash.
 * Obrigatório verificar AMBAS as assinaturas: conteúdo e comentário confiável.
 * Nunca aceita o antigo formato parcial de duas linhas.
 */
export function verifyMinisign(data: Uint8Array, signatureText: string, publicKeyText: string): { keynum: string } {
  const lines = signatureText.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const pubLines = publicKeyText.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines.length !== 4 || !lines[0].startsWith("untrusted comment: ") ||
      !lines[2].startsWith("trusted comment: ") || lines[2].length > 8190) {
    throw new Error("Assinatura minisign incompleta/inválida: exigido formato oficial de 4 linhas.");
  }
  const b64 = (value: string, length: number): Buffer => {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Assinatura/chave com base64 inválido.");
    const decoded = Buffer.from(value, "base64");
    if (decoded.length !== length || decoded.toString("base64") !== value) {
      throw new Error("Assinatura/chave malformada.");
    }
    return decoded;
  };
  const sigRaw = b64(lines[1], 74);
  const globalSig = b64(lines[3], 64);
  const pubRaw = b64(pubLines.length === 1 ? pubLines[0] : pubLines.length === 2 && pubLines[0].startsWith("untrusted comment: ") ? pubLines[1] : "", 42);
  const algo = sigRaw.subarray(0, 2).toString("ascii");
  if (!(["ED", "Ed"].includes(algo)) || pubRaw.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error("Assinatura/chave minisign inválida (magic). ");
  }
  const keynum = sigRaw.subarray(2, 10);
  if (!keynum.equals(pubRaw.subarray(2, 10))) {
    throw new Error("Assinatura feita por outra chave (keynum divergente) — RECUSADA.");
  }
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw.subarray(10, 42)]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  const message = algo === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
  if (!verify(null, message, key, sigRaw.subarray(10, 74))) {
    throw new Error("Assinatura INVÁLIDA — conteúdo alterado ou assinatura incorreta.");
  }
  // A assinatura global cobre os 64 bytes da assinatura principal + o TEXTO
  // do comentário confiável, sem o prefixo "trusted comment: ".
  const trustedText = Buffer.from(lines[2].slice("trusted comment: ".length), "utf8");
  const globalMessage = Buffer.concat([sigRaw.subarray(10, 74), trustedText]);
  if (!verify(null, globalMessage, key, globalSig)) {
    throw new Error("Assinatura global INVÁLIDA — comentário confiável adulterado.");
  }
  return { keynum: keynum.toString("hex") };
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

function historyPath(env: Env): string {
  return join(updatesDir(env), "history.jsonl");
}

export function appendHistory(env: Env, entry: Record<string, unknown>): void {
  try {
    mkdirSync(updatesDir(env), { recursive: true });
    // Histórico pode conter caudas de log: redact antes de gravar (§11).
    const line = redactSecrets(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
    appendFileSync(historyPath(env), line + "\n");
  } catch {
    // Histórico é auditoria best-effort; nunca quebra o fluxo.
  }
}

function parseManifest(json: unknown): UpdateManifest {
  const m = json as Record<string, unknown>;
  const version = String(m?.version ?? "").trim();
  const zipUrl = String(m?.zipUrl ?? "").trim();
  const sha256 = String(m?.sha256 ?? "").trim().toLowerCase();
  const signature = String(m?.signature ?? "");
  if (!version) throw new Error("Manifesto sem version.");
  if (!/^https?:\/\//.test(zipUrl)) throw new Error("Manifesto com zipUrl inválida (só http/https).");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Manifesto sem sha256 válido.");
  if (!signature.includes("untrusted comment")) throw new Error("Manifesto sem assinatura minisign.");
  return { version, notes: String(m?.notes ?? "") || undefined, zipUrl, sha256, signature };
}

/** Baixa e valida o manifesto (sem baixar o ZIP). */
export async function fetchManifest(url: string, fetchImpl: FetchImpl = fetch): Promise<UpdateManifest> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`manifesto HTTP ${res.status}`);
    return parseManifest(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

/** Lê o último status verificado (cache em disco) + dir de staging atual. */
export function readCachedStatus(env: Env): { latest: string | null; notes: string | null; checkedAt: string | null; staged: string | null; error: string | null } {
  const dir = updatesDir(env);
  let cached: { latest?: string; notes?: string; checkedAt?: string; error?: string } = {};
  try {
    const raw = readFileSync(join(dir, "last-check.json"), "utf8");
    cached = JSON.parse(raw) as typeof cached;
  } catch { /* sem cache ainda */ }
  let staged: string | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith("pending-") && existsSync(join(dir, f, ".cr-ia-receipt.json"))) {
        staged = f.slice("pending-".length);
      }
    }
  } catch { /* sem dir ainda */ }
  return {
    latest: cached.latest ?? null, notes: cached.notes ?? null,
    checkedAt: cached.checkedAt ?? null, staged, error: cached.error ?? null,
  };
}

/**
 * Verifica o manifesto remoto (NÃO baixa nem aplica nada).
 * Grava cache last-check.json p/ o worker/UI consultarem.
 */
export async function checkForUpdates(env: Env, fetchImpl: FetchImpl = fetch): Promise<UpdateStatus> {
  const current = currentVersion();
  const base = { configured: false, current, latest: null as string | null, notes: null as string | null, updateAvailable: false, staged: null as string | null, checkedAt: null as string | null, error: null as string | null };
  const url = env.UPDATES_MANIFEST_URL?.trim();
  if (!url) return { ...base, ...readCachedStatus(env), configured: false };
  if (!/^https?:\/\//.test(url)) {
    return { ...base, ...readCachedStatus(env), configured: true, error: "UPDATES_MANIFEST_URL inválida (só http/https)." };
  }
  try {
    const manifest = await fetchManifest(url, fetchImpl);
    const cache = { latest: manifest.version, notes: manifest.notes ?? null, checkedAt: new Date().toISOString(), error: null as string | null };
    mkdirSync(updatesDir(env), { recursive: true });
    writeFileSync(join(updatesDir(env), "last-check.json"), JSON.stringify(cache));
    appendHistory(env, { action: "check", latest: manifest.version });
    const cached = readCachedStatus(env);
    return {
      configured: true, current, latest: manifest.version, notes: manifest.notes ?? null,
      updateAvailable: compareVersions(manifest.version, current) > 0,
      staged: cached.staged, checkedAt: cache.checkedAt, error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "erro";
    return { ...base, ...readCachedStatus(env), configured: true, error: `Falha ao verificar: ${msg}` };
  }
}

function execFileAsync(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`;
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, out });
    });
  });
}

/**
 * Baixa o ZIP da versão, confere sha256 + assinatura e extrai p/ staging.
 * Recusa (apaga o baixado) em qualquer divergência. NÃO aplica nada.
 */
export async function stageUpdate(env: Env, manifest: UpdateManifest, fetchImpl: FetchImpl = fetch): Promise<{ version: string; dir: string }> {
  const pubkey = env.UPDATE_SIGNING_PUBLIC_KEY?.trim();
  if (!pubkey) throw new Error("UPDATE_SIGNING_PUBLIC_KEY não configurada — recuso baixar atualização sem chave de verificação.");
  const dir = updatesDir(env);
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, `pending-${manifest.version}.zip`);
  const stagePath = join(dir, `pending-${manifest.version}`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  let bytes: Uint8Array;
  try {
    const res = await fetchImpl(manifest.zipUrl, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
  if (bytes.length > 500 * 1024 * 1024) throw new Error("ZIP grande demais (>500MB) — recusado.");
  const hash = sha256Hex(bytes);
  if (hash !== manifest.sha256) throw new Error(`sha256 DIVERGE (manifesto=${manifest.sha256.slice(0, 16)}… baixado=${hash.slice(0, 16)}…) — arquivo recusado.`);
  const { keynum } = verifyMinisign(bytes, manifest.signature, pubkey);

  writeFileSync(zipPath, bytes);
  // Extrai: prefere `unzip`, cai para python3 (presente em todo Ubuntu).
  const { rmSync } = await import("node:fs");
  rmSync(stagePath, { recursive: true, force: true });
  mkdirSync(stagePath, { recursive: true });
  let r = await execFileAsync("unzip", ["-q", zipPath, "-d", stagePath], dir, 120_000);
  if (r.code !== 0) {
    r = await execFileAsync("python3", ["-m", "zipfile", "-e", zipPath, stagePath], dir, 180_000);
  }
  if (r.code !== 0) {
    rmSync(zipPath, { force: true });
    rmSync(stagePath, { recursive: true, force: true });
    throw new Error(`ZIP não extraiu (unzip/python3 falharam): ${r.out.slice(-300)}`);
  }
  // Normaliza: se o zip tem pasta única no topo (ex.: cr-ia/...), usa ela.
  let finalDir = stagePath;
  const top = readdirSync(stagePath);
  if (top.length === 1) {
    const only = join(stagePath, top[0]);
    try {
      const st = await import("node:fs").then((m) => m.statSync(only));
      if (st.isDirectory()) finalDir = only;
    } catch { /* segue com stagePath */ }
  }
  writeFileSync(join(stagePath, ".cr-ia-receipt.json"), JSON.stringify({
    version: manifest.version, sha256: manifest.sha256, keynum,
    stagedAt: new Date().toISOString(),
  }, null, 2));
  appendHistory(env, { action: "stage", version: manifest.version, ok: true });
  return { version: manifest.version, dir: finalDir };
}

/**
 * Aplica versão preparada (staging com recibo). Roda scripts/update.sh --zip
 * (que faz backup ANTES). Operação restrita: só via rota admin + aprovação
 * humana explícita na UI.
 */
export async function applyStaged(env: Env, version: string): Promise<{ version: string; log: string }> {
  const stagePath = join(updatesDir(env), `pending-${version}`);
  const receipt = join(stagePath, ".cr-ia-receipt.json");
  if (!existsSync(receipt)) {
    throw new Error(`Versão ${version} NÃO está preparada/verificada (sem recibo) — recuso aplicar.`);
  }
  const root = new URL("../../../..", import.meta.url).pathname;
  const script = join(root, "scripts", "update.sh");
  if (!existsSync(script)) throw new Error("scripts/update.sh não encontrado.");
  appendHistory(env, { action: "apply-start", version });
  const r = await execFileAsync("bash", [script, "--zip", stagePath], root, 1_200_000);
  appendHistory(env, { action: "apply-finish", version, ok: r.code === 0, tail: r.out.slice(-500) });
  if (r.code !== 0) throw new Error(`Aplicação falhou (exit ${r.code}):\n${r.out.slice(-2000)}`);
  return { version, log: r.out.slice(-4000) };
}
