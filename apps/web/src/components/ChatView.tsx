import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, Conversation, ModelInfo } from "@cr-ia/shared";
import { ApiError, API_BASE, api, post, postStream } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";

interface Props {
  conversations: Conversation[];
  activeConv: string | null;
  setActiveConv: (id: string | null) => void;
  refreshConvs: () => Promise<void>;
  models: ModelInfo[];
  onOpenSidebar: () => void;
}

interface StreamMeta {
  conversationId?: string;
  model?: string;
  messageId?: string;
  tokensIn?: number;
  tokensOut?: number;
  fallback?: { from: string; to: string; reason: string } | null;
  webUsed?: { provider: string; query: string } | null;
}

interface SearchProvider {
  id: string;
  label: string;
  configured: boolean;
  free: boolean;
  detail: string;
}

export function ChatView(p: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("auto");
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [error, setError] = useState("");
  const [fallback, setFallback] = useState<{ from: string; to: string; reason: string } | null>(null);
  const [attached, setAttached] = useState<{ name: string; content: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [webOn, setWebOn] = useState(false);
  const [webAvail, setWebAvail] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<SearchProvider[]>([]);
  const [webUsed, setWebUsed] = useState<{ provider: string; query: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ webSearch: boolean; searchProviders?: SearchProvider[] }>("/api/ai/status")
      .then((s) => {
        setWebAvail(s.webSearch);
        if (s.searchProviders) setProviders(s.searchProviders);
      })
      .catch(() => setWebAvail(false));
    // Preferência individual de modelo (pré-seleciona quando há)
    api<{ defaultChat: string }>("/api/models/preference")
      .then((r) => { if (r.defaultChat && r.defaultChat !== "auto") setModel(r.defaultChat); })
      .catch(() => undefined);
  }, []);

  // O catálogo completo continua na Administração. No chat, apenas modelos
  // realmente selecionáveis aparecem — sem chaves ausentes ou pagos bloqueados.
  const chatModels = useMemo(() => p.models.filter((m) =>
    m.capabilities.includes("chat") && m.enabled &&
    (m.status === "installed" || m.status === "available" || m.status === "limited") &&
    !(m.provider === "openrouter" && m.paid && m.status === "available")
  ), [p.models]);

  const providerNames: Record<string, string> = {
    nvidia: "🟢 NVIDIA", openrouter: "🌐 OpenRouter", google: "✨ Gemini",
    groq: "⚡ Groq", openai: "🧠 OpenAI", anthropic: "💬 Claude",
    deepseek: "🔷 DeepSeek", xai: "✴️ Grok", mistral: "🌬️ Mistral",
    ollama: "🏠 Local", "workers-ai": "☁️ Cloudflare", mock: "🧪 Demonstração",
  };
  const availableProviders = useMemo(() => [...new Set(chatModels.map((m) => m.provider))], [chatModels]);
  const activeProvider = model === "auto" ? "auto" : (chatModels.find((m) => m.id === model)?.provider ?? "auto");

  // Uma preferência salva pode ficar indisponível depois de uma revogação.
  // Nesse caso, não mantenha um valor inválido no seletor do navegador.
  useEffect(() => {
    if (model !== "auto" && p.models.length > 0 && !chatModels.some((m) => m.id === model)) {
      setModel("auto");
    }
  }, [model, p.models.length, chatModels]);

  const chooseProvider = (next: string) => {
    if (next === "auto") { setModel("auto"); return; }
    const first = chatModels.find((m) => m.provider === next);
    if (first) setModel(first.id);
  };

  useEffect(() => {
    (async () => {
      if (!p.activeConv) {
        setMessages([]);
        return;
      }
      try {
        const data = await api<{ conversation: Conversation; messages: ChatMessage[] }>(
          `/api/chat/conversations/${p.activeConv}`
        );
        setMessages(data.messages);
        if (data.conversation.modelId) setModel(data.conversation.modelId);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Falha ao carregar conversa.");
      }
    })();
  }, [p.activeConv]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const savePreference = async () => {
    setError("");
    try {
      await post("/api/models/preference", { defaultChat: model === "auto" ? null : model });
      setError("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar preferência.");
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setError("");
    setFallback(null);
    setWebUsed(null);
    setSending(true);
    setStreaming("");

    let webContext = "";
    if (webOn) {
      try {
        const r = await api<{ results: { title: string; url: string; snippet: string; engine: string; publishedAt: string | null }[]; query: string; provider: string }>(
          "/api/ai/search", { method: "POST", body: JSON.stringify({ q: text, limit: 6 }) }
        );
        webContext = r.results.length
          ? `\n\n--- Busca web por "${r.query}" via ${r.provider} (cite as fontes [1],[2]...) ---\n` +
            r.results.map((x, i) => `[${i + 1}] ${x.title}${x.publishedAt ? ` (${x.publishedAt})` : ""}\n${x.url}\n${x.snippet}`).join("\n\n")
          : "\n\n(Busca web sem resultados.)";
        setWebUsed({ provider: r.provider, query: r.query });
      } catch (e) {
        setSending(false);
        setError(e instanceof ApiError ? e.message : "Busca web falhou.");
        return;
      }
    }
    const fullText = (attached ? `${text}\n\n--- Anexo: ${attached.name} ---\n${attached.content}` : text) + webContext;
    // Otimista: mostra a pergunta na hora
    const optimistic: ChatMessage = {
      id: `tmp-${Date.now()}`, conversationId: p.activeConv ?? "nova",
      role: "user", content: text, modelId: null, tokensIn: 0, tokensOut: 0, createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    setInput("");
    setAttached(null);

    try {
      const meta = await postStream<StreamMeta>(
        "/api/chat/stream",
        {
          conversationId: p.activeConv ?? undefined,
          model: model === "auto" ? undefined : model,
          messages: [{ role: "user", content: fullText }],
          web: webOn || undefined,
        },
        (delta) => setStreaming((s) => s + delta)
      );
      if (meta.fallback) setFallback(meta.fallback);
      if (meta.webUsed) setWebUsed(meta.webUsed);
      if (meta.conversationId && meta.conversationId !== p.activeConv) {
        p.setActiveConv(meta.conversationId);
        await p.refreshConvs();
      }
      // Recarrega histórico real do servidor
      const convId = meta.conversationId ?? p.activeConv;
      if (convId) {
        const data = await api<{ messages: ChatMessage[] }>(`/api/chat/conversations/${convId}`);
        setMessages(data.messages);
      }
      setStreaming("");
      await p.refreshConvs();
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setStreaming("");
      setError(e instanceof ApiError ? e.message : "Falha ao enviar.");
    } finally {
      setSending(false);
    }
  };

  const regenerate = async () => {
    if (!p.activeConv || sending) return;
    setSending(true);
    setError("");
    setFallback(null);
    try {
      const r = await post<{ fallback: StreamMeta["fallback"] }>(
        `/api/chat/conversations/${p.activeConv}/regenerate`, {}
      );
      if (r.fallback) setFallback(r.fallback);
      const data = await api<{ messages: ChatMessage[] }>(`/api/chat/conversations/${p.activeConv}`);
      setMessages(data.messages);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao regenerar.");
    } finally {
      setSending(false);
    }
  };

  const attachFile = async (f: File) => {
    setError("");
    try {
      const form = new FormData();
      form.append("file", f);
      const token = localStorage.getItem("cr-ia-token");
      const res = await fetch(`${API_BASE}/api/files`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const body = (await res.json()) as { ok: boolean; data?: { file: { id: string; name: string } }; error?: string };
      if (!res.ok || !body.ok || !body.data) throw new Error(body.error ?? "Falha no upload.");
      const read = await api<{ name: string; content: string; truncated: boolean }>(`/api/files/${body.data.file.id}/read`);
      setAttached({
        name: read.name,
        content: read.truncated ? read.content + "\n[…trecho inicial — arquivo maior que o limite de leitura]" : read.content,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao anexar.");
    }
  };

  const copy = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
  };

  const webTitle = webAvail === null ? "Verificando busca web…"
    : webAvail
      ? `Busca web ligada (${providers.filter((x) => x.configured).map((x) => x.label).join(", ") || "?"}) — liga/desliga a pesquisa antes de responder`
      : "Busca web desligada no servidor (o admin configura em Administração → Pesquisa)";

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      {/* topo */}
      <header className="flex flex-col gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 bg-white/70 dark:bg-zinc-950/70 backdrop-blur">
        <div className="flex items-center gap-2 w-full min-w-0">
          <button onClick={p.onOpenSidebar} className="md:hidden text-xl px-1" aria-label="Abrir menu">☰</button>
          <div className="flex-1 min-w-0 font-semibold truncate text-sm">
            {p.activeConv
              ? p.conversations.find((c) => c.id === p.activeConv)?.title ?? "Conversa"
              : "Nova conversa"}
          </div>
          <button onClick={() => void savePreference()} title="Salvar modelo escolhido como preferência"
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            ⭐
          </button>
          {p.activeConv && (
            <button onClick={regenerate} disabled={sending} title="Regenerar última resposta"
              className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50">
              ↻
            </button>
          )}
        </div>
        <div role="group" aria-label="Escolher provedor de IA"
          className="w-full min-w-0 flex gap-1.5 overflow-x-auto pb-1 overscroll-x-contain">
          <button type="button" aria-pressed={activeProvider === "auto"} onClick={() => chooseProvider("auto")}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${activeProvider === "auto" ? "bg-indigo-600 text-white border-indigo-600" : "border-zinc-300 dark:border-zinc-700"}`}>
            ✨ Automático
          </button>
          {availableProviders.map((providerId) => (
            <button key={providerId} type="button" aria-pressed={activeProvider === providerId}
              onClick={() => chooseProvider(providerId)}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${activeProvider === providerId ? "bg-indigo-600 text-white border-indigo-600" : "border-zinc-300 dark:border-zinc-700"}`}>
              {providerNames[providerId] ?? providerId}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 w-full min-w-0">
          <label htmlFor="chat-model-select" className="shrink-0 text-xs text-zinc-500">Modelo:</label>
          <select id="chat-model-select" aria-label="Escolher modelo do provedor" value={model === "auto" ? "auto" : model}
            onChange={(e) => setModel(e.target.value)}
            className="flex-1 min-w-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500">
            {activeProvider === "auto" ? (
              <option value="auto">✨ Automático (melhor disponível)</option>
            ) : chatModels.filter((m) => m.provider === activeProvider).map((m) => {
              const label = m.provider === "nvidia" ? m.label.replace(/^nvidia-nim:nvidia\//, "") : m.label;
              const dot = m.status === "installed" ? "🟢" : m.status === "limited" ? "⏳" : "🟡";
              const suffix = m.status === "limited" ? " · grátis com limite"
                : m.cost === "paid" ? " · pago autorizado"
                : m.cost === "free-tier" ? " · grátis com limite" : "";
              return <option key={m.id} value={m.id} title={m.description}>{dot} {label}{suffix}</option>;
            })}
          </select>
          {activeProvider !== "auto" && (
            <span className="shrink-0 text-xs text-zinc-500" aria-live="polite">
              {chatModels.filter((m) => m.provider === activeProvider).length} disponível(is)
            </span>
          )}
        </div>
        {activeProvider === "nvidia" && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            ⏳ NVIDIA Free Endpoint: gratuito com cotas para desenvolvimento/testes; não habilitado para uso comercial.
          </p>
        )}
      </header>

      {fallback && (
        <div className="mx-3 mt-2 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 text-xs px-3 py-2">
          ⚠️ <strong>{fallback.from}</strong> indisponível ({fallback.reason}); respondido por{" "}
          <strong>{fallback.to}</strong> — o contexto desta mensagem foi enviado a outro provedor.{" "}
          <button onClick={() => setFallback(null)} className="underline ml-1">dispensar</button>
        </div>
      )}

      {webUsed && (
        <div className="mx-3 mt-2 rounded-lg bg-sky-50 dark:bg-sky-950/40 border border-sky-300 dark:border-sky-800 text-sky-800 dark:text-sky-200 text-xs px-3 py-2">
          🌐 Busca web via <strong>{webUsed.provider}</strong> por “{webUsed.query.slice(0, 80)}” —{" "}
          fatos recentes vêm das fontes citadas [n]; o resto é conhecimento interno da IA.{" "}
          <button onClick={() => setWebUsed(null)} className="underline ml-1">dispensar</button>
        </div>
      )}

      {/* mensagens */}
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.length === 0 && !streaming && (
            <div className="text-center text-zinc-500 dark:text-zinc-400 mt-10">
              <div className="text-5xl mb-3">✨</div>
              <h2 className="text-xl font-bold text-zinc-800 dark:text-zinc-100">Olá! Sou a CR IA</h2>
              <p className="text-sm mt-1">Pergunte, peça textos, campanhas, código ou anexe um arquivo.</p>
              <div className="grid sm:grid-cols-2 gap-2 mt-6 text-left">
                {[
                  "✍️ Escreva um texto de divulgação para minha loja",
                  "📣 Crie uma campanha para o Instagram",
                  "💡 Me ajude a planejar um projeto",
                  "❓ O que você sabe fazer?",
                ].map((s) => (
                  <button key={s} onClick={() => setInput(s.replace(/^[^\s]+\s/, ""))}
                    className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3 text-sm hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition text-left">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "user"
                  ? "bg-indigo-600 text-white rounded-br-sm"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-bl-sm"
              }`}>
                {m.role === "assistant" ? (
                  <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                ) : (
                  <div className="whitespace-pre-wrap">{m.content}</div>
                )}
                <div className={`flex items-center gap-2 mt-1.5 text-[11px] ${m.role === "user" ? "text-indigo-200" : "text-zinc-500"}`}>
                  {m.modelId && <span title="Modelo usado">🧠 {m.modelId}</span>}
                  {m.role === "assistant" && (
                    <button onClick={() => copy(m.id, m.content)} className="hover:underline">
                      {copied === m.id ? "✓ Copiado!" : "⧉ Copiar"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {streaming && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm bg-zinc-100 dark:bg-zinc-800">
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(streaming) }} />
                <span className="inline-block w-2 h-4 bg-indigo-500 animate-pulse ml-1" />
              </div>
            </div>
          )}

          {sending && !streaming && (
            <div className="flex justify-start">
              <div className="rounded-2xl px-4 py-3 bg-zinc-100 dark:bg-zinc-800 text-lg">
                <span className="typing-dot">●</span> <span className="typing-dot">●</span> <span className="typing-dot">●</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {error && (
        <div className="mx-3 mb-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm px-3 py-2">
          ⚠️ {error}
        </div>
      )}

      {/* entrada */}
      <div className="p-3 border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        <div className="max-w-3xl mx-auto">
          {attached && (
            <div className="flex items-center gap-2 mb-2 text-xs bg-indigo-50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 rounded-lg px-2 py-1.5">
              <span className="truncate">📎 {attached.name} ({(attached.content.length / 1024).toFixed(1)} KB de texto anexado)</span>
              <button onClick={() => setAttached(null)} className="ml-auto hover:opacity-70">✖</button>
            </div>
          )}
          {webAvail && providers.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2 text-[11px] text-zinc-500">
              {providers.map((x) => (
                <span key={x.id} title={x.detail}
                  className={`rounded-full border px-2 py-0.5 ${x.configured ? "border-green-300 dark:border-green-800 text-green-700 dark:text-green-300" : "border-zinc-300 dark:border-zinc-700 opacity-60"}`}>
                  {x.configured ? "🟢" : "⚪"} {x.label}{x.free ? "" : " 💳"}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <button onClick={() => setWebOn(!webOn)} title={webTitle}
              disabled={!webAvail}
              className={`rounded-xl border w-11 h-11 text-xl shrink-0 ${webOn ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950" : "border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"} disabled:opacity-40`}>
              🌐
            </button>
            <input ref={fileRef} type="file" className="hidden"
              accept=".txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.xls"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void attachFile(f); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} title="Anexar arquivo (.txt, .md, .csv, .json, imagens, PDF, DOCX, XLSX)"
              className="rounded-xl border border-zinc-300 dark:border-zinc-700 w-11 h-11 text-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 shrink-0">
              📎
            </button>
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Escreva sua mensagem… (Enter envia, Shift+Enter quebra linha)"
              rows={Math.min(5, Math.max(1, input.split("\n").length))}
              className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500 resize-none" />
            <button onClick={() => void send()} disabled={sending || !input.trim()}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold w-11 h-11 text-xl shrink-0">
              ➤
            </button>
          </div>
          <p className="text-[11px] text-zinc-400 mt-1.5 text-center">
            A CR IA pode cometer erros. Confira informações importantes. · Conversas salvas nesta conta.
          </p>
        </div>
      </div>
    </div>
  );
}
