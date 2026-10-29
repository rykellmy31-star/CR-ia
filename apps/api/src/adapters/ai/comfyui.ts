/**
 * Adaptador ComfyUI — geração e EDIÇÃO de imagens na GPU externa do cliente.
 * provider "external-gpu"; modelos: flux.1-schnell, qwen-image (t2i) e
 * qwen-image-edit (i2i). Só fica "installed" com GPU acessível + template
 * de workflow legível (ver apps/api/workflows/*.json).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageEditOptions, ImageGenOptions, ImageGenResult, ImageEditAdapter } from "./types.js";
import { comfyConfig, comfyPing, comfyRunWorkflow, comfyUpload, fillWorkflow, type ComfyConfig } from "../../services/comfyui.js";
import type { Env } from "../../types.js";

export const COMFY_T2I_MODELS = ["flux.1-schnell", "qwen-image"];
export const COMFY_EDIT_MODEL = "qwen-image-edit";

/** Localiza o template: override por env ou cópia embarcada (dev/dist/docker). */
export function loadWorkflowTemplate(env: Env, which: "t2i" | "edit"): string {
  const override = which === "t2i" ? env.COMFY_WORKFLOW_T2I : env.COMFY_WORKFLOW_EDIT;
  const name = which === "t2i" ? "comfy-t2i-sdxl.json" : "comfy-i2i-sdxl.json";
  const candidates: string[] = [];
  if (override?.trim()) candidates.push(override.trim());
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "..", "workflows", name)); // dist: dist/adapters/ai → dist/workflows
  } catch { /* ambiente sem fileURL (workers): ignora */ }
  candidates.push(join(process.cwd(), "workflows", name)); // vitest/dev: apps/api
  candidates.push(join(process.cwd(), "apps", "api", "workflows", name)); // dev na raiz
  const tried: string[] = [];
  for (const p of candidates) {
    tried.push(p);
    try {
      return readFileSync(p, "utf-8");
    } catch { /* tenta o próximo */ }
  }
  throw new Error(
    `Template ComfyUI (${which}) não encontrado. ` +
    `Defina ${which === "t2i" ? "COMFY_WORKFLOW_T2I" : "COMFY_WORKFLOW_EDIT"} ou verifique a instalação.`
  );
}

export class ComfyImageAdapter implements ImageEditAdapter {
  readonly provider = "external-gpu";
  private cfg: ComfyConfig | null;

  constructor(private env: Env) {
    this.cfg = comfyConfig(env);
  }

  models(): string[] {
    return this.cfg ? [...COMFY_T2I_MODELS, COMFY_EDIT_MODEL] : [];
  }

  /** Instalado = GPU acessível E templates legíveis. */
  async ping(): Promise<boolean> {
    if (!this.cfg) return false;
    try {
      loadWorkflowTemplate(this.env, "t2i");
      loadWorkflowTemplate(this.env, "edit");
    } catch {
      return false;
    }
    return comfyPing(this.cfg);
  }

  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    if (!this.cfg) throw new Error("GPU externa não configurada (EXTERNAL_GPU_URL). Ver docs/GPU-EXTERNA.md.");
    const template = loadWorkflowTemplate(this.env, "t2i");
    const workflow = fillWorkflow(
      template,
      { POSITIVE: opts.prompt, NEGATIVE: opts.negativePrompt ?? "" },
      { WIDTH: opts.width, HEIGHT: opts.height, SEED: opts.seed ?? Math.floor(Math.random() * 2 ** 31) }
    );
    const r = await comfyRunWorkflow(this.cfg, workflow);
    return { data: r.data, mime: r.mime, model: opts.model, paid: false };
  }

  async edit(opts: ImageEditOptions): Promise<ImageGenResult> {
    if (!this.cfg) throw new Error("GPU externa não configurada (EXTERNAL_GPU_URL). Ver docs/GPU-EXTERNA.md.");
    const remote = await comfyUpload(this.cfg, opts.image, opts.imageName);
    const template = loadWorkflowTemplate(this.env, "edit");
    const workflow = fillWorkflow(
      template,
      { POSITIVE: opts.prompt, NEGATIVE: opts.negativePrompt ?? "", IMAGE: remote },
      { SEED: opts.seed ?? Math.floor(Math.random() * 2 ** 31) }
    );
    const r = await comfyRunWorkflow(this.cfg, workflow);
    return { data: r.data, mime: r.mime, model: opts.model, paid: false };
  }
}
