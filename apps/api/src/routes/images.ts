/** Estúdio de imagens: gerar, listar (biblioteca), baixar e excluir. */
import { Hono } from "hono";
import { z } from "zod";
import { IMAGE_DIMENSIONS } from "@cr-ia/shared";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth } from "../middleware/auth.js";
import { getNum } from "../lib/config.js";
import { nowIso, uid } from "../lib/ids.js";
import { RateLimitError } from "../adapters/ai/pollinations.js";

declare module "hono" {
  interface ContextVariableMap {
    storage: import("../adapters/storage/types.js").StorageAdapter;
  }
}

export const imageRoutes = new Hono<{ Bindings: Env }>();

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

const genSchema = z.object({
  prompt: z.string().min(3, "Descreva a imagem desejada.").max(2000),
  negativePrompt: z.string().max(1000).optional(),
  format: z.enum(["1:1", "4:5", "9:16", "16:9"]).default("1:1"),
  model: z.string().optional(),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
  /** Identidade visual opcional (MVP: registrada no prompt/arquivo; sobreposição real em fase 2) */
  brand: z.object({
    name: z.string().max(80).optional(),
    color: z.string().max(20).optional(),
  }).optional(),
});

imageRoutes.post("/generate", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = genSchema.safeParse(body);
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const models = c.get("models");
  const storage = c.get("storage");
  const user = c.get("user");

  const limit = getNum(c, "DAILY_LIMIT_IMAGES", 50);
  if (limit > 0) {
    const used = await db.countUsageSince(user.id, "image", startOfTodayIso());
    if (used >= limit) return fail(c, `Limite diário de imagens atingido (${limit}).`, 429);
  }

  try {
    let modelId = parsed.data.model && parsed.data.model !== "auto"
      ? parsed.data.model
      : await models.autoSelectImage();
    models.assertUsable(modelId);
    if (modelId.startsWith("nvidia-nim:") && user.role !== "admin") {
      return fail(c, "NVIDIA NIM Free Endpoint: uso restrito ao administrador em testes.", 403);
    }
    const adapter = models.findImageAdapter(modelId);
    if (!adapter) return fail(c, `Modelo de imagem "${modelId}" desconhecido.`, 400);

    const dims = IMAGE_DIMENSIONS[parsed.data.format];
    const fullPrompt = parsed.data.brand?.name
      ? `${parsed.data.prompt} (marca: ${parsed.data.brand.name}${parsed.data.brand.color ? `, cor ${parsed.data.brand.color}` : ""})`
      : parsed.data.prompt;

    const result = await adapter.generate({
      model: modelId,
      prompt: fullPrompt,
      negativePrompt: parsed.data.negativePrompt,
      format: parsed.data.format,
      width: dims.w,
      height: dims.h,
      seed: parsed.data.seed,
    });

    const ext = result.mime === "image/svg+xml" ? "svg" : result.mime === "image/png" ? "png" : "jpg";
    const fileId = uid("fil");
    const key = `images/${user.id}/${fileId}.${ext}`;
    await storage.put(key, result.data, result.mime);
    const url = storage.urlFor(key);

    const file = await db.saveFile({
      id: fileId, userId: user.id,
      name: `cr-ia-${parsed.data.format.replace(":", "x")}-${Date.now()}.${ext}`,
      mime: result.mime, size: result.data.byteLength, url, createdAt: nowIso(),
    });
    const image = await db.saveImage({
      id: uid("img"), userId: user.id, prompt: parsed.data.prompt,
      negativePrompt: parsed.data.negativePrompt, format: parsed.data.format,
      modelId, fileId: file.id, url, width: dims.w, height: dims.h, createdAt: nowIso(),
    });
    await db.logUsage({
      userId: user.id, modelId, kind: "image",
      tokensIn: 0, tokensOut: 0, costFlag: result.paid,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    });
    return ok(c, { image });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha ao gerar imagem.";
    await db.logAudit({ userId: user.id, action: "image.error", detail: msg.slice(0, 500) });
    // Limite da nuvem gratuita = 429 com tempo de espera (a UI mostra contagem).
    if (e instanceof RateLimitError) {
      return c.json({ ok: false, error: msg, code: "RATE_LIMITED", retryAfterSec: e.retryAfterSec }, 429);
    }
    return fail(c, msg, 502);
  }
});

const editSchema = z.object({
  fileId: z.string().min(1, "Envie a imagem (fileId de um upload seu)."),
  prompt: z.string().min(3, "Descreva a edição desejada.").max(2000),
  model: z.string().default("qwen-image-edit"),
  seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
});

/**
 * Edição de imagem (upload + instrução) na GPU externa.
 * Sem EXTERNAL_GPU_URL configurado, retorna 503 honesto com instrução.
 */
