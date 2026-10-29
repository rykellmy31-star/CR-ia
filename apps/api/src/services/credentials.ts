/**
 * Credenciais de provedores por chave — env (VPS) ou cofre cifrado (painel).
 * Precedência: variável de ambiente > settings `cred.<provider>` (AES-GCM).
 * Chaves NUNCA retornam inteiras: só máscara para exibição.
 * Cobre: 6 pagos (KeyedProvider) + 2 grátis (FreeKeyedProvider) + busca.
 */
import type { Env } from "../types.js";
import type { DbAdapter } from "../adapters/db/types.js";
import {
  FREE_PROVIDER_DEFAULTS, PROVIDER_DEFAULTS, type FreeKeyedProvider, type KeyedProvider,
} from "../adapters/ai/providers.js";
import { maskKey, openSecret, sealSecret, vaultSecret } from "../lib/vault.js";

/** Qualquer provedor de IA por chave (pago ou grátis). */
export type AnyKeyedProvider = KeyedProvider | FreeKeyedProvider;
export type KeySource = (provider: AnyKeyedProvider) => Promise<string>;

/** Provedores de BUSCA por chave (Fase 3) — mesmo cofre, outro namespace. */
export type SearchCredProvider = "brave" | "tavily" | "google-pse";
export const SEARCH_CRED_PROVIDERS: SearchCredProvider[] = ["brave", "tavily", "google-pse"];

export function isSearchCred(p: string): p is SearchCredProvider {
  return (SEARCH_CRED_PROVIDERS as string[]).includes(p);
}

export const SEARCH_CRED_DEFS: Record<SearchCredProvider, { label: string; docsUrl: string; keyHint: string }> = {
  brave: {
    label: "Brave Search (busca web)",
    docsUrl: "https://brave.com/search/api/",
    keyHint: "BSA... (dashboard.search.brave.com → API keys)",
  },
  tavily: {
    label: "Tavily (busca web)",
    docsUrl: "https://docs.tavily.com/",
    keyHint: "tvly-... (app.tavily.com → API keys)",
  },
  "google-pse": {
    label: "Google Programmable Search",
    docsUrl: "https://developers.google.com/custom-search/v1/overview",
    keyHint: "AIza... (console.cloud.google.com → credenciais; exige também o CX)",
  },
};

const settingKey = (p: AnyKeyedProvider) => `cred.${p}`;
const searchSettingKey = (p: SearchCredProvider) => `cred.search.${p}`;

function aiDefs(p: AnyKeyedProvider): { keyEnv: (keyof Env)[] } {
  return (PROVIDER_DEFAULTS as Record<string, { keyEnv: (keyof Env)[] }>)[p]
    ?? (FREE_PROVIDER_DEFAULTS as Record<string, { keyEnv: (keyof Env)[] }>)[p];
}

export function keyFromEnv(env: Env, provider: AnyKeyedProvider): string {
  for (const name of aiDefs(provider).keyEnv) {
    const v = (env[name] as string | undefined)?.trim();
    if (v) return v;
  }
  return "";
}

/** Resolve a chave efetiva (env ou cofre). "" = não configurada. */
export async function resolveProviderKey(env: Env, db: DbAdapter, provider: AnyKeyedProvider): Promise<string> {
  const fromEnv = keyFromEnv(env, provider);
  if (fromEnv) return fromEnv;
  const packed = await db.getSetting(settingKey(provider)).catch(() => null);
  if (!packed) return "";
  try {
    return await openSecret(vaultSecret(env), packed);
  } catch {
    return "";
  }
}

export function makeKeySource(env: Env, db: DbAdapter): KeySource {
  return (provider) => resolveProviderKey(env, db, provider);
}

/** Guarda chave via painel (cofre). Exige CREDENTIALS_SECRET no .env. */
export async function storeProviderKey(
  env: Env, db: DbAdapter, provider: AnyKeyedProvider, key: string
): Promise<{ masked: string }> {
  const clean = key.trim();
  if (clean.length < 8) throw new Error("Chave inválida (curta demais).");
  if (clean.length > 500) throw new Error("Chave inválida (longa demais).");
  const packed = await sealSecret(vaultSecret(env), clean);
  await db.setSetting(settingKey(provider), packed);
  return { masked: maskKey(clean) };
}

export async function deleteProviderKey(_env: Env, db: DbAdapter, provider: AnyKeyedProvider): Promise<void> {
  await db.deleteSetting(settingKey(provider));
}

/** Mesmo cofre para chaves de BUSCA (namespace separado). */
export function searchKeyFromEnv(env: Env, provider: SearchCredProvider): string {
  const v =
    provider === "brave" ? env.BRAVE_API_KEY
    : provider === "tavily" ? env.TAVILY_API_KEY
    : env.GOOGLE_PSE_KEY;
  return (v ?? "").trim();
}

