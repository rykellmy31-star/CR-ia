/**
 * Helper de testes: gera ZIPs + assinaturas minisign (ed25519 real).
 * Não é teste (sem .test. no nome) — só utilidades.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export function minisignFor(data: Uint8Array): { pub: string; sig: string } {
  const key = createMinisignKey();
  return { pub: key.pub, sig: key.sign(data) };
}

/** Par Minisign reutilizável com assinatura ED prehashed e comentário assinado. */
export function createMinisignKey(): { pub: string; sign(data: Uint8Array): string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keynum = randomBytes(8);
  const pub = "untrusted comment: test key\n" + Buffer.concat([Buffer.from("Ed"), keynum, pubRaw]).toString("base64");
  return {
    pub,
    sign(data: Uint8Array): string {
      const checksum = createHash("blake2b512").update(data).digest();
      const sig = sign(null, checksum, privateKey);
      const sigRaw = Buffer.concat([Buffer.from("ED"), keynum, sig]);
      const trusted = "fixture: CR IA";
      const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
      return `untrusted comment: test signature\n${sigRaw.toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
    },
  };
}

/** Cria um ZIP real via python3 (preserva pastas) de {nomeNoZip: conteúdo}. */
export function makeZip(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "cr-ia-zipfix-"));
  const src = join(dir, "src");
  for (const [name, content] of Object.entries(files)) {
    const full = join(src, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  const script = join(dir, "mk.py");
  const out = join(dir, "out.zip");
  writeFileSync(script, `
import zipfile, os
z = zipfile.ZipFile(${JSON.stringify(out)}, "w", zipfile.ZIP_DEFLATED)
for root, _dirs, files in os.walk(${JSON.stringify(src)}):
    for f in files:
        full = os.path.join(root, f)
        z.write(full, os.path.relpath(full, ${JSON.stringify(src)}))
z.close()
`);
  execFileSync("python3", [script]);
  return readFileSync(out);
}

/** Cria um ZIP com entrada maliciosa (nome arbitrário, ex.: ../escape). */
export function makeZipRaw(entries: Array<{ name: string; content: string; symlink?: boolean }>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "cr-ia-zipraw-"));
  const script = join(dir, "mk.py");
  const payload = join(dir, "payload.json");
  writeFileSync(payload, JSON.stringify(entries));
  writeFileSync(script, `
import zipfile, json, stat
entries = json.load(open(${JSON.stringify(payload)}))
out = ${JSON.stringify(join(dir, "out.zip"))}
z = zipfile.ZipFile(out, "w")
for e in entries:
    zi = zipfile.ZipInfo(e["name"])
    if e.get("symlink"):
        zi.external_attr = (stat.S_IFLNK | 0o777) << 16
    z.writestr(zi, e["content"])
z.close()
`);
  execFileSync("python3", [script]);
  return readFileSync(join(dir, "out.zip"));
}
