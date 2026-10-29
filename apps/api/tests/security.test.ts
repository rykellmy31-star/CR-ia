import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { signToken, verifyToken } from "../src/lib/crypto.js";
import { _resetRateLimits, rateLimit, securityHeaders } from "../src/middleware/security.js";

const SECRET = "segredo-de-testes-com-mais-de-32-chars";

describe("token versioning", () => {
  it("assina com versão e verifica", async () => {
    const t = await signToken({ id: "u1", email: "a@b.com", name: "A", role: "user" }, SECRET, "1h", 3);
    const v = await verifyToken(t, SECRET);
    expect(v?.tokenVersion).toBe(3);
  });

  it("tokens legados (sem tv) assumem versão 1", async () => {
    const t = await signToken({ id: "u1", email: "a@b.com", name: "A", role: "user" }, SECRET, "1h");
    const v = await verifyToken(t, SECRET);
    expect(v?.tokenVersion).toBe(1);
  });
});

describe("security headers", () => {
  it("emite cabeçalhos de segurança", async () => {
    const app = new Hono();
    app.use("*", securityHeaders);
    app.get("/x", (c) => c.json({ ok: true }));
    const res = await app.request("/x");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("permissions-policy")).toContain("camera=()");
  });
});

describe("rate limit", () => {
  it("bloqueia após o máximo da janela", async () => {
    _resetRateLimits();
    const app = new Hono();
    app.use("/sensivel", rateLimit({ windowMs: 60_000, max: 3, keyPrefix: "t" }));
    app.get("/sensivel", (c) => c.json({ ok: true }));
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.request("/sensivel", { headers: { "x-real-ip": "9.9.9.9" } });
      codes.push(r.status);
    }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const last = await app.request("/sensivel", { headers: { "x-real-ip": "9.9.9.9" } });
    const body = (await last.json()) as { code: string };
    expect(body.code).toBe("RATE_LIMITED");
    _resetRateLimits();
  });

  it("IPs diferentes têm cotas separadas", async () => {
    _resetRateLimits();
    const app = new Hono();
    app.use("/s", rateLimit({ windowMs: 60_000, max: 1, keyPrefix: "t2" }));
    app.get("/s", (c) => c.json({ ok: true }));
    expect((await app.request("/s", { headers: { "x-real-ip": "1.1.1.1" } })).status).toBe(200);
    expect((await app.request("/s", { headers: { "x-real-ip": "1.1.1.1" } })).status).toBe(429);
    expect((await app.request("/s", { headers: { "x-real-ip": "2.2.2.2" } })).status).toBe(200);
    _resetRateLimits();
  });
});
