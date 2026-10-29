/** Cloudflare Workers AI REST — image generation on a VPS (no GPU required).
 * FLUX.2 Klein uses multipart/form-data; FLUX.1 Schnell uses JSON.
 * Model IDs remain stable for existing images and admin settings.
 */
import type { ImageAdapter, ImageGenOptions, ImageGenResult } from "./types.js";
import { validateImageBytes } from "./openrouter-image.js";
import { RateLimitError } from "./pollinations.js";

export const CLOUDFLARE_FLUX_REST_ID = "cloudflare-flux-1-schnell";
export const CLOUDFLARE_FLUX_KLEIN_ID = "cloudflare-flux-2-klein-4b";
const SCHNELL_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const KLEIN_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

export class CloudflareFluxRestAdapter implements ImageAdapter {
  readonly provider = "workers-ai";
  readonly needsKey = true as const;

  constructor(
    private accountId: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  models(): string[] { return [CLOUDFLARE_FLUX_KLEIN_ID, CLOUDFLARE_FLUX_REST_ID]; }
  async hasKey(): Promise<boolean> { return Boolean(this.accountId.trim() && this.token.trim()); }
  async ping(): Promise<boolean> { return this.hasKey(); }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (!await this.hasKey()) throw new Error("Configure CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_AI_API_TOKEN na VPS.");
    if (!opts.prompt.trim()) throw new Error("Informe uma descrição para a imagem.");
    if (!this.models().includes(opts.model)) throw new Error("Modelo Cloudflare não reconhecido.");

    const klein = opts.model === CLOUDFLARE_FLUX_KLEIN_ID;
    const endpoint = klein ? KLEIN_MODEL : SCHNELL_MODEL;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${endpoint}`;

    // FLUX.2 requires multipart even for prompt-only requests. Do not set
    // Content-Type manually: fetch adds the multipart boundary.
    const form = new FormData();
    form.set("prompt", opts.prompt);
    form.set("width", String(Math.min(1920, Math.max(256, opts.width))));
    form.set("height", String(Math.min(1920, Math.max(256, opts.height))));
    form.set("guidance", "5");
    if (opts.seed !== undefined) form.set("seed", String(opts.seed));

    // FLUX.1 Schnell supports up to 8 diffusion steps. This improves image
    // fidelity over the old 4-step configuration, within plan limits.
    const schnellBody = JSON.stringify({
      prompt: opts.prompt.slice(0, 2048),
      steps: 8,
      ...(opts.seed === undefined ? {} : { seed: opts.seed }),
    });

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: klein
          ? { Authorization: `Bearer ${this.token}`, Accept: "application/json" }
          : { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: klein ? form : schnellBody,
        signal: opts.signal ?? AbortSignal.timeout(120000),
      });
    } catch (err) {
      throw new Error(`Cloudflare Workers AI sem conexão: ${err instanceof Error ? err.message : "falha de rede"}`);
    }

    if (response.status === 429 || response.status === 402) {
      throw new RateLimitError("Limite ou franquia do Workers AI atingido. Verifique o uso da conta Cloudflare.", 86400);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Cloudflare recusou a autenticação ou a permissão Workers AI.");
    }
    if (!response.ok) throw new Error(`Cloudflare ${klein ? "FLUX.2 Klein" : "FLUX.1 Schnell"} indisponível (HTTP ${response.status}).`);

    const json = await response.json() as { success?: boolean; result?: { image?: string } };
    if (!json.success || typeof json.result?.image !== "string") {
      throw new Error("Cloudflare não retornou uma imagem válida.");
    }
    const img = validateImageBytes(json.result.image);
    if (img.mime !== "image/jpeg" && img.mime !== "image/png") throw new Error("Formato retornado não suportado.");
    return { data: img.bytes, mime: img.mime, model: opts.model, paid: false };
  }
}
