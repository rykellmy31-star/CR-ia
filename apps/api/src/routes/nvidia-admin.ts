/** Administração NVIDIA NIM: consulta sem custo e aprovação MANUAL de modelos.
 * A lista /v1/models inclui modelos não-inferíveis e/ou não gratuitos.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { resolveProviderKey, storeProviderKey, keyFromEnv } from "../services/credentials.js";
import { discoverNvidia, readNvidiaApproved, readNvidiaCatalog, NVIDIA_APPROVED_KEY } from "../services/nvidia.js";
import { nvidiaId } from "../adapters/ai/nvidia-nim.js";
import { NVIDIA_COSMOS_IMAGE_ID } from "../adapters/ai/nvidia-image.js";

export const nvidiaAdminRoutes = new Hono<{ Bindings: Env }>();
nvidiaAdminRoutes.use("*", requireAuth, requireAdmin);

nvidiaAdminRoutes.get("/status", async (c) => {
  const [key, catalog, approved] = await Promise.all([
    resolveProviderKey(c.env, c.get("db"), "nvidia"),
    readNvidiaCatalog(c.get("db")), readNvidiaApproved(c.get("db")),
  ]);
  const cosmosEnabled = (await c.get("db").getSetting("nvidia.cosmos.enabled")) === "true";
  return ok(c, { configured: Boolean(key), source: keyFromEnv(c.env, "nvidia") ? "env" : key ? "vault" : "none", catalog, approved,
    image: { modelId: NVIDIA_COSMOS_IMAGE_ID, enabled: cosmosEnabled, freeEndpointVerified: true,
      note: "Cosmos3 Nano gera imagens Physical AI pelo endpoint text2image; uso exclusivo de prototipagem. FLUX/Stable Diffusion não foram confirmados como Free Endpoint." },
    notice: "Free Endpoint é limitado a desenvolvimento/testes. /v1/models NÃO comprova que o modelo é gratuito nem aceita chat." });
});

nvidiaAdminRoutes.post("/key", async (c) => {
  const body = z.object({ key: z.string().min(8).max(500) }).safeParse(await c.req.json().catch(() => ({})));
  if (!body.success) return fail(c, "Chave inválida.", 400);
  try {
    const saved = await storeProviderKey(c.env, c.get("db"), "nvidia", body.data.key);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.nvidia.key.saved", detail: saved.masked });
    return ok(c, saved);
  } catch (e) { return fail(c, e instanceof Error ? e.message : "Falha ao salvar chave NVIDIA.", 400); }
});

nvidiaAdminRoutes.post("/sync", async (c) => {
  const key = await resolveProviderKey(c.env, c.get("db"), "nvidia");
  if (!key) return fail(c, "Configure a chave NVIDIA primeiro.", 400);
  try {
    const catalog = await discoverNvidia(c.env, c.get("db"), key);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.nvidia.sync", detail: `candidatos=${catalog.models.length}` });
    return ok(c, { catalog });
  } catch (e) { return fail(c, e instanceof Error ? e.message : "Falha na consulta NVIDIA.", 502); }
});

const approveSchema = z.object({
  models: z.array(z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/)).max(300),
  /** O usuário confirmou consultando o selo Free Endpoint e uso em testes. */
  confirmFreeEndpointAndDevOnly: z.literal(true),
});
nvidiaAdminRoutes.post("/approve", async (c) => {
  const parsed = approveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Confirme explicitamente Free Endpoint e uso apenas para testes.", 400);
  const catalog = await readNvidiaCatalog(c.get("db"));
  if (!catalog) return fail(c, "Sincronize o catálogo NVIDIA antes de aprovar.", 400);
  const known = new Set(catalog.models);
  const selected = [...new Set(parsed.data.models)];
  if (selected.some((id) => id.includes("cosmos3-nano"))) {
    return fail(c, "Cosmos3 Nano utiliza a API de imagem. Ative-o na seção Imagens NVIDIA, não como chat.", 400);
  }
  if (selected.some((id) => !known.has(id))) return fail(c, "Há modelos fora do catálogo atual. Sincronize novamente.", 400);
  await c.get("db").setSetting(NVIDIA_APPROVED_KEY, JSON.stringify(selected));
  c.get("models").setNvidiaModels(selected.map(nvidiaId));
  await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.nvidia.approved", detail: `quantidade=${selected.length}` });
  return ok(c, { approved: selected });
});

/** Habilita SOMENTE Cosmos3 Nano: imagem em teste/admin. Sem inferência nem cobrança nesta rota. */
nvidiaAdminRoutes.post("/image/enable", async (c) => {
  const parsed = z.object({
    enabled: z.boolean(),
    confirmFreeEndpointAndDevOnly: z.literal(true),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Confirme o uso exclusivo de testes administrativos.", 400);
  if (parsed.data.enabled && !(await resolveProviderKey(c.env, c.get("db"), "nvidia"))) {
    return fail(c, "Configure a NVIDIA API Key primeiro.", 400);
  }
  await c.get("db").setSetting("nvidia.cosmos.enabled", String(parsed.data.enabled));
  c.get("models").setNvidiaCosmosEnabled(parsed.data.enabled);
  await c.get("db").logAudit({
    userId: c.get("user").id,
    action: "admin.nvidia.cosmos.enabled",
    detail: String(parsed.data.enabled),
  });
  return ok(c, { modelId: NVIDIA_COSMOS_IMAGE_ID, enabled: parsed.data.enabled });
});

/** Ferramentas de busca semântica: acesso exclusivo do Superadmin, sob demanda. */
nvidiaAdminRoutes.post("/retrieval/embed", async (c) => {
  const schema = z.object({
    model: z.enum(["nvidia/nemotron-3.5-embed-1b", "nvidia/nemotron-3.5-embed-8b"]),
    input: z.string().min(1).max(3000),
    inputType: z.enum(["query", "passage"]).default("query"),
    confirmDevOnly: z.literal(true),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Dados inválidos. Uso exclusivo para desenvolvimento/testes.", 400);
  const key = await resolveProviderKey(c.env, c.get("db"), "nvidia");
  if (!key) return fail(c, "Configure a NVIDIA API Key.", 400);
  try {
    const { nvidiaEmbed } = await import("../services/nvidia-retrieval.js");
    const value = await nvidiaEmbed(c.env, key, parsed.data.model, parsed.data.input, parsed.data.inputType);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.nvidia.embed.test", detail: `${value.model}, dimensions=${value.dimensions}` });
    return ok(c, { model: value.model, dimensions: value.dimensions, preview: value.vector.slice(0, 8) });
  } catch (e) { return fail(c, e instanceof Error ? e.message : "Falha de embedding NVIDIA.", 502); }
});

nvidiaAdminRoutes.post("/retrieval/rerank", async (c) => {
  const parsed = z.object({
    query: z.string().min(1).max(1000),
    passages: z.array(z.string().min(1).max(2000)).min(1).max(10),
    confirmDevOnly: z.literal(true),
  }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Dados inválidos. Uso exclusivo para desenvolvimento/testes.", 400);
  const key = await resolveProviderKey(c.env, c.get("db"), "nvidia");
  if (!key) return fail(c, "Configure a NVIDIA API Key.", 400);
  try {
    const { nvidiaRerank } = await import("../services/nvidia-retrieval.js");
    const ranking = await nvidiaRerank(key, parsed.data.query, parsed.data.passages);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.nvidia.rerank.test", detail: `${parsed.data.passages.length} passages` });
    return ok(c, { ranking });
  } catch (e) { return fail(c, e instanceof Error ? e.message : "Falha de reranking NVIDIA.", 502); }
});
