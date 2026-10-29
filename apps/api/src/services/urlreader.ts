/**
 * Leitor de páginas públicas (Fase 3): baixa HTML e extrai texto legível.
 * Proteções: só http/https, bloqueio de hosts privados (anti-SSRF),
 * redirects seguidos manualmente (máx. 3, revalidados), timeout 15s,
 * limite 1,5 MB, só text/html. Falha sempre com mensagem clara.
 */
export interface ReadUrlResult {
  url: string;
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
}

const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;
const MAX_CHARS = 12_000;

function isPrivateLiteral(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) {
    return true;
  }
  // IPv4
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  // IPv6 privadas/comuns
  if (h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.includes(":127.")) return true;
  return false;
}

/** Best-effort: resolve DNS e bloqueia se apontar para IP privado (Node; no Workers, só literais). */
async function assertPublicHost(url: URL): Promise<void> {
  if (isPrivateLiteral(url.hostname)) {
    throw new Error(`Host bloqueado por segurança (${url.hostname}): somente páginas públicas.`);
  }
  try {
    const dns = await import("node:dns/promises").catch(() => null) as
      | typeof import("node:dns/promises") | null;
    if (!dns) return;
    const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    for (const a of addrs) {
      if (isPrivateLiteral(a.address)) {
        throw new Error(`Host bloqueado por segurança (${url.hostname} resolve para rede privada).`);
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Host bloqueado")) throw e;
    // DNS indisponível: segue com a validação literal (não quebra o Workers)
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return Number.isFinite(c) && c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : "";
    });
}

export function extractReadableText(html: string): { title: string; text: string; truncated: boolean } {
  const title = (html.match(/<title[^>]*>([\s\S]{1,300})<\/title>/i)?.[1] ?? "").trim().slice(0, 200);
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s).replace(/\s+/g, " ").trim();
  const truncated = s.length > MAX_CHARS;
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim(), text: s.slice(0, MAX_CHARS), truncated };
}

async function readCapped(res: Response): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BYTES * 2) {
    throw new Error(`Página grande demais (${Math.round(len / 1024 / 1024)} MB). Limite de leitura: 1,5 MB.`);
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Página grande demais. Limite de leitura: 1,5 MB.");
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** Baixa e extrai texto de uma URL pública. */
export async function readPublicUrl(rawUrl: string): Promise<ReadUrlResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("URL inválida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Somente URLs http(s) são aceitas.");
  }
  if (url.username || url.password) {
    throw new Error("URL com credenciais bloqueada por segurança.");
  }
  let current = url.toString();
  let res: Response | null = null;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const u = new URL(current);
    await assertPublicHost(u);
    res = await fetch(current, {
      redirect: "manual",
      headers: { accept: "text/html,application/xhtml+xml,text/plain", "user-agent": "cr-ia/0.2 (+leitor)" },
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw new Error(`Não foi possível abrir a página (${e instanceof Error ? e.message : "rede"}).`);
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new Error("Redirecionamento sem destino.");
      current = new URL(loc, current).toString();
      res = null;
      continue;
    }
    break;
  }
  if (!res) throw new Error("Redirecionamentos demais (máx. 3).");
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`A página respondeu HTTP ${res.status}.`);
  }
  const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!/text\/html|application\/xhtml|text\/plain/.test(ctype) && ctype.length > 0) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Tipo não legível (${ctype.split(";")[0] || "desconhecido"}). Envie o arquivo por upload.`);
  }
  const html = await readCapped(res);
  if (!html.trim()) throw new Error("Página vazia.");
  const { title, text, truncated } = extractReadableText(html);
  if (!text) throw new Error("Nenhum texto legível nesta página.");
  return { url: url.toString(), finalUrl: current, title: title || "(sem título)", text, truncated };
}
