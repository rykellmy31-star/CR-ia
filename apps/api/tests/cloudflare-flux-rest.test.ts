import { describe, expect, it, vi } from "vitest";
import { CloudflareFluxRestAdapter, CLOUDFLARE_FLUX_REST_ID, CLOUDFLARE_FLUX_KLEIN_ID } from "../src/adapters/ai/cloudflare-flux-rest.js";
import { createRegistry } from "../src/adapters/ai/registry.js";

const opts = { model: CLOUDFLARE_FLUX_REST_ID, prompt: "Blue car", format: "1:1" as const, width: 512, height: 512 };

describe("Cloudflare FLUX REST", () => {
  it("appears as usable without authorizing paid providers when configured", async () => {
    const registry = createRegistry({
      JWT_SECRET: "test", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_AI_API_TOKEN: "test-key", BLOCK_PAID_PROVIDERS: "true",
    });
    expect(registry.findImageAdapter(CLOUDFLARE_FLUX_REST_ID)).not.toBeNull();
    expect(registry.paidBlockedByPolicy(CLOUDFLARE_FLUX_REST_ID)).toBe(false);
    const entry = (await registry.listModels()).find((x) => x.id === CLOUDFLARE_FLUX_REST_ID);
    expect(entry?.capabilities).toContain("image-gen");
    expect(entry?.status).toBe("installed");
  });

  it("sends authenticated JSON, decodes returned image bytes", async () => {
    const image = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60)]);
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      success: true, result: { image: image.toString("base64") },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", fetchFn as typeof fetch);
    const result = await adapter.generate(opts);
    expect(result.mime).toBe("image/jpeg");
    expect(result.data.length).toBe(64);
    expect(result.paid).toBe(false);
    const [, init] = fetchFn.mock.calls[0];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
    expect(JSON.parse(String(init?.body)).steps).toBe(8);
  });

  it("generates with FLUX.2 Klein using multipart prompt, aspect dimensions, guidance, seed", async () => {
    const image = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60)]);
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      success: true, result: { image: image.toString("base64") },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", fetchFn as typeof fetch);
    const img = await adapter.generate({
      ...opts, model: CLOUDFLARE_FLUX_KLEIN_ID, format: "16:9", width: 1344, height: 768, seed: 123,
    });
    expect(img.mime).toBe("image/jpeg");
    const [url, req] = fetchFn.mock.calls[0];
    expect(url).toContain("flux-2-klein-4b");
    const hdrs = new Headers(req?.headers);
    expect(hdrs.has("Content-Type")).toBe(false);
    expect(hdrs.get("Authorization")).toBe("Bearer secret");
    expect(req?.body).toBeInstanceOf(FormData);
    const form = req?.body as FormData;
    expect(form.get("prompt")).toBe("Blue car");
    expect(form.get("width")).toBe("1344");
    expect(form.get("height")).toBe("768");
    expect(form.get("seed")).toBe("123");
    expect(form.get("guidance")).toBe("5");
  });

  it("refuses API limits without silently falling back to paid inference", async () => {
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", async () => new Response("", { status: 429 }));
    await expect(adapter.generate(opts)).rejects.toThrow("franquia");
  });
});