imageRoutes.post("/edit", requireAuth, async (c) => {
  const parsed = editSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const models = c.get("models");
  const storage = c.get("storage");
  const user = c.get("user");

  const limit = getNum(c, "DAILY_LIMIT_IMAGES", 50);
  if (limit > 0) {
    const used = await db.countUsageSince(user.id, "image", startOfTodayIso());
    if (used >= limit) return fail(c, `Limite diário de imagens atingido (${limit}).`, 429);
  }

  const file = await db.getFile(parsed.data.fileId, user.id);
  if (!file) return fail(c, "Imagem original não encontrada.", 404);
  if (!file.mime.startsWith("image/") || file.mime === "image/svg+xml") {
    return fail(c, `Edição exige PNG/JPEG/WebP. Recebido: ${file.mime}.`, 415);
  }
  const key = decodeURIComponent(file.url.split("/api/files/content/")[1] ?? "");
  if (!key) return fail(c, "Imagem sem conteúdo acessível.", 500);
  const obj = await storage.get(key);
  if (!obj) return fail(c, "Conteúdo da imagem não encontrado.", 404);

  try {
    models.assertUsable(parsed.data.model);
    if (parsed.data.model.startsWith("nvidia-nim:") && user.role !== "admin") {
      return fail(c, "NVIDIA NIM Free Endpoint: uso restrito ao administrador em testes.", 403);
    }
    const adapter = models.findImageEditAdapter(parsed.data.model);
    if (!adapter) {
      return fail(
        c,
        `Edição indisponível: nenhum adaptador de edição para "${parsed.data.model}". ` +
        `Configure a GPU externa (EXTERNAL_GPU_URL + COMFY_WORKFLOW_EDIT) — ver docs/GPU-EXTERNA.md.`,
        503
      );
    }
    if (!(await adapter.ping().catch(() => false))) {
      return fail(c, "GPU externa inacessível agora. Verifique o ComfyUI e tente de novo.", 503);
    }
    const result = await adapter.edit({
      model: parsed.data.model,
      prompt: parsed.data.prompt,
      format: "1:1",
      width: 1024,
      height: 1024,
      seed: parsed.data.seed,
      image: obj.data,
      imageName: file.name,
    });

    const ext = result.mime === "image/png" ? "png" : "jpg";
    const fileId = uid("fil");
    const outKey = `images/${user.id}/${fileId}.${ext}`;
    await storage.put(outKey, result.data, result.mime);
    const url = storage.urlFor(outKey);
    const saved = await db.saveFile({
      id: fileId, userId: user.id,
      name: `edicao-${Date.now()}.${ext}`,
      mime: result.mime, size: result.data.byteLength, url, createdAt: nowIso(),
    });
    const image = await db.saveImage({
      id: uid("img"), userId: user.id, prompt: `[edição de ${file.name}] ${parsed.data.prompt}`,
      format: "1:1", modelId: parsed.data.model, fileId: saved.id, url,
      width: 1024, height: 1024, createdAt: nowIso(),
    });
    await db.logUsage({
      userId: user.id, modelId: parsed.data.model, kind: "image",
      tokensIn: 0, tokensOut: 0, costFlag: result.paid,
      ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    });
    return ok(c, { image });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha ao editar imagem.";
    await db.logAudit({ userId: user.id, action: "image.edit.error", detail: msg.slice(0, 500) });
    return fail(c, msg, 502);
  }
});

imageRoutes.get("/", requireAuth, async (c) => {
  const images = await c.get("db").listImages(c.get("user").id);
  return ok(c, { images });
});

imageRoutes.get("/:id", requireAuth, async (c) => {
  const img = await c.get("db").getImage(c.req.param("id"), c.get("user").id);
  if (!img) return fail(c, "Imagem não encontrada.", 404);
  return ok(c, { image: img });
});

imageRoutes.delete("/:id", requireAuth, async (c) => {
  const db = c.get("db");
  const img = await db.getImage(c.req.param("id"), c.get("user").id);
  if (!img) return fail(c, "Imagem não encontrada.", 404);
  await db.deleteImage(img.id, c.get("user").id);
  return ok(c, { deleted: true });
});

/** Legenda publicitária automática para uma imagem (usa o chat). */
imageRoutes.post("/:id/caption", requireAuth, async (c) => {
  const db = c.get("db");
  const models = c.get("models");
  const user = c.get("user");
  const img = await db.getImage(c.req.param("id"), user.id);
  if (!img) return fail(c, "Imagem não encontrada.", 404);

  const schema = z.object({
    network: z.enum(["instagram", "facebook", "whatsapp"]).default("instagram"),
    tone: z.string().max(60).default("profissional e acolhedor"),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Dados inválidos.", 400);

  try {
    const modelId = await models.autoSelectText("chat");
    const adapter = models.findTextAdapter(modelId);
    if (!adapter) return fail(c, "Modelo de texto indisponível.", 502);
    const result = await adapter.chat({
      model: modelId,
      messages: [{
        role: "user",
        content: `Crie uma legenda publicitária em português brasileiro para ${parsed.data.network}, tom ${parsed.data.tone}, sobre: "${img.prompt}". Inclua chamada para ação e 5 hashtags. Responda só a legenda.`,
      }],
    });
    await db.logUsage({ userId: user.id, modelId, kind: "chat", tokensIn: result.tokensIn, tokensOut: result.tokensOut, costFlag: result.paid });
    return ok(c, { caption: result.text, model: modelId });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao gerar legenda.", 502);
  }
});
