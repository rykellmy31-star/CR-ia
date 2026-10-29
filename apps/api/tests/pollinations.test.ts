import { describe, expect, it } from "vitest";
import { POLLINATIONS_MODEL_ID, PollinationsImageAdapter } from "../src/adapters/ai/pollinations.js";

const LIVE = process.env.LIVE_EXTERNAL === "1";

describe("PollinationsImageAdapter (desligado por padrão)", () => {
  it("sem consentimento: sem modelos, ping falso, erro claro", async () => {
    const a = new PollinationsImageAdapter(false);
    expect(a.models()).toEqual([]);
    expect(await a.ping()).toBe(false);
    await expect(
      a.generate({ model: POLLINATIONS_MODEL_ID, prompt: "x", format: "1:1", width: 64, height: 64 })
    ).rejects.toThrow(/ENABLE_POLLINATIONS/);
  });

  it("expõe o modelo quando habilitado", () => {
    const a = new PollinationsImageAdapter(true);
    expect(a.models()).toEqual([POLLINATIONS_MODEL_ID]);
    expect(a.provider).toBe("pollinations");
  });
});

describe.runIf(LIVE)("PollinationsImageAdapter (LIVE — rede real)", () => {
  it("ping retorna verdadeiro", async () => {
    const a = new PollinationsImageAdapter(true);
    expect(await a.ping()).toBe(true);
  }, 20000);

  it("gera imagem REAL (bytes de imagem, não SVG)", async () => {
    const a = new PollinationsImageAdapter(true);
    const r = await a.generate({
      model: POLLINATIONS_MODEL_ID,
      prompt: "red apple on wooden table, photo",
      format: "1:1",
      width: 256,
      height: 256,
      seed: 42,
    });
    expect(r.mime).toMatch(/^image\//);
    expect(r.mime).not.toBe("image/svg+xml");
    expect(r.data.byteLength).toBeGreaterThan(1024);
    expect(r.paid).toBe(false);
  }, 180000);
});
