/**
 * Cofre de credenciais — AES-256-GCM via WebCrypto (Node 20 + Workers).
 * Chaves de provedores pagos ficam cifradas no banco (settings `cred.*`).
 * Formato: "v1:<saltB64>:<ivB64>:<ctB64>" (PBKDF2-SHA256, 100k iterações).
 */
import type { Env } from "../types.js";

const PREFIX = "v1";
const ITERATIONS = 100_000;

function b64e(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64d(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function vaultSecret(env: Env): string {
  const s = (env.CREDENTIALS_SECRET ?? "").trim();
  if (s.length < 32) {
    throw new Error(
      "CREDENTIALS_SECRET ausente ou fraco: defina 32+ caracteres no .env para guardar chaves de API no painel."
    );
  }
  return s;
}

/** Cifra um segredo (ex.: chave de API) para persistir no banco. */
export async function sealSecret(secret: string, plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("Nada para cifrar.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(secret, salt);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext))
  );
  return `${PREFIX}:${b64e(salt)}:${b64e(iv)}:${b64e(ct)}`;
}

/** Decifra um valor do cofre. Falha (erro) se adulterado ou segredo errado. */
export async function openSecret(secret: string, packed: string): Promise<string> {
  const parts = packed.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Formato de segredo inválido.");
  const key = await deriveKey(secret, b64d(parts[1]));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64d(parts[2]) as BufferSource },
      key,
      b64d(parts[3]) as BufferSource
    );
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("Não foi possível decifrar a credencial (segredo errado ou dado adulterado).");
  }
}

/** "sk-abc...xyz" — nunca exponha a chave inteira em logs/respostas. */
export function maskKey(key: string): string {
  const k = key.trim();
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 3)}••••${k.slice(-4)}`;
}
