/** Seletor visual de provedores no Centro de Modelos — responsivo (mobile primeiro).
 * As chaves ficam no cofre da API, nunca no navegador depois de salvar nem no GitHub.
 */
import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@cr-ia/shared";
import { ApiError, api, post } from "../lib/api";

interface Credential {
  provider: string;
  label: string;
  configured: boolean;
  source: "env" | "vault" | "none";
  masked: string | null;
  docsUrl: string;
  keyHint: string;
}
interface NvidiaStatus {
  configured: boolean;
  catalog: { models: string[]; at: string } | null;
  approved: string[];
  image?: { enabled: boolean; modelId: string };
}
interface Props {
  models: ModelInfo[];
  selected: string;
  onSelect: (provider: string) => void;
  isAdmin: boolean;
  refreshModels: () => Promise<void>;
}

const BRANDS: { id: string; name: string; emoji: string; description: string }[] = [
  { id: "nvidia", name: "NVIDIA NIM", emoji: "🟢", description: "Free Endpoints: testes" },
  { id: "google", name: "Google Gemini", emoji: "✨", description: "API oficial Gemini" },
  { id: "openrouter", name: "OpenRouter", emoji: "🌐", description: "Catálogo multimodelo" },
  { id: "groq", name: "Groq", emoji: "⚡", description: "Modelos rápidos" },
  { id: "openai", name: "OpenAI", emoji: "🧠", description: "API de modelos OpenAI" },
  { id: "anthropic", name: "Anthropic Claude", emoji: "💬", description: "API Claude" },
  { id: "deepseek", name: "DeepSeek", emoji: "🔷", description: "Raciocínio e código" },
  { id: "xai", name: "xAI Grok", emoji: "✴️", description: "API Grok" },
  { id: "mistral", name: "Mistral", emoji: "🌬️", description: "Modelos Mistral" },
  { id: "ollama", name: "Ollama", emoji: "🏠", description: "Modelos locais" },
  { id: "pollinations", name: "Pollinations", emoji: "🎨", description: "Imagens" },
  { id: "workers-ai", name: "Cloudflare AI", emoji: "☁️", description: "Modelos Workers AI" },
];

const card = "rounded-xl border px-3 py-3 text-left transition-colors min-w-0";
const field = "rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-3 py-2 text-sm w-full min-w-0";

