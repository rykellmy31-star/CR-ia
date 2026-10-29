/**
 * Memória do usuário/projeto (Fase 3 / §8): decisões técnicas, correções
 * e notas. Isolada por usuário — ninguém vê a memória alheia.
 * O agente desenvolvedor consulta "fix" do repo antes de analisar.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth } from "../middleware/auth.js";

export const memoryRoutes = new Hono<{ Bindings: Env }>();

const saveSchema = z.object({
  project: z.string().max(120).optional().default(""),
  kind: z.enum(["decision", "fix", "note"]),
  title: z.string().min(2).max(160),
  content: z.string().min(2).max(8000),
});

memoryRoutes.post("/", requireAuth, async (c) => {
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);
  const item = await c.get("db").saveMemoryItem({ userId: c.get("user").id, ...parsed.data });
  await c.get("db").logAudit({
    userId: c.get("user").id, action: "memory.saved",
    detail: `${item.kind}:${item.project || "geral"}:${item.title}`.slice(0, 160),
  });
  return ok(c, { item }, 201);
});

memoryRoutes.get("/", requireAuth, async (c) => {
  const project = c.req.query("project") || undefined;
  const kind = c.req.query("kind");
  const k = kind === "decision" || kind === "fix" || kind === "note" ? kind : undefined;
  const items = await c.get("db").listMemoryItems(c.get("user").id, project, k);
  return ok(c, { items });
});

memoryRoutes.delete("/:id", requireAuth, async (c) => {
  const gone = await c.get("db").deleteMemoryItem(c.req.param("id"), c.get("user").id);
  if (!gone) return fail(c, "Item não encontrado.", 404);
  await c.get("db").logAudit({ userId: c.get("user").id, action: "memory.deleted", detail: c.req.param("id") });
  return ok(c, { deleted: true });
});
