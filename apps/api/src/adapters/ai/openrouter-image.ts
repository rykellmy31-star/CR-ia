/**
 * CR IA v0.3.0 — imagens reais via OpenRouter Image API (oficial).
 * - Geração: POST /api/v1/images { model, prompt, aspect_ratio, n }
 * - Edição (image-to-image): mesmo endpoint + input_references (data URL)
 * - Resposta: { data: [{ b64_json, media_type }], usage: { cost } }
 *
 * Validação funcional dos bytes (não basta HTTP 200): decodifica o base64
 * e confere assinatura real (PNG/JPEG/WebP/GIF/SVG). Custo real (usage.cost)
 * é repassado para o registro de consumo.
 */
import type { ImageEditOptions, ImageGenOptions, ImageGenResult } from "./types.js";
import type { KeySource } from "../../services/credentials.js";
import type { Env } from "../../types.js";
import { orBase, orHeaders } from "../../services/openrouter.js";
import { RateLimitError } from "./pollinations.js";

const ASPECT: Record<string, string> = {
  "1:1": "1:1",
  "4:5": "4:5",
  "9:16": "9:16",
  "16:9": "16:9",
};

function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return "image/gif";
  }
  return null;
}

/**
 * Prova funcional de imagem: base64 válido + tamanho mínimo + assinatura
 * de formato real (ou <svg para vetoriais). HTTP 200 sozinho não prova nada.
 */
export function validateImageBytes(b64: string, mediaType?: string): { bytes: Uint8Array; mime: string } {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    throw new Error("Resposta inválida do provedor (base64 quebrado).");
  }
  if (bytes.length < 32) throw new Error("Resposta inválida do provedor (imagem vazia).");
  const sniffed = sniffMime(bytes);
  if (sniffed) {
    return { bytes, mime: mediaType && mediaType.startsWith("image/") ? mediaType : sniffed };
  }
  try {
    const head = Buffer.from(bytes.subarray(0, 300)).toString("utf-8").trimStart().toLowerCase();
    if (head.includes("<svg")) return { bytes, mime: "image/svg+xml" };
  } catch {
    /* cai no erro abaixo */
  }
  throw new Error("Resposta inválida do provedor (os bytes não são uma imagem).");
}

function extractOrError(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string } | string; message?: string };
    const m = typeof j.error === "string" ? j.error : j.error?.message ?? j.message;
    if (m) return String(m).slice(0, 300);
  } catch {
    /* texto puro abaixo */
  }
  return (bodyText || "erro desconhecido").slice(0, 300);
}

export class OpenRouterImageAdapter {
  readonly provider = "openrouter";
  readonly needsKey = true as const;
  private ids: string[] = [];
  private editable = new Set<string>();
  /** Classificação pago/grátis por modelo (ligada pelo registry via catálogo). */
  paidFor: (model: string) => boolean = () => true;

  constructor(private env: Env, private keys: KeySource, private fetchFn: typeof fetch = fetch) {}

  setModels(ids: string[]): void {
    this.ids = [...ids];
  }

  /** Modelos que declaram entrada de imagem (podem editar). */
  setEditable(ids: string[]): void {
    this.editable = new Set(ids);
  }

  models(): string[] {
    return [...this.ids];
  }

  /** Edição suportada por modelo (o registry consulta antes de oferecer). */
  canEdit(model: string): boolean {
    return this.editable.has(model);
  }

  async hasKey(): Promise<boolean> {
    return (await this.keys("openrouter").catch(() => "")).trim().length > 0;
  }

  /** Ping = valida a chave em /auth/key (sem gasto, sem gerar nada). */
  async ping(): Promise<boolean> {
    const key = await this.keys("openrouter").catch(() => "");
    if (!key.trim()) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await this.fetchFn(`${orBase(this.env)}/auth/key`, {
          headers: orHeaders(this.env, key),
          signal: ctrl.signal,
        });
        return res.ok;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    return this.call(opts.model, opts.prompt, undefined, opts.format);
  }

  async edit(opts: ImageEditOptions): Promise<ImageGenResult> {
    if (!this.canEdit(opts.model)) {
      throw new Error(
        `O modelo "${opts.model}" não declara suporte a edição (image-to-image). Escolha outro modelo de edição.`,
      );
    }
    const mime = sniffMime(opts.image) ?? "image/png";
    const dataUrl = `data:${mime};base64,${Buffer.from(opts.image).toString("base64")}`;
    return this.call(opts.model, opts.prompt, [{ type: "image_url", image_url: { url: dataUrl } }], opts.format);
  }

  private async call(
    model: string, prompt: string,
    refs: Array<{ type: string; image_url: { url: string } }> | undefined,
    format: string | undefined,
  ): Promise<ImageGenResult> {
    const key = await this.keys("openrouter").catch(() => "");
    if (!key.trim()) {
      throw new Error("OpenRouter sem chave — configure em Administração → Provedores de IA.");
    }
    const body: Record<string, unknown> = { model, prompt, n: 1 };
    if (format && ASPECT[format]) body.aspect_ratio = ASPECT[format];
    if (refs) body.input_references = refs;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 180_000);
    let res: Response;
    try {
      res = await this.fetchFn(`${orBase(this.env)}/images`, {
        method: "POST",
        headers: orHeaders(this.env, key),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const abort = e instanceof Error && e.name === "AbortError";
      throw new Error(abort ? "OpenRouter: tempo esgotado (180s) — tente de novo." : `OpenRouter inacessível: ${e instanceof Error ? e.message : e}`);
    } finally {
      clearTimeout(t);
    }
    if (res.status === 401) {
      throw new Error("Chave OpenRouter inválida — atualize em Administração → Provedores de IA.");
    }
    if (res.status === 402) {
      throw new Error("Sem créditos na OpenRouter (HTTP 402) — recarregue a conta ou use um modelo gratuito.");
    }
    if (res.status === 429) {
      throw new RateLimitError("Limite da OpenRouter atingido (429) — aguarde e tente de novo.", 60);
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`OpenRouter falhou (HTTP ${res.status}): ${extractOrError(bodyText)}`);
    }
    const json = (await res.json().catch(() => null)) as {
      data?: Array<{ b64_json?: unknown; media_type?: unknown }>;
      usage?: { cost?: unknown };
    } | null;
    const item = json?.data?.[0];
    if (!item || typeof item.b64_json !== "string" || !item.b64_json) {
      throw new Error("OpenRouter não retornou imagem (resposta sem b64_json). Nenhuma cobrança ocorre sem entrega.");
    }
    const { bytes, mime } = validateImageBytes(
      item.b64_json, typeof item.media_type === "string" ? item.media_type : undefined,
    );
    const cost = json?.usage?.cost;
    return {
      data: bytes,
      mime,
      model,
      paid: this.paidFor(model),
      ...(typeof cost === "number" && Number.isFinite(cost) ? { costUsd: cost } : {}),
    };
  }
}
