/** Fábrica do adaptador de banco conforme DB_DRIVER. */
import type { Env } from "../../types.js";
import type { DbAdapter } from "./types.js";
import { JsonFileAdapter } from "./json-file.js";
import { PostgresAdapter } from "./postgres.js";
import { D1Adapter } from "./d1.js";

export function createDb(env: Env): DbAdapter {
  const driver = env.DB_DRIVER ?? "json";
  if (driver === "postgres") {
    if (!env.DATABASE_URL) throw new Error("DB_DRIVER=postgres exige DATABASE_URL.");
    return new PostgresAdapter(env.DATABASE_URL);
  }
  if (driver === "d1") {
    if (!env.DB) throw new Error("DB_DRIVER=d1 exige binding DB (Cloudflare D1).");
    return new D1Adapter(env.DB);
  }
  return new JsonFileAdapter(env.JSON_DB_PATH ?? "./data/cr-ia.json");
}
