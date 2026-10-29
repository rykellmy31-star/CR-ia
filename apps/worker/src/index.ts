/**
 * CR IA — worker de tarefas (VPS).
 * Pesquisa a fila no banco, executa com o runner compartilhado e registra tudo.
 * Retoma automaticamente após reinícios (tarefas 'running' órfãs voltam p/ fila).
 */
import { createDb } from "@cr-ia/api/adapters/db/factory.js";
import { createStorage } from "@cr-ia/api/adapters/storage/factory.js";
import { createRegistry } from "@cr-ia/api/adapters/ai/registry.js";
import { processNext } from "@cr-ia/api/services/runner.js";
import type { Env } from "@cr-ia/api/types.js";

function envFromProcess(): Env {
  // Repassa TODO o process.env (o worker precisa das mesmas vars da API:
  // agente, updates, provedores...). Só aplica defaults seguros.
  const e = process.env as Record<string, string | undefined>;
  return {
    ...(e as unknown as Env),
    NODE_ENV: e.NODE_ENV,
    JWT_SECRET: e.JWT_SECRET ?? "worker-sem-jwt",
    DB_DRIVER: (e.DB_DRIVER as Env["DB_DRIVER"]) ?? "json",
    STORAGE_DRIVER: (e.STORAGE_DRIVER as Env["STORAGE_DRIVER"]) ?? "local",
  };
}

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 5000);

async function recoverOrphans(db: ReturnType<typeof createDb>): Promise<void> {
  // Tarefas travadas em 'running' (worker morreu no meio) voltam para 'pending'
  const running = await db.listTasks(undefined, "running");
  for (const t of running) {
    const stale = Date.now() - new Date(t.updatedAt).getTime() > 5 * 60 * 1000;
    if (stale) {
      await db.updateTask(t.id, { status: "pending", error: "Retomada após interrupção do worker." });
      console.log(`[worker] retomada: ${t.id} (${t.title})`);
    }
  }
}

async function main(): Promise<void> {
  const env = envFromProcess();
  const db = createDb(env);
  const storage = createStorage(env);
  const models = createRegistry(env);
  await db.init();
  await recoverOrphans(db);
  console.log(`[worker] CR IA iniciado (db=${db.driver}, poll=${POLL_MS}ms)`);

  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });

  let polls = 0;
  while (!stopped) {
    try {
      const didWork = await processNext({ env, db, storage, models });
      polls++;
      // Catálogo OpenRouter: sync automático quando devido (~10min; barato se não).
      if (polls % 120 === 0) {
        try {
          const { maybeAutoSync } = await import("@cr-ia/api/services/openrouter.js");
          await maybeAutoSync(env, db, (entries, at) => models.setOpenRouterCatalog(entries, at));
        } catch (e) {
          console.log("[worker] sync OpenRouter falhou:", e instanceof Error ? e.message : e);
        }
      }
      // Central de Atualizações: o worker só VERIFICA (a cada ~1h); nunca aplica.
      if (polls % 720 === 0 && env.UPDATES_MANIFEST_URL) {
        try {
          const { checkForUpdates } = await import("@cr-ia/api/services/updates.js");
          const st = await checkForUpdates(env);
          if (st.updateAvailable) console.log(`[worker] atualização disponível: ${st.current} → ${st.latest}`);
          else if (st.error) console.log(`[worker] verificação de atualização: ${st.error}`);
        } catch (e) {
          console.log("[worker] verificação de atualização falhou:", e instanceof Error ? e.message : e);
        }
      }
      if (!didWork) {
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
    } catch (e) {
      console.error("[worker] erro no loop:", e);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
  await db.close();
  console.log("[worker] encerrado.");
}

main().catch((e) => {
  console.error("[worker] falha fatal:", e);
  process.exit(1);
});
