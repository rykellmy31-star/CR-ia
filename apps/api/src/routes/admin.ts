/** Painel administrativo: usuários, uso, tarefas, logs e integrações. */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { bumpTokenVersion, currentTokenVersion, requireAdmin, requireAuth } from "../middleware/auth.js";
import { toPublicUser } from "../adapters/db/types.js";
import { hashPassword } from "../lib/crypto.js";
import { getNum } from "../lib/config.js";
import { csv } from "../lib/config.js";
import { credentialStatus, deleteProviderKey, deleteSearchKey, freeCredentialStatus, isSearchCred, keyFromEnv, searchCredentialStatus, searchKeyFromEnv, storeProviderKey, storeSearchKey } from "../services/credentials.js";
import { isFreeKeyedProvider, isKeyedProvider, type KeyedProvider } from "../adapters/ai/providers.js";
import { applyStaged, checkForUpdates, compareVersions, currentVersion, fetchManifest, readCachedStatus, stageUpdate } from "../services/updates.js";
import { orAdminRoutes } from "./openrouter-admin.js";
import { nvidiaAdminRoutes } from "./nvidia-admin.js";

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.route("/openrouter", orAdminRoutes);
adminRoutes.route("/nvidia", nvidiaAdminRoutes);

adminRoutes.get("/stats", async (c) => {
  const db = c.get("db");
  const models = c.get("models");
  const [users, usage, tasks, audit] = await Promise.all([
    db.listUsers(),
    db.usageSummary(),
    db.listTasks(),
    db.listAudit(20),
  ]);
  const byStatus: Record<string, number> = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  return ok(c, {
    users: users.length,
    usage,
    tasks: { total: tasks.length, byStatus },
    recentAudit: audit,
    drivers: {
      db: db.driver,
      storage: c.get("storage").driver,
      chatProvider: c.env.CHAT_PROVIDER ?? "mock",
      imageProvider: c.env.IMAGE_PROVIDER ?? "mock-svg",
      blockPaid: models.blockPaid(),
    },
  });
});

adminRoutes.get("/users", async (c) => {
  const users = await c.get("db").listUsers();
  return ok(c, { users: users.map(toPublicUser) });
});

const upsertSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(80),
  password: z.string().min(8).optional(),
  role: z.enum(["admin", "guest", "user"]).optional(),
  blocked: z.boolean().optional(),
});

adminRoutes.post("/users", async (c) => {
  const parsed = upsertSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);
  if (!parsed.data.password) return fail(c, "Informe a senha inicial.", 400);
  const db = c.get("db");
  if (await db.getUserByEmail(parsed.data.email)) return fail(c, "E-mail já cadastrado.", 409);
  const cost = getNum(c, "BCRYPT_COST", 10);
  const rec = await db.createUser({
    email: parsed.data.email,
    name: parsed.data.name,
    role: parsed.data.role ?? "user",
    passwordHash: await hashPassword(parsed.data.password, cost),
  });
  if (parsed.data.blocked) await db.updateUser(rec.id, { blocked: true });
  await db.logAudit({ userId: c.get("user").id, action: "admin.user.created", detail: rec.email });
  return ok(c, { user: toPublicUser(rec) }, 201);
});

adminRoutes.patch("/users/:id", async (c) => {
  const schema = z.object({
    name: z.string().min(2).max(80).optional(),
    role: z.enum(["admin", "guest", "user"]).optional(),
    blocked: z.boolean().optional(),
    password: z.string().min(8).optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Dados inválidos.", 400);
  const db = c.get("db");
  const patch: Parameters<DbAdapter["updateUser"]>[1] = {};
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.role !== undefined) patch.role = parsed.data.role;
  if (parsed.data.blocked !== undefined) patch.blocked = parsed.data.blocked;
  if (parsed.data.password !== undefined) {
    patch.passwordHash = await hashPassword(parsed.data.password, getNum(c, "BCRYPT_COST", 10));
  }
  const updated = await db.updateUser(c.req.param("id"), patch);
  if (!updated) return fail(c, "Usuário não encontrado.", 404);
  await db.logAudit({ userId: c.get("user").id, action: "admin.user.updated", detail: updated.email });
  return ok(c, { user: toPublicUser(updated) });
});

adminRoutes.delete("/users/:id", async (c) => {
  const me = c.get("user");
  if (c.req.param("id") === me.id) return fail(c, "Você não pode excluir a própria conta.", 400);
  const gone = await c.get("db").deleteUser(c.req.param("id"));
  if (!gone) return fail(c, "Usuário não encontrado.", 404);
  await c.get("db").logAudit({ userId: me.id, action: "admin.user.deleted", detail: c.req.param("id") });
  return ok(c, { deleted: true });
});

adminRoutes.get("/audit", async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 200)));
  const logs = await c.get("db").listAudit(limit);
  return ok(c, { logs });
});

