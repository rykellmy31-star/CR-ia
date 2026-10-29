/** Chat + conversas: histórico persistente, limites e streaming SSE. */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth } from "../middleware/auth.js";
import { csv, getBool, getNum } from "../lib/config.js";
import { estimateTokens } from "../adapters/ai/types.js";

export const chatRoutes = new Hono<{ Bindings: Env }>();

const msgSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(20000),
});

const completionSchema = z.object({
  conversationId: z.string().optional(),
  model: z.string().optional(), // omitido = automático
  messages: z.array(msgSchema).min(1).max(50),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(8192).optional(),
  /** true = o cliente já anexou contexto web (pula a busca automática do servidor). */
  web: z.boolean().optional(),
});

export interface WebUsed {
  provider: string;
  query: string;
}

/**
 * Busca web automática (Fase 3): se a pergunta parece depender de fatos
 * recentes e a busca automática está ligada, pesquisa e anexa o contexto
 * (com fontes [n], datas e a distinção web x conhecimento interno).
 * Falha de busca NUNCA quebra o chat (segue sem contexto + avisa no log).
 */
async function maybeAutoSearch(
  c: Ctx, userId: string, text: string, clientWeb: boolean | undefined
): Promise<{ context: string; webUsed: WebUsed | null }> {
  const none = { context: "", webUsed: null as WebUsed | null };
  if (clientWeb) return none;
  const db = c.get("db") as import("../adapters/db/types.js").DbAdapter;
  const autoSetting = await db.getSetting("search.auto").catch(() => null);
  if (autoSetting === "false") return none;
  const { needsWebSearch, webSearch, formatResultsForChat } = await import("../services/websearch.js");
  if (!needsWebSearch(text)) return none;
  try {
    const resp = await webSearch(c.env, db, text.slice(0, 300), 6, {
      paidBlocked: (c.get("models") as import("../adapters/ai/registry.js").ModelRegistry).blockPaid(),
    });
    await db.saveSearch({
      userId, provider: resp.provider, query: resp.query, resultsCount: resp.results.length,
    });
    await db.logUsage({
      userId, modelId: `search:${resp.provider}`, kind: "web-search",
      tokensIn: 0, tokensOut: 0, costFlag: resp.provider !== "searxng",
    });
    return {
      context: `\n\n--- Contexto da BUSCA WEB automática ---\n${formatResultsForChat(resp)}`,
      webUsed: { provider: resp.provider, query: resp.query },
    };
  } catch (e) {
    await db.logAudit({
      userId, action: "chat.autosearch.failed",
      detail: (e instanceof Error ? e.message : "busca falhou").slice(0, 200),
    });
    return none;
  }
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface ModelFallback {
  from: string;
  to: string;
  reason: string;
}

type Ctx = {
  get: (k: "models" | "db") => import("../adapters/ai/registry.js").ModelRegistry & import("../adapters/db/types.js").DbAdapter;
  env: Env;
};

export function userDefaultChatKey(userId: string): string {
  return `user.defaultChat.${userId}`;
}

/**
 * Resolve o modelo efetivo.
 * - Escolha explícita sem credencial => ERRO claro ("Indisponível — Configurar
 *   API"), sem trocar silenciosamente (o usuário pediu aquele provedor).
 * - Escolha explícita com provedor fora do ar => fallback para o automático,
 *   SEMPRE sinalizado (fallback.from/to/reason) para a UI avisar que o
 *   contexto foi enviado a outro provedor.
 * - "auto"/omitido => preferência do usuário (se válida) ou seleção automática.
 */
async function resolveModel(
  c: Ctx, requested: string | undefined, userId: string
): Promise<{ modelId: string; fallback: ModelFallback | null }> {
  const models = c.get("models") as import("../adapters/ai/registry.js").ModelRegistry;
  const db = c.get("db") as import("../adapters/db/types.js").DbAdapter;
  const auto = getBool({ env: c.env }, "AUTO_MODEL_SELECT", true);

  if (requested && requested !== "auto") {
    models.assertUsable(requested);
    const adapter = models.findTextAdapter(requested);
    if (!adapter) throw new Error(`Modelo "${requested}" desconhecido neste servidor.`);
    if ((await models.modelKeyState(requested)) === "needs-credentials") {
      throw new Error(
        `Indisponível — Configurar API: o modelo "${requested}" precisa de chave. ` +
        `Peça ao administrador em Administração → Credenciais.`
      );
    }
    if (!(await adapter.ping().catch(() => false))) {
      const to = await models.autoSelectText("chat");
      return {
        modelId: to,
        fallback: { from: requested, to, reason: "provedor inacessível no momento" },
      };
    }
    return { modelId: requested, fallback: null };
  }

  // Preferência individual do usuário (se válida e alcançável).
  const pref = await db.getSetting(userDefaultChatKey(userId)).catch(() => null);
  if (pref && pref !== "auto") {
    try {
      models.assertUsable(pref);
      const adapter = models.findTextAdapter(pref);
      if (adapter && (await models.modelKeyState(pref)) !== "needs-credentials" && await adapter.ping().catch(() => false)) {
        return { modelId: pref, fallback: null };
      }
    } catch {
      // preferência inválida/bloqueada: ignora e segue para o automático
    }
  }
  if (!auto && models.defaultChatModel) {
    models.assertUsable(models.defaultChatModel);
    return { modelId: models.defaultChatModel, fallback: null };
  }
  return { modelId: await models.autoSelectText("chat"), fallback: null };
}

/** Erros que NÃO admitem fallback (trocar de modelo esconderia o problema real). */
function isNoFallbackError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return /Configurar API|rejeitada|não existe|desconhecido|desabilitado|bloquead|Limite diário/i.test(msg);
}

