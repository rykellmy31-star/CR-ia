/**
 * Seed — criação SEGURA das contas iniciais (admin + convidada).
 *
 * Dev:    npm run seed -w apps/api            (tsx, lê .env)
 * Docker: node apps/api/dist/seed.js          (compilado, lê env do compose)
 *         ou ./scripts/migrate-seed.sh
 *
 * Regras de segurança (v0.1.1):
 * - Nunca sobrescreve usuários existentes, a menos que UPDATE_EXISTING=true.
 * - Recusa senhas padrão ("Trocar123!") quando NODE_ENV=production.
 * - Exige senha com 8+ caracteres e e-mail válido.
 * - Nunca imprime senhas; só e-mails e papéis.
 */
import { hashPassword } from "./lib/crypto.js";
import { createDb } from "./adapters/db/factory.js";
import type { Env } from "./types.js";

const DEFAULT_PASSWORD = "Trocar123!";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function fail(msg: string): never {
  console.error(`[seed] ERRO: ${msg}`);
  process.exit(1);
}

export interface SeedAccount {
  email: string;
  name: string;
  password: string;
  role: "admin" | "guest";
  label: string;
}

/** Validação pura (testável) das contas do seed. Retorna a lista de problemas. */
export function validateSeedInput(accounts: SeedAccount[], isProd: boolean): string[] {
  const problems: string[] = [];
  for (const a of accounts) {
    if (!EMAIL_RE.test(a.email)) problems.push(`${a.label}_EMAIL inválido: "${a.email}"`);
    if (!a.name || a.name.length < 2) problems.push(`${a.label}_NAME deve ter ao menos 2 caracteres.`);
    if (!a.password || a.password.length < 8) {
      problems.push(`${a.label}_PASSWORD deve ter ao menos 8 caracteres. Defina no .env e rode de novo.`);
    }
    if (isProd && a.password === DEFAULT_PASSWORD) {
      problems.push(
        `${a.label}_PASSWORD ainda é a senha padrão em PRODUÇÃO. ` +
        `Defina uma senha forte no .env (ADMIN_PASSWORD/GUEST_PASSWORD) e rode de novo. ` +
        `O seed foi ABORTADO e nada foi alterado.`
      );
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const e = process.env as Record<string, string | undefined>;
  const isProd = (e.NODE_ENV ?? "development") === "production";
  const env: Env = {
    JWT_SECRET: e.JWT_SECRET ?? "dev",
    DB_DRIVER: (e.DB_DRIVER as Env["DB_DRIVER"]) ?? "json",
    JSON_DB_PATH: e.JSON_DB_PATH,
    DATABASE_URL: e.DATABASE_URL,
  };

  const accounts = [
    {
      email: (e.ADMIN_EMAIL ?? "admin@cr-ia.local").trim(),
      name: (e.ADMIN_NAME ?? "Administrador").trim(),
      password: e.ADMIN_PASSWORD ?? DEFAULT_PASSWORD,
      role: "admin" as const,
      label: "ADMIN",
    },
    {
      email: (e.GUEST_EMAIL ?? "convidada@cr-ia.local").trim(),
      name: (e.GUEST_NAME ?? "Usuária Convidada").trim(),
      password: e.GUEST_PASSWORD ?? DEFAULT_PASSWORD,
      role: "guest" as const,
      label: "GUEST",
    },
  ];

  // ---- Validação antes de tocar no banco ----
  const problems = validateSeedInput(accounts, isProd);
  if (problems.length > 0) fail(problems.join(" "));

  const db = createDb(env);
  await db.init();

  const cost = Math.min(12, Math.max(4, Number(e.BCRYPT_COST ?? 10) || 10));
  const updateExisting = (e.UPDATE_EXISTING ?? "false").toLowerCase() === "true";

  for (const a of accounts) {
    const existing = await db.getUserByEmail(a.email);
    if (existing) {
      if (!updateExisting) {
        console.log(`[seed] mantida: ${a.email} (${existing.role}) — já existe; nada alterado.`);
        continue;
      }
      await db.updateUser(existing.id, {
        name: a.name,
        role: a.role,
        passwordHash: await hashPassword(a.password, cost),
        blocked: false,
      });
      console.log(`[seed] atualizada (UPDATE_EXISTING=true): ${a.email} (${a.role})`);
    } else {
      await db.createUser({
        email: a.email,
        name: a.name,
        role: a.role,
        passwordHash: await hashPassword(a.password, cost),
      });
      console.log(`[seed] criada: ${a.email} (${a.role})`);
    }
  }

  if (!isProd && accounts.some((a) => a.password === DEFAULT_PASSWORD)) {
    console.warn("[seed] AVISO: usando senha padrão em desenvolvimento. Troque no .env para produção.");
  }
  await db.close();
  console.log("[seed] concluído com sucesso.");
}

/** Executa somente quando chamado diretamente (não ao importar p/ testes). */
const invokedAs = (process.argv[1] ?? "").split(/[\\/]/).pop() ?? "";
if (import.meta.url.endsWith(`/${invokedAs}`) && invokedAs.startsWith("seed.")) {
  main().catch((err) => {
    console.error("[seed] falha:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