adminRoutes.get("/integrations", async (c) => {
  // Status SEM expor segredos: apenas "configurado/não" + testes de ping.
  const models = c.get("models");
  const ollama = models.textAdapters.find((a) => a.provider === "ollama");
  const ollamaOk = ollama ? await ollama.ping().catch(() => false) : false;
  return ok(c, {
    integrations: {
      ollama: { configured: Boolean(c.env.OLLAMA_URL || c.env.CHAT_PROVIDER === "ollama"), reachable: ollamaOk, url: maskUrl(c.env.OLLAMA_URL) },
      workersAi: { available: Boolean(c.env.AI) },
      github: {
        configured: Boolean(c.env.GITHUB_TOKEN),
        allowedRepos: csv(c.env.GITHUB_ALLOWED_REPOS),
        requireApproval: (c.env.GITHUB_REQUIRE_APPROVAL ?? "true") !== "false",
      },
      aiLocal: {
        configured: Boolean(c.env.AI_LOCAL_URL),
        reachable: models.transcriptionAdapter()
          ? await models.transcriptionAdapter()!.ping().catch(() => false)
          : false,
        url: maskUrl(c.env.AI_LOCAL_URL),
      },
      webSearch: { configured: Boolean(c.env.SEARXNG_URL), url: maskUrl(c.env.SEARXNG_URL) },
      smtp: { configured: Boolean(c.env.SMTP_HOST) },
      externalGpu: { configured: Boolean(c.env.EXTERNAL_GPU_URL), url: maskUrl(c.env.EXTERNAL_GPU_URL) },
      pollinations: {
        enabled: (c.env.ENABLE_POLLINATIONS ?? "false") === "true",
        hasApiKey: Boolean(c.env.POLLINATIONS_API_KEY),
        imageModel: c.env.POLLINATIONS_IMAGE_MODEL ?? "flux",
      },
      agent: {
        workDir: c.env.AGENT_WORK_DIR ?? "/agentwork",
        approvalsAlwaysRequired: true,
        maxParallel: Number(c.env.AGENT_MAX_PARALLEL_RUNS ?? "1"),
      },
      database: { driver: c.get("db").driver },
      storage: { driver: c.get("storage").driver },
    },
  });
});

/**
 * Credenciais de APIs (status sem expor segredos — só máscara + origem).
 * credentials = IAs pagas; free = IAs grátis com chave; search = busca web.
 */
adminRoutes.get("/credentials", async (c) => {
  const db = c.get("db");
  const [credentials, free, search] = await Promise.all([
    credentialStatus(c.env, db),
    freeCredentialStatus(c.env, db),
    searchCredentialStatus(c.env, db),
  ]);
  return ok(c, { credentials, free, search });
});

const credentialSchema = z.object({
  provider: z.string().min(1).max(30),
  key: z.string().min(8).max(500),
});