async function checkLimit(c: { get: (k: "db") => import("../adapters/db/types.js").DbAdapter; env: Env }, userId: string): Promise<void> {
  const db = c.get("db");
  const limit = getNum({ env: c.env }, "DAILY_LIMIT_CHAT", 200);
  if (limit <= 0) return;
  const used = await db.countUsageSince(userId, "chat", startOfTodayIso());
  if (used >= limit) {
    throw new Error(`Limite diário de conversas atingido (${limit}). Fale com o administrador.`);
  }
}

chatRoutes.post("/completions", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = completionSchema.safeParse(body);
  if (!parsed.success) return fail(c, parsed.error.issues[0]?.message ?? "Dados inválidos.", 400);

  const db = c.get("db");
  const models = c.get("models");
  const user = c.get("user");

  // Cota antes do try genérico: excedida = 429 (não 502).
  try {
    await checkLimit(c, user.id);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Limite atingido.", 429);
  }
  try {
    // Comando /agente (admin): cria uma execução REAL do agente via chat.
    // Antes do resolveModel: o comando não precisa de LLM.
    const cmdText = [...parsed.data.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (cmdText.trim().startsWith("/agente")) {
      if (user.role !== "admin") return fail(c, "O comando /agente é restrito ao administrador.", 403);
      const { parseAgentCommand, createAgentRunAndTask } = await import("../services/agent.js");
      let cmd: { repo: string; goal: string };
      try {
        cmd = parseAgentCommand(cmdText);
      } catch (e) {
        return fail(c, e instanceof Error ? e.message : "Comando inválido.", 400);
      }
      try {
        let convId = parsed.data.conversationId ?? null;
        if (convId) {
          const conv = await db.getConversation(convId, user.id);
          if (!conv) return fail(c, "Conversa não encontrada.", 404);
        } else {
          const conv = await db.createConversation({ userId: user.id, title: cmdText.slice(0, 60), modelId: "agent-command" });
          convId = conv.id;
        }
        await db.addMessage({ conversationId: convId, role: "user", content: cmdText, modelId: "agent-command" });
        const { run } = await createAgentRunAndTask({ env: c.env, db }, user.id, cmd);
        const text =
          `🤖 Agente iniciado no repo \`${run.repo}\` (execução \`${run.id}\`, branch \`${run.workBranch}\`).\n` +
          `Acompanhe em Tarefas/Agente. Push, PR e merge exigem sua aprovação.`;
        const savedCmd = await db.addMessage({ conversationId: convId, role: "assistant", content: text, modelId: "agent-command" });
        await db.logAudit({ userId: user.id, action: "chat.agent_command", detail: `${run.id} ${run.repo}` });
        return ok(c, {
          conversationId: convId, message: savedCmd, model: "agent-command", fallback: null,
          webUsed: null, usage: { tokensIn: 0, tokensOut: 0, paid: false },
        });
      } catch (e) {
        return fail(c, e instanceof Error ? e.message : "Falha ao iniciar o agente.", 403);
      }
    }

    let { modelId, fallback } = await resolveModel(c, parsed.data.model, user.id);
    if (modelId.startsWith("nvidia-nim:") && user.role !== "admin") return fail(c, "NVIDIA NIM Free Endpoint é exclusivo do administrador para testes.", 403);
    let adapter = models.findTextAdapter(modelId);
    if (!adapter) return fail(c, `Modelo "${modelId}" não encontrado.`, 400);

    // Conversa: reutiliza ou cria
    let conversationId = parsed.data.conversationId ?? null;
    if (conversationId) {
      const conv = await db.getConversation(conversationId, user.id);
      if (!conv) return fail(c, "Conversa não encontrada.", 404);
    } else {
      const firstUser = parsed.data.messages.find((m) => m.role === "user");
      const title = (firstUser?.content ?? "Nova conversa").slice(0, 60);
      const conv = await db.createConversation({ userId: user.id, title, modelId });
      conversationId = conv.id;
    }

    // Persiste mensagens do usuário (somente as novas: a última do lote)
    const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
      await db.addMessage({ conversationId, role: "user", content: lastUser.content, modelId });
    }

    const history = await db.listMessages(conversationId);
    // Busca web automática (Fase 3): contexto com fontes no último user msg.
    const auto = await maybeAutoSearch(c, user.id, lastUser?.content ?? "", parsed.data.web);
    const webUsed = auto.webUsed;
    const chatMessages = [
      ...history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
      ...(lastUser ? [] : [{ role: "user" as const, content: "" }]),
    ].filter((m) => m.content.length > 0);
    if (auto.context) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role === "user") {
          chatMessages[i] = { ...chatMessages[i], content: chatMessages[i].content + auto.context };
          break;
        }
      }
    }

    // Fallback em falha de execução (1 tentativa no automático; sempre avisado).
    let result;
    try {
      result = await adapter.chat({
        model: modelId, messages: chatMessages,
        temperature: parsed.data.temperature, maxTokens: parsed.data.maxTokens,
      });
    } catch (firstErr) {
      if (fallback || isNoFallbackError(firstErr)) throw firstErr;
      const to = await models.autoSelectText("chat");
      const alt = models.findTextAdapter(to);
      if (!alt || to === modelId) throw firstErr;
      fallback = { from: modelId, to, reason: firstErr instanceof Error ? firstErr.message.slice(0, 160) : "falha no provedor" };
      modelId = to;
      adapter = alt;
      result = await adapter.chat({
        model: modelId, messages: chatMessages,
        temperature: parsed.data.temperature, maxTokens: parsed.data.maxTokens,
      });
    }
    if (fallback) {
      await db.logAudit({
        userId: user.id, action: "chat.fallback",
        detail: `${fallback.from} -> ${fallback.to} :: ${fallback.reason}`.slice(0, 300),
      });
    }

    const saved = await db.addMessage({
      conversationId, role: "assistant", content: result.text,
      modelId, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    await db.logUsage({
      userId: user.id, modelId, kind: "chat",
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costFlag: result.paid,
    });

    return ok(c, {
      conversationId,
      message: saved,
      model: modelId,
      fallback,
      webUsed,
      usage: { tokensIn: result.tokensIn, tokensOut: result.tokensOut, paid: result.paid },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha na conversa.";
    await db.logAudit({ userId: user.id, action: "chat.error", detail: msg.slice(0, 500) });
    // Pago bloqueado/desabilitado = 403 (política); sem chave = 412; demais = 502.
    const status = /bloquead|desabilitado/i.test(msg) ? 403 : /Configurar API/i.test(msg) ? 412 : 502;
    return fail(c, msg, status);
  }
});

/** Streaming SSE: mesma lógica, entrega progressiva por palavras. */
chatRoutes.post("/stream", requireAuth, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = completionSchema.safeParse(body);
  if (!parsed.success) return fail(c, "Dados inválidos.", 400);

  const db = c.get("db");
  const models = c.get("models");
  const user = c.get("user");

  try {
    await checkLimit(c, user.id);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Limite atingido.", 429);
  }
  try {
    let { modelId, fallback } = await resolveModel(c, parsed.data.model, user.id);
    if (modelId.startsWith("nvidia-nim:") && user.role !== "admin") return fail(c, "NVIDIA NIM Free Endpoint é exclusivo do administrador para testes.", 403);
    let adapter = models.findTextAdapter(modelId);
    if (!adapter) return fail(c, "Modelo não encontrado.", 400);

    let conversationId = parsed.data.conversationId ?? null;
    if (conversationId) {
      const conv = await db.getConversation(conversationId, user.id);
      if (!conv) return fail(c, "Conversa não encontrada.", 404);
    } else {
      const firstUser = parsed.data.messages.find((m) => m.role === "user");
      const conv = await db.createConversation({
        userId: user.id,
        title: (firstUser?.content ?? "Nova conversa").slice(0, 60),
        modelId,
      });
      conversationId = conv.id;
    }
    const lastUser = [...parsed.data.messages].reverse().find((m) => m.role === "user");
    if (lastUser) await db.addMessage({ conversationId, role: "user", content: lastUser.content, modelId });

    const history = await db.listMessages(conversationId);
    const chatMessages = history.slice(-20).map((m) => ({ role: m.role, content: m.content })).filter((m) => m.content.length > 0);
    // Busca web automática (Fase 3): mesmo comportamento do completions.
    const streamAuto = await maybeAutoSearch(c, user.id, lastUser?.content ?? "", parsed.data.web);
    if (streamAuto.context) {
      for (let i = chatMessages.length - 1; i >= 0; i--) {
        if (chatMessages[i].role === "user") {
          chatMessages[i] = { ...chatMessages[i], content: chatMessages[i].content + streamAuto.context };
          break;
        }
      }
    }
    const streamWebUsed = streamAuto.webUsed;
    let result;
    try {
      result = await adapter.chat({
        model: modelId, messages: chatMessages,
        temperature: parsed.data.temperature, maxTokens: parsed.data.maxTokens,
      });
    } catch (firstErr) {
      if (fallback || isNoFallbackError(firstErr)) throw firstErr;
      const to = await models.autoSelectText("chat");
      const alt = models.findTextAdapter(to);
      if (!alt || to === modelId) throw firstErr;
      fallback = { from: modelId, to, reason: firstErr instanceof Error ? firstErr.message.slice(0, 160) : "falha no provedor" };
      modelId = to;
      adapter = alt;
      result = await adapter.chat({
        model: modelId, messages: chatMessages,
        temperature: parsed.data.temperature, maxTokens: parsed.data.maxTokens,
      });
    }
    if (fallback) {
      await db.logAudit({
        userId: user.id, action: "chat.fallback",
        detail: `${fallback.from} -> ${fallback.to} :: ${fallback.reason}`.slice(0, 300),
      });
    }
    const saved = await db.addMessage({
      conversationId, role: "assistant", content: result.text,
      modelId, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    await db.logUsage({
      userId: user.id, modelId, kind: "chat",
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costFlag: result.paid,
    });

    const words = result.text.split(/(\s+)/);
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "meta", data: JSON.stringify({ conversationId, model: modelId, messageId: saved.id, fallback, webUsed: streamWebUsed }) });
      let buf = "";
      for (const w of words) {
        buf += w;
        if (buf.length >= 24 || /[.!?\n]\s*$/.test(buf)) {
          await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: buf }) });
          buf = "";
          await stream.sleep(15);
        }
      }
      if (buf) await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: buf }) });
      await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId: saved.id, tokensIn: result.tokensIn, tokensOut: result.tokensOut }) });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Falha na conversa.";
    return fail(c, msg, 502);
  }
});

