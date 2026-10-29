/**
 * Adaptadores MOCK — funcionam sem GPU, sem rede e sem custo.
 * - MockTextAdapter: respostas úteis offline (eco estruturado + ajuda em PT-BR).
 * - MockSvgImageAdapter: gera SVG real (válido, visualizável, baixável) com o
 *   prompt renderizado — permite testar todo o fluxo de imagens sem GPU.
 * Produção real: configure Ollama (texto) e/ou Workers AI (texto+imagem).
 */
import type { ImageAdapter, ImageGenOptions, ImageGenResult, TextAdapter, ChatOptions, ChatResult } from "./types.js";
import { estimateTokens } from "./types.js";

export class MockTextAdapter implements TextAdapter {
  readonly provider = "mock";

  models(): string[] {
    return ["mock-cr-1"];
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === "user");
    const q = (lastUser?.content ?? "").trim();
    const text = this.answer(q);
    const tokensIn = estimateTokens(opts.messages.map((m) => m.content).join("\n"));
    return { text, model: "mock-cr-1", tokensIn, tokensOut: estimateTokens(text), paid: false };
  }

  private answer(q: string): string {
    if (!q) {
      return "Olá! Sou a **CR IA** (modo local de demonstração). Faça uma pergunta ou peça um texto, resumo ou ideia de campanha.";
    }
    const lower = q.toLowerCase();
    if (lower.includes("quem é você") || lower.includes("quem e voce") || lower.includes("o que você é")) {
      return [
        "Sou a **CR IA** — sua plataforma particular de inteligência artificial.",
        "",
        "No momento estou rodando com o **modelo local de demonstração** (sem GPU/rede), então minhas respostas são básicas. Para respostas avançadas, o administrador pode ativar:",
        "",
        "- **Ollama** na VPS (Qwen3, Gemma 3, Qwen3-Coder…)",
        "- **Cloudflare Workers AI** (Llama, Qwen, Gemma, FLUX para imagens)",
        "",
        "O que você gostaria de fazer? Posso ajudar a organizar ideias, rascunhar textos e gerar artes de teste.",
      ].join("\n");
    }
    if (lower.includes("campanha") || lower.includes("instagram") || lower.includes("anúncio") || lower.includes("anuncio") || lower.includes("divulga")) {
      return [
        `Ideia de campanha para: **"${q}"**`,
        "",
        "**1. Chamada principal:** Oferta clara em até 8 palavras.",
        "**2. Benefício:** o que o cliente ganha (economia, praticidade, status).",
        "**3. Prova:** depoimento, número ou garantia.",
        "**4. Ação:** “Chame no WhatsApp” / “Venha nos visitar”.",
        "",
        "Sugestão de legenda:",
        `> ✨ ${q} — qualidade e preço justo! Fale com a gente e aproveite. #oferta #novidade`,
        "",
        "_Dica: use o Estúdio de Imagens para gerar a arte 1:1 (Instagram) ou 9:16 (Stories/WhatsApp)._",
      ].join("\n");
    }
    if (lower.startsWith("resuma") || lower.includes("resumo")) {
      return [
        "Aqui vai um resumo estruturado do seu pedido:",
        "",
        `- **Tema:** ${q.slice(0, 120)}`,
        "- **Ponto 1:** contexto e objetivo.",
        "- **Ponto 2:** ação principal sugerida.",
        "- **Ponto 3:** próximo passo.",
        "",
        "_Para resumos de documentos reais, anexe um arquivo .txt/.md/.csv/.json na conversa (leitura real) — PDF/DOCX entram na próxima fase._",
      ].join("\n");
    }
    return [
      `Entendi seu pedido: **"${q.slice(0, 200)}"**`,
      "",
      "Estou no **modo local de demonstração** (modelo `mock-cr-1`), então dei uma resposta básica. Quando o administrador ativar o Ollama ou o Workers AI, responderei com muito mais profundidade.",
      "",
      "Enquanto isso, posso:",
      "- Organizar suas ideias em tópicos e planos;",
      "- Rascunhar textos, legendas e roteiros;",
      "- Gerar imagens de teste no Estúdio (SVG local);",
      "- Registrar tarefas e acompanhar projetos.",
      "",
      "Quer que eu estruture este pedido em um plano de ação?",
    ].join("\n");
  }
}

// ---------- Imagens SVG locais ----------

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur.trim());
      cur = w;
    } else {
      cur = `${cur} ${w}`.trim();
    }
  }
  if (cur) lines.push(cur.trim());
  return lines.slice(0, 6);
}

export function renderSvgArt(prompt: string, width: number, height: number, seed = 0): string {
  const h = hashStr(prompt + ":" + seed);
  const hue1 = h % 360;
  const hue2 = (hue1 + 50 + (h % 60)) % 360;
  const lines = wrapText(prompt, 22);
  const fontSize = Math.max(28, Math.min(72, Math.floor(width / 14)));
  const lineHeight = fontSize * 1.25;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  const circles = Array.from({ length: 5 }, (_, i) => {
    const cx = (h >> (i * 5)) % 100;
    const cy = (h >> (i * 3 + 7)) % 100;
    const r = 8 + ((h >> (i * 2)) % 22);
    const o = (0.08 + ((h >> i) % 10) / 100).toFixed(2);
    return `<circle cx="${cx}%" cy="${cy}%" r="${r}%" fill="white" opacity="${o}"/>`;
  }).join("");
  const textEls = lines
    .map((l, i) => {
      const y = startY + i * lineHeight;
      const esc = l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<text x="50%" y="${y.toFixed(0)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" stroke="rgba(0,0,0,.35)" stroke-width="1">${esc}</text>`;
    })
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue1},70%,45%)"/><stop offset="1" stop-color="hsl(${hue2},70%,35%)"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="url(#g)"/>`,
    circles,
    `<rect x="6%" y="8%" width="88%" height="84%" rx="24" fill="none" stroke="white" stroke-opacity=".5" stroke-width="3"/>`,
    textEls,
    `<text x="50%" y="${(height - 28).toFixed(0)}" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="20" fill="white" opacity=".8">CR IA · arte local de demonstração</text>`,
    `</svg>`,
  ].join("");
}

export class MockSvgImageAdapter implements ImageAdapter {
  readonly provider = "local-svg";
  models(): string[] {
    return ["local-svg-1"];
  }
  async ping(): Promise<boolean> {
    return true;
  }
  async generate(opts: ImageGenOptions): Promise<ImageGenResult> {
    const svg = renderSvgArt(opts.prompt, opts.width, opts.height, opts.seed ?? 0);
    return {
      data: new TextEncoder().encode(svg),
      mime: "image/svg+xml",
      model: "local-svg-1",
      paid: false,
    };
  }
}
