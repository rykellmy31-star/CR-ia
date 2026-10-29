import { describe, expect, it, vi } from "vitest";
import { CloudflareFluxRestAdapter, CLOUDFLARE_FLUX_REST_ID } from "../src/adapters/ai/cloudflare-flux-rest.js";
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
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      success: true, result: { image: image.toString("base64") },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", fetchFn as typeof fetch);
    const result = await adapter.generate(opts);
    expect(result.mime).toBe("image/jpeg");
    expect(result.data.length).toBe(64);
    expect(result.paid).toBe(false);
    const [, init] = fetchFn.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body).steps).toBe(4);
  });

  it("refuses API limits without silently falling back to paid inference", async () => {
    const adapter = new CloudflareFluxRestAdapter("a".repeat(32), "secret", async () => new Response("", { status: 429 }));
    await expect(adapter.generate(opts)).rejects.toThrow("Franquia");
  });
});
