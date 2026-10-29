/**
 * OpenRouter Image API (v0.3.0): formato oficial, validação funcional de
 * bytes (HTTP 200 não basta), edição por referência, erros e custo real.
 * Tudo com fetch stub — sem rede, sem gasto.
 */
import { describe, expect, it } from "vitest";
import type { Env } from "../src/types.js";
import type { KeySource } from "../src/services/credentials.js";
import { OpenRouterImageAdapter, validateImageBytes } from "../src/adapters/ai/openrouter-image.js";
import { RateLimitError } from "../src/adapters/ai/pollinations.js";

// PNG 1x1 real (67 bytes) — prova que o mínimo aceita imagem pequena válida.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const ENV = { OPENROUTER_BASE_URL: "https://or.test/api/v1" } as Env;
const KEYS: KeySource = async () => "K-OR-TESTES-12345";
const NOKEYS: KeySource = async () => "";

type StubHandler = (url: string, init?: RequestInit) => { status: number; body: unknown };
function stubFetch(handler: StubHandler): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const r = handler(String(url), init);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => JSON.stringify(r.body),
      json: async () => r.body,
    } as Response;
  }) as typeof fetch;
}

describe("validateImageBytes (prova funcional)", () => {
  it("aceita PNG/JPEG/WebP/GIF/SVG reais", () => {
    expect(validateImageBytes(PNG_1X1, "image/png").mime).toBe("image/png");
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]).toString("base64");
    expect(validateImageBytes(jpeg).mime).toBe("image/jpeg");
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]).toString("base64");
    expect(validateImageBytes(webp).mime).toBe("image/webp");
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)]).toString("base64");
    expect(validateImageBytes(gif).mime).toBe("image/gif");
    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><rect width='8' height='8'/></svg>").toString("base64");
    expect(validateImageBytes(svg, "image/svg+xml").mime).toBe("image/svg+xml");
  });
  it("rejeita bytes que não são imagem, vazio e curto", () => {
    const notImg = Buffer.from("x".repeat(100)).toString("base64");
    expect(() => validateImageBytes(notImg)).toThrow(/não são uma imagem/);
    expect(() => validateImageBytes("")).toThrow(/vazia/);
    expect(() => validateImageBytes("aGk=")).toThrow(/vazia/); // "hi" = 2 bytes
  });
});

describe("generate (POST /images oficial)", () => {
  const okBody = { data: [{ b64_json: PNG_1X1, media_type: "image/png" }], usage: { cost: 0.04 } };
  it("envia model+prompt+aspect_ratio+n e valida os bytes", async () => {
    let seen: Record<string, unknown> = {};
    let seenUrl = "";
    const a = new OpenRouterImageAdapter(ENV, KEYS, stubFetch((url, init) => {
      seenUrl = url;
      seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { status: 200, body: okBody };
    }));
    a.paidFor = () => true;
    const r = await a.generate({ model: "img/fast-image", prompt: "um gato", format: "16:9" });
    expect(seenUrl).toBe("https://or.test/api/v1/images");
    expect(seen).toMatchObject({ model: "img/fast-image", prompt: "um gato", aspect_ratio: "16:9", n: 1 });
    expect(r.mime).toBe("image/png");
    expect(r.data.length).toBeGreaterThan(32);
    expect(r.paid).toBe(true);
    expect(r.costUsd).toBe(0.04);
  });
  it("sem chave: erro honesto (não tenta rede)", async () => {
    let called = false;
    const a = new OpenRouterImageAdapter(ENV, NOKEYS, stubFetch(() => { called = true; return { status: 200, body: okBody }; }));
    await expect(a.generate({ model: "m", prompt: "p", format: "1:1" })).rejects.toThrow(/sem chave/);
    expect(called).toBe(false);
  });
  it("401/402/500 com mensagem acionável; 429 vira RateLimitError", async () => {
    const mk = (status: number, body: unknown) =>
      new OpenRouterImageAdapter(ENV, KEYS, stubFetch(() => ({ status, body })));
    await expect(mk(401, {}).generate({ model: "m", prompt: "p", format: "1:1" })).rejects.toThrow(/inválida/);
    await expect(mk(402, {}).generate({ model: "m", prompt: "p", format: "1:1" })).rejects.toThrow(/créditos/);
    await expect(mk(500, { error: { message: "boom" } }).generate({ model: "m", prompt: "p", format: "1:1" }))
      .rejects.toThrow(/HTTP 500.*boom/);
    const err = await mk(429, {}).generate({ model: "m", prompt: "p", format: "1:1" }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
  });
  it("200 sem b64_json ou com bytes inválidos = erro (não salva lixo)", async () => {
    const mk = (body: unknown) =>
      new OpenRouterImageAdapter(ENV, KEYS, stubFetch(() => ({ status: 200, body })));
    await expect(mk({ data: [] }).generate({ model: "m", prompt: "p", format: "1:1" })).rejects.toThrow(/sem b64_json/);
    const bad = { data: [{ b64_json: Buffer.from("z".repeat(100)).toString("base64"), media_type: "image/png" }] };
    await expect(mk(bad).generate({ model: "m", prompt: "p", format: "1:1" })).rejects.toThrow(/não são uma imagem/);
  });
});

describe("edit (input_references)", () => {
  it("recusa modelo sem suporte a edição", async () => {
    const a = new OpenRouterImageAdapter(ENV, KEYS, stubFetch(() => ({ status: 200, body: {} })));
    a.setModels(["img/fast-image"]);
    a.setEditable([]);
    await expect(a.edit({ model: "img/fast-image", prompt: "mude", format: "1:1", image: new Uint8Array(64), imageName: "a.png" }))
      .rejects.toThrow(/não declara suporte a edição/);
  });
  it("envia data URL em input_references", async () => {
    let seen: Record<string, unknown> = {};
    const a = new OpenRouterImageAdapter(ENV, KEYS, stubFetch((_u, init) => {
      seen = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { status: 200, body: { data: [{ b64_json: PNG_1X1, media_type: "image/png" }] } };
    }));
    a.setModels(["img/edit-pro"]);
    a.setEditable(["img/edit-pro"]);
    const pngBytes = Uint8Array.from(Buffer.from(PNG_1X1, "base64"));
    const r = await a.edit({ model: "img/edit-pro", prompt: "aquarela", format: "1:1", image: pngBytes, imageName: "foto.png" });
    const refs = seen.input_references as Array<{ type: string; image_url: { url: string } }>;
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("image_url");
    expect(refs[0].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
    expect(r.mime).toBe("image/png");
  });
});

describe("ping (valida chave, sem gasto)", () => {
  it("sem chave = false; 200 = true; 401 = false", async () => {
    const no = new OpenRouterImageAdapter(ENV, NOKEYS, stubFetch(() => ({ status: 200, body: {} })));
    expect(await no.ping()).toBe(false);
    const good = new OpenRouterImageAdapter(ENV, KEYS, stubFetch((url) => {
      expect(url).toBe("https://or.test/api/v1/auth/key");
      return { status: 200, body: { data: { label: "t" } } };
    }));
    expect(await good.ping()).toBe(true);
    const bad = new OpenRouterImageAdapter(ENV, KEYS, stubFetch(() => ({ status: 401, body: {} })));
    expect(await bad.ping()).toBe(false);
  });
});
