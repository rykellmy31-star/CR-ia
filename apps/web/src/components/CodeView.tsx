import { useState } from "react";
import { ApiError, api } from "../lib/api";

interface CodeMatch {
  repo: string;
  path: string;
  excerpt: string;
  score: number;
}

export function CodeView(p: { onOpenSidebar: () => void }) {
  const [runId, setRunId] = useState("");
  const [indexMsg, setIndexMsg] = useState("");
  const [q, setQ] = useState("");
  const [repo, setRepo] = useState("");
  const [matches, setMatches] = useState<CodeMatch[] | null>(null);
  const [method, setMethod] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const index = async () => {
    if (!runId.trim() || busy) return;
    setBusy(true);
    setError("");
    setIndexMsg("");
    try {
      const r = await api<{ repo: string; files: number; chunks: number; semantic: boolean }>(
        "/api/ai/code/index", { method: "POST", body: JSON.stringify({ runId: runId.trim() }) }
      );
      setIndexMsg(`✅ ${r.repo}: ${r.files} arquivo(s), ${r.chunks} trecho(s) indexados${r.semantic ? " (busca semântica ativa)" : " (busca por palavra-chave — voz/embeddings desligados)"}.`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Indexação falhou.");
    } finally {
      setBusy(false);
    }
  };

  const search = async () => {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ matches: CodeMatch[]; method: string; semantic: boolean; hint?: string }>(
        "/api/ai/code/search",
        { method: "POST", body: JSON.stringify({ q: q.trim(), repo: repo.trim() || undefined, limit: 10 }) }
      );
      setMatches(r.matches);
      setMethod(r.method === "semantic" ? "semântica 🧠" : r.method === "keyword" ? "palavra-chave 🔤" : "—");
      setHint(r.hint ?? "");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Busca falhou.");
      setMatches(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={p.onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h1 className="font-semibold text-sm">💻 Código indexado</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-3xl mx-auto space-y-3">
          <p className="text-xs text-zinc-500">
            Indexe o código de um run do agente e depois busque nele (“onde fica o login?”).
            A busca é semântica quando voz/embeddings estão ativos; senão, por palavra-chave.
          </p>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm px-3 py-2">
              ⚠️ {error}
            </div>
          )}

          <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3 space-y-2">
            <h2 className="text-sm font-semibold">📥 Indexar código de um run</h2>
            <div className="flex gap-2">
              <input value={runId} onChange={(e) => setRunId(e.target.value)}
                placeholder="ID do run (ex.: run-...)"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              <button onClick={() => void index()} disabled={busy || !runId.trim()}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2">
                {busy ? "…" : "Indexar"}
              </button>
            </div>
            {indexMsg && <p className="text-sm text-green-700 dark:text-green-300">{indexMsg}</p>}
          </section>

          <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3 space-y-2">
            <h2 className="text-sm font-semibold">🔎 Buscar no código</h2>
            <div className="flex gap-2">
              <input value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
                placeholder="O que procurar? (ex.: função de login)"
                className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              <input value={repo} onChange={(e) => setRepo(e.target.value)}
                placeholder="repo (opcional)"
                className="w-36 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
              <button onClick={() => void search()} disabled={busy || !q.trim()}
                className="rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2">
                {busy ? "…" : "Buscar"}
              </button>
            </div>
            {matches !== null && (
              <div className="text-sm">
                <p className="text-xs text-zinc-500 mb-2">
                  {matches.length} resultado(s) · busca {method}
                </p>
                {hint && <p className="text-sm text-amber-700 dark:text-amber-300 mb-2">⚠️ {hint}</p>}
                <ul className="space-y-2">
                  {matches.map((m, i) => (
                    <li key={`${m.repo}-${m.path}-${i}`} className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-2.5">
                      <div className="text-xs font-mono text-indigo-600 dark:text-indigo-400 break-all">
                        {m.repo} / {m.path}
                        <span className="text-zinc-400 ml-2">relevância {m.score}</span>
                      </div>
                      <pre className="text-xs text-zinc-700 dark:text-zinc-300 mt-1 whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
                        {m.excerpt}
                      </pre>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
