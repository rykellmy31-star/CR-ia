import { describe, expect, it } from "vitest";
import { MockSvgImageAdapter, MockTextAdapter, renderSvgArt } from "../src/adapters/ai/mock.js";
import { estimateTokens } from "../src/adapters/ai/types.js";

describe("MockTextAdapter", () => {
  it("responde em PT-BR sem rede", async () => {
    const a = new MockTextAdapter();
    expect(await a.ping()).toBe(true);
    const r = await a.chat({ model: "mock-cr-1", messages: [{ role: "user", content: "Olá, quem é você?" }] });
    expect(r.text).toMatch(/CR IA/);
    expect(r.paid).toBe(false);
    expect(r.tokensOut).toBeGreaterThan(0);
  });

  it("gera ideia de campanha", async () => {
    const a = new MockTextAdapter();
    const r = await a.chat({ model: "mock-cr-1", messages: [{ role: "user", content: "crie uma campanha para instagram" }] });
    expect(r.text.toLowerCase()).toContain("campanha");
  });
});

describe("MockSvgImageAdapter", () => {
  it("gera SVG válido nas dimensões pedidas", async () => {
    const a = new MockSvgImageAdapter();
    const r = await a.generate({ model: "local-svg-1", prompt: "promoção de padaria", format: "1:1", width: 1024, height: 1024 });
    expect(r.mime).toBe("image/svg+xml");
    const svg = new TextDecoder().decode(r.data);
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="1024"');
    expect(svg).toContain("padaria");
  });

  it("renderSvgArt varia com o prompt", () => {
    expect(renderSvgArt("a", 100, 100)).not.toBe(renderSvgArt("b", 100, 100));
  });
});

describe("estimateTokens", () => {
  it("estima ~4 chars/token", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
    expect(estimateTokens("")).toBe(1);
  });
});
