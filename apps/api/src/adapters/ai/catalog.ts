/**
 * CR IA v0.2.0 — catálogo curado do centro multimodelo.
 *
 * Cada entrada traz metadados HONESTOS e verificados (out/2026):
 * licença real do peso/serviço, onde roda, custo e o que falta para usar.
 * Modelos sem adaptador ativo aparecem como "unavailable" com requirements —
 * nunca como disponíveis.
 *
 * Fontes das licenças: repositórios oficiais (QwenLM, openai/gpt-oss,
 * black-forest-labs, google/gemma, llama.com) + termos do Workers AI e
 * documentação pública da Pollinations. Ver docs/MODELOS-LICENCAS.md.
 */
import type { ModelCapability, ModelCost, ModelProvider } from "@cr-ia/shared";

export interface CatalogEntry {
  id: string;
  label: string;
  provider: ModelProvider;
  capabilities: ModelCapability[];
  description: string;
  license: string;
  licenseUrl?: string;
  local: boolean;
  cost: ModelCost;
  sizeNote?: string;
  /** Cotas do grátis (só cost free-tier). */
  limits?: string;
  requirements?: string;
}

export const MODEL_CATALOG: CatalogEntry[] = [
  // ---------- Demonstração (sempre instalados, sem IA real) ----------
  {
    id: "mock-cr-1", label: "CR Local (demonstração)", provider: "mock",
    capabilities: ["chat"],
    description: "Respostas básicas offline para testar fluxos. NÃO é IA real — use um modelo local.",
    license: "Código próprio (demo)", local: true, cost: "free",
  },
  {
    id: "local-svg-1", label: "Arte local SVG (demonstração)", provider: "local-svg",
    capabilities: ["image-gen"],
    description: "Desenhos SVG locais para testar o fluxo de imagens. NÃO é IA gerativa.",
    license: "Código próprio (demo)", local: true, cost: "free",
  },
  // ---------- Texto local via Ollama (VPS, sem custo por chamada) ----------
  {
    id: "qwen3:4b", label: "Qwen3 4B (local)", provider: "ollama",
    capabilities: ["chat", "reasoning"],
    description: "Modelo aberto eficiente; padrão da VPS. Bom para chat e raciocínio em PT.",
    license: "Apache-2.0", licenseUrl: "https://github.com/QwenLM/Qwen3/blob/main/LICENSE",
    local: true, cost: "free", sizeNote: "~2,5 GB RAM",
    requirements: "Baixe com: ./scripts/ollama-setup.sh",
  },
  {
    id: "qwen3:8b", label: "Qwen3 8B (local)", provider: "ollama",
    capabilities: ["chat", "reasoning"],
    description: "Versão maior do Qwen3; mais capaz, cabe nos 12 GB da VPS.",
    license: "Apache-2.0", licenseUrl: "https://github.com/QwenLM/Qwen3/blob/main/LICENSE",
    local: true, cost: "free", sizeNote: "~5 GB RAM",
    requirements: "Baixe com: ollama pull qwen3:8b",
  },
  {
    id: "qwen2.5-coder:7b", label: "Qwen2.5-Coder 7B (local)", provider: "ollama",
    capabilities: ["chat", "code", "reasoning"],
    description: "Especialista em código; usado pelo agente desenvolvedor para análise e revisão.",
    license: "Apache-2.0", licenseUrl: "https://github.com/QwenLM/Qwen2.5-Coder/blob/main/LICENSE",
    local: true, cost: "free", sizeNote: "~4,7 GB RAM",
    requirements: "Baixe com: ollama pull qwen2.5-coder:7b",
  },
  {
    id: "gemma3:4b", label: "Gemma 3 4B (local)", provider: "ollama",
    capabilities: ["chat", "reasoning"],
    description: "Modelo aberto do Google; leve e multilíngue.",
    license: "Gemma Terms of Use (uso comercial permitido, ver AUP)",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    local: true, cost: "free", sizeNote: "~3,3 GB RAM",
    requirements: "Baixe com: ollama pull gemma3:4b",
  },
  {
    id: "gemma3:12b", label: "Gemma 3 12B (local)", provider: "ollama",
    capabilities: ["chat", "reasoning"],
    description: "Versão maior do Gemma 3; exige quase toda a RAM da VPS sozinho.",
    license: "Gemma Terms of Use (uso comercial permitido, ver AUP)",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    local: true, cost: "free", sizeNote: "~8 GB RAM",
    requirements: "Baixe com: ollama pull gemma3:12b (feche outros modelos)",
  },
  {
    id: "llama3.1:8b", label: "Llama 3.1 8B (local)", provider: "ollama",
    capabilities: ["chat", "reasoning"],
    description: "Modelo aberto da Meta; boa base geral multilíngue.",
    license: "Llama 3.1 Community License", licenseUrl: "https://www.llama.com/license/",
    local: true, cost: "free", sizeNote: "~4,9 GB RAM",
    requirements: "Baixe com: ollama pull llama3.1:8b",
  },
  {
    id: "gpt-oss:20b", label: "GPT-OSS 20B (GPU externa)", provider: "ollama",
    capabilities: ["chat", "reasoning", "code"],
    description: "Modelo aberto da OpenAI (Apache-2.0). Grande demais para os 12 GB da VPS — rode numa GPU externa e aponte OLLAMA_URL.",
    license: "Apache-2.0", licenseUrl: "https://github.com/openai/gpt-oss/blob/main/LICENSE",
    local: false, cost: "free", sizeNote: "~14 GB VRAM/RAM",
    requirements: "Exige GPU externa (ver docs/GPU-EXTERNA.md) ou VPS maior",
  },
  // ---------- Voz + embeddings locais (serviço ai-local) ----------
  {
    id: "whisper-small", label: "Whisper Small (transcrição local)", provider: "ai-local",
    capabilities: ["transcription"],
    description: "Transcreve áudio em PT/EN na CPU da VPS. Nada sai do servidor.",
    license: "MIT", licenseUrl: "https://github.com/openai/whisper/blob/main/LICENSE",
    local: true, cost: "free", sizeNote: "~1 GB RAM",
    requirements: "Suba o perfil: docker compose --profile ai up -d",
  },
  {
    id: "bge-m3", label: "BGE-M3 (busca em documentos)", provider: "ai-local",
    capabilities: ["embeddings"],
    description: "Embeddings multilíngues (inclui PT) para busca semântica nos seus arquivos.",
    license: "MIT", licenseUrl: "https://huggingface.co/BAAI/bge-m3",
    local: true, cost: "free", sizeNote: "~2 GB RAM",
    requirements: "Suba o perfil: docker compose --profile ai up -d",
  },
  // ---------- Imagem externa gratuita ----------
  {
    id: "pollinations-flux", label: "FLUX real (nuvem gratuita)", provider: "pollinations",
    capabilities: ["image-gen"],
    description:
      "Imagens reais de IA via serviço externo gratuito. Limite: ~1 imagem/min por IP, sem SLA, JPEG com logo; " +
      "desde jul/2026 o grátis contínuo acabou (só créditos de Quests/conta) — o endpoint anônimo segue best-effort. " +
      "USO COMERCIAL NÃO CONFIRMADO (ToS manda verificar por modelo, 23/10/2026). O prompt sai do servidor.",
    license: "Serviço externo — comercial NÃO confirmado (ver termos)",
    licenseUrl: "https://enter.pollinations.ai/terms",
    local: false, cost: "free",
    requirements: "Ative ENABLE_POLLINATIONS=true (consentimento do admin)",
  },
  // ---------- Texto gratuito por chave (free-tier: $0, cotas rígidas) ----------
  {
    id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (Groq grátis)", provider: "groq",
    capabilities: ["chat", "reasoning"],
    description:
      "API Groq OpenAI-compatível. GRÁTIS sem cartão: 30 req/min, 1.000 req/dia, 200K tok/dia (out/2026). " +
      "Rápido; o prompt sai do servidor — nada sensível.",
    license: "Apache-2.0 (pesos GPT-OSS) + termos da Groq",
    licenseUrl: "https://console.groq.com/docs/rate-limits",
    local: false, cost: "free-tier", limits: "30 req/min · 1.000 req/dia · 200K tok/dia",
    requirements: "Chave gratuita: GROQ_API_KEY ou Administração → Credenciais (Guia grátis)",
  },
  {
    id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (Groq grátis)", provider: "groq",
    capabilities: ["chat", "reasoning", "code"],
    description:
      "API Groq OpenAI-compatível. GRÁTIS sem cartão: 30 req/min, 1.000 req/dia, 200K tok/dia (out/2026). " +
      "O mais capaz do grátis; o prompt sai do servidor — nada sensível.",
    license: "Apache-2.0 (pesos GPT-OSS) + termos da Groq",
    licenseUrl: "https://console.groq.com/docs/rate-limits",
    local: false, cost: "free-tier", limits: "30 req/min · 1.000 req/dia · 200K tok/dia",
    requirements: "Chave gratuita: GROQ_API_KEY ou Administração → Credenciais (Guia grátis)",
  },
  {
    id: "openrouter-free", label: "OpenRouter Free (elenco rotativo)", provider: "openrouter",
    capabilities: ["chat", "reasoning"],
    description:
      "Modelos :free do OpenRouter (elenco GIRA sem aviso). GRÁTIS sem cartão: 20 req/min, 50 req/dia " +
      "(1.000 após $10 vitalícios). Hosts variam: alguns PODEM TREINAR com prompts — nada sensível.",
    license: "Varia por modelo/host (ver openrouter.ai/models)",
    licenseUrl: "https://openrouter.ai/docs/api-reference/limits",
    local: false, cost: "free-tier", limits: "20 req/min · 50 req/dia (1.000 após $10)",
    requirements: "Defina OPENROUTER_MODELS com IDs :free atuais (ver openrouter.ai/models) + chave em Credenciais",
  },
  // ---------- Imagem local/nuvem própria (GPU externa, ComfyUI) ----------
  {
    id: "flux.1-schnell", label: "FLUX.1 Schnell (GPU própria)", provider: "external-gpu",
    capabilities: ["image-gen"],
    description: "Peso aberto Apache-2.0 rodando no SEU ComfyUI (GPU externa sob seu controle). Uso comercial liberado.",
    license: "Apache-2.0", licenseUrl: "https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md",
    local: false, cost: "free", sizeNote: "GPU ≥ 12 GB VRAM",
    requirements: "Configure EXTERNAL_GPU_URL (ComfyUI) — ver docs/GPU-EXTERNA.md",
  },
  {
    id: "qwen-image", label: "Qwen-Image (GPU própria)", provider: "external-gpu",
    capabilities: ["image-gen"],
    description: "Geração de imagens Qwen, peso aberto. Roda no seu ComfyUI.",
    license: "Apache-2.0", licenseUrl: "https://github.com/QwenLM/Qwen-Image/blob/main/LICENSE",
    local: false, cost: "free", sizeNote: "GPU ≥ 16 GB VRAM",
    requirements: "Configure EXTERNAL_GPU_URL (ComfyUI) — ver docs/GPU-EXTERNA.md",
  },
  {
    id: "qwen-image-edit", label: "Qwen-Image-Edit (GPU própria)", provider: "external-gpu",
    capabilities: ["image-gen", "image-edit"],
    description: "Edição de imagens por instrução (upload + prompt). Roda no seu ComfyUI.",
    license: "Apache-2.0", licenseUrl: "https://github.com/QwenLM/Qwen-Image/blob/main/LICENSE",
    local: false, cost: "free", sizeNote: "GPU ≥ 16 GB VRAM",
    requirements: "Configure EXTERNAL_GPU_URL (ComfyUI) — edição exige GPU",
  },
  // ---------- Cloudflare Workers AI (serverless; pode gerar custo) ----------
  {
    id: "@cf/qwen/qwen3-8b", label: "Qwen3 8B (Cloudflare)", provider: "workers-ai",
    capabilities: ["chat", "reasoning"],
    description: "Inferência serverless Cloudflare. Bloqueado por padrão (pode gerar custo).",
    license: "Apache-2.0", licenseUrl: "https://github.com/QwenLM/Qwen3/blob/main/LICENSE",
    local: false, cost: "paid",
    requirements: "Deploy Cloudflare + liberar em Modelos (verifique o plano)",
  },
  {
    id: "@cf/meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B (Cloudflare)", provider: "workers-ai",
    capabilities: ["chat", "reasoning"],
    description: "Inferência serverless Cloudflare. Bloqueado por padrão (pode gerar custo).",
    license: "Llama 3.1 Community License", licenseUrl: "https://www.llama.com/license/",
    local: false, cost: "paid",
    requirements: "Deploy Cloudflare + liberar em Modelos (verifique o plano)",
  },
  {
    id: "@cf/google/gemma-3-12b-it", label: "Gemma 3 12B (Cloudflare)", provider: "workers-ai",
    capabilities: ["chat", "reasoning"],
    description: "Inferência serverless Cloudflare. Bloqueado por padrão (pode gerar custo).",
    license: "Gemma Terms of Use", licenseUrl: "https://ai.google.dev/gemma/terms",
    local: false, cost: "paid",
    requirements: "Deploy Cloudflare + liberar em Modelos (verifique o plano)",
  },
  {
    id: "@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 Schnell (Cloudflare)", provider: "workers-ai",
    capabilities: ["image-gen"],
    description: "Inferência serverless Cloudflare. Bloqueado por padrão (pode gerar custo).",
    license: "Apache-2.0", licenseUrl: "https://huggingface.co/black-forest-labs/FLUX.1-schnell/blob/main/LICENSE.md",
    local: false, cost: "paid",
    requirements: "Deploy Cloudflare + liberar em Modelos (verifique o plano)",
  },
  // ---------- APIs pagas por chave (IDs reais, verificados em 22/10/2026) ----------
  {
    id: "gpt-5-mini", label: "GPT-5 Mini (OpenAI API)", provider: "openai",
    capabilities: ["chat", "reasoning"],
    description: "API oficial OpenAI. PAGO (~$0,25/$2,00 por 1M in/out, tab. 22/10/2026). O prompt sai do servidor.",
    license: "Serviço externo (termos da OpenAI)", licenseUrl: "https://platform.openai.com/docs/models",
    local: false, cost: "paid",
    requirements: "Configure OPENAI_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "gpt-5", label: "GPT-5 (OpenAI API)", provider: "openai",
    capabilities: ["chat", "reasoning", "code"],
    description: "API oficial OpenAI. PAGO (~$1,25/$10,00 por 1M in/out, tab. 22/10/2026). O prompt sai do servidor.",
    license: "Serviço externo (termos da OpenAI)", licenseUrl: "https://platform.openai.com/docs/models",
    local: false, cost: "paid",
    requirements: "Configure OPENAI_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "claude-opus-4-6", label: "Claude Opus 4.6 (Anthropic API)", provider: "anthropic",
    capabilities: ["chat", "reasoning", "code"],
    description: "Messages API oficial. PAGO (preço não publicado na pesquisa — consulte o console). O prompt sai do servidor.",
    license: "Serviço externo (termos da Anthropic)", licenseUrl: "https://docs.anthropic.com/en/docs/models-overview",
    local: false, cost: "paid",
    requirements: "Configure ANTHROPIC_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Anthropic API)", provider: "anthropic",
    capabilities: ["chat", "reasoning", "code"],
    description: "Messages API oficial. PAGO (consulte o preço no console). O prompt sai do servidor.",
    license: "Serviço externo (termos da Anthropic)", licenseUrl: "https://docs.anthropic.com/en/docs/models-overview",
    local: false, cost: "paid",
    requirements: "Configure ANTHROPIC_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (Google API)", provider: "google",
    capabilities: ["chat", "reasoning"],
    description: "generateContent oficial. PAGO (~$0,75/$3,75 por 1M in/out, tab. 22/10/2026). O prompt sai do servidor.",
    license: "Serviço externo (termos do Google AI)", licenseUrl: "https://ai.google.dev/gemini-api/docs/models",
    local: false, cost: "paid",
    requirements: "Configure GOOGLE_AI_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "gemini-4-argon", label: "Gemini 4 Argon (Google API)", provider: "google",
    capabilities: ["chat", "reasoning"],
    description: "Modelo flagship atual. PAGO (~$2,00/$10,00 por 1M in/out, tab. 22/10/2026). O prompt sai do servidor.",
    license: "Serviço externo (termos do Google AI)", licenseUrl: "https://ai.google.dev/gemini-api/docs/models",
    local: false, cost: "paid",
    requirements: "Configure GOOGLE_AI_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "grok-4.7", label: "Grok 4.7 (xAI API)", provider: "xai",
    capabilities: ["chat", "reasoning", "code"],
    description: "API oficial xAI (OpenAI-compatível). PAGO ($2,00/$6,00 por 1M in/out, docs.x.ai). O prompt sai do servidor.",
    license: "Serviço externo (termos da xAI)", licenseUrl: "https://docs.x.ai/overview",
    local: false, cost: "paid",
    requirements: "Configure XAI_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "grok-4.3", label: "Grok 4.3 (xAI API)", provider: "xai",
    capabilities: ["chat", "reasoning"],
    description: "API oficial xAI (OpenAI-compatível). PAGO (consulte o preço no console). O prompt sai do servidor.",
    license: "Serviço externo (termos da xAI)", licenseUrl: "https://docs.x.ai/overview",
    local: false, cost: "paid",
    requirements: "Configure XAI_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "deepseek-chat", label: "DeepSeek Chat (API)", provider: "deepseek",
    capabilities: ["chat", "reasoning"],
    description: "API oficial DeepSeek (OpenAI-compatível). PAGO (consulte o preço no console). O prompt sai do servidor.",
    license: "Serviço externo (termos da DeepSeek)", licenseUrl: "https://api-docs.deepseek.com/",
    local: false, cost: "paid",
    requirements: "Configure DEEPSEEK_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "deepseek-reasoner", label: "DeepSeek Reasoner (API)", provider: "deepseek",
    capabilities: ["chat", "reasoning", "code"],
    description: "Modelo de raciocínio oficial. PAGO (consulte o preço no console). O prompt sai do servidor.",
    license: "Serviço externo (termos da DeepSeek)", licenseUrl: "https://api-docs.deepseek.com/",
    local: false, cost: "paid",
    requirements: "Configure DEEPSEEK_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "mistral-large-latest", label: "Mistral Large (API)", provider: "mistral",
    capabilities: ["chat", "reasoning", "code"],
    description: "API oficial Mistral (OpenAI-compatível). PAGO (consulte o preço no console). O prompt sai do servidor.",
    license: "Serviço externo (termos da Mistral)", licenseUrl: "https://docs.mistral.ai/getting-started/models/",
    local: false, cost: "paid",
    requirements: "Configure MISTRAL_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  {
    id: "mistral-medium-latest", label: "Mistral Medium (API)", provider: "mistral",
    capabilities: ["chat", "reasoning"],
    description: "API oficial Mistral (OpenAI-compatível). PAGO (consulte o preço no console). O prompt sai do servidor.",
    license: "Serviço externo (termos da Mistral)", licenseUrl: "https://docs.mistral.ai/getting-started/models/",
    local: false, cost: "paid",
    requirements: "Configure MISTRAL_API_KEY ou cadastre a chave em Administração → Credenciais",
  },
  // ---------- Modelos EXCLUÍDOS de propósito (documentados, não integrados) --
  // FLUX.1-dev: licença NÃO comercial (FLUX.1 [dev] Non-Commercial License).
  // Qwen-Image-2.1: Qwen Research License (somente pesquisa, sem comercial).
  // A CR IA prioriza pesos com licença comercial; esses ficam fora do catálogo.
];

/** Busca tolerante: ignora tag ":latest" e caixa. */
export function catalogFor(modelId: string): CatalogEntry | null {
  const norm = modelId.trim().toLowerCase().replace(/:latest$/, "");
  return (
    MODEL_CATALOG.find((e) => e.id.toLowerCase() === norm) ??
    MODEL_CATALOG.find((e) => e.id.toLowerCase() === `${norm}:latest`) ??
    null
  );
}

/** Metadados genéricos para modelos @cf/* fora da lista curada. */
export function genericWorkersAiEntry(modelId: string): CatalogEntry {
  return {
    id: modelId,
    label: modelId.replace("@cf/", "").replace(/-/g, " ") + " (Cloudflare)",
    provider: "workers-ai",
    capabilities: ["chat", "reasoning"],
    description: "Inferência serverless Cloudflare. Bloqueado por padrão (pode gerar custo).",
    license: "Ver termos do Workers AI",
    licenseUrl: "https://developers.cloudflare.com/workers-ai/",
    local: false,
    cost: "paid",
    requirements: "Deploy Cloudflare + liberar em Modelos (verifique o plano)",
  };
}
