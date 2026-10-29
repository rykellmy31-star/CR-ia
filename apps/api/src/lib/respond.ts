/** Envelopes de resposta padronizados. */
import type { Context } from "hono";
import type { ApiErr, ApiOk } from "@cr-ia/shared";

export function ok<T>(c: Context, data: T, status = 200) {
  const body: ApiOk<T> = { ok: true, data };
  return c.json(body, status as never);
}

export function fail(c: Context, error: string, status = 400, code?: string) {
  const body: ApiErr = { ok: false, error, code };
  return c.json(body, status as never);
}
