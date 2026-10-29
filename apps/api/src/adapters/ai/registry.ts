/**
 * Central multimodelo — registro, seleção manual/automática e políticas.
 * - Lista unificada de modelos (texto + imagem + voz + embeddings) com
 *   disponibilidade REAL e metadados do catálogo (licença, custo, requisitos).
 * - Status por modelo: installed | available | limited | unavailable |
 *   testing | needs-credentials | incompatible.
 * - Seleção automática: melhor modelo disponível para a tarefa
 *   (local > grátis-com-cota > pago-com-chave > demo).
 * - Política BLOCK_PAID_PROVIDERS: impede chamadas pagas sem autorização.
 *   Groq free-tier NÃO é bloqueado ($0, sem cartão). OpenRouter usa o
 *   catálogo dinâmico (v0.3.0): só o comprovadamente grátis é livre;
 *   pago ou sem preço divulgado exige ativação por modelo (paidAck, admin).
 */
import type { ModelCapability, ModelCost, ModelInfo, ModelProvider, ModelStatus, ModelTestResult } from "@cr-ia/shared";
import type { Env } from "../../types.js";
import type { EmbeddingsAdapter, ImageAdapter, TextAdapter, TranscriptionAdapter } from "./types.js";
import { MockSvgImageAdapter, MockTextAdapter } from "./mock.js";
import { OllamaAdapter } from "./ollama.js";
import { WORKERS_AI_TEXT_DEFAULTS, WorkersAiImageAdapter, WorkersAiTextAdapter } from "./workers-ai.js";
import { POLLINATIONS_MODEL_ID, PollinationsImageAdapter } from "./pollinations.js";
import { AiLocalAdapter } from "./ailocal.js";
import { ComfyImageAdapter } from "./comfyui.js";
import { MODEL_CATALOG, catalogFor, genericWorkersAiEntry, type CatalogEntry } from "./catalog.js";
import { OpenAICompatTextAdapter, type KeyedAdapter } from "./openai-compatible.js";
import { OpenRouterImageAdapter } from "./openrouter-image.js";
import { NvidiaNimTextAdapter } from "./nvidia-nim.js";
import { NvidiaCosmosImageAdapter, NVIDIA_COSMOS_IMAGE_ID } from "./nvidia-image.js";
import { CloudflareFluxRestAdapter, CLOUDFLARE_FLUX_REST_ID } from "./cloudflare-flux-rest.js";
import { OR_DEFAULT_REFERER, type OrCatalogEntry } from "../../services/openrouter.js";
import { AnthropicTextAdapter } from "./anthropic.js";
import { GoogleTextAdapter } from "./google.js";
import {
  FREE_KEYED_PROVIDERS, FREE_PROVIDER_DEFAULTS, KEYED_PROVIDERS, PRICE_TABLE, PROVIDER_DEFAULTS,
  isFreeKeyedProvider, isKeyedProvider, type KeyedProvider,
} from "./providers.js";
import type { KeySource } from "../../services/credentials.js";

function isKeyed(a: { provider: string }): a is KeyedAdapter {
  return (a as KeyedAdapter).needsKey === true && isKeyedProvider(a.provider);
}

/** Adaptador de API gratuita (mesmo contrato de chave, outra política). */
function isFreeKeyed(a: { provider: string }): a is KeyedAdapter {
  return (a as KeyedAdapter).needsKey === true && isFreeKeyedProvider(a.provider);
}

export type TaskKind = "chat" | "reasoning" | "code" | "image" | "transcription";

const INSTALLED_CACHE_MS = 60_000;

function capsFor(modelId: string, fallback: ModelCapability[]): ModelCapability[] {
  const id = modelId.toLowerCase();
  if (id.includes("coder") || id.includes("code")) return ["chat", "code", "reasoning"];
  if (id.includes("flux") || id.includes("dreamshaper") || id.includes("sdxl") || id.includes("image")) {
    return id.includes("edit") ? ["image-gen", "image-edit"] : ["image-gen"];
  }
  if (id.includes("whisper")) return ["transcription"];
  if (id.includes("embed") || id.includes("bge")) return ["embeddings"];
  return fallback;
}

function labelFor(modelId: string): string {
  if (modelId.startsWith("@cf/")) return modelId.replace("@cf/", "").replace(/-/g, " ");
  return modelId;
}