/** Guarda/atualiza chave no cofre cifrado (exige CREDENTIALS_SECRET no .env). */
adminRoutes.post("/credentials", async (c) => {
  const parsed = credentialSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { provider, key }.", 400);
  const p = parsed.data.provider;
  if (!isKeyedProvider(p) && !isFreeKeyedProvider(p) && !isSearchCred(p)) {
    return fail(c, `Provedor "${p}" desconhecido.`, 400);
  }
  try {
    const { masked } = isSearchCred(p)
      ? await storeSearchKey(c.env, c.get("db"), p, parsed.data.key)
      : await storeProviderKey(c.env, c.get("db"), p as KeyedProvider, parsed.data.key);
    await c.get("db").logAudit({
      userId: c.get("user").id, action: "admin.credential.saved", detail: `${p} ${masked}`,
    });
    return ok(c, { saved: true, provider: p, masked });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao guardar credencial.", 400);
  }
});

/** Remove chave do cofre (a env, se existir, continua valendo — avisado na resposta). */
adminRoutes.delete("/credentials/:provider", async (c) => {
  const p = c.req.param("provider");
  if (isKeyedProvider(p) || isFreeKeyedProvider(p)) {
    await deleteProviderKey(c.env, c.get("db"), p as KeyedProvider);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.credential.deleted", detail: p });
    return ok(c, { deleted: true, provider: p, envStillConfigured: keyFromEnv(c.env, p as KeyedProvider).length > 0 });
  }
  if (isSearchCred(p)) {
    await deleteSearchKey(c.env, c.get("db"), p);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.credential.deleted", detail: `search:${p}` });
    return ok(c, { deleted: true, provider: p, envStillConfigured: searchKeyFromEnv(c.env, p).length > 0 });
  }
  return fail(c, `Provedor "${p}" desconhecido.`, 400);
});

adminRoutes.get("/settings", async (c) => {
  const db = c.get("db");
  const keys = ["models.defaultChat", "models.defaultImage", "models.disabled", "models.blockPaid",
    "models.paidAck", "search.google_cx", "search.provider", "search.auto"];
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = await db.getSetting(k);
  return ok(c, { settings: out });
});

const settingSchema = z.object({
  key: z.enum(["search.google_cx", "search.provider", "search.auto"]),
  value: z.string().max(200),
});

/** Configurações de busca web (allowlist estrita — nada arbitrário). */
adminRoutes.post("/settings", async (c) => {
  const parsed = settingSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Configuração inválida.", 400);
  const { key, value } = parsed.data;
  if (key === "search.provider" && !["auto", "searxng", "brave", "tavily", "google-pse"].includes(value)) {
    return fail(c, "Provedor inválido.", 400);
  }
  if (key === "search.auto" && !["true", "false"].includes(value)) {
    return fail(c, "Valor inválido (true/false).", 400);
  }
  await c.get("db").setSetting(key, value);
  await c.get("db").logAudit({
    userId: c.get("user").id, action: "admin.setting.saved",
    detail: `${key}=${key === "search.google_cx" && value ? "(definido)" : value}`,
  });
  return ok(c, { saved: true, key });
});

/** Histórico de pesquisas (todos os usuários — admin). */
adminRoutes.get("/searches", async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100)));
  const items = await c.get("db").listAllSearches(limit);
  return ok(c, { items });
});

/**
 * Revoga TODAS as sessões ativas (todos os usuários fazem login de novo).
 * Use após incidente de segurança, troca de equipe ou vazamento de token.
 */
adminRoutes.post("/sessions/revoke-all", async (c) => {
  const db = c.get("db");
  const version = await bumpTokenVersion(db);
  await db.logAudit({
    userId: c.get("user").id,
    action: "admin.sessions.revoked",
    detail: `tokenVersion=${version}`,
  });
  return ok(c, { revoked: true, tokenVersion: version });
});

adminRoutes.get("/sessions/version", async (c) => {
  return ok(c, { tokenVersion: await currentTokenVersion(c.get("db")) });
});

/**
 * Uso por dia + usuário + modelo (controle de cotas, v0.2.0).
 * Inclui os limites configurados e o consumo de hoje por usuário.
 */
