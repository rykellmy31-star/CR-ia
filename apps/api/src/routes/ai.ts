/**
 * CR IA v0.2.0 — rotas de IA local/auxiliar:
 * busca web (SearXNG), transcrição (Whisper) e busca em documentos.
 * Nada aqui é simulado: sem o serviço correspondente, a resposta é
 * erro claro com instrução de ativação (verificada por testes).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth } from "../middleware/auth.js";
import { cosineSimilarity, EMBEDDING_MODEL_ID, WHISPER_MODEL_ID } from "../adapters/ai/ailocal.js";
import { chunkText } from "../services/docparse.js";
import { searchProviderStatus, webSearch } from "../services/websearch.js";
import { indexFileChunks } from "../services/docindex.js";

export const aiRoutes = new Hono<{ Bindings: Env }>();

/** Estado real dos serviços auxiliares (para badges na UI). */
aiRoutes.get("/status", requireAuth, async (c) => {
  const models = c.get("models");
  const voice = models.transcriptionAdapter();
  const voiceUp = voice ? await voice.ping().catch(() => false) : false;
  const providers = await searchProviderStatus(c.env, c.get("db"));
  return ok(c, {
    transcription: voiceUp,
    embeddings: voiceUp,
    webSearch: providers.some((p) => p.configured),
    searchProviders: providers,
    models: { transcription: WHISPER_MODEL_ID, embeddings: EMBEDDING_MODEL_ID },
  });
});

const searchSchema = z.object({
  q: z.string().min(2).max(300),
  limit: z.number().int().min(1).max(20).optional(),
  provider: z.string().max(30).optional(),
});

aiRoutes.post("/search", requireAuth, async (c) => {
  const parsed = searchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { q: \"termo\" }.", 400);
  const db = c.get("db");
  try {
    const resp = await webSearch(c.env, db, parsed.data.q, parsed.data.limit ?? 8, {
      provider: parsed.data.provider, paidBlocked: c.get("models").blockPaid(),
    });
    await db.saveSearch({
      userId: c.get("user").id, provider: resp.provider,
      query: resp.query, resultsCount: resp.results.length,
    });
    await db.logUsage({
      userId: c.get("user").id, modelId: `search:${resp.provider}`, kind: "web-search",
      tokensIn: 0, tokensOut: 0, costFlag: resp.provider !== "searxng",
    });
    await db.logAudit({
      userId: c.get("user").id, action: "ai.web_search",
      detail: `${resp.provider}:${parsed.data.q.slice(0, 120)}`,
    });
    return ok(c, resp);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Busca falhou.", 503);
  }
});

/** Histórico de pesquisas do usuário. */
aiRoutes.get("/searches", requireAuth, async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 30)));
  const items = await c.get("db").listSearches(c.get("user").id, limit);
  return ok(c, { items });
});

const readUrlSchema = z.object({ url: z.string().min(10).max(2000) });

/** Lê uma página pública e devolve texto legível (anti-SSRF embutido). */
aiRoutes.post("/read-url", requireAuth, async (c) => {
  const parsed = readUrlSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { url: \"https://...\" }.", 400);
  try {
    const { readPublicUrl } = await import("../services/urlreader.js");
    const r = await readPublicUrl(parsed.data.url);
    await c.get("db").logAudit({
      userId: c.get("user").id, action: "ai.read_url", detail: r.finalUrl.slice(0, 200),
    });
    return ok(c, r);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Leitura falhou.", 400);
  }
});

const codeIndexSchema = z.object({ runId: z.string().min(1).max(80) });

/**
 * Indexa o código do clone de um run do agente (somente dentro do
 * diretório isolado do agente; dono do run ou admin).
 */
aiRoutes.post("/code/index", requireAuth, async (c) => {
  const parsed = codeIndexSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { runId }.", 400);
  const db = c.get("db");
  const user = c.get("user");
  const run = await db.getAgentRun(parsed.data.runId);
  if (!run) return fail(c, "Run não encontrado.", 404);
  if (run.userId !== user.id && user.role !== "admin") return fail(c, "Sem acesso a este run.", 403);
  try {
    const { runDir } = await import("../services/agent.js");
    const { indexRepoCode } = await import("../services/codeindex.js");
    const r = await indexRepoCode(db, c.get("models"), user.id, run.repo, runDir(c.env, run.id));
    await db.logAudit({
      userId: user.id, action: "ai.code_indexed",
      detail: `${run.repo}: ${r.files} arquivos, ${r.chunks} trechos`,
    });
    return ok(c, r);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Indexação falhou.", 400);
  }
});

