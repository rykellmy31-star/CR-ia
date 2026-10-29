/**
 * Migrate — aplica o schema PostgreSQL (VPS) a partir de migrations/*.sql.
 * Uso: npm run migrate -w apps/api   (usa DATABASE_URL do .env)
 * D1 usa `wrangler d1 execute` (ver wrangler.toml). JSON não precisa migrar.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("[migrate] DATABASE_URL ausente. Defina no .env (driver postgres).");
    process.exit(1);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const files = ["0001_init_postgres.sql", "0002_v020_docs_agent.sql", "0003_v020_search_memory.sql", "0004_v030_usage_cost_postgres.sql"];
  const pool = new Pool({ connectionString: url });
  try {
    for (const f of files) {
      const sql = readFileSync(join(here, "..", "migrations", f), "utf-8");
      try {
        await pool.query(sql);
      } catch (e) {
        // Falha CONTROLADA: diz o arquivo, aborta (exit 1) e NÃO segue.
        throw new Error(`[${f}] ${e instanceof Error ? e.message : e}`);
      }
      console.log(`[migrate] ${f} aplicado.`);
    }
    console.log("[migrate] schema PostgreSQL aplicado com sucesso.");
  } finally {
    await pool.end();
  }
}

const invokedAsMigrate = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (import.meta.url.endsWith(`/${invokedAsMigrate}`) && invokedAsMigrate.startsWith("migrate.")) {
  main().catch((e) => {
    console.error("[migrate] falha:", e);
    process.exit(1);
  });
}
