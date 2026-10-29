#!/usr/bin/env node
/**
 * CR IA v0.2.0 — backup externo criptografado para Cloudflare R2.
 *
 * 1. Gera backup local (db + arquivos) via scripts/backup.sh
 * 2. Criptografa com AES-256-GCM (BACKUP_ENCRYPTION_KEY, hex 64 chars)
 * 3. Envia ao bucket R2 com retenção diária/semanal
 *
 * Uso:
 *   node scripts/backup-r2.mjs            # backup agora
 *   node scripts/backup-r2.mjs --dry-run  # só valida config + local
 *
 * Requer no .env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET, BACKUP_ENCRYPTION_KEY. Dependência: npm i @aws-sdk/client-s3
 * (R2 é compatível com S3). Sem as variáveis, sai com erro explicativo.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import {
  acquireLock, backupKeyName, encryptBuffer, selectForDeletion, weeklyOrDaily,
} from "./r2-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DRY = process.argv.includes("--dry-run");

// Trava entre execuções (dois backups juntos corromperiam a retenção).
const releaseLock = acquireLock("backup-r2");
if (!releaseLock) { console.error("ERRO: outro backup-r2 em execução."); process.exit(3); }
process.on("exit", () => releaseLock());

function env(name, { required = false } = {}) {
  const v = (process.env[name] ?? "").trim();
  if (required && !v) {
    console.error(`ERRO: variável ${name} não definida no ambiente/.env.`);
    process.exit(1);
  }
  return v;
}

const cfg = {
  accountId: env("R2_ACCOUNT_ID", { required: !DRY }),
  accessKey: env("R2_ACCESS_KEY_ID", { required: !DRY }),
  secretKey: env("R2_SECRET_ACCESS_KEY", { required: !DRY }),
  bucket: process.env.R2_BUCKET?.trim() || "cr-ia-backups",
  endpoint: process.env.R2_ENDPOINT?.trim() || "",
  encKey: env("BACKUP_ENCRYPTION_KEY", { required: !DRY }),
  retentionDaily: Number(process.env.BACKUP_RETENTION_DAILY || 7),
  retentionWeekly: Number(process.env.BACKUP_RETENTION_WEEKLY || 4),
};
if (!DRY && !/^[0-9a-fA-F]{64}$/.test(cfg.encKey)) {
  console.error("ERRO: BACKUP_ENCRYPTION_KEY deve ser hex de 64 caracteres (openssl rand -hex 32).");
  process.exit(1);
}
if (!cfg.endpoint) cfg.endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;

console.log("=== CR IA — backup externo R2 ===");

// 1. Backup local
console.log("[1/4] Gerando backup local...");
execFileSync("bash", [join(ROOT, "scripts/backup.sh")], { cwd: ROOT, stdio: "inherit" });
const backupDir = join(ROOT, "backups");
const latest = readdirSync(backupDir)
  .filter((f) => f.endsWith(".tar.gz") && !f.endsWith(".enc"))
  .map((f) => ({ f, t: statSync(join(backupDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0];
if (!latest) { console.error("ERRO: backup.sh não gerou nenhum .tar.gz em backups/."); process.exit(1); }
const plainPath = join(backupDir, latest.f);
console.log(`      base: ${latest.f} (${(statSync(plainPath).size / 1024 / 1024).toFixed(1)} MB)`);

// 2. Criptografia AES-256-GCM (formato: IV 12B || ciphertext || tag 16B)
const encPath = `${plainPath}.enc`;
console.log("[2/4] Criptografando (AES-256-GCM)...");
writeFileSync(encPath, encryptBuffer(readFileSync(plainPath), cfg.encKey || "0".repeat(64)));

console.log(`      criptografado: ${basename(encPath)}`);
if (DRY) { console.log("--dry-run: parando antes do upload. Remova .enc se quiser."); process.exit(0); }

// 3. Upload S3-compatível (R2)
console.log("[3/4] Enviando ao R2...");
let S3, PutObjectCommand, ListRef, DelRef;
try {
  ({ S3Client: S3, PutObjectCommand, ListObjectsV2Command: ListRef, DeleteObjectCommand: DelRef } = await import("@aws-sdk/client-s3"));
} catch {
  console.error("ERRO: pacote @aws-sdk/client-s3 não instalado. Rode: npm i @aws-sdk/client-s3");
  process.exit(1);
}
const s3 = new S3({
  region: "auto",
  endpoint: cfg.endpoint,
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
});
const now = new Date();
const key = backupKeyName(now, weeklyOrDaily(now));
{
  await s3.send(new PutObjectCommand({
    Bucket: cfg.bucket, Key: key, Body: readFileSync(encPath),
    ContentType: "application/octet-stream",
    Metadata: { created: now.toISOString(), tool: "cr-ia-backup-r2", version: "0.2.0" },
  }));
}
console.log(`      enviado: s3://${cfg.bucket}/${key}`);

// 4. Retenção (mantém N diários + M semanais mais recentes)
console.log("[4/4] Aplicando retenção...");
for (const [prefix, keep] of [["daily/", cfg.retentionDaily], ["weekly/", cfg.retentionWeekly]]) {
  const listed = await s3.send(new ListRef({ Bucket: cfg.bucket, Prefix: prefix }));
  for (const o of selectForDeletion(listed.Contents ?? [], keep)) {
    await s3.send(new DelRef({ Bucket: cfg.bucket, Key: o.Key }));
    console.log(`      removido antigo: ${o.Key}`);
  }
}

// Limpeza: remove .enc local (o .tar.gz local fica para restore rápido)
unlinkSync(encPath);
console.log("✅ Backup externo concluído. Teste a restauração com: node scripts/restore-r2.mjs --list");
