/**
 * CR IA v0.2.0 — cliente ComfyUI (GPU externa sob controle do cliente).
 *
 * Usa a API HTTP oficial do ComfyUI: /system_stats (ping), /upload (imagem),
 * /prompt (enfileira workflow em formato API) + /history (resultado) + /view.
 *
 * Workflows: JSON em formato API com placeholders {{VAR}} — ver
 * apps/api/workflows/*.json. O caminho confiável é exportar o workflow no
 * PRÓPRIO ComfyUI ("Save API Format") e ajustar os nomes dos checkpoints
 * aos arquivos instalados (docs/GPU-EXTERNA.md).
 */
import type { Env } from "../types.js";

export interface ComfyConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMin: number;
}

export function comfyConfig(env: Env): ComfyConfig | null {
  const baseUrl = (env.EXTERNAL_GPU_URL ?? "").trim().replace(/\/$/, "");
  if (!baseUrl) return null;
  const t = Number(env.COMFY_TIMEOUT_MIN ?? "10");
  return { baseUrl, apiKey: (env.EXTERNAL_GPU_API_KEY ?? "").trim(), timeoutMin: Number.isFinite(t) && t > 0 ? Math.min(t, 60) : 10 };
}

function headers(cfg: ComfyConfig): Record<string, string> {
  const h: Record<string, string> = { "user-agent": "cr-ia/0.2 (+self-hosted)" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

/** Ping real: /system_stats responde e traz versão do ComfyUI. */
export async function comfyPing(cfg: ComfyConfig): Promise<boolean> {
  try {
    const res = await fetch(`${cfg.baseUrl}/system_stats`, {
      headers: headers(cfg), signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { system?: { comfyui_version?: string } };
    return Boolean(data.system?.comfyui_version ?? data.system);
  } catch {
    return false;
  }
}

/** Sobe imagem para o ComfyUI (edição img2img). Retorna o nome remoto. */
export async function comfyUpload(cfg: ComfyConfig, data: Uint8Array, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("image", new Blob([data as unknown as BlobPart], { type: "application/octet-stream" }), fileName);
  form.append("overwrite", "true");
  const res = await fetch(`${cfg.baseUrl}/upload`, {
    method: "POST", headers: headers(cfg), body: form, signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`ComfyUI upload HTTP ${res.status}.`);
  const out = (await res.json()) as { name?: string };
  if (!out.name) throw new Error("ComfyUI não retornou o nome da imagem enviada.");
  return out.name;
}

/** Formato real do GET /history/{prompt_id} do ComfyUI. */
interface HistoryEntry {
  outputs?: Record<string, { images?: { filename?: string; subfolder?: string; type?: string }[] }>;
  status?: { status_str?: string; completed?: boolean };
}

/**
 * Enfileira o workflow (objeto em formato API) e aguarda a 1ª imagem gerada.
 * Lança erro claro em timeout/falha — nunca retorna bytes falsos.
 */
export async function comfyRunWorkflow(
  cfg: ComfyConfig, workflow: Record<string, unknown>
): Promise<{ data: Uint8Array; mime: string }> {
  const queued = await fetch(`${cfg.baseUrl}/prompt`, {
    method: "POST",
    headers: { ...headers(cfg), "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!queued.ok) {
    throw new Error(`ComfyUI recusou o workflow (HTTP ${queued.status}): ${(await queued.text()).slice(0, 300)}`);
  }
  const { prompt_id: promptId } = (await queued.json()) as { prompt_id?: string };
  if (!promptId) throw new Error("ComfyUI não retornou prompt_id.");

  const deadline = Date.now() + cfg.timeoutMin * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const h = await fetch(`${cfg.baseUrl}/history/${encodeURIComponent(promptId)}`, {
      headers: headers(cfg), signal: AbortSignal.timeout(30_000),
    });
    if (!h.ok) continue;
    const hist = (await h.json()) as Record<string, HistoryEntry>;
    const entry = hist[promptId];
    if (!entry) continue;
    // Falha explícita do ComfyUI (status_str=error)?
    if (entry.status?.status_str === "error") {
      throw new Error("ComfyUI falhou no workflow (status=error — ver console da GPU).");
    }
    const images = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
    const img = images.find((i) => i.filename);
    if (img?.filename) {
      const q = `filename=${encodeURIComponent(img.filename)}` +
        `&subfolder=${encodeURIComponent(img.subfolder ?? "")}` +
        `&type=${encodeURIComponent(img.type ?? "output")}`;
      const v = await fetch(`${cfg.baseUrl}/view?${q}`, {
        headers: headers(cfg), signal: AbortSignal.timeout(120_000),
      });
      if (!v.ok) throw new Error(`ComfyUI gerou, mas o download falhou (HTTP ${v.status}).`);
      const mime = (v.headers.get("content-type") ?? "image/png").split(";")[0].trim();
      const data = new Uint8Array(await v.arrayBuffer());
      if (data.byteLength < 1024) throw new Error("ComfyUI retornou imagem vazia.");
      return { data, mime };
    }
  }
  throw new Error(`ComfyUI não concluiu em ${cfg.timeoutMin} min (GPU ocupada ou workflow travado).`);
}

/**
 * Substitui {{PLACEHOLDERS}} no template. Strings são escapadas para JSON
 * (prompt com aspas/quebras não quebra o workflow); números entram crus.
 */
export function fillWorkflow(
  template: string,
  strings: Record<string, string>,
  numbers: Record<string, number>
): Record<string, unknown> {
  let out = template;
  for (const [k, v] of Object.entries(strings)) {
    const escaped = JSON.stringify(v).slice(1, -1); // sem as aspas externas
    out = out.split(`{{${k}}}`).join(escaped);
  }
  for (const [k, v] of Object.entries(numbers)) {
    if (!Number.isFinite(v)) throw new Error(`Workflow: valor numérico inválido para ${k}.`);
    out = out.split(`{{${k}}}`).join(String(Math.round(v)));
  }
  const leftover = out.match(/{{\w+}}/);
  if (leftover) {
    throw new Error(`Template ComfyUI com placeholder não preenchido (${leftover[0]}) — verifique o workflow.`);
  }
  return JSON.parse(out) as Record<string, unknown>;
}
