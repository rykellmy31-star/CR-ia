/**
 * CR IA v0.3.0 — Administração da OpenRouter (provedor primário).
 * Montado sob /api/admin/openrouter (sempre exige admin).
 * - Chave: status mascarado, atualização segura (cofre) e teste sem gasto.
 * - Catálogo dinâmico: sync manual + config do sync automático + relatório.
 * A chave do .env (se existir) continua valendo e tem prioridade; o painel
 * nunca exibe o valor completo, só a máscara.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  freeCredentialStatus, resolveProviderKey, storeProviderKey,
} from "../services/credentials.js";
import {
  OR_SYNC_KEY, loadCatalog, loadReport, loadSyncConfig,
  syncCatalog, testKey,
} from "../services/openrouter.js";

export const orAdminRoutes = new Hono<{ Bindings: Env }>();

orAdminRoutes.use("*", requireAuth, requireAdmin);

async function orKeyStatus(env: Env, db: Parameters<typeof freeCredentialStatus>[1]) {
  const all = await freeCredentialStatus(env, db);
  return all.find((c) => c.provider === "openrouter") ?? null;
}

orAdminRoutes.get("/status", async (c) => {
  const db = c.get("db");
  const key = await orKeyStatus(c.env, db);
  const [catalog, report, syncCfg, lastSync] = await Promise.all([
    loadCatalog(db),
    loadReport(db),
    loadSyncConfig(db),
    db.getSetting("openrouter.lastSync").catch(() => null),
  ]);
  // Teste ao vivo SOMENTE se há chave (GET /auth/key: oficial, sem gasto).
  let ping: Awaited<ReturnType<typeof testKey>> | null = null;
  if (key?.configured) {
    const secret = await resolveProviderKey(c.env, db, "openrouter").catch(() => "");
    if (secret) ping = await testKey(c.env, secret, fetch, 8000);
  }
  const models = catalog?.models ?? [];
  return ok(c, {
    key: key ? { configured: key.configured, source: key.source, masked: key.masked } : null,
    ping,
    catalog: catalog
      ? {
        total: models.length,
        text: models.filter((m) => m.text).length,
        image: models.filter((m) => m.image).length,
        free: models.filter((m) => m.free).length,
        paidOrUnknown: models.filter((m) => !m.free).length,
        at: catalog.at,
      }
      : null,
    sync: { ...syncCfg, lastSync },
    report,
  });
});

const keySchema = z.object({ key: z.string().min(8).max(500) });

/** Guarda/atualiza a chave no cofre (preserva a do .env; nunca expõe o valor). */
orAdminRoutes.post("/key", async (c) => {
  const parsed = keySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { key } (mínimo 8 caracteres).", 400);
  try {
    const { masked } = await storeProviderKey(c.env, c.get("db"), "openrouter", parsed.data.key);
    await c.get("db").logAudit({
      userId: c.get("user").id, action: "admin.openrouter.key.saved", detail: masked,
    });
    return ok(c, {
      saved: true,
      masked,
      note: "Chave guardada no cofre. Se houver OPENROUTER_API_KEY no .env, ela continua tendo prioridade.",
    });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao guardar chave.", 400);
  }
});

/** Testa uma chave (informada ou a configurada) sem salvar e sem gastar. */
orAdminRoutes.post("/key/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
  const provided = typeof body.key === "string" && body.key.trim().length >= 8 ? body.key.trim() : "";
  const secret = provided || (await resolveProviderKey(c.env, c.get("db"), "openrouter").catch(() => ""));
  if (!secret) return fail(c, "Nenhuma chave para testar — informe { key } ou configure primeiro.", 400);
  const info = await testKey(c.env, secret, fetch, 15000);
  await c.get("db").logAudit({
    userId: c.get("user").id,
    action: "admin.openrouter.key.tested",
    detail: info.ok ? `ok label=${info.label ?? "?"} usage=${info.usage ?? "?"} limit=${info.limit ?? "?"}` : (info.error ?? "fail"),
  });
  return ok(c, { info, testedProvidedKey: Boolean(provided) });
});

/** ATUALIZAR MODELOS DE IA — sync manual agora (descoberta pública, sem gasto). */
orAdminRoutes.post("/sync", async (c) => {
  const db = c.get("db");
  const models = c.get("models");
  try {
    const report = await syncCatalog(c.env, db, { source: "manual", timeoutMs: 25000 });
    const cat = await loadCatalog(db);
    models.setOpenRouterCatalog(cat?.models ?? [], report.at);
    await db.logAudit({
      userId: c.get("user").id,
      action: "admin.openrouter.sync",
      detail: `total=${report.total} added=${report.added.length} updated=${report.updated.length} removed=${report.removed.length}`,
    });
    return ok(c, { report });
  } catch (e) {
    await db.logAudit({
      userId: c.get("user").id, action: "admin.openrouter.sync.failed",
      detail: e instanceof Error ? e.message : "falha",
    });
    return fail(c, e instanceof Error ? e.message : "Falha na sincronização.", 502);
  }
});

const syncConfigSchema = z.object({
  auto: z.boolean(),
  intervalHours: z.number().int().min(1).max(168),
});

/** Configura o sync automático (padrão: ligado, 24h). */
orAdminRoutes.post("/sync-config", async (c) => {
  const parsed = syncConfigSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { auto: boolean, intervalHours: 1..168 }.", 400);
  await c.get("db").setSetting(OR_SYNC_KEY, JSON.stringify(parsed.data));
  await c.get("db").logAudit({
    userId: c.get("user").id, action: "admin.openrouter.sync_config",
    detail: JSON.stringify(parsed.data),
  });
  return ok(c, { saved: true, config: parsed.data });
});

/** Último relatório de sync + resumo do catálogo (para o painel). */
orAdminRoutes.get("/report", async (c) => {
  const db = c.get("db");
  const [catalog, report, syncCfg, lastSync] = await Promise.all([
    loadCatalog(db),
    loadReport(db),
    loadSyncConfig(db),
    db.getSetting("openrouter.lastSync").catch(() => null),
  ]);
  const models = catalog?.models ?? [];
  return ok(c, {
    report,
    catalog: catalog
      ? {
        total: models.length, text: models.filter((m) => m.text).length,
        image: models.filter((m) => m.image).length, free: models.filter((m) => m.free).length,
        paidOrUnknown: models.filter((m) => !m.free).length, at: catalog.at,
      }
      : null,
    sync: { ...syncCfg, lastSync },
  });
});