function descFor(modelId: string, provider: string): string {
  if (provider === "ollama") return "Modelo aberto rodando no Ollama da VPS/rede local. Sem custo por chamada.";
  if (provider === "workers-ai") return "Inferência serverless Cloudflare. Verifique limites do plano.";
  if (provider === "pollinations") return "Imagens reais de IA (FLUX) via serviço externo gratuito. O prompt sai do servidor; não use dados sensíveis.";
  if (provider === "ai-local") return "Serviço local de voz/embeddings (perfil ai do compose).";
  if (provider === "external-gpu") return "Modelo aberto rodando na sua GPU externa (ComfyUI sob seu controle).";
  if (provider === "groq") {
    return "Groq grátis (OpenAI-compatível, sem cartão). Cotas: 30 req/min · 1.000 req/dia. O prompt sai do servidor; nada sensível.";
  }
  if (provider === "nvidia") {
    return "NVIDIA NIM Free Endpoint: somente desenvolvimento/testes; não disponibilizar para usuários de produção. Confirme o selo Free Endpoint em build.nvidia.com; /v1/models NÃO comprova gratuidade.";
  }
  if (provider === "openrouter") {
    return "OpenRouter — catálogo dinâmico sincronizado da API oficial. Grátis têm cotas rígidas; pagos exigem créditos e ativação do admin. O prompt sai do servidor; nada sensível.";
  }
  if (isKeyedProvider(provider)) {
    const def = PROVIDER_DEFAULTS[provider];
    return `${def.label} via API oficial. PAGO — o prompt sai do servidor. Configure a chave em Administração → Credenciais.`;
  }
  return "";
}

/** Metadados efetivos: catálogo curado > genérico @cf > derivado do id. */
function metaFor(modelId: string, provider: string): CatalogEntry {
  const freeDef = isFreeKeyedProvider(provider) ? FREE_PROVIDER_DEFAULTS[provider] : null;
  const derivedCost: ModelCost =
    modelId.startsWith("@cf/") || isKeyedProvider(provider) ? "paid"
    : freeDef ? "free-tier"
    : "free";
  return (
    catalogFor(modelId) ??
    (modelId.startsWith("@cf/") ? genericWorkersAiEntry(modelId) : null) ?? {
      id: modelId,
      label: labelFor(modelId),
      provider: provider as ModelProvider,
      capabilities: [],
      description: descFor(modelId, provider),
      license: provider === "mock" || provider === "local-svg" ? "Código próprio (demo)" : "Verificar no provedor",
      local: provider === "mock" || provider === "local-svg" || provider === "ollama" || provider === "ai-local",
      cost: derivedCost,
      ...(freeDef ? { limits: freeDef.limits } : {}),
    }
  );
}

export class ModelRegistry {
  textAdapters: TextAdapter[] = [];
  imageAdapters: ImageAdapter[] = [];
  voiceAdapters: Array<TranscriptionAdapter & EmbeddingsAdapter> = [];
  disabled = new Set<string>();
  defaultChatModel: string | null = null;
  defaultImageModel: string | null = null;
  /** Últimos testes reais de inferência por modelo (memória; o audit guarda histórico). */
  testResults = new Map<string, ModelTestResult>();
  private testing = new Set<string>();
  private installedCache: { at: number; models: string[] } | null = null;
  private keySource: KeySource = async () => "";
  /** Catálogo OpenRouter sincronizado (id → entrada) + data do sync. */
  private orMeta = new Map<string, OrCatalogEntry>();
  private orCatalogAt: string | null = null;
  /** Modelos pagos com ativação explícita do admin (settings `models.paidAck`). */
  paidAck = new Set<string>();
  private orText: OpenAICompatTextAdapter | null = null;
  private orImage: OpenRouterImageAdapter | null = null;
  private nvidiaText: NvidiaNimTextAdapter | null = null;
  private nvidiaImage: NvidiaCosmosImageAdapter | null = null;

