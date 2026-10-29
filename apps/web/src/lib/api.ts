/** Cliente HTTP da CR IA — fala com /api (proxy do Vite/Nginx ou VITE_API_URL). */
import type { ApiResult } from "@cr-ia/shared";

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** Base da API ("" = mesma origem via proxy do Nginx; absoluto = domínio separado). */
export const API_BASE = BASE;

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function getToken(): string | null {
  return localStorage.getItem("cr-ia-token");
}
export function setToken(t: string | null): void {
  if (t) localStorage.setItem("cr-ia-token", t);
  else localStorage.removeItem("cr-ia-token");
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  const token = getToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (init.body && typeof init.body === "string" && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body: ApiResult<T>;
  try {
    body = JSON.parse(text) as ApiResult<T>;
  } catch {
    throw new ApiError(`Resposta inválida do servidor (HTTP ${res.status}).`, res.status);
  }
  if (!res.ok || body.ok === false) {
    const err = body as { ok: false; error: string; code?: string };
    throw new ApiError(err.error || `Erro HTTP ${res.status}`, res.status, err.code);
  }
  return (body as { ok: true; data: T }).data;
}

export const post = <T,>(path: string, data: unknown): Promise<T> =>
  api<T>(path, { method: "POST", body: JSON.stringify(data) });

/** POST com streaming SSE — chama onDelta a cada trecho. Retorna o meta final. */
export async function postStream<TMeta>(
  path: string,
  data: unknown,
  onDelta: (text: string) => void
): Promise<TMeta> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(data) });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    try {
      const j = JSON.parse(t) as { error?: string };
      throw new ApiError(j.error ?? `Erro HTTP ${res.status}`, res.status);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError(`Erro HTTP ${res.status}`, res.status);
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let meta = {} as TMeta;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n");
      let event = "";
      let dataStr = "";
      for (const ln of lines) {
        if (ln.startsWith("event:")) event = ln.slice(6).trim();
        else if (ln.startsWith("data:")) dataStr += ln.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        const j = JSON.parse(dataStr) as Record<string, unknown>;
        if (event === "meta") meta = { ...meta, ...j };
        else if (event === "delta" && typeof j.text === "string") onDelta(j.text);
        else if (event === "done") meta = { ...meta, ...j };
      } catch { /* ignora fragmento */ }
    }
  }
  return meta;
}

export function fileUrl(url: string): string {
  // URLs da API são relativas (/api/...) — prefixa com BASE quando absoluto.
  if (url.startsWith("http")) return url;
  return `${BASE}${url}`;
}

/** Download autenticado (arquivos exigem token). */
export async function downloadAuth(url: string, filename: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${url}`, { headers });
  if (!res.ok) throw new ApiError(`Falha no download (HTTP ${res.status}).`, res.status);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
