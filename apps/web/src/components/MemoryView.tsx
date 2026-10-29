import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";

interface MemoryItem {
  id: string;
  project: string;
  kind: "decision" | "fix" | "note";
  title: string;
  content: string;
  createdAt: string;
}

const KINDS = [
  { id: "decision", label: "📌 Decisão", hint: "ex.: usar Postgres em vez de SQLite" },
  { id: "fix", label: "🔧 Correção", hint: "ex.: o que já tentou e falhou" },
  { id: "note", label: "📝 Nota", hint: "ex.: contexto do projeto" },
] as const;

export function MemoryView(p: { onOpenSidebar: () => void }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [fProject, setFProject] = useState("");
  const [fKind, setFKind] = useState("");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState<"decision" | "fix" | "note">("note");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const qs = new URLSearchParams();
    if (fProject.trim()) qs.set("project", fProject.trim());
    if (fKind) qs.set("kind", fKind);
    try {
      const r = await api<{ items: MemoryItem[] }>(`/api/memory?${qs.toString()}`);
      setItems(r.items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar.");
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fProject, fKind]);

  const save = async () => {
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/memory", {
        method: "POST",
        body: JSON.stringify({ project: project.trim(), kind, title: title.trim(), content: content.trim() }),
      });
      setTitle("");
      setContent("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Excluir este registro da memória?")) return;
    try {
      await api(`/api/memory/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao excluir.");
    }
  };

  const kindLabel = (k: string) => KINDS.find((x) => x.id === k)?.label ?? k;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={p.onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h1 className="font-semibold text-sm">🧠 Memória (por projeto)</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-3xl mx-auto space-y-3">
          <p className="text-xs text-zinc-500">
            Só você vê sua memória. O agente desenvolvedor consulta automaticamente as{" "}
            <strong>decisões</strong> e <strong>correções</strong> do repositório antes de analisar uma tarefa
            (use em “Projeto” o mesmo nome do repo, ex.: <code>loja-site</code>).
          </p>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm px-3 py-2">
              ⚠️ {error}
            </div>
          )}

          <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3 space-y-2">
            <h2 className="text-sm font-semibold">➕ Novo registro</h2>
            <div className="grid sm:grid-cols-2 gap-2">
              <input value={project} onChange={(e) => setProject(e.target.value)}
                placeholder="Projeto (ex.: loja-site) — vazio = geral"
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm">
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </select>
            </div>
            <input value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Título (ex.: não usar biblioteca X)"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
            <textarea value={content} onChange={(e) => setContent(e.target.value)}
              placeholder={KINDS.find((k) => k.id === kind)?.hint}
              rows={3}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 resize-y" />
            <button onClick={() => void save()} disabled={busy || !title.trim() || !content.trim()}
              className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2">
              {busy ? "Salvando…" : "Salvar na memória"}
            </button>
          </section>

          <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3">
            <div className="flex gap-2 mb-2">
              <input value={fProject} onChange={(e) => setFProject(e.target.value)}
                placeholder="Filtrar por projeto…"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm outline-none" />
              <select value={fKind} onChange={(e) => setFKind(e.target.value)}
                className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                <option value="">todos os tipos</option>
                {KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.label}</option>
                ))}
              </select>
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-zinc-500">Nenhum registro. Salve o primeiro acima.</p>
            ) : (
              <ul className="space-y-2">
                {items.map((m) => (
                  <li key={m.id} className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5 text-sm">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] rounded-full bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 mr-2">
                          {kindLabel(m.kind)}
                        </span>
                        <span className="font-medium">{m.title}</span>
                        <div className="text-[11px] text-zinc-500 mt-0.5">
                          {m.project || "geral"} · {new Date(m.createdAt).toLocaleString("pt-BR")}
                        </div>
                        <p className="text-zinc-700 dark:text-zinc-300 mt-1 whitespace-pre-wrap">{m.content}</p>
                      </div>
                      <button onClick={() => void remove(m.id)} title="Excluir"
                        className="text-zinc-400 hover:text-red-500 shrink-0">
                        🗑️
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
