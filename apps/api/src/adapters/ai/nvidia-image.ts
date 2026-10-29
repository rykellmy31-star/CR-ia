/**
 * NVIDIA NIM Cosmos3 Nano — hosted trial image generator (Physical AI).
 * Source: https://build.nvidia.com/nvidia/cosmos3-nano/modelcard
 * Hosted POST https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano
 * This is NOT a generic commercial image API. Access is for development/tests;
 * admin must explicitly enable it, and image routes must enforce admin-only.
 */
import type { ImageAdapter, ImageGenOptions, ImageGenResult } from "./types.js";
import type { KeySource } from "../../services/credentials.js";
import { validateImageBytes } from "./openrouter-image.js";
import { RateLimitError } from "./pollinations.js";

export const NVIDIA_COSMOS_IMAGE_ID = "nvidia-nim:nvidia/cosmos3-nano";
const DEFAULT_ENDPOINT = "https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos3-nano";

export class NvidiaCosmosImageAdapter implements ImageAdapter {
  readonly provider = "nvidia";
  readonly needsKey = true as const;
  private enabled = false;

  constructor(
    private getKey: KeySource,
    private fetchFn: typeof fetch = fetch,
    private endpoint = DEFAULT_ENDPOINT,
  ) {}

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  models(): string[] { return this.enabled ? [NVIDIA_COSMOS_IMAGE_ID] : []; }
  async hasKey(): Promise<boolean> {
    return Boolean((await this.getKey("nvidia").catch(() => "")).trim());
  }

  /** No-cost connectivity check; never generates media on ping. */
  async ping(): Promise<boolean> {
    if (!this.enabled) return false;
    return this.hasKey();
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (!this.enabled || opts.model !== NVIDIA_COSMOS_IMAGE_ID) {
      throw new Error("Cosmos3 Nano não autorizado para testes pelo administrador.");
    }
    if (!opts.prompt.trim()) throw new Error("Informe uma descrição para gerar a imagem.");
    // 4:5 is not an exact supported Cosmos ratio. Never silently misrepresent it.
    if (opts.format === "4:5") {
      throw new Error("Cosmos3 Nano não suporta 4:5; use 1:1, 9:16 ou 16:9.");
    }
    const key = (await this.getKey("nvidia")).trim();
    if (!key) throw new Error("Configure a NVIDIA API Key no painel Superadmin.");
    const resolutions: Record<string, string> = {
      "1:1": "720_1_1", "16:9": "720_16_9", "9:16": "720_9_16",
    };
    let res: Response;
    try {
      res = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model_mode: "text2image",
          prompt: opts.prompt.slice(0, 4000),
          resolution: resolutions[opts.format],
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        }),
        signal: opts.signal ?? AbortSignal.timeout(180000),
      });
    } catch (e) {
      throw new Error(`NVIDIA Cosmos inacessível: ${e instanceof Error ? e.message : "erro de rede"}`);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? "60");
      throw new RateLimitError("Cota gratuita de testes NVIDIA atingida.", Number.isFinite(retry) && retry > 0 ? retry : 60);
    }
    if (res.status === 401 || res.status === 403) throw new Error(`NVIDIA recusou a chave ou o acesso ao Cosmos (HTTP ${res.status}).`);
    if (res.status === 402) throw new Error("NVIDIA exige créditos ou outra permissão para este endpoint. Nenhuma cobrança foi autorizada pela CR IA.");
    if (!res.ok) throw new Error(`NVIDIA Cosmos indisponível (HTTP ${res.status}). Confirme o acesso em build.nvidia.com.`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.toLowerCase().includes("application/json")) throw new Error("NVIDIA Cosmos retornou resposta inesperada (não JSON).");
    // Never record model responses or credentials in logs.
    const body = await res.json() as { b64_image?: unknown };
    if (typeof body.b64_image !== "string" || !body.b64_image) {
      throw new Error("NVIDIA Cosmos não retornou b64_image. Não foi gerada uma imagem válida.");
    }
    const image = validateImageBytes(body.b64_image);
    if (image.mime !== "image/jpeg" && image.mime !== "image/png") {
      throw new Error("Formato de imagem retornado pelo Cosmos não suportado.");
    }
    return { data: image.bytes, mime: image.mime, model: opts.model, paid: false };
  }
}
