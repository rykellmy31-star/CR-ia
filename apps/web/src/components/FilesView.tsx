import { useEffect, useRef, useState } from "react";
import type { StoredFile } from "@cr-ia/shared";
import { ApiError, API_BASE, api, downloadAuth } from "../lib/api";

type Tab = "files" | "search" | "voice";

interface DocMatch {
  fileId: string;
  fileName: string;
  excerpt: string;
  score: number;
}

export function FilesView({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [tab, setTab] = useState<Tab>("files");
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ name: string; content: string } | null>(null);
  const [aiStatus, setAiStatus] = useState<{ transcription: boolean; embeddings: boolean; webSearch: boolean } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLInputElement>(null);
  // busca docs
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<DocMatch[]>([]);
  const [method, setMethod] = useState("");
  const [hint, setHint] = useState("");
  // voz
  const [lang, setLang] = useState("pt");
  const [transcript, setTranscript] = useState("");
  const [transcribing, setTranscribing] = useState(false);

  const refresh = async () => {
    try {
      const data = await api<{ files: StoredFile[] }>("/api/files");
      setFiles(data.files);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar arquivos.");
    }
  };

  useEffect(() => {
    void refresh();
    api<{ transcription: boolean; embeddings: boolean; webSearch: boolean }>("/api/ai/status")
      .then(setAiStatus)
      .catch(() => undefined);
  }, []);

  const upload = async (f: File) => {
    setBusy(true);
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
      const body = (await res.json()) as { ok: boolean; error?: string; data?: { indexed: { chunks: number; semantic: boolean } | null } };
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Falha no upload.");
      await refresh();
      if (body.data?.indexed) {
        setError("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha no upload.");
    } finally {
      setBusy(false);
    }
  };

  const read = async (f: StoredFile) => {
    setError("");
    try {
      const data = await api<{ name: string; content: string; truncated: boolean; pages?: number; sheets?: string[] }>(`/api/files/${f.id}/read`);
      setPreview({
        name: data.name + (data.pages ? ` (${data.pages} pág.)` : "") + (data.sheets?.length ? ` [${data.sheets.join(", ")}]` : ""),
        content: data.truncated ? data.content + "\n\n[…trecho inicial — arquivo maior que o limite]" : data.content,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha na leitura.");
    }
  };

  const remove = async (f: StoredFile) => {
    if (!confirm(`Excluir "${f.name}"?`)) return;
    try {
      await api(`/api/files/${f.id}`, { method: "DELETE" });
      await refresh();
      if (preview?.name === f.name) setPreview(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao excluir.");
    }
  };

  const docSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const r = await api<{ matches: DocMatch[]; method: string; semantic: boolean; hint?: string }>("/api/ai/documents/search", {
        method: "POST", body: JSON.stringify({ q: query }),
      });
      setMatches(r.matches);
      setMethod(r.method);
      setHint(r.hint ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha na busca.");
    } finally {
      setBusy(false);
    }
  };

  const transcribe = async (f: File) => {
    setTranscribing(true);
    setError("");
    setTranscript("");
    try {
      const form = new FormData();
      form.append("audio", f);
      form.append("language", lang);
      const token = localStorage.getItem("cr-ia-token");
      const res = await fetch(`${API_BASE}/api/ai/transcribe`, {
        method: "POST",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body: form,
      });
      const body = (await res.json()) as { ok: boolean; error?: string; data?: { text: string; language: string; durationSec: number | null } };
      if (!res.ok || !body.ok) throw new Error(body.error ?? "Falha na transcrição.");
      setTranscript(body.data!.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha na transcrição.");
    } finally {
      setTranscribing(false);
    }
  };

  const fmtSize = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(1)} KB`);

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h2 className="font-semibold text-sm">📁 Arquivos</h2>
        <div className="flex gap-1 text-xs ml-2">
          {(["files", "search", "voice"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-2 py-1 rounded-lg ${tab === t ? "bg-indigo-600 text-white" : "bg-zinc-200 dark:bg-zinc-800"}`}>
              {t === "files" ? "Arquivos" : t === "search" ? "🔍 Buscar nos documentos" : "🎙️ Transcrever áudio"}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {tab === "files" && (
          <>
            <input ref={inputRef} type="file" className="hidden"
              accept=".txt,.md,.csv,.json,.png,.jpg,.jpeg,.webp,.pdf,.docx,.xlsx,.xls"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            <button onClick={() => inputRef.current?.click()} disabled={busy}
              className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
              {busy ? "Enviando…" : "⬆ Enviar arquivo"}
            </button>
          </>
        )}
      </header>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-4xl mx-auto space-y-3">
          {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}

          {tab === "files" && (
            <>
              <p className="text-xs text-zinc-500">
                Permitidos: .txt, .md, .csv, .json, .png, .jpg, .webp, .pdf, .docx, .xlsx (padrão 25 MB).
                Documentos de texto são indexados no upload para a busca.{" "}
                {aiStatus && (
                  <>Voz/embeddings: {aiStatus.transcription ? "✅ ativos" : "⚪ desligados (perfil ai)"}.</>
                )}
              </p>
              {preview && (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-medium text-sm flex-1 truncate">👁 {preview.name}</span>
                    <button onClick={() => setPreview(null)} className="text-sm">✖</button>
                  </div>
                  <pre className="text-xs whitespace-pre-wrap max-h-72 overflow-y-auto bg-white dark:bg-black/30 rounded-lg p-2">{preview.content}</pre>
                </div>
              )}
              <div className="grid sm:grid-cols-2 gap-2">
                {files.map((f) => (
                  <div key={f.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                    <div className="font-medium text-sm truncate">📄 {f.name}</div>
                    <div className="text-[11px] text-zinc-500">{f.mime} · {fmtSize(f.size)} · {new Date(f.createdAt).toLocaleDateString("pt-BR")}</div>
                    <div className="flex gap-3 mt-2 text-xs">
                      <button onClick={() => void read(f)} className="text-indigo-600 dark:text-indigo-400 hover:underline">Ler texto</button>
                      <button onClick={() => void downloadAuth(f.url, f.name).catch((e) => setError(String(e)))}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline">Baixar</button>
                      <button onClick={() => void remove(f)} className="text-red-600 dark:text-red-400 hover:underline ml-auto">Excluir</button>
                    </div>
                  </div>
                ))}
              </div>
              {files.length === 0 && <p className="text-sm text-zinc-500 text-center">Nenhum arquivo enviado.</p>}
            </>
          )}

          {tab === "search" && (
            <>
              <form onSubmit={docSearch} className="flex gap-2">
                <input value={query} onChange={(e) => setQuery(e.target.value)} required minLength={2}
                  placeholder="Ex.: quando vence o contrato de aluguel?"
                  className="flex-1 rounded-lg border px-3 py-2 text-sm bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 outline-none focus:ring-2 focus:ring-indigo-500" />
                <button disabled={busy} className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-4 disabled:opacity-50">
                  {busy ? "Buscando…" : "Buscar"}
                </button>
              </form>
              {method && (
                <p className="text-xs text-zinc-500">
                  Método: {method === "semantic" ? "🧠 semântica (embeddings)" : method === "keyword" ? "🔤 palavra-chave" : "— nenhum documento indexado"}.
                  {hint && <> {hint}</>}
                </p>
              )}
              <div className="space-y-2">
                {matches.map((m, i) => (
                  <div key={i} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                    <div className="text-sm font-medium">📄 {m.fileName} <span className="text-[11px] text-zinc-500">({Math.round(m.score * 100)}%)</span></div>
                    <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-1 whitespace-pre-wrap">{m.excerpt}</p>
                  </div>
                ))}
              </div>
              {method && matches.length === 0 && <p className="text-sm text-zinc-500">Nada encontrado nos seus documentos.</p>}
            </>
          )}

          {tab === "voice" && (
            <>
              <p className="text-xs text-zinc-500">
                Transcrição local (Whisper, português). O áudio é processado no seu servidor — nada sai da máquina.{" "}
                {aiStatus && !aiStatus.transcription && "⚠️ Serviço desligado: suba com docker compose --profile ai up -d"}
              </p>
              <div className="flex items-center gap-2">
                <input ref={audioRef} type="file" className="hidden" accept="audio/*,video/mp4,video/webm"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void transcribe(f); e.target.value = ""; }} />
                <select value={lang} onChange={(e) => setLang(e.target.value)}
                  className="rounded-lg border px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700">
                  <option value="pt">Português</option>
                  <option value="en">Inglês</option>
                  <option value="">Automático</option>
                </select>
                <button onClick={() => audioRef.current?.click()} disabled={transcribing || !aiStatus?.transcription}
                  className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-4 py-1.5 disabled:opacity-50">
                  {transcribing ? "Transcrevendo… (pode levar minutos)" : "🎙️ Escolher áudio"}
                </button>
              </div>
              {transcript && (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-medium text-sm flex-1">📝 Transcrição</span>
                    <button onClick={() => void navigator.clipboard.writeText(transcript)} className="text-xs text-indigo-600 hover:underline">Copiar</button>
                  </div>
                  <p className="text-sm whitespace-pre-wrap">{transcript}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