adminRoutes.get("/usage", async (c) => {
  const db = c.get("db");
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? 30)));
  const rows = await db.usageBreakdown(days);
  const today = new Date().toISOString().slice(0, 10);
  const users = await db.listUsers();
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayUsage: Record<string, { email: string; chat: number; image: number; transcription: number }> = {};
  for (const u of users) {
    const [chat, image, transcription] = await Promise.all([
      db.countUsageSince(u.id, "chat", startOfDay.toISOString()),
      db.countUsageSince(u.id, "image", startOfDay.toISOString()),
      db.countUsageSince(u.id, "transcription", startOfDay.toISOString()),
    ]);
    todayUsage[u.id] = { email: u.email, chat, image, transcription };
  }
  return ok(c, {
    days,
    today,
    limits: {
      chat: getNum(c, "DAILY_LIMIT_CHAT", 200),
      images: getNum(c, "DAILY_LIMIT_IMAGES", 50),
    },
    todayUsage,
    rows,
  });
});

/**
 * Saúde do servidor (monitoramento, v0.2.0): processo, SO, disco e banco.
 * Leitura portátil (funciona no container da API).
 */
adminRoutes.get("/system", async (c) => {
  const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const mem = process.memoryUsage();
  const load = os.loadavg();
  let disk: { path: string; totalMB: number | null; freeMB: number | null } | null = null;
  try {
    // df -k <dir de dados/uploads>: portátil em Linux (VPS + container).
    const dir = c.env.LOCAL_STORAGE_DIR ?? "/app/data/uploads";
    const out = execFileSync("df", ["-k", dir], { encoding: "utf8", timeout: 5000 });
    const parts = out.trim().split("\n").pop()?.split(/\s+/) ?? [];
    if (parts.length >= 4) {
      disk = {
        path: dir,
        totalMB: Math.round(Number(parts[1]) / 1024),
        freeMB: Math.round(Number(parts[3]) / 1024),
      };
    }
  } catch {
    disk = null;
  }
  const db = c.get("db");
  const [tables, sizeMB] = await Promise.all([
    db.tableCounts().catch(() => null),
    db.dbSizeMB().catch(() => null),
  ]);
  return ok(c, {
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: {
      version: process.version,
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    os: {
      platform: os.platform(),
      arch: os.arch(),
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
      freeMemMB: Math.round(os.freemem() / 1024 / 1024),
    },
    disk,
    database: { driver: db.driver, sizeMB, tables },
  });
});

// ---- Central de Atualizações (item 4) — todas exigem admin (ver topo) ----
adminRoutes.get("/updates/status", async (c) => {
  const current = currentVersion();
  const cached = readCachedStatus(c.env);
  // Sinal de vida do aplicador (serviço separado; sem ele, pedidos acumulam).
  let updater: { active: boolean; lastBeatAt: string | null } = { active: false, lastBeatAt: null };
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = c.env.UPDATES_DIR?.trim() || "/tmp/cr-ia-updates";
    const f = join(dir, "heartbeat.json");
    if (existsSync(f)) {
      const beat = JSON.parse(readFileSync(f, "utf-8")) as { at?: string };
      const at = typeof beat.at === "string" ? beat.at : null;
      const age = at ? Date.now() - new Date(at).getTime() : Infinity;
      updater = { active: Number.isFinite(age) && age < 120_000, lastBeatAt: at };
    }
  } catch {
    /* sem heartbeat = aplicador parado */
  }
  return ok(c, {
    configured: Boolean(c.env.UPDATES_MANIFEST_URL?.trim()),
    current,
    latest: cached.latest,
    notes: cached.notes,
    staged: cached.staged,
    checkedAt: cached.checkedAt,
    updateAvailable: cached.latest ? compareVersions(cached.latest, current) > 0 : false,
    error: cached.error,
    updater,
  });
});

adminRoutes.post("/updates/check", async (c) => {
  try {
    return ok(c, await checkForUpdates(c.env));
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao verificar atualizações.", 502);
  }
});

adminRoutes.post("/updates/stage", async (c) => {
  const url = c.env.UPDATES_MANIFEST_URL?.trim();
  if (!url) return fail(c, "UPDATES_MANIFEST_URL não configurada.", 400);
  try {
    const status = await checkForUpdates(c.env);
    if (status.error) return fail(c, status.error, 502);
    const manifest = await fetchManifest(url);
    const staged = await stageUpdate(c.env, manifest);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.update.staged", detail: staged.version });
    return ok(c, staged);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao preparar atualização.", 502);
  }
});

