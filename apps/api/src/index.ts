/**
 * CR IA — aplicação HTTP (Hono). Mesmo código no Node (VPS/dev) e no Workers (CF).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { securityHeaders } from "./middleware/security.js";
import type { Env } from "./types.js";
import { createDb } from "./adapters/db/factory.js";
import { createStorage } from "./adapters/storage/factory.js";
import { createRegistry } from "./adapters/ai/registry.js";
import { makeKeySource } from "./services/credentials.js";
import { currentVersion } from "./services/updates.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { modelRoutes } from "./routes/models.js";
import { imageRoutes } from "./routes/images.js";
import { fileRoutes } from "./routes/files.js";
import { taskRoutes } from "./routes/tasks.js";
import { adminRoutes } from "./routes/admin.js";
import { aiRoutes } from "./routes/ai.js";
import { agentRoutes } from "./routes/agent.js";
import { memoryRoutes } from "./routes/memory.js";
import { ok } from "./lib/respond.js";

export function createApp(env: Env) {
  const db = createDb(env);
  const storage = createStorage(env);
  const models = createRegistry(env);
  models.setKeySource(makeKeySource(env, db));

  const app = new Hono<{ Bindings: Env }>();

  // Sobe o banco uma vez por instância + aplica overrides do admin
  let booted = false;
  app.use("*", async (c, next) => {
    c.env = { ...env, ...c.env } as Env;
    c.set("db", db);
    c.set("storage", storage);
    c.set("models", models);
    if (!booted) {
      booted = true;
      try {
        await db.init();
        const [dChat, dImg, dis, bp, pack, orCat, nvidiaApproved, nvidiaCosmos] = await Promise.all([
          db.getSetting("models.defaultChat"),
          db.getSetting("models.defaultImage"),
          db.getSetting("models.disabled"),
          db.getSetting("models.blockPaid"),
          db.getSetting("models.paidAck"),
          db.getSetting("openrouter.catalog"),
          db.getSetting("nvidia.approved"),
          db.getSetting("nvidia.cosmos.enabled"),
        ]);
        models.setNvidiaCosmosEnabled(nvidiaCosmos === "true");
        if (nvidiaApproved) {
          try { models.setNvidiaModels(JSON.parse(nvidiaApproved) as string[]); } catch { /* mantém vazio */ }
        }
        if (pack) {
          try { models.setPaidAck(JSON.parse(pack) as string[]); } catch { /* segue vazio */ }
        }
        let catalogLoaded = false;
        if (orCat) {
          try {
            const parsed = JSON.parse(orCat) as { v: number; at: string; models: Array<{ id: string }> };
            if (parsed?.v === 1 && Array.isArray(parsed.models)) {
              const { loadCatalog } = await import("./services/openrouter.js");
              const cat = await loadCatalog(db);
              if (cat) {
                models.setOpenRouterCatalog(cat.models, cat.at);
                catalogLoaded = true;
              }
            }
          } catch { /* sync abaixo tenta de novo */ }
        }
        if (!catalogLoaded) {
          // 1º boot (ou catálogo perdido): tenta o sync sem travar a subida.
          void import("./services/openrouter.js").then(async ({ syncCatalog, loadCatalog }) => {
            try {
              const report = await syncCatalog(env, db, { source: "boot", timeoutMs: 25000 });
              const cat = await loadCatalog(db);
              models.setOpenRouterCatalog(cat?.models ?? [], report.at);
              console.log(`[CR IA] catálogo OpenRouter sincronizado no boot (${report.total} modelos).`);
            } catch (e) {
              console.log("[CR IA] sync OpenRouter no boot falhou (tenta de novo no /models):", e instanceof Error ? e.message : e);
            }
          });
        }
        models.applyOverrides({
          defaultChat: dChat,
          defaultImage: dImg,
          disabled: dis ? (JSON.parse(dis) as string[]) : undefined,
        });
        if (bp === "true" || bp === "false") {
          (models as unknown as { env: Env }).env.BLOCK_PAID_PROVIDERS = bp;
        }
      } catch (e) {
        console.error("[CR IA] falha no boot do banco:", e);
      }
    }
    await next();
  });

  const origins = (env.CORS_ORIGINS ?? "http://localhost:5173")
    .split(",").map((s) => s.trim()).filter(Boolean);
  app.use("*", cors({ origin: origins.length ? origins : ["http://localhost:5173"], credentials: true }));
  app.use("*", securityHeaders);
  if ((env.NODE_ENV ?? "development") !== "production") {
    app.use("*", logger());
  }

  app.get("/api/health", (c) =>
    ok(c, {
      status: "ok",
      app: "cr-ia",
      version: currentVersion(),
      time: new Date().toISOString(),
      drivers: { db: db.driver, storage: storage.driver },
    })
  );

  app.route("/api/auth", authRoutes);
  app.route("/api/chat", chatRoutes);
  app.route("/api/models", modelRoutes);
  app.route("/api/images", imageRoutes);
  app.route("/api/files", fileRoutes);
  app.route("/api/tasks", taskRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/ai", aiRoutes);
  app.route("/api/agent", agentRoutes);
  app.route("/api/memory", memoryRoutes);

  app.notFound((c) => c.json({ ok: false, error: "Rota não encontrada.", code: "NOT_FOUND" }, 404));
  app.onError((err, c) => {
    console.error("[CR IA] erro:", err);
    return c.json({ ok: false, error: "Erro interno. Tente novamente.", code: "INTERNAL" }, 500);
  });

  return { app, db, storage, models };
}

export type CrIaApp = ReturnType<typeof createApp>;