  constructor(private env: Env) {
    const ollamaModels = (env.OLLAMA_TEXT_MODELS ?? "qwen3:4b")
      .split(",").map((s) => s.trim()).filter(Boolean);

    // Texto
    this.textAdapters.push(new MockTextAdapter());
    if (env.OLLAMA_URL || env.CHAT_PROVIDER === "ollama") {
      this.textAdapters.push(new OllamaAdapter(env.OLLAMA_URL ?? "http://localhost:11434", ollamaModels));
    }
    this.textAdapters.push(new WorkersAiTextAdapter(env.AI ?? null, [...WORKERS_AI_TEXT_DEFAULTS]));
    // Provedores por API paga (OpenAI, Anthropic, Google, xAI, DeepSeek, Mistral):
    // sempre listados; sem chave ficam "needs-credentials" (nunca disponíveis).
    for (const p of KEYED_PROVIDERS) {
      const def = PROVIDER_DEFAULTS[p];
      const fromEnv = (env[def.modelsEnv] as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      const models = fromEnv.length ? fromEnv : [...def.models];
      const baseUrl = ((env[def.baseUrlEnv] as string | undefined)?.trim() || def.baseUrl);
      const getKey = () => this.keySource(p);
      if (p === "anthropic") this.textAdapters.push(new AnthropicTextAdapter({ baseUrl, models, getKey }));
      else if (p === "google") this.textAdapters.push(new GoogleTextAdapter({ baseUrl, models, getKey }));
      else {
        this.textAdapters.push(new OpenAICompatTextAdapter({
          provider: p, baseUrl, models, getKey, keyLabel: def.label,
        }));
      }
    }
    // Provedores GRATUITOS por chave (Groq, OpenRouter): $0 com cotas.
    // Com chave ficam "limited" (usáveis dentro das cotas); sem chave,
    // "needs-credentials". Nunca entram em cobrança.
    for (const p of FREE_KEYED_PROVIDERS) {
      const def = FREE_PROVIDER_DEFAULTS[p];
      const fromEnv = (env[def.modelsEnv] as string | undefined)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      const models = fromEnv.length ? fromEnv : [...def.models];
      const baseUrl = ((env[def.baseUrlEnv] as string | undefined)?.trim() || def.baseUrl);
      const getKey = () => this.keySource(p);
      const orReferer = p === "openrouter" ? (env.OPENROUTER_REFERER ?? "").trim() || OR_DEFAULT_REFERER : "";
      const extraHeaders = p === "openrouter"
        ? { ...(orReferer ? { "HTTP-Referer": orReferer } : {}), "X-Title": "CR IA" }
        : undefined;
      const textAdapter = p === "nvidia"
        ? new NvidiaNimTextAdapter({ provider: p, baseUrl, models, getKey, keyLabel: def.label, paidResult: false })
        : new OpenAICompatTextAdapter({
          provider: p, baseUrl, models, getKey, keyLabel: def.label, extraHeaders, paidResult: false,
        });
      if (p === "nvidia") this.nvidiaText = textAdapter as NvidiaNimTextAdapter;
      if (p === "openrouter") {
        this.orText = textAdapter;
        textAdapter.paidFor = (m) => this.openRouterPaid(m);
      }
      this.textAdapters.push(textAdapter);
    }

    // Imagem (ordem de preferência configurável; SVG sempre como fallback)
    this.imageAdapters.push(new MockSvgImageAdapter());
    if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_API_TOKEN) {
      this.imageAdapters.push(new CloudflareFluxRestAdapter(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_AI_API_TOKEN));
    }
    // OpenRouter Image API: primário com chave + catálogo; Pollinations segue de fallback.
    const orImage = new OpenRouterImageAdapter(env, (provider) => this.keySource(provider));
    orImage.paidFor = (m) => this.openRouterPaid(m);
    this.orImage = orImage;
    this.imageAdapters.push(orImage);
    // Único modelo de imagem NVIDIA marcado Free Endpoint no catálogo consultado.
    // Desabilitado até autorização expressa do admin para uso em testes.
    this.nvidiaImage = new NvidiaCosmosImageAdapter((provider) => this.keySource(provider));
    this.imageAdapters.push(this.nvidiaImage);
    const pollinationsOn = (env.ENABLE_POLLINATIONS ?? "false").toLowerCase() === "true";
    this.imageAdapters.push(new PollinationsImageAdapter(
      pollinationsOn,
      env.POLLINATIONS_IMAGE_MODEL ?? "flux",
      env.POLLINATIONS_API_KEY ?? ""
    ));
    this.imageAdapters.push(
      new WorkersAiImageAdapter(env.AI ?? null, env.WORKERS_AI_IMAGE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell")
    );
    // GPU externa do cliente (ComfyUI): FLUX schnell, Qwen-Image e edição.
    if (env.EXTERNAL_GPU_URL) {
      this.imageAdapters.push(new ComfyImageAdapter(env));
    }

    // Voz + embeddings locais (ai-local)
    if (env.AI_LOCAL_URL) {
      this.voiceAdapters.push(new AiLocalAdapter(env.AI_LOCAL_URL));
    }

    const chatPref = env.CHAT_PROVIDER ?? "mock";
    this.defaultChatModel = chatPref === "ollama" ? ollamaModels[0] ?? "mock-cr-1"
      : chatPref === "workers-ai" ? WORKERS_AI_TEXT_DEFAULTS[0]
      : "mock-cr-1";
    this.defaultImageModel =
      env.IMAGE_PROVIDER === "cloudflare-rest"
        ? CLOUDFLARE_FLUX_REST_ID
        : env.IMAGE_PROVIDER === "workers-ai"
        ? (env.WORKERS_AI_IMAGE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell")
        : env.IMAGE_PROVIDER === "pollinations"
          ? POLLINATIONS_MODEL_ID
          : "local-svg-1";
  }

  /** Fonte das chaves (env ou cofre). Ligada no boot da app (index.ts). */
  setKeySource(fn: KeySource): void {
    this.keySource = fn;
  }

  /**
   * Aplica o catálogo OpenRouter sincronizado: texto (só saída texto),
   * imagem (só saída imagem), edição (entrada imagem). Ordena grátis
   * primeiro para a seleção automática preferir $0.
   */
  setOpenRouterCatalog(entries: OrCatalogEntry[], at: string | null): void {
    this.orMeta = new Map(entries.map((e) => [e.id, e]));
    this.orCatalogAt = at;
    const rank = (e: OrCatalogEntry): number => (e.free ? 0 : this.paidAck.has(e.id) ? 1 : 2);
    const byRank = (a: OrCatalogEntry, b: OrCatalogEntry): number => rank(a) - rank(b) || a.id.localeCompare(b.id);
    this.orText?.setModels(entries.filter((e) => e.text).sort(byRank).map((e) => e.id));
    this.orImage?.setModels(entries.filter((e) => e.image).sort(byRank).map((e) => e.id));
    this.orImage?.setEditable(entries.filter((e) => e.image && e.imageInput).map((e) => e.id));
  }

  /** Somente modelos NIM explicitamente revisados pelo admin podem ser usados, e apenas em testes. */
  setNvidiaModels(ids: string[]): void {
    // Nunca cadastrar Cosmos3 Nano como chat; a API é separada.
    this.nvidiaText?.setModels(ids.filter((id) => !id.includes("cosmos3-nano")));
  }

  setNvidiaCosmosEnabled(enabled: boolean): void {
    this.nvidiaImage?.setEnabled(enabled);
  }

  /** Modelos pagos autorizados pelo admin (persiste em settings `models.paidAck`). */
  setPaidAck(ids: string[]): void {
    this.paidAck = new Set(ids);
    // Reordena com o novo ack (grátis → ativados → resto).
    if (this.orCatalogAt) this.setOpenRouterCatalog([...this.orMeta.values()], this.orCatalogAt);
  }

  /**
   * OpenRouter é pago? Sincronizado: tudo que não é comprovadamente grátis
   * (preço ausente = pago). Antes do 1º sync: vale a semente free-tier legada.
   */
  openRouterPaid(modelId: string): boolean {
    if (this.orCatalogAt) return !(this.orMeta.get(modelId)?.free ?? false);
    const seed = FREE_PROVIDER_DEFAULTS.openrouter?.models ?? [];
    return !(modelId.endsWith(":free") || seed.includes(modelId));
  }

  /** Estado da credencial de um modelo (para mensagens honestas na UI). */
  async modelKeyState(modelId: string): Promise<"ok" | "needs-credentials" | "not-keyed"> {
    const a = this.findTextAdapter(modelId) ?? this.findImageAdapter(modelId);
    if (!a || (!isKeyed(a) && !isFreeKeyed(a))) return "not-keyed";
    return (await a.hasKey().catch(() => false)) ? "ok" : "needs-credentials";
  }

  /** Aplica overrides do admin (settings do banco). */
  applyOverrides(overrides: { disabled?: string[]; defaultChat?: string | null; defaultImage?: string | null }): void {
    if (overrides.disabled) this.disabled = new Set(overrides.disabled);
    if (overrides.defaultChat !== undefined && overrides.defaultChat) this.defaultChatModel = overrides.defaultChat;
    if (overrides.defaultImage !== undefined && overrides.defaultImage) this.defaultImageModel = overrides.defaultImage;
  }

  markTesting(modelId: string, active: boolean): void {
    if (active) this.testing.add(modelId);
    else this.testing.delete(modelId);
  }

  markTest(modelId: string, result: ModelTestResult): void {
    this.testResults.set(modelId, result);
  }

  findTextAdapter(modelId: string): TextAdapter | null {
    return this.textAdapters.find((a) => a.models().includes(modelId)) ?? null;
  }

  findImageAdapter(modelId: string): ImageAdapter | null {
    return this.imageAdapters.find((a) => a.models().includes(modelId)) ?? null;
  }

  /** Adaptador com capacidade de EDIÇÃO (upload + instrução), se houver. */
  findImageEditAdapter(modelId: string): import("./types.js").ImageEditAdapter | null {
    const a = this.imageAdapters.find(
      (x) =>
        x.models().includes(modelId) &&
        "edit" in x &&
        (typeof (x as unknown as { canEdit?: (m: string) => boolean }).canEdit !== "function" ||
          (x as unknown as { canEdit: (m: string) => boolean }).canEdit(modelId)),
    );
    return (a as import("./types.js").ImageEditAdapter | undefined) ?? null;
  }

  findVoiceAdapter(modelId: string): (TranscriptionAdapter & EmbeddingsAdapter) | null {
    return this.voiceAdapters.find((a) => a.models().includes(modelId)) ?? null;
  }

  transcriptionAdapter(): (TranscriptionAdapter & EmbeddingsAdapter) | null {
    return this.voiceAdapters[0] ?? null;
  }

  blockPaid(): boolean {
    const v = (this.env.BLOCK_PAID_PROVIDERS ?? "true").toLowerCase();
    return v !== "0" && v !== "false" && v !== "no";
  }

  providerOf(modelId: string): string | null {
    const a = this.findTextAdapter(modelId) ?? this.findImageAdapter(modelId) ?? this.findVoiceAdapter(modelId);
    return a ? a.provider : null;
  }

  isPaidModel(modelId: string): boolean {
    const cat = catalogFor(modelId);
    if (cat) return cat.cost === "paid";
    const p = this.providerOf(modelId);
    if (p === "openrouter") return this.openRouterPaid(modelId);
    if (p && isKeyedProvider(p)) return true;
    // Free-tier (groq) e locais: nunca pagos.
    if (p && isFreeKeyedProvider(p)) return false;
    return modelId.startsWith("@cf/") || modelId.startsWith("openai/") || modelId.startsWith("anthropic/");
  }

  /** Pago e sem ativação explícita do admin (paidAck). */
  paidBlockedByPolicy(modelId: string): boolean {
    return this.blockPaid() && this.isPaidModel(modelId) && !this.paidAck.has(modelId);
  }

  assertUsable(modelId: string): void {
    if (this.disabled.has(modelId)) throw new Error(`Modelo "${modelId}" está desabilitado pelo administrador.`);
    if (this.paidBlockedByPolicy(modelId)) {
      throw new Error(
        `Modelo "${modelId}" pode gerar custo e está bloqueado pela política BLOCK_PAID_PROVIDERS. ` +
        `O administrador pode ativar em Administração → Provedores de IA ("Pago autorizado").`
      );
    }
  }

  /** Seleção automática: melhor modelo de texto disponível e permitido. */
  async autoSelectText(kind: TaskKind = "chat"): Promise<string> {
    const preference: string[] = [];
    const isWorkers = Boolean(this.env.AI);
    const ollama = this.textAdapters.find((a) => a.provider === "ollama");
    const ollamaOk = ollama ? await ollama.ping().catch(() => false) : false;

    if (kind === "code") {
      if (ollamaOk && ollama) {
        const installed = ollama instanceof OllamaAdapter ? await ollama.installedModels().catch(() => [] as string[]) : [];
        const coder = installed.find((m) => m.toLowerCase().includes("coder")) ?? ollama.models().find((m) => m.toLowerCase().includes("coder"));
        if (coder) preference.push(coder);
        preference.push(...ollama.models());
      }
      if (isWorkers) preference.push(...WORKERS_AI_TEXT_DEFAULTS);
    } else {
      if (ollamaOk && ollama) preference.push(...ollama.models());
      if (isWorkers) preference.push(...WORKERS_AI_TEXT_DEFAULTS);
    }
    // Grátis com chave (Groq/OpenRouter) ANTES dos pagos: $0, sem cartão.
    for (const a of this.textAdapters) {
      if (isFreeKeyed(a) && a.provider !== "nvidia" && (await a.hasKey().catch(() => false))) preference.push(...a.models());
    }
    // APIs pagas por chave (só entram se configuradas E liberadas — o laço
    // abaixo respeita disabled + BLOCK_PAID_PROVIDERS para cada candidato).
    for (const a of this.textAdapters) {
      if (isKeyed(a) && (await a.hasKey().catch(() => false))) preference.push(...a.models());
    }
    preference.push("mock-cr-1");

    // Ping UMA vez por adaptador (o catálogo OpenRouter tem centenas de ids).
    const pingCache = new Map<TextAdapter, boolean>();
    for (const id of preference) {
      if (this.disabled.has(id)) continue;
      if (this.paidBlockedByPolicy(id)) continue;
      const adapter = this.findTextAdapter(id);
      if (!adapter) continue;
      let reachable = pingCache.get(adapter);
      if (reachable === undefined) {
        reachable = await adapter.ping().catch(() => false);
        pingCache.set(adapter, reachable);
      }
      if (reachable) return id;
    }
    return "mock-cr-1";
  }

  async autoSelectImage(): Promise<string> {
    const orKeyed = this.orImage ? await this.orImage.hasKey().catch(() => false) : false;
    const orIds = orKeyed && this.orImage ? this.orImage.models() : [];
    const preferred =
      this.env.IMAGE_PROVIDER === "cloudflare-rest"
        ? CLOUDFLARE_FLUX_REST_ID
        : this.env.IMAGE_PROVIDER === "workers-ai"
        ? (this.env.WORKERS_AI_IMAGE_MODEL ?? "@cf/black-forest-labs/flux-1-schnell")
        : this.env.IMAGE_PROVIDER === "pollinations"
          ? POLLINATIONS_MODEL_ID
          : this.env.IMAGE_PROVIDER === "external-gpu"
            ? "flux.1-schnell"
            : this.env.IMAGE_PROVIDER === "openrouter"
              ? (orIds[0] ?? POLLINATIONS_MODEL_ID) // sem chave/catálogo: cai no fallback grátis
              : "local-svg-1";
    // Padrão do admin → preferido do env → OpenRouter (grátis primeiro) →
    // GPU externa → Pollinations (fallback) → SVG local garantido.
    // O SVG é fallback explícito de demonstração — nunca se passa por IA real.
    const candidates = [
      ...(this.defaultImageModel ? [this.defaultImageModel] : []),
      preferred, CLOUDFLARE_FLUX_REST_ID, ...orIds, "flux.1-schnell", POLLINATIONS_MODEL_ID, "local-svg-1",
    ].filter((id, i, arr) => arr.indexOf(id) === i);
    const pingCache = new Map<ImageAdapter, boolean>();
    for (const id of candidates) {
      if (this.disabled.has(id)) continue;
      if (this.paidBlockedByPolicy(id)) continue;
      const adapter = this.findImageAdapter(id);
      if (!adapter) continue;
      // OpenRouter sem chave nem tenta (economiza um ping por id).
      if (adapter.provider === "openrouter" && orIds.length === 0) continue;
      let reachable = pingCache.get(adapter);
      if (reachable === undefined) {
        reachable = await adapter.ping().catch(() => false);
        pingCache.set(adapter, reachable);
      }
      if (reachable) return id;
    }
    return "local-svg-1";
  }

  private async ollamaInstalled(): Promise<string[]> {
    const now = Date.now();
    if (this.installedCache && now - this.installedCache.at < INSTALLED_CACHE_MS) {
      return this.installedCache.models;
    }
    const ollama = this.textAdapters.find((a) => a.provider === "ollama");
    const models = ollama instanceof OllamaAdapter ? await ollama.installedModels().catch(() => []) : [];
    this.installedCache = { at: now, models };
    return models;
  }

  private statusFor(
    provider: string, modelId: string, reachable: boolean, installed: string[],
    keyed?: { needsKey: boolean; hasKey: boolean },
  ): ModelStatus {
    if (this.testing.has(modelId)) return "testing";
    if (provider === "mock" || provider === "local-svg") return "installed";
    if (keyed?.needsKey && !keyed.hasKey) return "needs-credentials";
    // OpenRouter dinâmico: grátis com cotas (limited); pago ativado (installed);
    // pago sem ativação (available = existe, ativável); fora do catálogo (unavailable).
    if (provider === "nvidia") return reachable ? "limited" : "unavailable";
    if (provider === "openrouter" && this.orCatalogAt) {
      const meta = this.orMeta.get(modelId);
      if (!meta || !reachable) return "unavailable";
      if (meta.free) return "limited";
      return this.paidAck.has(modelId) ? "installed" : "available";
    }
    // Free-tier com chave: usável, mas com cotas rígidas (status próprio).
    if (isFreeKeyedProvider(provider)) return reachable ? "limited" : "unavailable";
    if (!reachable) return "unavailable";
    if (provider === "ollama") {
      const norm = modelId.toLowerCase().replace(/:latest$/, "");
      const hit = installed.some((m) => {
        const im = m.toLowerCase().replace(/:latest$/, "");
        return im === norm || im.startsWith(`${norm}:`) || norm.startsWith(`${im}:`);
      });
      return hit ? "installed" : "available";
    }
    // Serviço externo/local alcançável = pronto para uso.
    return "installed";
  }

  /** Capacidades derivadas das modalidades declaradas (sem adivinhar nada). */
  private orCaps(modelId: string, e: OrCatalogEntry): ModelCapability[] {
    const caps: ModelCapability[] = [];
    if (e.text) {
      caps.push("chat");
      if (/coder|code/i.test(modelId)) caps.push("code", "reasoning");
    }
    if (e.image) {
      caps.push("image-gen");
      if (this.orImage?.canEdit(modelId)) caps.push("image-edit");
    }
    return caps.length ? caps : ["chat"];
  }

  private toInfo(
    id: string, provider: string, reachable: boolean,
    installed: string[], fallbackCaps: ModelCapability[],
    keyed?: { needsKey: boolean; hasKey: boolean },
  ): ModelInfo {
    const meta = metaFor(id, provider);
    const or = provider === "openrouter" ? this.orMeta.get(id) : undefined;
    const caps = id === NVIDIA_COSMOS_IMAGE_ID ? (["image-gen"] as ModelCapability[])
      : or ? this.orCaps(id, or) : meta.capabilities.length ? meta.capabilities : capsFor(id, fallbackCaps);
    const paid = meta.cost === "paid" || this.isPaidModel(id);
    const status = this.statusFor(provider, id, reachable, installed, keyed);
    const price = or?.priceKnown && or.priceIn1M !== null && or.priceOut1M !== null && this.orCatalogAt
      ? { in: or.priceIn1M, out: or.priceOut1M, asOf: this.orCatalogAt.slice(0, 10) }
      : PRICE_TABLE[id];
    const free = isFreeKeyedProvider(provider);
    return {
      id,
      label: meta.label,
      provider: meta.provider,
      capabilities: caps,
      available: reachable,
      enabled: !this.disabled.has(id),
      paid,
      external: provider === "pollinations" || provider === "workers-ai" || isKeyedProvider(provider) || free,
      description: id === NVIDIA_COSMOS_IMAGE_ID
        ? "NVIDIA Cosmos3 Nano: endpoint gratuito para protótipos de Physical AI. Gera JPEG de imagens de ambientes físicos; uso exclusivo para testes administrativos, cotas e termos da NVIDIA."
        : meta.description || descFor(id, provider),
      status,
      cost: paid ? "paid" : meta.cost,
      license: meta.license,
      licenseUrl: meta.licenseUrl,
      local: meta.local,
      sizeNote: meta.sizeNote,
      limits: meta.limits,
      requirements: provider === "openrouter" && this.orCatalogAt && paid && !this.paidAck.has(id) && status === "available"
        ? "Modelo pago na OpenRouter (ou sem preço divulgado). Ative em Administração → Provedores de IA (\"Pago autorizado\"). Sem ativação, segue bloqueado."
        : status === "installed" || status === "limited"
          ? undefined
          : status === "needs-credentials"
          ? free
            ? `Chave GRATUITA (sem cartão) de ${FREE_PROVIDER_DEFAULTS[provider as "groq" | "openrouter"]?.label ?? provider} em Administração → Credenciais (seção Grátis). Cotas rígidas — não é ilimitado.`
            : `Configure a chave ${PROVIDER_DEFAULTS[provider as KeyedProvider]?.label ?? provider} em Administração → Credenciais (API paga — o prompt sai do servidor).`
          : meta.requirements,
      lastTest: this.testResults.get(id) ?? null,
      ...(price ? { pricePer1M: { in: price.in, out: price.out, asOf: price.asOf } } : {}),
      ...(or?.context ? { contextLength: or.context } : {}),
      ...(this.findImageEditAdapter(id) ? { supportsEdit: true } : {}),
    };
  }

  /** Lista unificada com disponibilidade REAL (ping em cada adaptador) + catálogo. */
  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    const installed = await this.ollamaInstalled();
    const seen = new Set<string>();

    for (const a of this.textAdapters) {
      const keyedLike = isKeyed(a) || isFreeKeyed(a);
      const keyed = keyedLike ? { needsKey: true, hasKey: await (a as KeyedAdapter).hasKey().catch(() => false) } : undefined;
      // Sem chave, nem tenta ping (economiza timeout e não vaza nada).
      const reachable = keyed && !keyed.hasKey ? false : await a.ping().catch(() => false);
      for (const id of a.models()) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(this.toInfo(id, a.provider, reachable, installed, ["chat", "reasoning"], keyed));
      }
    }
    for (const a of this.imageAdapters) {
      const keyedLike = (a as { needsKey?: boolean }).needsKey === true;
      const keyed = keyedLike
        ? { needsKey: true, hasKey: await (a as unknown as KeyedAdapter).hasKey().catch(() => false) }
        : undefined;
      const reachable = keyed && !keyed.hasKey ? false : await a.ping().catch(() => false);
      for (const id of a.models()) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(this.toInfo(id, a.provider, reachable, installed, ["image-gen"], keyed));
      }
    }
    for (const a of this.voiceAdapters) {
      const reachable = await a.ping().catch(() => false);
      for (const id of a.models()) {
        if (seen.has(id)) continue;
        seen.add(id);
        const caps = id.includes("whisper") ? ["transcription" as const] : ["embeddings" as const];
        out.push(this.toInfo(id, a.provider, reachable, installed, [...caps]));
      }
    }
    // Entradas do catálogo sem adaptador ativo: aparecem como unavailable
    // com requirements (o usuário vê o que existe e como ativar).
    for (const entry of MODEL_CATALOG) {
      if (seen.has(entry.id)) continue;
      // Modelos de demo e workers-ai sem binding: só lista se fizer sentido.
      if (entry.provider === "mock" || entry.provider === "local-svg") continue;
      seen.add(entry.id);
      const price = PRICE_TABLE[entry.id];
      out.push({
        id: entry.id,
        label: entry.label,
        provider: entry.provider,
        capabilities: entry.capabilities,
        available: false,
        enabled: !this.disabled.has(entry.id),
        paid: entry.cost === "paid",
        external: entry.provider === "pollinations" || entry.provider === "workers-ai" || isKeyedProvider(entry.provider) || isFreeKeyedProvider(entry.provider),
        description: entry.description,
        status: "unavailable",
        cost: entry.cost,
        license: entry.license,
        licenseUrl: entry.licenseUrl,
        local: entry.local,
        sizeNote: entry.sizeNote,
        limits: entry.limits,
        requirements: entry.requirements,
        lastTest: this.testResults.get(entry.id) ?? null,
        ...(price ? { pricePer1M: { in: price.in, out: price.out, asOf: price.asOf } } : {}),
      });
    }
    return out;
  }
}

export function createRegistry(env: Env): ModelRegistry {
  return new ModelRegistry(env);
}
