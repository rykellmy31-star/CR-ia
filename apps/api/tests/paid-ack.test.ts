/**
 * Política de pagos v0.3.0: bloqueio por padrão, ativação por modelo
 * (paidAck do admin), catálogo OpenRouter aplicado e ping 1×/adaptador.
 */
import { describe, expect, it } from "vitest";
import { createRegistry } from "../src/adapters/ai/registry.js";

import type { OrCatalogEntry } from "../src/services/openrouter.js";
import type { Env } from "../src/types.js";

const ENV = { JWT_SECRET: "x".repeat(40), BLOCK_PAID_PROVIDERS: "true" } as Env;

const entry = (id: string, free: boolean, extra: Partial<OrCatalogEntry> = {}): OrCatalogEntry => ({
  id, name: id, text: true, image: false, imageInput: false,
  context: null, priceIn1M: free ? 0 : 3, priceOut1M: free ? 0 : 15,
  free, priceKnown: true, ...extra,
});

describe("openRouterPaid + paidAck", () => {
  it("antes do sync: semente :free é livre", () => {
    const r = createRegistry(ENV);
    expect(r.openRouterPaid("x/y:free")).toBe(false);
  });
  it("sincronizado: só free é livre; desconhecido = pago", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog([entry("a/free", true), entry("b/paid", false)], "2026-10-24T00:00:00.000Z");
    expect(r.openRouterPaid("a/free")).toBe(false);
    expect(r.openRouterPaid("b/paid")).toBe(true);
    expect(r.openRouterPaid("sumiu/do-catalogo")).toBe(true);
  });
  it("bloqueado por padrão; paidAck libera só o modelo ativado", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog([entry("b/paid", false), entry("c/outro", false)], "2026-10-24T00:00:00.000Z");
    expect(() => r.assertUsable("b/paid")).toThrow(/BLOCK_PAID/);
    expect(() => r.assertUsable("b/paid")).toThrow(/Provedores de IA/);
    r.setPaidAck(["b/paid"]);
    expect(() => r.assertUsable("b/paid")).not.toThrow();
    expect(() => r.assertUsable("c/outro")).toThrow(/BLOCK_PAID/);
  });
  it("grátis sincronizado passa mesmo com BLOCK=true", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog([entry("a/free", true)], "2026-10-24T00:00:00.000Z");
    expect(() => r.assertUsable("a/free")).not.toThrow();
  });
  it("catálogo ordena grátis primeiro (auto-select prefere $0)", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog(
      [entry("b/paid", false, { image: true }), entry("a/free", true, { image: true })],
      "2026-10-24T00:00:00.000Z",
    );
    const text = r.textAdapters.find((a) => a.provider === "openrouter")!;
    expect(text.models()[0]).toBe("a/free");
    const img = r.imageAdapters.find((a) => a.provider === "openrouter")!;
    expect(img.models()).toEqual(["a/free", "b/paid"]);
  });
  it("edição só para modelos com entrada de imagem", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog(
      [entry("e/edit", false, { image: true, imageInput: true }), entry("g/gen", false, { image: true })],
      "2026-10-24T00:00:00.000Z",
    );
    expect(r.findImageEditAdapter("e/edit")).not.toBeNull();
    expect(r.findImageEditAdapter("g/gen")).toBeNull();
  });
});

describe("status OpenRouter (via statusFor)", () => {
  const st = (r: ReturnType<typeof createRegistry>, id: string, reachable: boolean, hasKey: boolean) =>
    (r as unknown as {
      statusFor: (p: string, m: string, rc: boolean, ins: string[], k?: { needsKey: boolean; hasKey: boolean }) => string;
    }).statusFor("openrouter", id, reachable, [], { needsKey: true, hasKey });
  it("free+chave+ping = limited; pago+ack = installed; pago = available", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog([entry("a/free", true), entry("b/paid", false)], "2026-10-24T00:00:00.000Z");
    expect(st(r, "a/free", true, true)).toBe("limited");
    expect(st(r, "b/paid", true, true)).toBe("available");
    r.setPaidAck(["b/paid"]);
    expect(st(r, "b/paid", true, true)).toBe("installed");
  });
  it("sem chave = needs-credentials; fora do catálogo = unavailable", () => {
    const r = createRegistry(ENV);
    r.setOpenRouterCatalog([entry("a/free", true)], "2026-10-24T00:00:00.000Z");
    expect(st(r, "a/free", false, false)).toBe("needs-credentials");
    expect(st(r, "sumiu", true, true)).toBe("unavailable");
    expect(st(r, "a/free", false, true)).toBe("unavailable");
  });
});

describe("auto-select com catálogo grande", () => {
  function keyedRegistry() {
    const r = createRegistry({ ...ENV, CHAT_PROVIDER: "mock" } as Env);
    r.setKeySource(async () => "K-TESTE-12345");
    const or = r.textAdapters.find((a) => a.provider === "openrouter")!;
    let pings = 0;
    or.ping = async () => { pings++; return true; };
    return { r, pings: () => pings };
  }
  it("ping 1× por adaptador mesmo com 200 ids", async () => {
    const { r, pings } = keyedRegistry();
    const entries = Array.from({ length: 200 }, (_, i) => entry(`or/m-${i}`, true));
    r.setOpenRouterCatalog(entries, "2026-10-24T00:00:00.000Z");
    const picked = await r.autoSelectText();
    expect(picked).toBe("or/m-0");
    expect(pings()).toBe(1);
  });
  it("pagos sem ack são pulados; com ack entram", async () => {
    const { r } = keyedRegistry();
    r.setOpenRouterCatalog([entry("or/pro", false)], "2026-10-24T00:00:00.000Z");
    expect(await r.autoSelectText()).toBe("mock-cr-1");
    r.setPaidAck(["or/pro"]);
    expect(await r.autoSelectText()).toBe("or/pro");
  });
  it("autoSelectImage respeita o padrão do admin", async () => {
    const r = createRegistry({ ...ENV, IMAGE_PROVIDER: "mock-svg" } as Env);
    r.applyOverrides({ defaultImage: "local-svg-1" });
    expect(await r.autoSelectImage()).toBe("local-svg-1");
  });
});