const codeSearchSchema = z.object({
  q: z.string().min(2).max(300),
  repo: z.string().max(160).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

/** Busca no código indexado (semântica quando há embeddings). */
aiRoutes.post("/code/search", requireAuth, async (c) => {
  const parsed = codeSearchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { q: \"termo\" }.", 400);
  const db = c.get("db");
  const user = c.get("user");
  const limit = parsed.data.limit ?? 8;
  const chunks = await db.listCodeChunks(user.id, parsed.data.repo);
  if (!chunks.length) {
    return ok(c, {
      query: parsed.data.q, method: "none", semantic: false, matches: [],
      hint: "Nenhum código indexado. No painel do agente, rode “Indexar código” num run concluído.",
    });
  }
  const models = c.get("models");
  const adapter = models.transcriptionAdapter();
  const withEmb = chunks.filter((ch) => ch.embedding);
  if (adapter && withEmb.length) {
    try {
      const { embeddings } = await adapter.embed({ texts: [parsed.data.q] });
      const qv = embeddings[0] ?? [];
      const scored = withEmb.map((ch) => {
        let v: number[] = [];
        try { v = JSON.parse(ch.embedding as string) as number[]; } catch { /* ignora */ }
        return { ch, score: cosineSimilarity(qv, v) };
      }).filter((s) => s.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      await db.logUsage({
        userId: user.id, modelId: EMBEDDING_MODEL_ID, kind: "embedding",
        tokensIn: 0, tokensOut: 0, costFlag: false,
      });
      return ok(c, {
        query: parsed.data.q, method: "semantic", semantic: true,
        matches: scored.map((s) => ({
          repo: s.ch.repo, path: s.ch.path,
          excerpt: s.ch.text.slice(0, 600), score: Math.round(s.score * 1000) / 1000,
        })),
      });
    } catch {
      // Cai para palavra-chave.
    }
  }
  const terms = parsed.data.q.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  const scored = chunks.map((ch) => {
    const low = ch.text.toLowerCase();
    let hits = 0;
    for (const t of terms) if (low.includes(t)) hits++;
    return { ch, score: terms.length ? hits / terms.length : 0 };
  }).filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ok(c, {
    query: parsed.data.q, method: terms.length ? "keyword" : "none",
    semantic: false,
    matches: scored.map((s) => ({
      repo: s.ch.repo, path: s.ch.path,
      excerpt: s.ch.text.slice(0, 600), score: Math.round(s.score * 1000) / 1000,
    })),
  });
});

const AUDIO_MIMES = [
  "audio/", "video/mp4", "video/webm", "video/quicktime",
  "application/octet-stream", "application/ogg",
];

aiRoutes.post("/transcribe", requireAuth, async (c) => {
  const db = c.get("db");
  const models = c.get("models");
  const user = c.get("user");

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, "Envie o áudio como multipart/form-data (campo \"audio\").", 400);
  }
  const part = form.get("audio");
  if (!(part instanceof File)) return fail(c, "Campo \"audio\" ausente.", 400);
  const mime = part.type || "application/octet-stream";
  if (!AUDIO_MIMES.some((p) => mime.startsWith(p))) {
    return fail(c, `Tipo de áudio não suportado: ${mime}.`, 415);
  }
  if (part.size === 0 || part.size > 100 * 1024 * 1024) {
    return fail(c, "Áudio vazio ou maior que 100 MB.", 400);
  }
  const language = form.get("language");
  const adapter = models.transcriptionAdapter();
  if (!adapter) {
    return fail(c, "Transcrição indisponível: AI_LOCAL_URL não configurado. Suba com: docker compose --profile ai up -d", 503);
  }
  try {
    const audio = new Uint8Array(await part.arrayBuffer());
    const r = await adapter.transcribe({
      audio, mime, fileName: part.name || "audio",
      language: typeof language === "string" && language ? language : undefined,
    });
    await db.logUsage({
      userId: user.id, modelId: WHISPER_MODEL_ID, kind: "transcription",
      tokensIn: 0, tokensOut: 0, costFlag: false,
    });
    return ok(c, { text: r.text, language: r.language, durationSec: r.durationSec, model: WHISPER_MODEL_ID });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Transcrição falhou.", 502);
  }
});

const indexSchema = z.object({ fileId: z.string().min(1) });

/** (Re)indexa um arquivo próprio para busca (texto + embeddings quando disponíveis). */
aiRoutes.post("/documents/index", requireAuth, async (c) => {
  const parsed = indexSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { fileId }.", 400);
  const db = c.get("db");
  const file = await db.getFile(parsed.data.fileId, c.get("user").id);
  if (!file) return fail(c, "Arquivo não encontrado.", 404);
  try {
    const r = await indexFileChunks({
      db, storage: c.get("storage"), models: c.get("models"),
      file, userId: c.get("user").id,
    });
    return ok(c, r);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Indexação falhou.", 415);
  }
});

const docSearchSchema = z.object({
  q: z.string().min(2).max(500),
  limit: z.number().int().min(1).max(20).optional(),
});

function keywordScore(query: string, text: string): number {
  const terms = query.toLowerCase().split(/[^a-zà-ú0-9]+/i).filter((t) => t.length > 2);
  if (!terms.length) return 0;
  const low = text.toLowerCase();
  let hits = 0;
  for (const t of terms) if (low.includes(t)) hits++;
  return hits / terms.length;
}

/** Busca nos documentos do usuário: semântica (embeddings) ou palavra-chave. */
aiRoutes.post("/documents/search", requireAuth, async (c) => {
  const parsed = docSearchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return fail(c, "Informe { q: \"termo\" }.", 400);
  const db = c.get("db");
  const models = c.get("models");
  const user = c.get("user");
  const limit = parsed.data.limit ?? 8;

  const chunks = await db.listDocumentChunks(user.id);
  if (!chunks.length) {
    return ok(c, {
      query: parsed.data.q, method: "none", semantic: false,
      matches: [], hint: "Nenhum documento indexado. Envie um arquivo ou rode a indexação.",
    });
  }

  // Tenta busca semântica quando há embeddings e o serviço responde.
  const adapter = models.transcriptionAdapter();
  const withEmb = chunks.filter((ch) => ch.embedding);
  if (adapter && withEmb.length) {
    try {
      const { embeddings } = await adapter.embed({ texts: [parsed.data.q] });
      const qv = embeddings[0] ?? [];
      const scored = withEmb.map((ch) => {
        let v: number[] = [];
        try { v = JSON.parse(ch.embedding as string) as number[]; } catch { /* ignora */ }
        return { ch, score: cosineSimilarity(qv, v) };
      }).filter((s) => s.score > 0.15)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      await db.logUsage({
        userId: user.id, modelId: EMBEDDING_MODEL_ID, kind: "embedding",
        tokensIn: 0, tokensOut: 0, costFlag: false,
      });
      return ok(c, {
        query: parsed.data.q, method: "semantic", semantic: true,
        matches: scored.map((s) => ({
          fileId: s.ch.fileId, fileName: s.ch.fileName,
          excerpt: s.ch.text.slice(0, 600), score: Math.round(s.score * 1000) / 1000,
        })),
      });
    } catch {
      // Cai para palavra-chave (avisa na resposta — nada escondido).
    }
  }

  const scored = chunks.map((ch) => ({ ch, score: keywordScore(parsed.data.q, ch.text) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ok(c, {
    query: parsed.data.q, method: "keyword", semantic: false,
    matches: scored.map((s) => ({
      fileId: s.ch.fileId, fileName: s.ch.fileName,
      excerpt: s.ch.text.slice(0, 600), score: Math.round(s.score * 1000) / 1000,
    })),
    hint: "Busca por palavra-chave (serviço de embeddings indisponível). Suba: docker compose --profile ai up -d",
  });
});

export { chunkText };
