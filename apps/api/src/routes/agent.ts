/**
 * CR IA v0.2.0 — rotas do agente desenvolvedor.
 * Criar execução, acompanhar fases/logs, aprovar (admin) e cancelar.
 * Aprovações de push/PR/merge são SEMPRE humanas — não há bypass.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { cleanupRunDir } from "../services/agent.js";
import { csv } from "../lib/config.js";

export const agentRoutes = new Hono<{ Bindings: Env }>();

const createSchema = z.object({
  repo: z.string().min(3).max(200),
  baseBranch: z.string().min(1).max(100).optional(),
  goal: z.string().min(10, "Descreva a tarefa (mín. 10 caracteres).").max(2000),
  commands: z.array(z.string().min(1).max(500)).max(5).optional(),
  patch: z.string().max(100_000).optional(),
});

agentRoutes.post("/runs", requireAuth, async (c) => {
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);
  const db = c.get("db");
  const user = c.get("user");

  try {
    const { createAgentRunAndTask } = await import("../services/agent.js");
    const { run, taskId } = await createAgentRunAndTask({ env: c.env, db }, user.id, {
      repo: parsed.data.repo,
      baseBranch: parsed.data.baseBranch,
      goal: parsed.data.goal,
      commands: parsed.data.commands,
      patch: parsed.data.patch,
    });
    return ok(c, { run, taskId }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha ao criar execução.";
    const status = /DESATIVADO|NÃO autorizado|não configurado|inválid|bloqueado/i.test(msg) ? 403 : 400;
    return fail(c, msg, status);
  }
});

agentRoutes.get("/runs", requireAuth, async (c) => {
  const user = c.get("user");
  const runs = await c.get("db").listAgentRuns(user.role === "admin" ? undefined : user.id);
  return ok(c, { runs });
});

agentRoutes.get("/runs/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const run = await c.get("db").getAgentRun(c.req.param("id"), user.role === "admin" ? undefined : user.id);
  if (!run) return fail(c, "Execução não encontrada.", 404);
  return ok(c, { run });
});

const approveSchema = z.object({ kind: z.enum(["push", "pr", "merge"]) });

agentRoutes.post("/runs/:id/approve", requireAuth, requireAdmin, async (c) => {
  const parsed = approveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { kind: \"push\" | \"pr\" | \"merge\" }.", 400);
  const db = c.get("db");
  const user = c.get("user");
  const run = await db.getAgentRun(c.req.param("id"));
  if (!run) return fail(c, "Execução não encontrada.", 404);
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    return fail(c, `Execução já encerrada (${run.status}).`, 409);
  }
  const approvals = { ...run.approvals, [parsed.data.kind]: { by: user.id, at: new Date().toISOString() } };
  await db.updateAgentRun(run.id, { approvals });
  // Se estava pausada nesta aprovação, reenfileira para o worker retomar.
  const step = run.steps.find((s) => s.awaitingApproval === parsed.data.kind);
  if (run.status === "awaiting_approval" && step && run.taskId) {
    await db.updateAgentRun(run.id, { status: "running" });
    const task = await db.getTask(run.taskId);
    if (task && (task.status === "awaiting_approval" || task.status === "pending")) {
      await db.updateTask(run.taskId, { status: "pending", attempts: 0 });
    } else {
      // Tarefa encerrada por timeout do worker: cria continuação.
      const cont = await db.createTask({
        userId: run.userId, type: "agent-run",
        title: `Agente (retomada): ${run.repo}`, payload: { runId: run.id }, maxAttempts: 1,
      });
      await db.updateAgentRun(run.id, { taskId: cont.id });
    }
  }
  await db.logAudit({ userId: user.id, action: "agent.approved", detail: `${run.id} :: ${parsed.data.kind}` });
  return ok(c, { approved: parsed.data.kind, run: await db.getAgentRun(run.id) });
});

agentRoutes.post("/runs/:id/cancel", requireAuth, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const run = await db.getAgentRun(c.req.param("id"), user.role === "admin" ? undefined : user.id);
  if (!run) return fail(c, "Execução não encontrada.", 404);
  if (run.status === "done" || run.status === "failed" || run.status === "cancelled") {
    return fail(c, `Execução já encerrada (${run.status}).`, 409);
  }
  await db.updateAgentRun(run.id, { status: "cancelled", error: `Cancelada por ${user.email}.` });
  if (run.taskId) {
    const task = await db.getTask(run.taskId);
    if (task && task.status !== "done" && task.status !== "failed") {
      await db.updateTask(run.taskId, { status: "failed", error: "Execução cancelada pelo usuário." });
    }
  }
  cleanupRunDir(c.env, run.id);
  await db.logAudit({ userId: user.id, action: "agent.cancelled", detail: run.id });
  return ok(c, { cancelled: true });
});

/** Repositórios autorizados + política (para a UI montar o seletor). */
agentRoutes.get("/policy", requireAuth, async (c) => {
  const { agentRunnable } = await import("../services/agent.js");
  const r = await agentRunnable(c.env);
  return ok(c, {
    allowedRepos: csv(c.env.GITHUB_ALLOWED_REPOS),
    approvalsAlwaysRequired: true,
    workDir: c.env.AGENT_WORK_DIR ?? "/agentwork",
    protectedBranches: ["main", "master", "production", "prod", "stable"],
    maxParallel: Number(c.env.AGENT_MAX_PARALLEL_RUNS ?? "1"),
    timeoutMin: Number(c.env.AGENT_RUN_TIMEOUT_MIN ?? "20"),
    runnable: r.runnable,
    engine: r.engine,
    isolationDetail: r.detail,
    disabledReason: r.reason,
  });
});
