import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";

interface SearchProvider {
  id: string;
  label: string;
  configured: boolean;
  free: boolean;
  detail: string;
}

interface WebResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
  publishedAt: string | null;
  score: number | null;
}

interface SearchRecord {
  id: string;
  provider: string;
  query: string;
  resultsCount: number;
  createdAt: string;
}

export function SearchView(p: { onOpenSidebar: () => void }) {
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("auto");
  const [providers, setProviders] = useState<SearchProvider[]>([]);
  const [results, setResults] = useState<WebResult[] | null>(null);
  const [usedProvider, setUsedProvider] = useState("");
  const [history, setHistory] = useState<SearchRecord[]>([]);
  const [reading, setReading] = useState<{ title: string; text: string; finalUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    try {
      const s = await api<{ webSearch: boolean; searchProviders?: SearchProvider[] }>("/api/ai/status");
      if (s.searchProviders) setProviders(s.searchProviders);
    } catch {
      /* mantém */
    }
  };
  const loadHistory = async () => {
    try {
      const h = await api<{ items: SearchRecord[] }>("/api/ai/searches?limit=30");
      setHistory(h.items);
    } catch {
      /* mantém */
    }
  };
  useEffect(() => {
    void loadStatus();
    void loadHistory();
  }, []);

  const run = async (term?: string) => {
    const query = (term ?? q).trim();
    if (!query || busy) return;
    setBusy(true);
    setError("");
    setReading(null);
    try {
      const r = await api<{ results: WebResult[]; provider: string; query: string }>(
        "/api/ai/search", { method: "POST", body: JSON.stringify({ q: query, limit: 10, provider }) }
      );
      setResults(r.results);
      setUsedProvider(r.provider);
      setQ(query);
      await loadHistory();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Busca falhou.");
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  const readPage = async (url: string, title: string) => {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ title: string; text: string; finalUrl: string }>(
        "/api/ai/read-url", { method: "POST", body: JSON.stringify({ url }) }
      );
      setReading({ title: r.title || title, text: r.text, finalUrl: r.finalUrl });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Leitura falhou.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={p.onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h1 className="font-semibold text-sm">🌐 Pesquisar na web</h1>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-3xl mx-auto space-y-3">
          <div className="flex flex-wrap gap-1 text-[11px] text-zinc-500">
            {providers.map((x) => (
              <span key={x.id} title={x.detail}
                className={`rounded-full border px-2 py-0.5 ${x.configured ? "border-green-300 dark:border-green-800 text-green-700 dark:text-green-300" : "border-zinc-300 dark:border-zinc-700 opacity-60"}`}>
                {x.configured ? "🟢" : "⚪"} {x.label}{x.free ? "" : " 💳"}
              </span>
            ))}
          </div>

          <div className="flex gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
              placeholder="O que você quer saber? (ex.: preço do café hoje)"
              className="flex-1 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500" />
            <select value={provider} onChange={(e) => setProvider(e.target.value)}
              className="rounded-xl border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-2 text-sm">
              <option value="auto">auto</option>
              {providers.map((x) => (
                <option key={x.id} value={x.id} disabled={!x.configured}>
                  {x.configured ? "" : "(off) "}{x.id}
                </option>
              ))}
            </select>
            <button onClick={() => void run()} disabled={busy || !q.trim()}
              className="rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold px-4 text-sm">
              {busy ? "…" : "Buscar"}
            </button>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm px-3 py-2">
              ⚠️ {error}
            </div>
          )}

          {results !== null && (
            <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3">
              <h2 className="text-sm font-semibold mb-2">
                {results.length ? `${results.length} resultado(s) via ${usedProvider}` : `Sem resultados via ${usedProvider || "?"}`}
              </h2>
              <ul className="space-y-3">
                {results.map((r, i) => (
                  <li key={`${r.url}-${i}`} className="text-sm">
                    <div className="font-medium">
                      <span className="text-zinc-400 mr-1">[{i + 1}]</span>
                      <a href={r.url} target="_blank" rel="noreferrer" className="text-indigo-600 dark:text-indigo-400 hover:underline">
                        {r.title || r.url}
                      </a>
                    </div>
                    <div className="text-[11px] text-zinc-500 truncate">{r.url}</div>
                    <p className="text-zinc-700 dark:text-zinc-300 mt-0.5">{r.snippet || "(sem resumo)"}</p>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-500 mt-1">
                      <span>🔎 {r.engine}</span>
                      <span>📅 {r.publishedAt || "data não informada"}</span>
                      <button onClick={() => void readPage(r.url, r.title)} disabled={busy}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">
                        📖 Ler página
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {reading && (
            <section className="rounded-xl border border-indigo-300 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-3">
              <div className="flex items-start gap-2">
                <h2 className="text-sm font-semibold flex-1">📖 {reading.title}</h2>
                <button onClick={() => setReading(null)} className="text-zinc-500 hover:opacity-70">✖</button>
              </div>
              <a href={reading.finalUrl} target="_blank" rel="noreferrer" className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline break-all">
                {reading.finalUrl}
              </a>
              <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-2 whitespace-pre-wrap max-h-96 overflow-y-auto">
                {reading.text}
              </p>
            </section>
          )}

          <section className="rounded-xl border border-zinc-200 dark:border-zinc-700 p-3">
            <h2 className="text-sm font-semibold mb-2">🕘 Minhas pesquisas recentes</h2>
            {history.length === 0 ? (
              <p className="text-sm text-zinc-500">Nada ainda — suas buscas aparecem aqui.</p>
            ) : (
              <ul className="text-sm space-y-1">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2">
                    <button onClick={() => void run(h.query)} className="text-indigo-600 dark:text-indigo-400 hover:underline truncate text-left flex-1">
                      {h.query}
                    </button>
                    <span className="text-[11px] text-zinc-500 shrink-0">
                      {h.provider} · {h.resultsCount} · {new Date(h.createdAt).toLocaleString("pt-BR")}
                    </span>
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
