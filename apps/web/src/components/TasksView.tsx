import { useEffect, useState } from "react";
import type { AgentTask, TaskStatus } from "@cr-ia/shared";
import { ApiError, api, post } from "../lib/api";

const STATUS: Record<TaskStatus, { label: string; color: string }> = {
  pending: { label: "Pendente", color: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  running: { label: "Em execução", color: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200" },
  awaiting_approval: { label: "Aguardando aprovação", color: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200" },
  done: { label: "Concluída", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  failed: { label: "Falhou", color: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200" },
};

export function TasksView({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [type, setType] = useState<AgentTask["type"]>("chat");
  const [title, setTitle] = useState("");
  const [payloadText, setPayloadText] = useState('{\n  "prompt": "Resuma as novidades da semana"\n}');
  const [inspectRepo, setInspectRepo] = useState("");
  const [inspectResult, setInspectResult] = useState<string>("");
  const [readPath, setReadPath] = useState("");
  const [readResult, setReadResult] = useState("");
  const [pullsResult, setPullsResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<AgentTask | null>(null);

  const refresh = async () => {
    try {
      const data = await api<{ tasks: AgentTask[] }>("/api/tasks");
      setTasks(data.tasks);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar tarefas.");
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 8000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    setError("");
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(payloadText || "{}") as Record<string, unknown>;
    } catch {
      setError("Payload JSON inválido.");
      return;
    }
    setBusy(true);
    try {
      await post("/api/tasks", { type, title: title.trim() || "Tarefa sem título", payload });
      setShowNew(false);
      setTitle("");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao criar tarefa.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string, approved: boolean) => {
    try {
      await post(`/api/tasks/${id}/approve`, { approved });
      await refresh();
      setDetail(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha na aprovação.");
    }
  };

  const retry = async (id: string) => {
    try {
      await post(`/api/tasks/${id}/retry`, {});
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao repetir.");
    }
  };

  const inspect = async () => {
    if (!inspectRepo.trim()) return;
    setBusy(true);
    setError("");
    setInspectResult("");
    try {
      const data = await post<Record<string, unknown>>("/api/tasks/github/inspect", { repo: inspectRepo.trim() });
      setInspectResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha na inspeção.");
    } finally {
      setBusy(false);
    }
  };

  const readFile = async () => {
    if (!inspectRepo.trim() || !readPath.trim()) {
      setError("Informe o repositório e o caminho do arquivo.");
      return;
    }
    setBusy(true);
    setError("");
    setReadResult("");
    try {
      const data = await post<{ content: string; truncated: boolean; sha: string }>(
        "/api/tasks/github/read", { repo: inspectRepo.trim(), path: readPath.trim() }
      );
      setReadResult(`sha: ${data.sha}${data.truncated ? " (trecho — arquivo maior que o limite)" : ""}\n\n${data.content}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha na leitura.");
    } finally {
      setBusy(false);
    }
  };

  const listPulls = async () => {
    if (!inspectRepo.trim()) return;
    setBusy(true);
    setError("");
    setPullsResult("");
    try {
      const data = await post<{ pulls: unknown[] }>("/api/tasks/github/pulls", { repo: inspectRepo.trim() });
      setPullsResult(JSON.stringify(data.pulls, null, 2));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao listar PRs.");
    } finally {
      setBusy(false);
    }
  };

  const payloadHint = (t: AgentTask["type"]): string => {
    switch (t) {
      case "chat": return '{\n  "prompt": "Seu pedido para a IA"\n}';
      case "echo": return '{\n  "mensagem": "teste de fila"\n}';
      case "image-batch": return '{\n  "format": "1:1",\n  "prompts": ["arte 1", "arte 2"]\n}';
      case "github-inspect": return '{\n  "repo": "dono/repositorio"\n}';
      case "github-fix-proposal": return '{\n  "repo": "dono/repositorio",\n  "issue": "descreva o problema"\n}';
      case "agent-run": return '{\n  "runId": "use a tela do Agente dev (criação por aqui é avançada)"\n}';
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h2 className="font-semibold text-sm flex-1">🤖 Tarefas e agentes</h2>
        <button onClick={() => { setPayloadText(payloadHint(type)); setShowNew(true); }}
          className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5">＋ Nova tarefa</button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-4xl mx-auto space-y-4">
          {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}

          {/* GitHub inspect rápido */}
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
            <h3 className="font-semibold text-sm mb-1">🔍 Inspecionar repositório GitHub (somente leitura)</h3>
            <p className="text-xs text-zinc-500 mb-2">Somente repositórios autorizados pelo administrador. Nenhuma alteração é feita.</p>
            <div className="flex gap-2">
              <input value={inspectRepo} onChange={(e) => setInspectRepo(e.target.value)}
                placeholder="dono/repositorio" className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm" />
              <button onClick={() => void inspect()} disabled={busy}
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50">
                {busy ? "…" : "Inspecionar"}
              </button>
            </div>
            {inspectResult && (
              <pre className="mt-2 text-xs bg-black/5 dark:bg-black/40 rounded-lg p-3 overflow-x-auto max-h-72 overflow-y-auto">{inspectResult}</pre>
            )}
            <div className="flex gap-2 mt-2 flex-wrap">
              <input value={readPath} onChange={(e) => setReadPath(e.target.value)}
                placeholder="caminho/do/arquivo.ext" className="flex-1 min-w-[180px] rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm" />
              <button onClick={() => void readFile()} disabled={busy}
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50">
                📖 Ler arquivo
              </button>
              <button onClick={() => void listPulls()} disabled={busy}
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50">
                🔀 Ver PRs abertos
              </button>
            </div>
            {readResult && (
              <pre className="mt-2 text-xs bg-black/5 dark:bg-black/40 rounded-lg p-3 overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap">{readResult}</pre>
            )}
            {pullsResult && (
              <pre className="mt-2 text-xs bg-black/5 dark:bg-black/40 rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto">{pullsResult}</pre>
            )}
          </div>

          {/* Nova tarefa */}
          {showNew && (
            <div className="rounded-2xl border border-indigo-300 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-4 space-y-2">
              <h3 className="font-semibold text-sm">Nova tarefa</h3>
              <div className="grid sm:grid-cols-2 gap-2">
                <select value={type} onChange={(e) => { const t = e.target.value as AgentTask["type"]; setType(t); setPayloadText(payloadHint(t)); }}
                  className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                  <option value="chat">💬 Pergunta à IA</option>
                  <option value="image-batch">🎨 Lote de imagens</option>
                  <option value="github-inspect">🔍 Inspecionar GitHub</option>
                  <option value="github-fix-proposal">🛠️ Propor correção (exige aprovação)</option>
                  <option value="echo">📡 Teste de fila (echo)</option>
                </select>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Título da tarefa"
                  className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-1.5 text-sm" />
              </div>
              <textarea value={payloadText} onChange={(e) => setPayloadText(e.target.value)} rows={5}
                className="w-full rounded-lg border font-mono text-xs border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2" />
              <div className="flex gap-2">
                <button onClick={() => void create()} disabled={busy} className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-4 py-1.5 disabled:opacity-50">
                  {busy ? "Criando…" : "Enfileirar"}
                </button>
                <button onClick={() => setShowNew(false)} className="rounded-lg border text-sm px-4 py-1.5">Cancelar</button>
              </div>
            </div>
          )}

          {/* Lista */}
          <div className="space-y-2">
            {tasks.map((t) => (
              <div key={t.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS[t.status].color}`}>
                    {STATUS[t.status].label}
                  </span>
                  <span className="text-[11px] text-zinc-500 font-mono">{t.type}</span>
                  <span className="font-medium text-sm flex-1 min-w-[120px]">{t.title}</span>
                  <span className="text-[11px] text-zinc-400">{new Date(t.updatedAt).toLocaleString("pt-BR")}</span>
                </div>
                {t.error && <p className="text-xs text-red-600 dark:text-red-400 mt-1">❌ {t.error}</p>}
                <div className="flex gap-2 mt-2">
                  <button onClick={() => setDetail(detail?.id === t.id ? null : t)} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">
                    {detail?.id === t.id ? "Ocultar detalhes" : "Ver detalhes/resultado"}
                  </button>
                  {t.status === "awaiting_approval" && (
                    <>
                      <button onClick={() => void approve(t.id, true)} className="text-xs font-semibold text-emerald-600 hover:underline">✓ Aprovar próxima etapa</button>
                      <button onClick={() => void approve(t.id, false)} className="text-xs font-semibold text-red-600 hover:underline">✖ Rejeitar</button>
                    </>
                  )}
                  {t.status === "failed" && (
                    <button onClick={() => void retry(t.id)} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">↻ Repetir</button>
                  )}
                </div>
                {detail?.id === t.id && (
                  <pre className="mt-2 text-[11px] bg-black/5 dark:bg-black/40 rounded-lg p-2 overflow-x-auto max-h-64 overflow-y-auto">
                    {JSON.stringify({ payload: t.payload, result: t.result, attempts: `${t.attempts}/${t.maxAttempts}` }, null, 2)}
                  </pre>
                )}
              </div>
            ))}
            {tasks.length === 0 && <p className="text-sm text-zinc-500 text-center">Nenhuma tarefa. Crie a primeira acima.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
