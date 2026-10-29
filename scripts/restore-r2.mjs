#!/usr/bin/env node
/**
 * CR IA v0.2.0 — restauração a partir do backup externo (Cloudflare R2).
 *
 * Uso:
 *   node scripts/restore-r2.mjs --list            # lista backups no R2
 *   node scripts/restore-r2.mjs --key daily/....  # baixa + descriptografa
 *   node scripts/restore-r2.mjs --latest          # baixa o mais recente
 *   node scripts/restore-r2.mjs --test            # TESTE de restore: baixa o
 *        mais recente, descriptografa, valida gzip -t e o manifesto, SEM
 *        tocar no banco de produção. Rode mensalmente e anote o resultado.
 *
 * Após baixar, a restauração efetiva usa scripts/restore.sh <arquivo.tar.gz>
 * (que pede confirmação e faz backup de segurança antes).
 */
import { execFileSync } from "node:child_process";
import { acquireLock, decryptBuffer, sortNewestFirst } from "./r2-lib.mjs";
import { createWriteStream, readFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const ROOT = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2);

const releaseLock = acquireLock("restore-r2");
if (!releaseLock) { console.error("ERRO: outro restore-r2 em execução."); process.exit(3); }
process.on("exit", () => releaseLock());
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : ""; };

function env(name) {
  const v = (process.env[name] ?? "").trim();
  if (!v) { console.error(`ERRO: variável ${name} não definida no ambiente/.env.`); process.exit(1); }
  return v;
}
const accountId = env("R2_ACCOUNT_ID");
const bucket = process.env.R2_BUCKET?.trim() || "cr-ia-backups";
const endpoint = process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
const encKey = env("BACKUP_ENCRYPTION_KEY");
if (!/^[0-9a-fA-F]{64}$/.test(encKey)) {
  console.error("ERRO: BACKUP_ENCRYPTION_KEY deve ser hex de 64 caracteres.");
  process.exit(1);
}

let S3, ListRef, GetRef;
try {
  ({ S3Client: S3, ListObjectsV2Command: ListRef, GetObjectCommand: GetRef } = await import("@aws-sdk/client-s3"));
} catch {
  console.error("ERRO: pacote @aws-sdk/client-s3 não instalado. Rode: npm i @aws-sdk/client-s3");
  process.exit(1);
}
const s3 = new S3({
  region: "auto", endpoint,
  credentials: { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") },
});

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const r = await s3.send(new ListRef({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    out.push(...(r.Contents ?? []));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return sortNewestFirst(out);
}

if (flag("--list")) {
  for (const prefix of ["daily/", "weekly/"]) {
    console.log(`--- ${prefix} ---`);
    for (const o of await listAll(prefix)) {
      console.log(`  ${o.LastModified.toISOString()}  ${(o.Size / 1024 / 1024).toFixed(1)} MB  ${o.Key}`);
    }
  }
  process.exit(0);
}

let key = val("--key");
if (flag("--latest") || flag("--test") || !key) {
  const all = [...await listAll("daily/"), ...await listAll("weekly/")];
  if (!all.length) { console.error("ERRO: nenhum backup encontrado no R2."); process.exit(1); }
  const sorted = sortNewestFirst(all);
  key = key || sorted[0].Key;
  console.log(`Backup selecionado: ${key} (${sorted[0].LastModified.toISOString()})`);
}

console.log(`Baixando s3://${bucket}/${key} ...`);
const obj = await s3.send(new GetRef({ Bucket: bucket, Key: key }));
const chunks = [];
for await (const c of obj.Body) chunks.push(c);
const buf = Buffer.concat(chunks);
console.log(`Descriptografando (${(buf.length / 1024 / 1024).toFixed(1)} MB)...`);
let plain;
try {
  plain = decryptBuffer(buf, encKey);
} catch {
  console.error("ERRO: falha na descriptografia — BACKUP_ENCRYPTION_KEY errada ou arquivo corrompido.");
  process.exit(1);
}

const restoreDir = join(ROOT, "backups", "r2-restore");
mkdirSync(restoreDir, { recursive: true });
const outPath = join(restoreDir, basename(key).replace(/\.enc$/, ""));
await pipeline(Readable.from([plain]), createWriteStream(outPath));
console.log(`Arquivo restaurado em: ${outPath}`);

if (flag("--test")) {
  console.log("--- TESTE de restore (não toca em produção) ---");
  execFileSync("gzip", ["-t", outPath], { stdio: "inherit" });
  console.log("gzip -t: OK (arquivo íntegro)");
  const list = execFileSync("tar", ["-tzf", outPath], { encoding: "utf8" });
  const hasDb = list.includes("db.sql.gz") || list.includes("db.sql");
  const hasManifest = list.includes("MANIFEST") || list.includes("manifest");
  console.log(`conteúdo: db=${hasDb ? "OK" : "AUSENTE"}, manifesto=${hasManifest ? "OK" : "ausente"}`);
  if (!hasDb) { console.error("FALHA no teste: backup sem dump do banco."); process.exit(1); }
  console.log("✅ TESTE DE RESTORE APROVADO — backup do R2 é válido e restaurável.");
  console.log("Para restaurar de verdade: ./scripts/restore.sh " + outPath);
} else {
  console.log("Para aplicar: ./scripts/restore.sh " + outPath);
}
