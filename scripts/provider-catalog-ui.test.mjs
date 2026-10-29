import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, "apps/web/src/components", name), "utf8");

describe("Catálogo por provedor — navegação mobile", () => {
  it("tem cartões separados para NVIDIA, Gemini, OpenRouter e demais empresas", () => {
    const code = read("ProviderCatalogPicker.tsx");
    for (const label of ["NVIDIA NIM", "Google Gemini", "OpenRouter", "Groq", "OpenAI", "Anthropic Claude", "Ollama"]) {
      assert.ok(code.includes(label), label);
    }
    assert.match(code, /grid grid-cols-2 sm:grid-cols-3/);
    assert.match(code, /aria-pressed/);
  });
  it("Centro de modelos mostra catálogo agrupado antes da lista e filtra pelo provedor", () => {
    const code = read("ModelsView.tsx");
    assert.match(code, /<ProviderCatalogPicker/);
    assert.match(code, /m\.provider === provider/);
    assert.match(code, /post\("\/api\/models\/select"/);
  });
  it("credenciais são salvas no backend e nunca no GitHub", () => {
    const code = read("ProviderCatalogPicker.tsx");
    assert.match(code, /"\/api\/admin\/credentials"/);
    assert.match(code, /type="password"/);
    assert.ok(code.includes('setKey("");'));
    assert.doesNotMatch(code, /localStorage\.setItem/);
  });
  it("NVIDIA exige confirmação explícita de Free Endpoint para aprovar", () => {
    const code = read("ProviderCatalogPicker.tsx");
    assert.match(code, /confirmFreeEndpointAndDevOnly: true/);
    assert.match(code, /confirmFree/);
    assert.match(code, /"\/api\/admin\/nvidia\/approve"/);
    assert.match(code, /"\/api\/admin\/nvidia\/image\/enable"/);
  });
  it("chat organiza por provedor e esconde modelos bloqueados", () => {
    const code = read("ChatView.tsx");
    assert.match(code, /aria-label="Escolher provedor de IA"/);
    assert.match(code, /availableProviders\.map/);
    assert.match(code, /aria-pressed=\{activeProvider === providerId\}/);
    assert.match(code, /m\.capabilities\.includes\("chat"\) && m\.enabled/);
    assert.match(code, /m\.status === "limited"/);
    assert.match(code, /m\.provider === activeProvider/);
    assert.doesNotMatch(code, /disabled=\{!usable\}/);
    assert.match(code, /NVIDIA Free Endpoint: gratuito com cotas/);
  });
  it("Administração exibe abas e abre provedores por padrão", () => {
    const code = read("AdminView.tsx");
    assert.match(code, /\("providers"\)/);
    assert.match(code, /flex flex-wrap gap-1/);
    assert.match(code, /Provedores \/ APIs/);
  });
});
