/**
 * OpenRouter dinâmico (v0.3.0): normalização, gratuidade honesta, diff de
 * sync, teste de chave e sync automático. Tudo com fetch stub — sem rede,
 * sem chave real, sem gasto.
 */
import { describe, expect, it } from "vitest";
import type { DbAdapter } from "../src/adapters/db/types.js";
import type { Env } from "../src/types.js";
import {
  OR_CATALOG_KEY, freeFromPricing, loadCatalog, loadReport, loadSyncConfig,
  maskKey, maybeAutoSync, mergeImageModels, normalizeTextModels,
  syncCatalog, syncDue, testKey, type OrFetch,
} from "../src/services/openrouter.js";

const ENV = { OPENROUTER_BASE_URL: "https://or.test/api/v1" } as Env;

function fakeDb(seed: Record<string, string> = {}): DbAdapter {
  const store = new Map(Object.entries(seed));
  return {
    getSetting: async (k: string) => store.get(k) ?? null,
    setSetting: async (k: string, v: string) => { store.set(k, v); },
  } as unknown as DbAdapter;
}

function stubFetch(routes: Record<string, { status: number; body: unknown }>): OrFetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    const r = routes[path] ?? { status: 404, body: { error: "not found" } };
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as OrFetch;
}

const MODELS_PAGE_1 = [
  { id: "free/chat-model", name: "Free Chat", context_length: 32000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0", completion: "0", request: "0" } },
  { id: "paid/pro-model", name: "Paid Pro", context_length: 200000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: { prompt: "0.000003", completion: "0.000015", request: "0" } },
  { id: "mystery/noprice", name: "No Price",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
  { id: "legacy/noarch", name: "Legacy",
    pricing: { prompt: "0", completion: "0" } },
];

const IMAGE_MODELS = [
  { id: "img/fast-image", name: "Fast Image",
    architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1"] }, seed: { type: "boolean" } } },
  { id: "paid/pro-model", name: "Paid Pro",
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
    supported_parameters: {} },
];

describe("freeFromPricing (gratuidade honesta)", () => {
  it("tudo zero conhecido = free", () => {
    expect(freeFromPricing({ prompt: "0", completion: "0" })).toEqual({ free: true, known: true });
  });
  it("qualquer preço > 0 = pago", () => {
    expect(freeFromPricing({ prompt: "0", completion: "0.00001" }).free).toBe(false);
  });
  it("preço ausente NÃO é free (desconhecido)", () => {
    expect(freeFromPricing(undefined)).toEqual({ free: false, known: false });
    expect(freeFromPricing({})).toEqual({ free: false, known: false });
    expect(freeFromPricing({ prompt: "abc" })).toEqual({ free: false, known: false });
  });
  it("aceita número e string", () => {
    expect(freeFromPricing({ prompt: 0, completion: 0 }).free).toBe(true);
  });
});

describe("normalizeTextModels", () => {
  it("mapeia modalidades, contexto e preços por 1M", () => {
    const [free, paid] = normalizeTextModels(MODELS_PAGE_1);
    expect(free.text).toBe(true);
    expect(free.image).toBe(false);
    expect(free.free).toBe(true);
    expect(free.context).toBe(32000);
    expect(paid.free).toBe(false);
    expect(paid.priceIn1M).toBeCloseTo(3, 6);
    expect(paid.priceOut1M).toBeCloseTo(15, 6);
    expect(paid.imageInput).toBe(true);
  });
  it("sem modalidades = texto legado; sem preço = desconhecido", () => {
    const entries = normalizeTextModels(MODELS_PAGE_1);
    const legacy = entries.find((e) => e.id === "legacy/noarch")!;
    expect(legacy.text).toBe(true);
    const mystery = entries.find((e) => e.id === "mystery/noprice")!;
    expect(mystery.priceKnown).toBe(false);
    expect(mystery.free).toBe(false);
  });
  it("ignora entradas inválidas", () => {
    expect(normalizeTextModels([{ nope: 1 }, null, "x"])).toEqual([]);
    expect(normalizeTextModels({ data: [] })).toEqual([]);
  });
});

describe("mergeImageModels", () => {
  it("marca imagem, parâmetros e edição; image-only perde texto", () => {
    const merged = mergeImageModels(normalizeTextModels(MODELS_PAGE_1), IMAGE_MODELS);
    const img = merged.find((e) => e.id === "img/fast-image")!;
    expect(img.image).toBe(true);
    expect(img.text).toBe(false);
    expect(img.imageInput).toBe(false);
    expect(img.imageParams).toEqual(["aspect_ratio", "seed"]);
    // Só de imagem e fora do /models: desconhecido (pago por segurança).
    expect(img.priceKnown).toBe(false);
    expect(img.free).toBe(false);
    const paid = merged.find((e) => e.id === "paid/pro-model")!;
    expect(paid.text).toBe(true);
    expect(paid.image).toBe(true);
    expect(paid.imageInput).toBe(true);
  });
});

describe("syncCatalog (diff + persistência)", () => {
  const routes = {
    "/api/v1/models": { status: 200, body: { data: MODELS_PAGE_1 } },
    "/api/v1/images/models": { status: 200, body: { data: IMAGE_MODELS } },
  };
  it("primeiro sync: tudo adicionado; prefs do admin intactas", async () => {
    const db = fakeDb({ "models.disabled": JSON.stringify(["x"]) });
    const report = await syncCatalog(ENV, db, { fetchFn: stubFetch(routes), source: "manual" });
    expect(report.total).toBe(5);
    expect(report.text).toBe(4);
    expect(report.image).toBe(2);
    expect(report.free).toBe(2); // free/chat-model + legacy/noarch
    expect(report.added).toHaveLength(5);
    expect(report.removed).toHaveLength(0);
    expect(report.imageErrors).toHaveLength(0);
    const cat = await loadCatalog(db);
    expect(cat?.models).toHaveLength(5);
    expect(await db.getSetting("models.disabled")).toBe(JSON.stringify(["x"]));
    expect((await loadReport(db))?.total).toBe(5);
  });
  it("segundo sync: detecta adicionado/atualizado/removido", async () => {
    const db = fakeDb();
    await syncCatalog(ENV, db, { fetchFn: stubFetch(routes) });
    const page2 = [
      { ...MODELS_PAGE_1[0] },
      { ...MODELS_PAGE_1[1], pricing: { prompt: "0.000009", completion: "0.000015", request: "0" } },
      { id: "brand/new-model", name: "New",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
        pricing: { prompt: "0", completion: "0" } },
    ];
    const report = await syncCatalog(ENV, db, {
      fetchFn: stubFetch({
        "/api/v1/models": { status: 200, body: { data: page2 } },
        "/api/v1/images/models": { status: 200, body: { data: [] } },
      }),
    });
    expect(report.added).toEqual(["brand/new-model"]);
    expect(report.updated).toEqual(["paid/pro-model"]);
    expect(report.removed.sort()).toEqual(["img/fast-image", "legacy/noarch", "mystery/noprice"].sort());
  });
  it("falha em /images/models não derruba o sync de texto", async () => {
    const db = fakeDb();
    const report = await syncCatalog(ENV, db, {
      fetchFn: stubFetch({
        "/api/v1/models": { status: 200, body: { data: MODELS_PAGE_1 } },
        "/api/v1/images/models": { status: 500, body: { error: "x" } },
      }),
    });
    expect(report.total).toBe(4);
    expect(report.imageErrors).toHaveLength(1);
  });
  it("falha em /models aborta com erro claro", async () => {
    const db = fakeDb();
    await expect(syncCatalog(ENV, db, {
      fetchFn: stubFetch({ "/api/v1/models": { status: 500, body: {} } }),
    })).rejects.toThrow(/catálogo OpenRouter/);
    expect(await db.getSetting(OR_CATALOG_KEY)).toBeNull();
  });
});

describe("syncDue + loadSyncConfig", () => {
  it("padrão: auto ligado, 24h", async () => {
    expect(await loadSyncConfig(fakeDb())).toEqual({ auto: true, intervalHours: 24 });
  });
  it("limita intervalo a 1..168", async () => {
    expect(await loadSyncConfig(fakeDb({ "openrouter.sync": JSON.stringify({ auto: true, intervalHours: 999 }) })))
      .toEqual({ auto: true, intervalHours: 168 });
  });
  it("vencimento por tempo; desligado nunca", () => {
    expect(syncDue({ auto: false, intervalHours: 1 }, null)).toBe(false);
    expect(syncDue({ auto: true, intervalHours: 24 }, null)).toBe(true);
    const now = Date.now();
    expect(syncDue({ auto: true, intervalHours: 24 }, new Date(now - 25 * 3600_000).toISOString(), now)).toBe(true);
    expect(syncDue({ auto: true, intervalHours: 24 }, new Date(now - 3600_000).toISOString(), now)).toBe(false);
    expect(syncDue({ auto: true, intervalHours: 24 }, "lixo", now)).toBe(true);
  });
});

describe("maskKey", () => {
  it("nunca expõe o valor completo", () => {
    const m = maskKey("sk-or-v1-abcdefghijklmnopqrstuvwx");
    expect(m).toContain("…");
    expect("sk-or-v1-abcdefghijklmnopqrstuvwx").not.toContain(m.replace("…", ""));
    expect(m.length).toBeLessThan(16);
    expect(maskKey("")).toBe("");
  });
});

describe("testKey (sem gasto)", () => {
  it("200 com label/uso/limite", async () => {
    const info = await testKey(ENV, "K-TESTE-12345",
      stubFetch({ "/api/v1/auth/key": { status: 200, body: { data: { label: "minha", usage: 1.5, limit: 10 } } } }));
    expect(info).toMatchObject({ ok: true, label: "minha", usage: 1.5, limit: 10 });
  });
  it("401/402/429 com mensagem em pt-BR", async () => {
    for (const [status, re] of [[401, /inválida/], [402, /créditos/], [429, /Limite/]] as const) {
      const info = await testKey(ENV, "K-TESTE-12345",
        stubFetch({ "/api/v1/auth/key": { status, body: {} } }));
      expect(info.ok).toBe(false);
      expect(info.error).toMatch(re);
    }
  });
  it("chave curta nem chama a rede", async () => {
    let called = false;
    const info = await testKey(ENV, "curta", (async () => { called = true; throw new Error("x"); }) as OrFetch);
    expect(info.ok).toBe(false);
    expect(called).toBe(false);
  });
});

describe("maybeAutoSync", () => {
  it("sincroniza quando devido e aplica; segunda chamada imediata é ignorada", async () => {
    const db = fakeDb();
    const fetchFn = stubFetch({
      "/api/v1/models": { status: 200, body: { data: MODELS_PAGE_1 } },
      "/api/v1/images/models": { status: 200, body: { data: [] } },
    });
    // Força o fetch stub via syncCatalog indireto: configura env? maybeAutoSync usa fetch global.
    // Aqui validamos o (não-)vencimento; o caminho feliz é coberto via rotas com stub global.
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: OrFetch }).fetch = fetchFn;
    try {
      let applied: string[] = [];
      let appliedAt: string | null = null;
      const r1 = await maybeAutoSync(ENV, db, (entries, at) => {
        applied = entries.map((e) => e.id);
        appliedAt = at;
      });
      expect(r1?.source).toBe("auto");
      expect(applied).toHaveLength(4);
      expect(appliedAt).toBeTruthy();
      const r2 = await maybeAutoSync(ENV, db, () => { throw new Error("não devia rodar"); });
      expect(r2).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