// ---- Conversas ----
chatRoutes.get("/conversations", requireAuth, async (c) => {
  const q = c.req.query("q") || undefined;
  const list = await c.get("db").listConversations(c.get("user").id, q);
  return ok(c, { conversations: list });
});

chatRoutes.get("/conversations/:id", requireAuth, async (c) => {
  const conv = await c.get("db").getConversation(c.req.param("id"), c.get("user").id);
  if (!conv) return fail(c, "Conversa não encontrada.", 404);
  const messages = await c.get("db").listMessages(conv.id);
  return ok(c, { conversation: conv, messages });
});

chatRoutes.patch("/conversations/:id", requireAuth, async (c) => {
  const schema = z.object({ title: z.string().min(1).max(120).optional(), modelId: z.string().nullable().optional() });
  const body = await c.req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail(c, "Dados inválidos.", 400);
  const conv = await c.get("db").updateConversation(c.req.param("id"), c.get("user").id, parsed.data);
  if (!conv) return fail(c, "Conversa não encontrada.", 404);
  return ok(c, { conversation: conv });
});

chatRoutes.delete("/conversations/:id", requireAuth, async (c) => {
  const gone = await c.get("db").deleteConversation(c.req.param("id"), c.get("user").id);
  if (!gone) return fail(c, "Conversa não encontrada.", 404);
  return ok(c, { deleted: true });
});

