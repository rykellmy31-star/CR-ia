/** Centro multimodelo: catálogo íntegro, status honestos e licenças. */
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, catalogFor } from "../src/adapters/ai/catalog.js";
import { createRegistry } from "../src/adapters/ai/registry.js";

describe("catálogo de modelos", () => {
  it("toda entrada tem licença, descrição e custo definidos", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(10);
    for (const e of MODEL_CATALOG) {
      expect(e.id, "id").toBeTruthy();
      expect(e.label, `${e.id} label`).toBeTruthy();
      expect(e.license, `${e.id} license`).toBeTruthy();
      expect(e.description.length, `${e.id} description`).toBeGreaterThan(20);
      expect(["free", "free-tier", "paid"]).toContain(e.cost);
      expect(e.capabilities.length, `${e.id} capabilities`).toBeGreaterThan(0);
    }
  });

  it("modelos com licença não-comercial NÃO estão no catálogo", () => {
    const ids = MODEL_CATALOG.map((e) => e.id.toLowerCase());
    expect(ids.some((id) => id.includes("flux.1-dev") || id.includes("flux-1-dev"))).toBe(false);
    expect(ids.some((id) => id.includes("2.1"))).toBe(false);
    expect(catalogFor("flux.1-dev")).toBeNull();
  });

  it("licenças verificadas dos pesos abertos", () => {
    expect(catalogFor("qwen3:4b")?.license).toBe("Apache-2.0");
    expect(catalogFor("qwen3:8b")?.license).toBe("Apache-2.0");
    expect(catalogFor("qwen2.5-coder:7b")?.license).toBe("Apache-2.0");
    expect(catalogFor("gpt-oss:20b")?.license).toBe("Apache-2.0");
    expect(catalogFor("llama3.1:8b")?.license).toContain("Llama");
    expect(catalogFor("gemma3:4b")?.license).toContain("Gemma");
    expect(catalogFor("whisper-small")?.license).toBe("MIT");
    expect(catalogFor("bge-m3")?.license).toBe("MIT");
    expect(catalogFor("flux.1-schnell")?.license).toBe("Apache-2.0");
    expect(catalogFor("qwen-image-edit")?.license).toBe("Apache-2.0");
  });

  it("Qwen-Image-Edit anuncia edição de imagem", () => {
    expect(catalogFor("qwen-image-edit")?.capabilities).toContain("image-edit");
  });

  it("listModels expõe status/custo/licença e nunca 'instala' sem adaptador", async () => {
    const models = createRegistry({
      JWT_SECRET: "x".repeat(40),
      CHAT_PROVIDER: "mock",
      IMAGE_PROVIDER: "mock-svg",
      BLOCK_PAID_PROVIDERS: "true",
    });
    const list = await models.listModels();
    const ids = list.map((m) => m.id);
    // Demo sempre instalada
    expect(list.find((m) => m.id === "mock-cr-1")?.status).toBe("installed");
    expect(list.find((m) => m.id === "local-svg-1")?.status).toBe("installed");
    // Catálogo sem adaptador aparece como unavailable com requirements
    for (const id of ["flux.1-schnell", "qwen-image", "qwen-image-edit"]) {
      expect(ids).toContain(id);
      const m = list.find((x) => x.id === id)!;
      expect(m.status).toBe("unavailable");
      expect(m.requirements, `${id} requirements`).toBeTruthy();
      expect(m.license).toBe("Apache-2.0");
    }
    // Pollinations desligado por padrão
    expect(list.find((m) => m.id === "pollinations-flux")?.status).toBe("unavailable");
    // APIs por chave sem credencial: needs-credentials (nunca disponíveis)
    for (const id of ["gpt-5-mini", "claude-opus-4-6", "gemini-3.8-flash", "grok-4.7", "deepseek-chat", "mistral-large-latest"]) {
      expect(ids).toContain(id);
      const m = list.find((x) => x.id === id)!;
      expect(m.status).toBe("needs-credentials");
      expect(m.available).toBe(false);
      expect(m.paid).toBe(true);
      expect(m.requirements, `${id} requirements`).toContain("Credenciais");
    }
    // Campos novos presentes em todas
    for (const m of list) {
      expect(["installed", "available", "limited", "unavailable", "testing", "needs-credentials", "incompatible"]).toContain(m.status);
      expect(["free", "free-tier", "paid"]).toContain(m.cost);
      expect(m.license).toBeTruthy();
      expect(typeof m.local).toBe("boolean");
    }
  });

  it("isPaidModel respeita o catálogo", () => {
    const models = createRegistry({ JWT_SECRET: "x".repeat(40), BLOCK_PAID_PROVIDERS: "true" });
    expect(models.isPaidModel("@cf/qwen/qwen3-8b")).toBe(true);
    expect(models.isPaidModel("qwen3:4b")).toBe(false);
    expect(models.isPaidModel("pollinations-flux")).toBe(false);
  });
});
