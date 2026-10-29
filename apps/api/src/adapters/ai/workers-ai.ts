/**
 * Adaptador Cloudflare Workers AI — inferência serverless.
 * Texto: @cf/meta/llama-3.1-8b-instruct, @cf/qwen/qwen3-*, @cf/google/gemma-3-*…
 * Imagem: @cf/black-forest-labs/flux-1-schnell (FLUX.1 Schnell).
 * Funciona DENTRO do Workers (binding AI). Fora dele, exige API Token (REST).
 */
import type {
  ChatOptions,
  ChatResult,
  ImageAdapter,
  ImageGenOptions,
  ImageGenResult,
  TextAdapter,
} from "./types.js";
import { estimateTokens } from "./types.js";
import type { AiBindingLike } from "../../types.js";

export const WORKERS_AI_TEXT_DEFAULTS = [
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/qwen/qwen3-8b",
  "@cf/google/gemma-3-12b-it",
];

export class WorkersAiTextAdapter implements TextAdapter {
  readonly provider = "workers-ai";
  constructor(
    private ai: AiBindingLike | null,
    private modelIds: string[] = WORKERS_AI_TEXT_DEFAULTS
  ) {}

  models(): string[] {
    return [...this.modelIds];
  }

  async ping(): Promise<boolean> {
    return this.ai !== null;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    if (!this.ai) {
      throw new Error(
        "Workers AI indisponível: este adaptador exige execução dentro do Cloudflare Workers (binding AI)."
      );
    }
    const out = (await this.ai.run(opts.model, {
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
    })) as { response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } } | string;
    const text = typeof out === "string" ? out : out.response ?? "";
    if (!text) throw new Error(`Workers AI (${opts.model}) retornou resposta vazia.`);
    const usage = typeof out === "object" ? out.usage : undefined;
    return {
      text,
      model: opts.model,
      tokensIn: usage?.prompt_tokens ?? estimateTokens(opts.messages.map((m) => m.content).join("\n")),
      tokensOut: usage?.completion_tokens ?? estimateTokens(text),
      paid: true, // pode gerar custo conforme plano/limites — bloqueável por política
    };
  }
}

export class WorkersAiImageAdapter implements ImageAdapter {
  readonly provider = "workers-ai";
  constructor(
    private ai: AiBindingLike | null,
    private modelId = "@cf/black-forest-labs/flux-1-schnell"
  ) {}

  models(): string[] {
    return [this.modelId];
  }

  async ping(): Promise<boolean> {
    return this.ai !== null;
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (!this.ai) {
      throw new Error(
        "Workers AI indisponível: geração de imagens reais exige deploy na Cloudflare (binding AI) ou IMAGE_PROVIDER=mock-svg local."
      );
    }
    const out = await this.ai.run(this.modelId, {
      prompt: opts.prompt,
      width: opts.width,
      height: opts.height,
      seed: opts.seed,
    });
    // O binding pode retornar ReadableStream, ArrayBuffer ou Uint8Array
    let data: Uint8Array;
    if (out instanceof Uint8Array) data = out;
    else if (out instanceof ArrayBuffer) data = new Uint8Array(out);
    else data = new Uint8Array(await new Response(out as ReadableStream).arrayBuffer());
    if (data.byteLength < 100) throw new Error("Workers AI retornou imagem vazia.");
    return { data, mime: "image/jpeg", model: this.modelId, paid: true };
  }
}