chatRoutes.post("/conversations/:id/regenerate", requireAuth, async (c) => {
  // Regenera a última resposta do assistente com base no histórico atual.
  const db = c.get("db");
  const models = c.get("models");
  const user = c.get("user");
  const conv = await db.getConversation(c.req.param("id"), user.id);
  if (!conv) return fail(c, "Conversa não encontrada.", 404);
  const history = await db.listMessages(conv.id);
  if (history.length === 0) return fail(c, "Conversa vazia.", 400);
  try {
    await checkLimit(c, user.id);
    const { modelId, fallback } = await resolveModel(c, conv.modelId ?? undefined, user.id);
    if (modelId.startsWith("nvidia-nim:") && user.role !== "admin") return fail(c, "NVIDIA NIM Free Endpoint é exclusivo do administrador para testes.", 403);
    const adapter = models.findTextAdapter(modelId);
    if (!adapter) return fail(c, "Modelo indisponível.", 502);
    const result = await adapter.chat({
      model: modelId,
      messages: history.slice(-20).map((m) => ({ role: m.role, content: m.content })),
    });
    const saved = await db.addMessage({
      conversationId: conv.id, role: "assistant", content: result.text,
      modelId, tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    });
    await db.logUsage({
      userId: user.id, modelId, kind: "chat",
      tokensIn: result.tokensIn, tokensOut: result.tokensOut, costFlag: result.paid,
    });
    return ok(c, { message: saved, model: modelId, fallback });
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao regenerar.", 502);
  }
});

export { estimateTokens, csv };
