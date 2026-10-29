#!/usr/bin/env node
/**
 * CR IA: utiliza a CLI Minisign OFICIAL para criação de chaves e assinatura.
 * Chaves privadas são geradas e utilizadas exclusivamente na máquina do dono.
 * Os ZIPs levam assinaturas oficiais de quatro linhas (com comentário assinado).
 * Uso:
 *  node scripts/sign-release.mjs genkey --name cr-ia-release --out ~/seguro
 *  node scripts/sign-release.mjs sign --key ~/seguro/cr-ia-release.key --file ./release.zip
 *  node scripts/sign-release.mjs verify --pub ~/seguro/cr-ia-release.pub --file ./release.zip --sig ./release.zip.minisig
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

const usage = () => {
  console.error('Uso: sign-release.mjs genkey --name <nome> --out <pasta> | sign --key <.key> --file <zip> [--out <.minisig>] | verify --pub <.pub> --file <zip> --sig <.minisig>');
  process.exit(2);
};
const arg = (n, optional = false) => {
  const i = process.argv.indexOf('--' + n);
  if (i < 0 || !process.argv[i + 1]) return optional ? '' : usage();
  return process.argv[i + 1];
};
function minisign(args) {
  const result = spawnSync('minisign', args, { stdio: 'inherit' });
  if (result.error) {
    console.error('ERRO: instale Minisign oficial (sudo apt-get install minisign):', result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}
const cmd = process.argv[2];
if (cmd === 'genkey') {
  const name = arg('name');
  const out = arg('out');
  if (!/^[\w][\w.-]*$/.test(name)) usage();
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const pub = join(out, name + '.pub');
  const secret = join(out, name + '.key');
  if (existsSync(pub) || existsSync(secret)) {
    console.error('ERRO: chave existente. Nunca sobrescreva uma chave privada.');
    process.exit(1);
  }
  minisign(['-G', '-p', pub, '-s', secret]);
  chmodSync(secret, 0o600);
  console.log('Chave pública:', pub);
  console.log('Chave PRIVADA (não envie, guarde offline):', secret);
  console.log('UPDATE_SIGNING_PUBLIC_KEY=' + readFileSync(pub, 'utf8').trim().split(/\r?\n/)[1]);
} else if (cmd === 'sign') {
  const key = arg('key'); const file = arg('file');
  const out = arg('out', true) || file + '.minisig';
  if (existsSync(out)) { console.error('ERRO: assinatura já existe; recuso sobrescrever.'); process.exit(1); }
  minisign(['-S', '-m', file, '-s', key, '-x', out]);
  console.log('Assinatura oficial de 4 linhas criada:', out);
} else if (cmd === 'verify') {
  minisign(['-V', '-m', arg('file'), '-p', arg('pub'), '-x', arg('sig')]);
} else usage();