export async function storeSearchKey(
  env: Env, db: DbAdapter, provider: SearchCredProvider, key: string
): Promise<{ masked: string }> {
  const clean = key.trim();
  if (clean.length < 8) throw new Error("Chave inválida (curta demais).");
  if (clean.length > 500) throw new Error("Chave inválida (longa demais).");
  const packed = await sealSecret(vaultSecret(env), clean);
  await db.setSetting(searchSettingKey(provider), packed);
  return { masked: maskKey(clean) };
}

export async function deleteSearchKey(_env: Env, db: DbAdapter, provider: SearchCredProvider): Promise<void> {
  await db.deleteSetting(searchSettingKey(provider));
}

export interface SearchCredentialStatus {
  provider: SearchCredProvider;
  label: string;
  configured: boolean;
  source: "env" | "vault" | "none";
  masked: string | null;
  docsUrl: string;
  keyHint: string;
}

export async function searchCredentialStatus(env: Env, db: DbAdapter): Promise<SearchCredentialStatus[]> {
  const out: SearchCredentialStatus[] = [];
  for (const p of SEARCH_CRED_PROVIDERS) {
    const def = SEARCH_CRED_DEFS[p];
    const fromEnv = searchKeyFromEnv(env, p);
    if (fromEnv) {
      out.push({ provider: p, label: def.label, configured: true, source: "env", masked: maskKey(fromEnv), docsUrl: def.docsUrl, keyHint: def.keyHint });
      continue;
    }
    const packed = await db.getSetting(searchSettingKey(p)).catch(() => null);
    if (packed) {
      let masked: string | null = "••••";
      try { masked = maskKey(await openSecret(vaultSecret(env), packed)); } catch { masked = "••••"; }
      out.push({ provider: p, label: def.label, configured: true, source: "vault", masked, docsUrl: def.docsUrl, keyHint: def.keyHint });
      continue;
    }
    out.push({ provider: p, label: def.label, configured: false, source: "none", masked: null, docsUrl: def.docsUrl, keyHint: def.keyHint });
  }
  return out;
}

export interface CredentialStatus {
  provider: KeyedProvider;
  label: string;
  configured: boolean;
  source: "env" | "vault" | "none";
  masked: string | null;
  docsUrl: string;
  keyHint: string;
}

/** Status SEM expor segredos (para o painel admin). */
export async function credentialStatus(env: Env, db: DbAdapter): Promise<CredentialStatus[]> {
  const out: CredentialStatus[] = [];
  for (const p of Object.keys(PROVIDER_DEFAULTS) as KeyedProvider[]) {
    const def = PROVIDER_DEFAULTS[p];
    const fromEnv = keyFromEnv(env, p);
    if (fromEnv) {
      out.push({ provider: p, label: def.label, configured: true, source: "env", masked: maskKey(fromEnv), docsUrl: def.docsUrl, keyHint: def.keyHint });
      continue;
    }
    const packed = await db.getSetting(settingKey(p)).catch(() => null);
    if (packed) {
      let masked: string | null = "••••";
      try { masked = maskKey(await openSecret(vaultSecret(env), packed)); } catch { masked = "••••"; }
      out.push({ provider: p, label: def.label, configured: true, source: "vault", masked, docsUrl: def.docsUrl, keyHint: def.keyHint });
      continue;
    }
    out.push({ provider: p, label: def.label, configured: false, source: "none", masked: null, docsUrl: def.docsUrl, keyHint: def.keyHint });
  }
  return out;
}

export interface FreeCredentialStatus {
  provider: FreeKeyedProvider;
  label: string;
  configured: boolean;
  source: "env" | "vault" | "none";
  masked: string | null;
  docsUrl: string;
  keyHint: string;
  limits: string;
}

/** Status das chaves GRATUITAS (mesmo cofre, seção separada no painel). */
export async function freeCredentialStatus(env: Env, db: DbAdapter): Promise<FreeCredentialStatus[]> {
  const out: FreeCredentialStatus[] = [];
  for (const p of Object.keys(FREE_PROVIDER_DEFAULTS) as FreeKeyedProvider[]) {
    const def = FREE_PROVIDER_DEFAULTS[p];
    const fromEnv = keyFromEnv(env, p);
    if (fromEnv) {
      out.push({ provider: p, label: def.label, configured: true, source: "env", masked: maskKey(fromEnv), docsUrl: def.docsUrl, keyHint: def.keyHint, limits: def.limits });
      continue;
    }
    const packed = await db.getSetting(settingKey(p)).catch(() => null);
    if (packed) {
      let masked: string | null = "••••";
      try { masked = maskKey(await openSecret(vaultSecret(env), packed)); } catch { masked = "••••"; }
      out.push({ provider: p, label: def.label, configured: true, source: "vault", masked, docsUrl: def.docsUrl, keyHint: def.keyHint, limits: def.limits });
      continue;
    }
    out.push({ provider: p, label: def.label, configured: false, source: "none", masked: null, docsUrl: def.docsUrl, keyHint: def.keyHint, limits: def.limits });
  }
  return out;
}
