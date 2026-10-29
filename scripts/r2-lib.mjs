#!/usr/bin/env node
/**
 * CR IA — funções compartilhadas dos scripts R2 (backup-r2/restore-r2).
 * Separadas aqui para serem TESTÁVEIS (node --test scripts/).
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Domingo = semanal (UTC), demais dias = diário. */
export function weeklyOrDaily(date = new Date()) {
  return date.getUTCDay() === 0 ? "weekly" : "daily";
}

/** Nome da chave no bucket: daily/cr-ia-backup-AAAA-MM-DD.tar.gz.enc */
export function backupKeyName(date, kind) {
  return `${kind}/cr-ia-backup-${date.toISOString().slice(0, 10)}.tar.gz.enc`;
}

/** Ordena do mais novo ao mais antigo (sem data = mais antigo). */
export function sortNewestFirst(objects) {
  const ts = (o) => {
    const d = o?.LastModified;
    if (d instanceof Date) return d.getTime();
    if (typeof d === "string" || typeof d === "number") {
      const t = new Date(d).getTime();
      return Number.isFinite(t) ? t : 0;
    }
    return 0;
  };
  return [...objects].sort((a, b) => ts(b) - ts(a));
}

/**
 * Quais objetos APAGAR pela retenção: ordena por data (mais novos primeiro)
 * e devolve o que passar de `keep`.
 */
export function selectForDeletion(objects, keep) {
  return sortNewestFirst(objects).slice(keep);
}

/** Criptografa (AES-256-GCM). Formato: IV 12B || ciphertext || tag 16B. */
export function encryptBuffer(plain, keyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]);
}

/** Descriptografa o formato acima. Lança erro se chave errada/tamper. */
export function decryptBuffer(enc, keyHex) {
  const buf = Buffer.from(enc);
  if (buf.length < 29) throw new Error("arquivo criptografado curto demais.");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
}

/**
 * Trava entre execuções (lockdir atômico + pid). Devolve release(), ou null
 * se outro processo VIVO detém a trava. Trava de processo morto é re-colhida.
 */
export function acquireLock(name) {
  const dir = join(tmpdir(), `cr-ia-${name}.lockdir`);
  const pidFile = join(dir, "pid");
  const mine = String(process.pid);
  const take = () => { mkdirSync(dir); writeFileSync(pidFile, mine); };
  try {
    take();
  } catch {
    let owner = 0;
    try { owner = Number(readFileSync(pidFile, "utf8").trim()); } catch { owner = 0; }
    let alive = false;
    if (owner > 0 && owner !== process.pid) {
      try { process.kill(owner, 0); alive = true; } catch { alive = false; }
    }
    if (alive) return null; // outro processo vivo: não entra
    rmSync(dir, { recursive: true, force: true }); // dono morto/corrompido: re-colhe
    take();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(pidFile, "utf8").trim() === mine) rmSync(dir, { recursive: true, force: true });
    } catch { /* já removida */ }
  };
}
