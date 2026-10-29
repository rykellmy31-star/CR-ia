/** Cloudflare Workers AI REST — FLUX.1 Schnell for self-hosted VPS. */
import type { ImageAdapter, ImageGenOptions, ImageGenResult } from "./types.js";
import { validateImageBytes } from "./openrouter-image.js";
import { RateLimitError } from "./pollinations.js";

export const CLOUDFLARE_FLUX_REST_ID = "cloudflare-flux-1-schnell";
const MODEL = "@cf/black-forest-labs/flux-1-schnell";

export class CloudflareFluxRestAdapter implements ImageAdapter {
  readonly provider = "workers-ai";
  readonly needsKey = true as const;
  constructor(
    private accountId: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}
  models(): string[] { return [CLOUDFLARE_FLUX_REST_ID]; }
  async hasKey(): Promise<boolean> { return Boolean(this.accountId && this.token); }
  async ping(): Promise<boolean> { return this.hasKey(); }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (!await this.hasKey()) throw new Error("Configure CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_AI_API_TOKEN na VPS.");
    if (!opts.prompt.trim()) throw new Error("Informe uma descrição para a imagem.");
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${MODEL}`;
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ prompt: opts.prompt, steps: 4 }),
        signal: opts.signal ?? AbortSignal.timeout(120000),
      });
    } catch (err) {
      throw new Error(`Cloudflare Workers AI sem conexão: ${err instanceof Error ? err.message : "falha de rede"}`);
    }
    if (response.status === 429 || response.status === 402) {
      throw new RateLimitError("Franquia ou limite do Workers AI atingido. Nenhum excedente será autorizado pela CR IA.", 86400);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Cloudflare recusou a autenticação ou a permissão Workers AI.");
    }
    if (!response.ok) throw new Error(`Cloudflare FLUX indisponível (HTTP ${response.status}).`);
    const json = await response.json() as { success?: boolean; result?: { image?: string }; errors?: Array<{ message?: string }> };
    if (!json.success || typeof json.result?.image !== "string") {
      throw new Error("Cloudflare não retornou uma imagem válida.");
    }
    const img = validateImageBytes(json.result.image);
    if (img.mime !== "image/jpeg" && img.mime !== "image/png") throw new Error("Formato retornado não suportado.");
    return { data: img.bytes, mime: img.mime, model: opts.model, paid: false };
  }
}
