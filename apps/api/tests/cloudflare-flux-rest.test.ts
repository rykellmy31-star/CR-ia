import { describe, expect, it, vi } from "vitest";
import { CloudflareFluxRestAdapter, CLOUDFLARE_FLUX_REST_ID, CLOUDFLARE_FLUX_KLEIN_ID, CLOUDFLARE_PHOENIX_ID } from "../src/adapters/ai/cloudflare-flux-rest.js";
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

  it("auto selects a real Cloudflare image model rather than the SVG demo", async () => {
    const registry = createRegistry({
      JWT_SECRET: "test", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_AI_API_TOKEN: "test-key", BLOCK_PAID_PROVIDERS: "true",
      IMAGE_PROVIDER: "openrouter",
    });
    expect(await registry.autoSelectImage()).toBe(CLOUDFLARE_FLUX_KLEIN_ID);
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

  it("sends prompt, dimensions, negative prompt and guidance to Leonardo Phoenix", async () => {
    const image = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(60)]);
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      success: true, result: { image: image.toString("base64") },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", fetchFn as typeof fetch);
    const result = await adapter.generate({ ...opts, model: CLOUDFLARE_PHOENIX_ID, negativePrompt: "people", width: 768, height: 1024 });
    expect(result.mime).toBe("image/jpeg");
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("/ai/run/@cf/leonardo/phoenix-1.0");
    const body = JSON.parse(String(init?.body));
    expect(body.prompt).toBe("Blue car");
    expect(body.negative_prompt).toBe("people");
    expect(body.guidance).toBe(7);
    expect(body.num_steps).toBe(30);
    expect(body.width).toBe(768);
    expect(body.height).toBe(1024);
  });

  it("accepts raw JPEG stream from Leonardo Phoenix instead of forcing JSON", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80)]);
    const fetchFn = vi.fn(async () => new Response(jpeg, {
      status: 200, headers: { "content-type": "image/jpeg" },
    }));
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", fetchFn as typeof fetch);
    const result = await adapter.generate({ ...opts, model: CLOUDFLARE_PHOENIX_ID });
    expect(result.mime).toBe("image/jpeg");
    expect(Buffer.from(result.data).equals(jpeg)).toBe(true);
  });

  it("accepts raw PNG even if proxy labels it octet-stream", async () => {
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(80)]);
    const fetchFn = vi.fn(async () => new Response(png, {
      status: 200, headers: { "content-type": "application/octet-stream" },
    }));
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", fetchFn as typeof fetch);
    const result = await adapter.generate({ ...opts, model: CLOUDFLARE_PHOENIX_ID });
    expect(result.mime).toBe("image/png");
  });

  it("rejects non-image binary safely", async () => {
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", async () => new Response("not an image", {
      status: 200, headers: { "content-type": "image/jpeg" },
    }));
    await expect(adapter.generate({ ...opts, model: CLOUDFLARE_PHOENIX_ID }))
      .rejects.toThrow("dados inválidos");
  });

  it("refuses API limits without silently falling back to paid inference", async () => {
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", async () => new Response("", { status: 429 }));
    await expect(adapter.generate(opts)).rejects.toThrow("franquia");
  });
});