export function ProviderCatalogPicker({ models, selected, onSelect, isAdmin, refreshModels }: Props) {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [nvidia, setNvidia] = useState<NvidiaStatus | null>(null);
  const [candidates, setCandidates] = useState<Set<string>>(new Set());
  const [confirmFree, setConfirmFree] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);

  const providers = useMemo(() => {
    const extra = [...new Set(models.map((m) => m.provider))]
      .filter((p) => !BRANDS.some((b) => b.id === p))
      .sort().map((p) => ({ id: p, name: p, emoji: "🧩", description: "Modelos disponíveis" }));
    return [...BRANDS, ...extra];
  }, [models]);

  const loadCredentials = async () => {
    if (!isAdmin) return;
    try {
      const r = await api<{ credentials: Credential[]; free: Credential[] }>("/api/admin/credentials");
      setCredentials([...r.credentials, ...r.free]);
    } catch (e) {
      setMessage("Não foi possível consultar as credenciais: " + (e instanceof Error ? e.message : "erro"));
    }
  };

  const loadNvidia = async () => {
    if (!isAdmin) return;
    try {
      const r = await api<NvidiaStatus>("/api/admin/nvidia/status");
      setNvidia(r);
      setCandidates(new Set(r.approved));
    } catch (e) {
      setMessage("Catálogo NVIDIA indisponível: " + (e instanceof Error ? e.message : "erro"));
    }
  };

  useEffect(() => { void loadCredentials(); }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setKey("");
    setMessage("");
    setConfirmFree(false);
    if (selected === "nvidia") void loadNvidia();
  }, [selected, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedBrand = providers.find((x) => x.id === selected);
  const selectedCred = credentials.find((x) => x.provider === selected);
  const count = (id: string) => models.filter((m) => m.provider === id).length;

  const saveKey = async () => {
    if (!selectedCred || key.trim().length < 8 || busy) return;
    setBusy("key");
    setMessage("");
    try {
      await post("/api/admin/credentials", { provider: selectedCred.provider, key: key.trim() });
      setKey("");
      setMessage("✅ Chave armazenada no cofre da CR IA. Não foi enviada ao GitHub.");
      await loadCredentials();
      if (selected === "nvidia") await loadNvidia();
      await refreshModels();
    } catch (e) {
      setMessage("❌ " + (e instanceof ApiError ? e.message : "Não foi possível salvar a chave."));
    } finally { setBusy(""); }
  };

  const sync = async () => {
    setBusy("sync");
    setMessage("");
    try {
      if (selected === "nvidia") {
        const r = await post<{ catalog: { models: string[] } }>("/api/admin/nvidia/sync", {});
        setMessage("✅ " + r.catalog.models.length + " candidatos consultados. Selecione somente os confirmados como Free Endpoint e compatíveis com chat.");
        await loadNvidia();
      } else if (selected === "openrouter") {
        const r = await post<{ report: { total: number } }>("/api/admin/openrouter/sync", {});
        setMessage("✅ Catálogo atualizado: " + r.report.total + " modelos consultados.");
        await refreshModels();
      }
    } catch (e) {
      setMessage("❌ " + (e instanceof Error ? e.message : "Falha na consulta."));
    } finally { setBusy(""); }
  };

  const approveNvidia = async () => {
    if (!confirmFree || busy) return;
    setBusy("approve");
    setMessage("");
    try {
      await post("/api/admin/nvidia/approve", {
        models: [...candidates],
        confirmFreeEndpointAndDevOnly: true,
      });
      setMessage("✅ Seleção NVIDIA salva para testes administrativos.");
      await loadNvidia();
      await refreshModels();
    } catch (e) {
      setMessage("❌ " + (e instanceof Error ? e.message : "Falha ao aprovar modelos."));
    } finally { setBusy(""); }
  };

  const toggleCosmos = async () => {
    if (!nvidia?.configured || imageBusy) return;
    const next = !nvidia.image?.enabled;
    if (next && !window.confirm("NVIDIA Cosmos3 Nano: confirmar uso exclusivo de desenvolvimento e testes, sujeito a limites de acesso?")) return;
    setImageBusy(true);
    try {
      await post("/api/admin/nvidia/image/enable", { enabled: next, confirmFreeEndpointAndDevOnly: true });
      setMessage(next ? "✅ Cosmos habilitado para testes de imagens." : "Cosmos desabilitado.");
      await loadNvidia();
      await refreshModels();
    } catch (e) {
      setMessage("❌ " + (e instanceof Error ? e.message : "Falha no Cosmos."));
    } finally { setImageBusy(false); }
  };

  return (
    <section className="space-y-3" aria-label="Catálogo de modelos por provedor">
      <div className="rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/20 p-3">
        <h3 className="font-semibold text-sm">🏢 Escolha uma empresa de IA</h3>
        <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-1">
          Abra NVIDIA, Google Gemini, OpenRouter ou outra empresa para ver apenas seus modelos.
          A chave é configurada uma vez por provedor, não por modelo.
        </p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        <button type="button" onClick={() => onSelect("all")}
          aria-pressed={selected === "all"}
          className={card + (selected === "all" ? " border-indigo-600 ring-2 ring-indigo-500 bg-indigo-50 dark:bg-indigo-950/30" : " border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900")}>
          <span className="block text-sm font-semibold">🗂️ Todos</span>
          <span className="block text-xs text-zinc-500 mt-1">{models.length} modelos</span>
        </button>
        {providers.map((p) => (
          <button key={p.id} type="button" onClick={() => onSelect(p.id)}
            aria-pressed={selected === p.id}
            className={card + (selected === p.id ? " border-indigo-600 ring-2 ring-indigo-500 bg-indigo-50 dark:bg-indigo-950/30" : " border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900")}>
            <span className="block text-sm font-semibold break-words">{p.emoji} {p.name}</span>
            <span className="block text-[11px] text-zinc-500 mt-1">{p.description}</span>
            <span className="block text-xs font-medium mt-1">{count(p.id)} modelo(s)</span>
          </button>
        ))}
      </div>

      {selectedBrand && (
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-sm">{selectedBrand.emoji} {selectedBrand.name} — catálogo</h3>
            <span className="text-xs text-zinc-500">{count(selectedBrand.id)} modelo(s) na CR IA</span>
          </div>
          {selectedCred && (
            <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800/60 p-3 space-y-2">
              <p className="text-xs">🔑 API do provedor: {selectedCred.configured
                ? "✅ configurada (" + selectedCred.source + (selectedCred.masked ? ", " + selectedCred.masked : "") + ")"
                : "não configurada"}</p>
              {isAdmin && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <input className={field} type="password" autoComplete="off" value={key}
                    onChange={(e) => setKey(e.target.value)} placeholder="Cole sua chave de API aqui" aria-label="Chave de API do provedor" />
                  <button type="button" onClick={() => void saveKey()} disabled={busy !== "" || key.trim().length < 8}
                    className="rounded-lg bg-indigo-600 text-white text-sm px-4 py-2 disabled:opacity-50 whitespace-nowrap">
                    Salvar chave</button>
                </div>
              )}
              <p className="text-[11px] text-zinc-500">Uma chave por empresa, protegida no servidor. Uma chave do .env, se existir, tem prioridade.</p>
              <a className="inline-block text-xs text-indigo-600 dark:text-indigo-400 underline" href={selectedCred.docsUrl} target="_blank" rel="noreferrer">
                Instruções oficiais do provedor ↗</a>
            </div>
          )}
          {isAdmin && (selected === "nvidia" || selected === "openrouter") && (
            <button type="button" disabled={busy !== "" || (selected === "nvidia" && !nvidia?.configured)}
              onClick={() => void sync()}
              className="rounded-lg border border-indigo-300 dark:border-indigo-700 px-3 py-2 text-xs font-semibold disabled:opacity-50">
              {busy === "sync" ? "Consultando…" : "🔄 Consultar novos modelos " + (selected === "nvidia" ? "NVIDIA" : "OpenRouter")}
            </button>
          )}
          {selected === "google" && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              A lista da API Google é a configurada na CR IA; não há sincronização automática do catálogo Google nesta versão.
              Os modelos Gemini acessados via OpenRouter aparecem no grupo OpenRouter.
            </p>
          )}
          {selected === "nvidia" && isAdmin && (
            <div className="space-y-2">
              <p className="text-xs text-amber-700 dark:text-amber-300">
                ⚠️ A lista da NVIDIA é de CANDIDATOS, não comprova Free Endpoint nem compatibilidade com chat.
                Acesso gratuito é para desenvolvimento/testes, não para seus clientes.
                Confirme cada seleção no site oficial NVIDIA Build.
              </p>
              <div className="rounded-lg border dark:border-zinc-700 p-2">
                <p className="text-xs font-medium mb-2">🎨 Imagens NVIDIA: Cosmos3 Nano (testes)</p>
                <button className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50"
                  disabled={!nvidia?.configured || imageBusy} onClick={() => void toggleCosmos()}>
                  {imageBusy ? "Salvando…" : nvidia?.image?.enabled ? "Desativar Cosmos" : "Ativar Cosmos para testes"}
                </button>
              </div>
              {nvidia?.catalog?.models?.length ? (
                <>
                  <p className="text-xs">Modelos consultados ({nvidia.catalog.models.length}). Marque os confirmados como Free Endpoint de chat:</p>
                  <div className="max-h-56 overflow-y-auto border rounded-lg dark:border-zinc-700 p-2 space-y-2">
                    {nvidia.catalog.models.slice(0, 300).map((id) => (
                      <label key={id} className="flex gap-2 items-center text-xs break-all">
                        <input type="checkbox" checked={candidates.has(id)} onChange={() => {
                          const next = new Set(candidates); if (next.has(id)) next.delete(id); else next.add(id);
                          setCandidates(next); setConfirmFree(false);
                        }} />
                        <span>{id}</span>
                      </label>
                    ))}
                  </div>
                  <label className="flex items-start gap-2 text-xs">
                    <input type="checkbox" className="mt-0.5" checked={confirmFree}
                      onChange={(e) => setConfirmFree(e.target.checked)} />
                    <span>Conferi os modelos selecionados no catálogo oficial: Free Endpoint, compatíveis com chat e apenas para testes.</span>
                  </label>
                  <button type="button" onClick={() => void approveNvidia()} disabled={busy !== "" || !confirmFree}
                    className="rounded-lg bg-indigo-600 text-white text-xs px-4 py-2 disabled:opacity-50">
                    Salvar {candidates.size} modelo(s) NVIDIA para testes
                  </button>
                </>
              ) : <p className="text-xs text-zinc-500">Catálogo NVIDIA ainda não consultado. Salve a chave e toque em Consultar novos modelos.</p>}
            </div>
          )}
          {!selectedCred && !["nvidia", "google", "openrouter"].includes(selected) &&
            <p className="text-xs text-zinc-500">Este provedor não oferece campo de chave nesta tela (ex.: modelo local).</p>}
          {message && <p role="status" className="text-xs break-words">{message}</p>}
        </div>
      )}
    </section>
  );
}
