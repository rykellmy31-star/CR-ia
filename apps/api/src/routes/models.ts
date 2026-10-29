/** Catálogo multimodelo: lista real com disponibilidade + seleção admin. */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { maybeAutoSync } from "../services/openrouter.js";
import type { ModelRegistry } from "../adapters/ai/registry.js";

declare module "hono" {
  interface ContextVariableMap {
    models: ModelRegistry;
  }
}

export const modelRoutes = new Hono<{ Bindings: Env }>();

modelRoutes.get("/", requireAuth, async (c) => {
  const models = c.get("models");
  // Sync automático do catálogo OpenRouter quando devido (não bloqueia a lista).
  void maybeAutoSync(c.env, c.get("db"), (entries, at) => models.setOpenRouterCatalog(entries, at))
    .catch(() => null);
  const list = await models.listModels();
  return ok(c, {
    // Free Endpoints NVIDIA são somente para administradores (prototipagem).
    models: c.get("user").role === "admin" ? list : list.filter((m) => m.provider !== "nvidia"),
    defaults: { chat: models.defaultChatModel, image: models.defaultImageModel },
    blockPaid: models.blockPaid(),
  });
});

const selectSchema = z.object({
  defaultChat: z.string().optional(),
  defaultImage: z.string().optional(),
  disabled: z.array(z.string()).max(2000).optional(),
  blockPaid: z.boolean().optional(),
  /** Modelos pagos com ativação explícita do admin (por id). */
  paidAck: z.array(z.string().max(200)).max(2000).optional(),
});

modelRoutes.post("/select", requireAuth, requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = selectSchema.safeParse(body);
  if (!parsed.success) return fail(c, "Dados inválidos.", 400);

  const db = c.get("db");
  const models = c.get("models");
  const { defaultChat, defaultImage, disabled, blockPaid, paidAck } = parsed.data;
  if (defaultChat?.startsWith("nvidia-nim:") || defaultImage?.startsWith("nvidia-nim:")) {
    return fail(c, "NVIDIA NIM não pode ser padrão global: somente testes administrativos.", 403);
  }

  if (defaultChat !== undefined) await db.setSetting("models.defaultChat", defaultChat);
  if (defaultImage !== undefined) await db.setSetting("models.defaultImage", defaultImage);
  if (disabled !== undefined) await db.setSetting("models.disabled", JSON.stringify(disabled));
  if (blockPaid !== undefined) await db.setSetting("models.blockPaid", blockPaid ? "true" : "false");
  if (paidAck !== undefined) await db.setSetting("models.paidAck", JSON.stringify(paidAck));

  models.applyOverrides({
    defaultChat: defaultChat ?? models.defaultChatModel,
    defaultImage: defaultImage ?? models.defaultImageModel,
    disabled: disabled ?? [...models.disabled],
  });
  if (blockPaid !== undefined) {
    // Override em memória + persistido; recarrega no próximo boot via settings.
    (models as unknown as { env: Env }).env.BLOCK_PAID_PROVIDERS = blockPaid ? "true" : "false";
  }
  if (paidAck !== undefined) models.setPaidAck(paidAck);

  await db.logAudit({
    userId: c.get("user").id,
    action: "models.select",
    detail: JSON.stringify(parsed.data),
  });
  return ok(c, { saved: true });
});

/**
 * Modelo padrão individual (qualquer usuário autenticado; vale para "auto").
 * Guardado em settings `user.defaultChat.<userId>`.
 */
modelRoutes.get("/preference", requireAuth, async (c) => {
  const { userDefaultChatKey } = await import("./chat.js");
  const v = await c.get("db").getSetting(userDefaultChatKey(c.get("user").id));
  return ok(c, { defaultChat: v ?? "auto" });
});

const prefSchema = z.object({ defaultChat: z.string().min(1).max(120).nullable() });

