/** Fila de tarefas/agentes: criar, acompanhar, aprovar, repetir. */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth } from "../middleware/auth.js";
import { githubListActionsRuns, githubListPulls, githubListTree, githubReadFile, githubRepoInfo } from "../services/github.js";

export const taskRoutes = new Hono<{ Bindings: Env }>();

const createSchema = z.object({
  type: z.enum(["echo", "chat", "image-batch", "github-inspect", "github-fix-proposal"]),
  title: z.string().min(3).max(160),
  payload: z.record(z.unknown()).default({}),
  runAfter: z.string().datetime({ offset: true }).optional(),
});

taskRoutes.post("/", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const user = c.get("user");

  // Validações por tipo (fail-fast, antes de enfileirar)
  if (parsed.data.type === "github-inspect" || parsed.data.type === "github-fix-proposal") {
    const repo = String((parsed.data.payload.repo as string) ?? "");
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      return fail(c, "Informe payload.repo no formato \"dono/repositorio\".", 400);
    }
    const allowed = (c.env.GITHUB_ALLOWED_REPOS ?? "").split(",").map((s) => s.trim());
    if (!allowed.includes(repo)) {
      return fail(c, `Repositório "${repo}" não autorizado. Autorizados: ${allowed.join(", ") || "(nenhum)"}.`, 403);
    }
  }
  if (parsed.data.type === "image-batch") {
    const prompts = parsed.data.payload.prompts;
    if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > 10) {
      return fail(c, "payload.prompts deve ser uma lista de 1 a 10 descrições.", 400);
    }
  }

  const task = await db.createTask({
    userId: user.id,
    type: parsed.data.type,
    title: parsed.data.title,
    payload: parsed.data.payload as Record<string, unknown>,
    runAfter: parsed.data.runAfter ?? null,
  });

  // Cloudflare Queues (quando disponível): espelha para consumo serverless
  if (c.env.TASKS) {
    await c.env.TASKS.send({ taskId: task.id }).catch(() => undefined);
  }

  await db.logAudit({ userId: user.id, action: "task.created", detail: `${task.id} ${task.type}` });
  return ok(c, { task }, 201);
});

taskRoutes.get("/", requireAuth, async (c) => {
  const user = c.get("user");
  const status = c.req.query("status") as import("@cr-ia/shared").TaskStatus | undefined;
  // Admin vê todas; demais veem as próprias
  const tasks = await c.get("db").listTasks(user.role === "admin" ? undefined : user.id, status);
  return ok(c, { tasks });
});

taskRoutes.get("/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const task = await c.get("db").getTask(c.req.param("id"), user.role === "admin" ? undefined : user.id);
  if (!task) return fail(c, "Tarefa não encontrada.", 404);
  return ok(c, { task });
});

/** Aprova uma tarefa aguardando aprovação (ex.: proposta de correção GitHub). */
taskRoutes.post("/:id/approve", requireAuth, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const task = await db.getTask(c.req.param("id"), user.role === "admin" ? undefined : user.id);
  if (!task) return fail(c, "Tarefa não encontrada.", 404);
  if (task.status !== "awaiting_approval") return fail(c, `Tarefa está "${task.status}", não aguarda aprovação.`, 400);

  const schema = z.object({ approved: z.boolean(), note: z.string().max(500).optional() });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { approved: true|false }.", 400);

  if (!parsed.data.approved) {
    const updated = await db.updateTask(task.id, { status: "failed", error: `Rejeitada por ${user.email}: ${parsed.data.note ?? "sem motivo"}` });
    return ok(c, { task: updated });
  }
  // Aprovada: volta para a fila para execução do passo seguinte.
  const updated = await db.updateTask(task.id, { status: "pending", error: null });
  await db.logAudit({ userId: user.id, action: "task.approved", detail: `${task.id} ${parsed.data.note ?? ""}` });
  return ok(c, { task: updated });
});

taskRoutes.post("/:id/retry", requireAuth, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const task = await db.getTask(c.req.param("id"), user.role === "admin" ? undefined : user.id);
  if (!task) return fail(c, "Tarefa não encontrada.", 404);
  if (task.status !== "failed") return fail(c, "Somente tarefas com falha podem ser repetidas.", 400);
  const updated = await db.updateTask(task.id, { status: "pending", error: null, attempts: 0 });
  return ok(c, { task: updated });
});

/** Atalho síncrono (somente leitura): inspecionar repositório autorizado. */
taskRoutes.post("/github/inspect", requireAuth, async (c) => {
  const schema = z.object({ repo: z.string().min(3) });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { repo: \"dono/nome\" }.", 400);
  try {
    const [info, tree] = await Promise.all([
      githubRepoInfo(c.env, parsed.data.repo),
      githubListTree(c.env, parsed.data.repo),
    ]);
    let actions: unknown = null;
    try { actions = await githubListActionsRuns(c.env, parsed.data.repo); } catch { actions = { unavailable: true }; }
    const files = tree.filter((t) => t.type === "file");
    const summary = {
      repo: parsed.data.repo,
      defaultBranch: info.default_branch,
      language: info.language,
      size: info.size,
      openIssues: info.open_issues_count,
      totalFiles: files.length,
      byExtension: countExt(files.map((f) => f.path)),
      actions: actions as unknown,
    };
    await c.get("db").logAudit({ userId: c.get("user").id, action: "github.inspect", detail: parsed.data.repo });
    return ok(c, summary);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha na inspeção.", 502);
  }
});

/** Atalho síncrono (somente leitura): ler arquivo de repositório autorizado. */
taskRoutes.post("/github/read", requireAuth, async (c) => {
  const schema = z.object({
    repo: z.string().min(3),
    path: z.string().min(1).max(500),
    branch: z.string().max(100).optional(),
  });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { repo, path }.", 400);
  if (parsed.data.path.includes("..")) return fail(c, "Caminho inválido.", 400);
  try {
    const file = await githubReadFile(c.env, parsed.data.repo, parsed.data.path, parsed.data.branch);
    await c.get("db").logAudit({
      userId: c.get("user").id, action: "github.read", detail: `${parsed.data.repo} :: ${parsed.data.path}`,
    });
    return ok(c, { repo: parsed.data.repo, path: parsed.data.path, ...file });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha na leitura.", 502);
  }
});

/** Atalho síncrono (somente leitura): pull requests recentes do repositório. */
taskRoutes.post("/github/pulls", requireAuth, async (c) => {
  const schema = z.object({ repo: z.string().min(3), state: z.enum(["open", "closed", "all"]).default("open") });
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { repo }.", 400);
  try {
    const pulls = await githubListPulls(c.env, parsed.data.repo, parsed.data.state);
    return ok(c, { repo: parsed.data.repo, pulls });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao listar PRs.", 502);
  }
});

function countExt(paths: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of paths) {
    const ext = p.includes(".") ? p.split(".").pop()!.toLowerCase().slice(0, 10) : "(sem extensão)";
    out[ext] = (out[ext] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]).slice(0, 20));
}
