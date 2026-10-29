/** Entrada Node.js (dev local + VPS Hostinger via Docker). */
import { serve } from "@hono/node-server";
import { createApp } from "./index.js";
import type { Env } from "./types.js";

function envFromProcess(): Env {
  // Repassa TODO o process.env (compose define ~50 vars; listar uma a uma
  // já causou bug crítico: vault/Groq/updates/busca ignorados em produção).
  // Só aplica defaults seguros para o essencial.
  const e = process.env as Record<string, string | undefined>;
  return {
    ...(e as unknown as Env),
    NODE_ENV: e.NODE_ENV,
    JWT_SECRET: e.JWT_SECRET ?? "DEV-ONLY-troque-este-segredo-antes-de-usar",
    DB_DRIVER: (e.DB_DRIVER as Env["DB_DRIVER"]) ?? "json",
    STORAGE_DRIVER: (e.STORAGE_DRIVER as Env["STORAGE_DRIVER"]) ?? "local",
  };
}

const env = envFromProcess();
const port = Number(process.env.PORT ?? 8787);

if ((env.NODE_ENV ?? "development") === "production") {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
    console.error("[CR IA] JWT_SECRET ausente/fraco em produção. Abortando.");
    process.exit(1);
  }
  if (!process.env.CREDENTIALS_SECRET || process.env.CREDENTIALS_SECRET.trim().length < 32) {
    console.error("[CR IA] CREDENTIALS_SECRET ausente/fraco em produção. Abortando (cofre inutilizável).");
    process.exit(1);
  }
}

const { app } = createApp(env);

console.log(`[CR IA] API ouvindo em http://localhost:${port} (db=${env.DB_DRIVER}, storage=${env.STORAGE_DRIVER}, chat=${env.CHAT_PROVIDER ?? "mock"})`);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" });