modelRoutes.post("/preference", requireAuth, async (c) => {
  const parsed = prefSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { defaultChat: \"id-do-modelo\" | null }.", 400);
  const { userDefaultChatKey } = await import("./chat.js");
  const db = c.get("db");
  const key = userDefaultChatKey(c.get("user").id);
  const v = parsed.data.defaultChat;
  if (v === null || v === "auto") {
    await db.deleteSetting(key);
    return ok(c, { defaultChat: "auto" });
  }
  if (v.startsWith("nvidia-nim:") && c.get("user").role !== "admin") return fail(c, "NVIDIA NIM: somente testes administrativos.", 403);
  const models = c.get("models");
  const adapter = models.findTextAdapter(v);
  if (!adapter || !adapter.models().includes(v)) return fail(c, `Modelo "${v}" desconhecido.`, 400);
  await db.setSetting(key, v);
  return ok(c, { defaultChat: v });
});

const testSchema = z.object({ model: z.string().min(1).max(120) });

/**
 * Teste REAL de inferência (admin): executa uma chamada mínima no modelo e
 * devolve latência + amostra. Prova que o modelo responde de verdade —
 * não basta o ping de disponibilidade.
 */
modelRoutes.post("/test", requireAuth, requireAdmin, async (c) => {
  const parsed = testSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { model: \"id-do-modelo\" }.", 400);

  const models = c.get("models");
  const db = c.get("db");
  const modelId = parsed.data.model;
  try {
    models.assertUsable(modelId);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Modelo bloqueado.", 403);
  }
  if ((await models.modelKeyState(modelId)) === "needs-credentials") {
    return fail(c, `Indisponível — Configurar API: cadastre a chave em Administração → Credenciais antes de testar "${modelId}".`, 400);
  }

  const textAdapter = models.findTextAdapter(modelId);
  const imageAdapter = !textAdapter ? models.findImageAdapter(modelId) : null;
  if (!textAdapter && !imageAdapter) return fail(c, `Modelo "${modelId}" desconhecido.`, 404);

  const started = Date.now();
  models.markTesting(modelId, true);
  try {
    if (textAdapter) {
      const r = await textAdapter.chat({
        model: modelId,
        messages: [{ role: "user", content: "Responda apenas com a palavra: OK" }],
        temperature: 0,
        maxTokens: 16,
      });
      const latencyMs = Date.now() - started;
      models.markTest(modelId, { ok: true, latencyMs, at: new Date().toISOString() });
      await db.logAudit({
        userId: c.get("user").id, action: "models.test",
        detail: `${modelId} ok em ${latencyMs}ms`,
      });
      return ok(c, {
        model: modelId, kind: "text", ok: true, latencyMs,
        provider: textAdapter.provider,
        tokensIn: r.tokensIn, tokensOut: r.tokensOut,
        sample: r.text.slice(0, 200),
      });
    }
    const r = await imageAdapter!.generate({
      model: modelId, prompt: "red apple on wooden table, photo",
      format: "1:1", width: 256, height: 256,
    });
    const latencyMs = Date.now() - started;
    models.markTest(modelId, { ok: true, latencyMs, at: new Date().toISOString(), detail: `${r.data.byteLength} bytes` });
    await db.logAudit({
      userId: c.get("user").id, action: "models.test",
      detail: `${modelId} ok em ${latencyMs}ms (${r.data.byteLength} bytes)`,
    });
    return ok(c, {
      model: modelId, kind: "image", ok: true, latencyMs,
      provider: imageAdapter!.provider, mime: r.mime, bytes: r.data.byteLength,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha no teste.";
    models.markTest(modelId, { ok: false, latencyMs: Date.now() - started, at: new Date().toISOString(), detail: msg.slice(0, 200) });
    await db.logAudit({ userId: c.get("user").id, action: "models.test.failed", detail: `${modelId} :: ${msg.slice(0, 200)}` });
    return fail(c, `Teste falhou após ${Date.now() - started}ms: ${msg}`, 502);
  } finally {
    models.markTesting(modelId, false);
  }
});
