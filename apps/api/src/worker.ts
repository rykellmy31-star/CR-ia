/** Entrada Cloudflare Workers (fetch + consumer da fila TASKS). */
import { createApp } from "./index.js";
import type { Env } from "./types.js";
import { executeTask } from "./services/runner.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { app } = createApp({ ...env, DB_DRIVER: "d1", STORAGE_DRIVER: "r2" });
    return app.fetch(request, env);
  },

  /** Consumer da fila cr-ia-tasks (wrangler [[queues.consumers]]). */
  async queue(batch: { messages: { body: unknown }[] }, env: Env): Promise<void> {
    const { db, storage, models } = createApp({ ...env, DB_DRIVER: "d1", STORAGE_DRIVER: "r2" });
    await db.init();
    for (const msg of batch.messages) {
      const body = msg.body as { taskId?: string };
      if (!body?.taskId) continue;
      const task = await db.getTask(body.taskId);
      if (!task || task.status !== "pending") continue;
      await db.updateTask(task.id, { status: "running", attempts: task.attempts + 1 });
      const fresh = (await db.getTask(task.id))!;
      await executeTask({ env, db, storage, models }, fresh);
    }
  },
};