adminRoutes.post("/updates/apply", async (c) => {
  const parsed = z.object({ version: z.string().min(1).max(32) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { version }.", 400);
  try {
    const applied = await applyStaged(c.env, parsed.data.version);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.update.applied", detail: applied.version });
    return ok(c, applied);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao aplicar atualização.", 500);
  }
});

// ---- Central de Atualizações: UPLOAD de ZIP (§4) — admin only ----
adminRoutes.post("/updates/upload", async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, "Envie multipart/form-data com os campos \"zip\" + \"signature\".", 400);
  }
  const part = form.get("zip");
  if (!(part instanceof File)) return fail(c, "Campo \"zip\" ausente.", 400);
  const maxMb = Math.max(1, Number(c.env.UPDATE_MAX_ZIP_MB ?? 256) || 256);
  if (part.size > maxMb * 1024 * 1024) return fail(c, `ZIP maior que o limite de ${maxMb} MB.`, 413);
  if (part.size === 0) return fail(c, "ZIP vazio.", 400);
  const sigPart = form.get("signature");
  const sigFile = form.get("sigfile");
  const signature = typeof sigPart === "string" ? sigPart
    : sigFile instanceof File ? await sigFile.text() : "";
  try {
    const { stageUploadedZip, runStagingChecks } = await import("../services/update-upload.js");
    const bytes = new Uint8Array(await part.arrayBuffer());
    const staged = await stageUploadedZip(c.env, bytes, signature);
    const checks = await runStagingChecks(c.env, staged.version);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.update.uploaded", detail: staged.version });
    return ok(c, { version: staged.version, dir: staged.dir, report: staged.report, checks }, 201);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao processar o ZIP.", 422);
  }
});

adminRoutes.post("/updates/check-staging", async (c) => {
  const parsed = z.object({ version: z.string().min(1).max(32) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { version }.", 400);
  try {
    const { runStagingChecks } = await import("../services/update-upload.js");
    return ok(c, await runStagingChecks(c.env, parsed.data.version));
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha nas verificações.", 500);
  }
});

adminRoutes.post("/updates/test-staging", async (c) => {
  const parsed = z.object({ version: z.string().min(1).max(32) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { version }.", 400);
  try {
    const { runStagingTests } = await import("../services/update-upload.js");
    return ok(c, await runStagingTests(c.env, parsed.data.version));
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha nos testes.", 500);
  }
});

adminRoutes.post("/updates/approve", async (c) => {
  const parsed = z.object({ version: z.string().min(1).max(32) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { version }.", 400);
  try {
    const { approveStaged } = await import("../services/update-upload.js");
    const out = await approveStaged(c.env, parsed.data.version, c.get("user").id);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.update.approved", detail: out.version });
    return ok(c, out);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao aprovar.", 400);
  }
});

adminRoutes.get("/updates/releases", async (c) => {
  const { listReleases } = await import("../services/update-upload.js");
  return ok(c, { releases: listReleases(c.env) });
});

adminRoutes.post("/updates/rollback", async (c) => {
  const parsed = z.object({ target: z.string().min(1).max(120) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { target }.", 400);
  try {
    const { requestRollback } = await import("../services/update-upload.js");
    const out = await requestRollback(c.env, parsed.data.target, c.get("user").id);
    await c.get("db").logAudit({ userId: c.get("user").id, action: "admin.update.rollback_requested", detail: out.target });
    return ok(c, out);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao pedir reversão.", 400);
  }
});

adminRoutes.get("/updates/history", async (c) => {
  const { readHistory } = await import("../services/update-upload.js");
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 100)));
  return ok(c, { items: readHistory(c.env, limit) });
});

function maskUrl(url: string | undefined): string {
  if (!url) return "(não configurado)";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "(inválido)";
  }
}

import type { DbAdapter } from "../adapters/db/types.js";
