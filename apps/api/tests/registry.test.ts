import { describe, expect, it } from "vitest";
import { ModelRegistry } from "../src/adapters/ai/registry.js";
import type { Env } from "../src/types.js";

const baseEnv: Env = {
  JWT_SECRET: "teste-segredo-longo-suficiente-123",
  CHAT_PROVIDER: "mock",
  IMAGE_PROVIDER: "mock-svg",
  BLOCK_PAID_PROVIDERS: "true",
};

describe("ModelRegistry", () => {
  it("lista modelos com mock sempre disponível", async () => {
    const r = new ModelRegistry(baseEnv);
    const list = await r.listModels();
    const mock = list.find((m) => m.id === "mock-cr-1");
    const svg = list.find((m) => m.id === "local-svg-1");
    expect(mock?.available).toBe(true);
    expect(svg?.available).toBe(true);
    // Workers AI sem binding = indisponível (honesto)
    const flux = list.find((m) => m.id.includes("flux"));
    expect(flux?.available).toBe(false);
  });

  it("auto-seleção cai no mock quando nada mais existe", async () => {
    const r = new ModelRegistry(baseEnv);
    expect(await r.autoSelectText("chat")).toBe("mock-cr-1");
    expect(await r.autoSelectImage()).toBe("local-svg-1");
  });

  it("política BLOCK_PAID_PROVIDERS impede modelos pagos", () => {
    const r = new ModelRegistry(baseEnv);
    expect(() => r.assertUsable("@cf/meta/llama-3.1-8b-instruct")).toThrow(/bloqueado/);
    expect(() => r.assertUsable("mock-cr-1")).not.toThrow();
  });

  it("admin pode desabilitar modelos", async () => {
    const r = new ModelRegistry(baseEnv);
    r.applyOverrides({ disabled: ["mock-cr-1"] });
    expect(() => r.assertUsable("mock-cr-1")).toThrow(/desabilitado/);
    const list = await r.listModels();
    expect(list.find((m) => m.id === "mock-cr-1")?.enabled).toBe(false);
  });
});
