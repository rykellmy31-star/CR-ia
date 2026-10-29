/** NVIDIA NIM Developer API. Compatibilidade apenas com /v1/chat/completions.
 * Os IDs são prefixados localmente para não colidir com OpenRouter.
 * Não adicionar APIs de imagem/embeddings como se fossem chat.
 */
import type { ChatOptions, ChatResult } from "./types.js";
import { OpenAICompatTextAdapter, type OpenAICompatConfig } from "./openai-compatible.js";

export const NVIDIA_PREFIX = "nvidia-nim:";
export const nvidiaId = (id: string): string => NVIDIA_PREFIX + id;
export function actualNvidiaId(id: string): string {
  if (!id.startsWith(NVIDIA_PREFIX)) throw new Error("ID NVIDIA inválido.");
  const actual = id.slice(NVIDIA_PREFIX.length);
  if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(actual)) throw new Error("ID NVIDIA inválido.");
  return actual;
}

export class NvidiaNimTextAdapter extends OpenAICompatTextAdapter {
  constructor(cfg: OpenAICompatConfig) {
    super({ ...cfg, models: cfg.models.map((m) => m.startsWith(NVIDIA_PREFIX) ? m : nvidiaId(m)), paidResult: false });
  }
  override setModels(models: string[]): void {
    super.setModels([...new Set(models.map((m) => m.startsWith(NVIDIA_PREFIX) ? m : nvidiaId(m)))]);
  }
  override async chat(opts: ChatOptions): Promise<ChatResult> {
    const model = actualNvidiaId(opts.model);
    if (!this.models().includes(opts.model)) throw new Error("Modelo NVIDIA não autorizado pelo administrador.");
    const result = await super.chat({ ...opts, model });
    return { ...result, model: opts.model, paid: false };
  }
}
