import { useEffect, useState } from "react";
import type { AuditLog, ModelInfo, User } from "@cr-ia/shared";
import { ApiError, api, post } from "../lib/api";
import { ProvidersView } from "./ProvidersView";
import { UpdateCenter } from "./UpdateCenter";

interface Stats {
  users: number;
  usage: { total: number; byModel: Record<string, number>; byKind: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  recentAudit: AuditLog[];
  drivers: Record<string, string | boolean>;
}

interface Credential {
  provider: string;
  label: string;
  configured: boolean;
  source: "env" | "vault" | "none";
  masked: string | null;
  docsUrl: string;
  keyHint: string;
}

function statusDot(s: ModelInfo["status"]): string {
  if (s === "installed") return "🟢";
  if (s === "limited") return "⏳";
  if (s === "available") return "🟡";
  if (s === "needs-credentials") return "🔑";
  if (s === "incompatible") return "⛔";
  if (s === "testing") return "🔵";
  return "🔴";
}

export function AdminView({ models, refreshModels, onOpenSidebar }: {
  models: ModelInfo[];
  refreshModels: () => Promise<void>;
  onOpenSidebar: () => void;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [audit, setAudit] = useState<AuditLog[]>([]);
  const [integrations, setIntegrations] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"models" | "providers" | "keys" | "search" | "users" | "usage" | "logs" | "system" | "updates">("providers");
  const [usage, setUsage] = useState<{
    limits: { chat: number; images: number };
    todayUsage: Record<string, { email: string; chat: number; image: number; transcription: number }>;
    rows: { day: string; email: string; modelId: string; kind: string; count: number; tokensIn: number; tokensOut: number; costUsd: number }[];
  } | null>(null);
  const [system, setSystem] = useState<{
    time: string; uptimeSec: number;
    node: { version: string; heapUsedMB: number; rssMB: number };
    os: { load1: number; load5: number; totalMemMB: number; freeMemMB: number };
    disk: { path: string; totalMB: number | null; freeMB: number | null } | null;
    database: { driver: string; sizeMB: number | null; tables: Record<string, number> | null };
  } | null>(null);
  const [defaultChat, setDefaultChat] = useState("");
  const [defaultImage, setDefaultImage] = useState("");
  const [disabled, setDisabled] = useState<string[]>([]);
  const [blockPaid, setBlockPaid] = useState(true);
  const [newUser, setNewUser] = useState({ email: "", name: "", password: "", role: "user" });
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Credential[]>([]);
  const [freeCreds, setFreeCreds] = useState<(Credential & { limits: string })[]>([]);
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [keyBusy, setKeyBusy] = useState<string | null>(null);
  // Pesquisa web (Fase 3)
  const [searchCreds, setSearchCreds] = useState<Credential[]>([]);
  const [searchProviders, setSearchProviders] = useState<{ id: string; label: string; configured: boolean; free: boolean; detail: string }[]>([]);
  const [googleCx, setGoogleCx] = useState("");
  const [searchProvider, setSearchProvider] = useState("auto");
  const [searchAuto, setSearchAuto] = useState(true);
  const [searchHistory, setSearchHistory] = useState<{ id: string; email: string; provider: string; query: string; resultsCount: number; createdAt: string }[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);

  const testModel = async (id: string) => {
    setTesting(id);
    setError("");
    try {
      const r = await post<{ kind: string; latencyMs: number; sample?: string; bytes?: number }>(
        "/api/models/test", { model: id }
      );
      setTestResults((t) => ({
        ...t,
        [id]: `✅ OK em ${r.latencyMs}ms (${r.kind})` +
          (r.sample ? ` — "${r.sample.slice(0, 80)}"` : ` — ${r.bytes} bytes`),
      }));
    } catch (e) {
      setTestResults((t) => ({ ...t, [id]: `❌ ${e instanceof ApiError ? e.message : "falhou"}` }));
    } finally {
      setTesting(null);
    }
  };

  const revokeSessions = async () => {
    if (!confirm("Revogar TODAS as sessões? Todos (inclusive você) precisarão fazer login de novo.")) return;
    setError("");
    try {
      await post("/api/admin/sessions/revoke-all", {});
      alert("Sessões revogadas. Faça login novamente.");
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao revogar.");
    }
  };

  const load = async () => {
    try {
      const [s, u, a, integ, m, usg, sys, cr, st, srch, hist] = await Promise.all([
        api<Stats>("/api/admin/stats"),
        api<{ users: User[] }>("/api/admin/users"),
        api<{ logs: AuditLog[] }>("/api/admin/audit?limit=100"),
        api<{ integrations: Record<string, unknown> }>("/api/admin/integrations"),
        api<{ defaults: { chat: string | null; image: string | null }; blockPaid: boolean }>("/api/models"),
        api<NonNullable<typeof usage>>("/api/admin/usage?days=30"),
        api<NonNullable<typeof system>>("/api/admin/system"),
        api<{ credentials: Credential[]; free: (Credential & { limits: string })[]; search: Credential[] }>("/api/admin/credentials"),
        api<{ webSearch: boolean; searchProviders?: { id: string; label: string; configured: boolean; free: boolean; detail: string }[] }>("/api/ai/status"),
        api<{ settings: Record<string, string | null> }>("/api/admin/settings"),
        api<{ items: { id: string; email: string; provider: string; query: string; resultsCount: number; createdAt: string }[] }>("/api/admin/searches?limit=50"),
      ]);
      setStats(s);
      setUsers(u.users);
      setAudit(a.logs);
      setIntegrations(integ.integrations);
      setUsage(usg);
      setSystem(sys);
      setCreds(cr.credentials);
      setFreeCreds(cr.free ?? []);
      setSearchCreds(cr.search ?? []);
      setSearchProviders(st.searchProviders ?? []);
      setGoogleCx(srch.settings["search.google_cx"] ?? "");
      setSearchProvider(srch.settings["search.provider"] ?? "auto");
      setSearchAuto((srch.settings["search.auto"] ?? "true") !== "false");
      setSearchHistory(hist.items);
      setDefaultChat(m.defaults.chat ?? "");
      setDefaultImage(m.defaults.image ?? "");
      setBlockPaid(m.blockPaid);
      setDisabled(models.filter((x) => !x.enabled).map((x) => x.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar painel.");
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveCred = async (provider: string) => {
    const key = (keyInput[provider] ?? "").trim();
    if (key.length < 8) {
      setError("Chave muito curta — cole a chave completa do provedor.");
      return;
    }
    setKeyBusy(provider);
    setError("");
    try {
      await post("/api/admin/credentials", { provider, key });
      setKeyInput((k) => ({ ...k, [provider]: "" }));
      const cr = await api<{ credentials: Credential[]; free: (Credential & { limits: string })[]; search: Credential[] }>("/api/admin/credentials");
      setCreds(cr.credentials);
      setFreeCreds(cr.free ?? []);
      setSearchCreds(cr.search ?? []);
      await refreshModels();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar chave.");
    } finally {
      setKeyBusy(null);
    }
  };

  const delCred = async (provider: string) => {
    if (!confirm(`Remover a chave ${provider} do cofre? (A variável do .env, se existir, continua valendo.)`)) return;
    setKeyBusy(provider);
    setError("");
    try {
      const r = await api<{ envStillConfigured: boolean }>(`/api/admin/credentials/${provider}`, { method: "DELETE" });
      if (r.envStillConfigured) alert("Atenção: este provedor continua configurado via variável de ambiente (.env).");
      const cr = await api<{ credentials: Credential[]; free: (Credential & { limits: string })[]; search: Credential[] }>("/api/admin/credentials");
      setCreds(cr.credentials);
      setFreeCreds(cr.free ?? []);
      setSearchCreds(cr.search ?? []);
      await refreshModels();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao remover chave.");
    } finally {
      setKeyBusy(null);
    }
  };

  /** Salva uma configuração de busca web (CX, provedor, busca automática). */
  const saveSearchSetting = async (key: string, value: string) => {
    setSearchBusy(true);
    setError("");
    try {
      await post("/api/admin/settings", { key, value });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar configuração.");
    } finally {
      setSearchBusy(false);
    }
  };

  const saveModels = async () => {
    setError("");
    try {
      await post("/api/models/select", {
        defaultChat: defaultChat || undefined,
        defaultImage: defaultImage || undefined,
        disabled,
        blockPaid,
      });
      await refreshModels();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar.");
    }
  };

  const toggleDisabled = (id: string) => {
    setDisabled((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  };

  const createUser = async () => {
    setError("");
    try {
      await post("/api/admin/users", { ...newUser, role: newUser.role });
      setNewUser({ email: "", name: "", password: "", role: "user" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao criar usuário.");
    }
  };

  const patchUser = async (id: string, patch: Record<string, unknown>) => {
    setError("");
    try {
      await api(`/api/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao atualizar usuário.");
    }
  };

  const deleteUser = async (id: string, email: string) => {
    if (!confirm(`Excluir o usuário ${email}? Conversas e arquivos dele serão removidos.`)) return;
    setError("");
    try {
      await api(`/api/admin/users/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao excluir.");
    }
  };

  /** Estimativa de custo (USD) de uma linha de uso, via tabela de preços dos modelos. */
  const estimateRow = (modelId: string, tIn: number, tOut: number): string => {
    const m = models.find((x) => x.id === modelId);
    if (!m?.pricePer1M) return "—";
    const v = (tIn * m.pricePer1M.in + tOut * m.pricePer1M.out) / 1_000_000;
    return v < 0.01 ? "<$0,01" : `~$${v.toFixed(2)}`;
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h2 className="font-semibold text-sm flex-1">⚙️ Administração</h2>
        <button onClick={() => void load()} className="text-sm rounded-lg border px-2 py-1">↻ Atualizar</button>
      </header>

      <div className="flex flex-wrap gap-1 px-3 pt-2 pb-1 border-b border-zinc-200 dark:border-zinc-800 text-sm">
        {(["models", "providers", "keys", "search", "users", "usage", "logs", "system", "updates"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-t-lg font-medium whitespace-nowrap ${tab === t ? "bg-indigo-600 text-white" : "hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}>
            {t === "models" ? "🧠 Modelos" : t === "providers" ? "🏢 Provedores / APIs" : t === "keys" ? "🔑 Credenciais" : t === "search" ? "🌐 Pesquisa" : t === "users" ? "👥 Usuários" : t === "usage" ? "📊 Uso e cotas" : t === "logs" ? "📋 Logs" : t === "updates" ? "🔄 Atualizações" : "🖥 Sistema"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-4xl mx-auto space-y-3">
          {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}

          {tab === "models" && (
            <>
              <div className="grid sm:grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-medium">Modelo padrão de chat</label>
                  <select value={defaultChat} onChange={(e) => setDefaultChat(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                    <option value="">Automático</option>
                    {models.filter((m) => m.capabilities.includes("chat")).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium">Modelo padrão de imagem</label>
                  <select value={defaultImage} onChange={(e) => setDefaultImage(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                    <option value="">Automático</option>
                    {models.filter((m) => m.capabilities.includes("image-gen")).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl p-3 cursor-pointer">
                <input type="checkbox" checked={blockPaid} onChange={(e) => setBlockPaid(e.target.checked)} className="w-4 h-4" />
                <span><strong>Bloquear modelos pagos</strong> (recomendado — impede custos sem autorização)</span>
              </label>

              <div className="space-y-2">
                {models.map((m) => (
                  <div key={m.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-start gap-3">
                    <input type="checkbox" checked={!disabled.includes(m.id)} onChange={() => toggleDisabled(m.id)}
                      title="Habilitado" className="w-4 h-4 mt-1" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{statusDot(m.status)} {m.label}</span>
                        <span className="text-[10px] text-zinc-500">({m.status})</span>
                        {m.paid && <span className="text-[10px] font-bold bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 px-1.5 py-0.5 rounded">PAGO</span>}
                        {m.external && <span className="text-[10px] font-bold bg-sky-200 dark:bg-sky-800 text-sky-900 dark:text-sky-100 px-1.5 py-0.5 rounded" title="O prompt sai do seu servidor">🌐 EXTERNO</span>}
                        <span className="text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">{m.provider}</span>
                        {m.pricePer1M && (
                          <span className="text-[10px] text-zinc-500" title="Estimativa — confirme no provedor">
                            💲 ~${m.pricePer1M.in}/${m.pricePer1M.out}/1M (tab. {m.pricePer1M.asOf})
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-zinc-500 font-mono truncate">{m.id}</div>
                      <div className="text-xs text-zinc-600 dark:text-zinc-300">{m.description}</div>
                      <div className="text-[11px] text-zinc-400">Capacidades: {m.capabilities.join(", ")}</div>
                      {m.requirements && m.status !== "installed" && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-300">➡️ {m.requirements}</div>
                      )}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <button onClick={() => void testModel(m.id)} disabled={testing === m.id || (m.status !== "installed" && m.status !== "available") || !m.enabled}
                          className="text-xs rounded-lg border border-zinc-300 dark:border-zinc-700 px-2 py-1 disabled:opacity-50 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                          {testing === m.id ? "⏳ Testando inferência real…" : "🧪 Testar inferência real"}
                        </button>
                        {testResults[m.id] && (
                          <span className="text-[11px] font-mono break-all">{testResults[m.id]}</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={() => void saveModels()} className="rounded-xl bg-indigo-600 text-white font-semibold px-5 py-2 text-sm">
                Salvar configurações
              </button>
            </>
          )}

          {tab === "providers" && (
            <ProvidersView models={models} refreshModels={refreshModels} />
          )}

          {tab === "keys" && (
            <>
              <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-3 text-sm">
                <strong>⚠️ APIs pagas.</strong> Cada chamada pode gerar custo no provedor. As chaves ficam
                cifradas no banco (cofre AES-256) ou nas variáveis do <code>.env</code> — nunca aparecem
                inteiras nesta tela. Sem chave, o modelo mostra <strong>🔑 Configurar API</strong> e não é chamado.
              </div>
              {creds.map((c) => (
                <div key={c.provider} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{c.configured ? "✅" : "🔑"} {c.label}</span>
                    {c.configured && (
                      <span className="text-[11px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        {c.masked} · via {c.source === "env" ? ".env" : "cofre"}
                      </span>
                    )}
                    <a href={c.docsUrl} target="_blank" rel="noreferrer" className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline ml-auto">
                      documentar-modelos ↗
                    </a>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">Formato: {c.keyHint}</p>
                  <div className="flex gap-2 mt-2">
                    <input type="password" value={keyInput[c.provider] ?? ""} autoComplete="off"
                      onChange={(e) => setKeyInput((k) => ({ ...k, [c.provider]: e.target.value }))}
                      placeholder={c.configured ? "Colar nova chave para substituir…" : "Colar chave do provedor…"}
                      className="flex-1 min-w-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm font-mono" />
                    <button onClick={() => void saveCred(c.provider)} disabled={keyBusy === c.provider}
                      className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
                      {keyBusy === c.provider ? "…" : "Salvar"}
                    </button>
                    {c.configured && c.source === "vault" && (
                      <button onClick={() => void delCred(c.provider)} disabled={keyBusy === c.provider}
                        className="rounded-lg border border-red-300 text-red-600 text-sm px-3 py-1.5 disabled:opacity-50">
                        Remover
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <h3 className="font-semibold text-sm mt-2">⏳ Chaves GRATUITAS (sem cartão, com cotas — nunca geram cobrança)</h3>
              <div className="rounded-2xl border border-cyan-200 dark:border-cyan-800 bg-cyan-50/50 dark:bg-cyan-950/20 p-3 text-sm">
                Groq e OpenRouter Free custam <strong>$0</strong>, mas têm <strong>cotas rígidas</strong> (req/min e
                req/dia) e fila — não são ilimitados. O prompt sai do servidor: nunca envie dados sensíveis.
              </div>
              {freeCreds.map((c) => (
                <div key={c.provider} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{c.configured ? "✅" : "🔑"} {c.label}</span>
                    {c.configured && (
                      <span className="text-[11px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        {c.masked} · via {c.source === "env" ? ".env" : "cofre"}
                      </span>
                    )}
                    <span className="text-[11px] text-cyan-700 dark:text-cyan-300">⏳ {c.limits}</span>
                    <a href={c.docsUrl} target="_blank" rel="noreferrer" className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline ml-auto">
                      documentar-modelos ↗
                    </a>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">Formato: {c.keyHint}</p>
                  <div className="flex gap-2 mt-2">
                    <input type="password" value={keyInput[c.provider] ?? ""} autoComplete="off"
                      onChange={(e) => setKeyInput((k) => ({ ...k, [c.provider]: e.target.value }))}
                      placeholder={c.configured ? "Colar nova chave para substituir…" : "Colar chave gratuita…"}
                      className="flex-1 min-w-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm font-mono" />
                    <button onClick={() => void saveCred(c.provider)} disabled={keyBusy === c.provider}
                      className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
                      {keyBusy === c.provider ? "…" : "Salvar"}
                    </button>
                    {c.configured && c.source === "vault" && (
                      <button onClick={() => void delCred(c.provider)} disabled={keyBusy === c.provider}
                        className="rounded-lg border border-red-300 text-red-600 text-sm px-3 py-1.5 disabled:opacity-50">
                        Remover
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}

          {tab === "search" && (
            <>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-sm">
                <strong>🌐 Provedores de busca web.</strong> Ordem automática: SearXNG próprio (grátis) →{" "}
                Brave → Tavily → Google PSE (pagos). Só os configurados são usados; sem nenhum, a busca
                responde “desligada” — nada é simulado.
                <div className="flex flex-wrap gap-1 mt-2 text-[11px]">
                  {searchProviders.map((x) => (
                    <span key={x.id} title={x.detail}
                      className={`rounded-full border px-2 py-0.5 ${x.configured ? "border-green-300 dark:border-green-800 text-green-700 dark:text-green-300" : "border-zinc-300 dark:border-zinc-700 opacity-60"}`}>
                      {x.configured ? "🟢" : "⚪"} {x.label}{x.free ? "" : " 💳"}
                    </span>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 space-y-2 text-sm">
                <h3 className="font-semibold">⚙️ Configurações</h3>
                <div className="grid sm:grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs font-medium">Provedor preferido</label>
                    <div className="flex gap-2 mt-1">
                      <select value={searchProvider} onChange={(e) => setSearchProvider(e.target.value)}
                        className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                        <option value="auto">auto (primeiro configurado)</option>
                        <option value="searxng">searxng (próprio, grátis)</option>
                        <option value="brave">brave 💳</option>
                        <option value="tavily">tavily 💳</option>
                        <option value="google-pse">google-pse 💳</option>
                      </select>
                      <button onClick={() => void saveSearchSetting("search.provider", searchProvider)} disabled={searchBusy}
                        className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
                        Salvar
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium">Busca automática no chat</label>
                    <div className="flex gap-2 mt-1">
                      <select value={searchAuto ? "true" : "false"} onChange={(e) => setSearchAuto(e.target.value === "true")}
                        className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                        <option value="true">ligada (perguntas sobre o recente)</option>
                        <option value="false">desligada</option>
                      </select>
                      <button onClick={() => void saveSearchSetting("search.auto", searchAuto ? "true" : "false")} disabled={searchBusy}
                        className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
                        Salvar
                      </button>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="text-xs font-medium">CX do Google PSE (ID do mecanismo)</label>
                  <div className="flex gap-2 mt-1">
                    <input value={googleCx} onChange={(e) => setGoogleCx(e.target.value)}
                      placeholder="ex.: 0123456789abcdefg"
                      className="flex-1 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm font-mono" />
                    <button onClick={() => void saveSearchSetting("search.google_cx", googleCx)} disabled={searchBusy}
                      className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
                      Salvar
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Crie em programmablesearchengine.google.com. A chave da API vai na aba 🔑 Credenciais abaixo.
                  </p>
                </div>
              </div>

              <h3 className="font-semibold text-sm">🔑 Chaves dos provedores de busca (pagos)</h3>
              {searchCreds.map((c) => (
                <div key={c.provider} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{c.configured ? "✅" : "🔑"} {c.label}</span>
                    {c.configured && (
                      <span className="text-[11px] font-mono bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">
                        {c.masked} · via {c.source === "env" ? ".env" : "cofre"}
                      </span>
                    )}
                    <a href={c.docsUrl} target="_blank" rel="noreferrer" className="text-[11px] text-indigo-600 dark:text-indigo-400 hover:underline ml-auto">
                      documentar-modelos ↗
                    </a>
                  </div>
                  <p className="text-[11px] text-zinc-500 mt-1">Formato: {c.keyHint}</p>
                  <div className="flex gap-2 mt-2">
                    <input type="password" value={keyInput[`search:${c.provider}`] ?? ""} autoComplete="off"
                      onChange={(e) => setKeyInput((k) => ({ ...k, [`search:${c.provider}`]: e.target.value }))}
                      placeholder={c.configured ? "Colar nova chave para substituir…" : "Colar chave do provedor…"}
                      className="flex-1 min-w-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm font-mono" />
                    <button
                      onClick={() => {
                        const v = keyInput[`search:${c.provider}`] ?? "";
                        setKeyInput((k) => ({ ...k, [c.provider]: v }));
                        setTimeout(() => void saveCred(c.provider), 0);
                      }}
                      disabled={keyBusy === c.provider}
                      className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
                      {keyBusy === c.provider ? "…" : "Salvar"}
                    </button>
                    {c.configured && c.source === "vault" && (
                      <button onClick={() => void delCred(c.provider)} disabled={keyBusy === c.provider}
                        className="rounded-lg border border-red-300 text-red-600 text-sm px-3 py-1.5 disabled:opacity-50">
                        Remover
                      </button>
                    )}
                  </div>
                </div>
              ))}

              <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <h3 className="font-semibold text-sm mb-2">🕘 Pesquisas recentes (todos os usuários)</h3>
                {searchHistory.length === 0 ? (
                  <p className="text-sm text-zinc-500">Nenhuma pesquisa registrada.</p>
                ) : (
                  <ul className="text-sm space-y-1 max-h-64 overflow-y-auto">
                    {searchHistory.map((h) => (
                      <li key={h.id} className="flex items-center gap-2">
                        <span className="truncate flex-1">{h.query}</span>
                        <span className="text-[11px] text-zinc-500 shrink-0">
                          {h.email} · {h.provider} · {h.resultsCount} · {new Date(h.createdAt).toLocaleString("pt-BR")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {tab === "users" && (
            <>
              <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/20 p-3 flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <h3 className="font-semibold text-sm">🔐 Sessões ativas</h3>
                  <p className="text-xs text-zinc-500">Revoga todos os logins (uso após incidentes ou troca de equipe).</p>
                </div>
                <button onClick={() => void revokeSessions()}
                  className="rounded-lg border border-red-400 text-red-700 dark:text-red-300 text-sm font-semibold px-3 py-1.5 hover:bg-red-100 dark:hover:bg-red-950">
                  Revogar todas as sessões
                </button>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-3">
                <h3 className="font-semibold text-sm mb-2">Novo usuário</h3>
                <div className="grid sm:grid-cols-2 gap-2">
                  <input value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder="E-mail"
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm" />
                  <input value={newUser.name} onChange={(e) => setNewUser({ ...newUser, name: e.target.value })} placeholder="Nome"
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm" />
                  <input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder="Senha inicial (mín. 8)"
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm" />
                  <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                    className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm">
                    <option value="user">Usuário</option>
                    <option value="guest">Convidada</option>
                    <option value="admin">Administrador</option>
                  </select>
                </div>
                <button onClick={() => void createUser()} className="mt-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold px-4 py-1.5">
                  Criar usuário
                </button>
              </div>

              {users.map((u) => (
                <div key={u.id} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 flex items-center gap-2 flex-wrap">
                  <div className="flex-1 min-w-[160px]">
                    <div className="font-medium text-sm">{u.blocked ? "🚫 " : ""}{u.name}</div>
                    <div className="text-xs text-zinc-500">{u.email} · {u.role}</div>
                  </div>
                  <select value={u.role} onChange={(e) => void patchUser(u.id, { role: e.target.value })}
                    className="rounded-lg border text-xs px-2 py-1 bg-white dark:bg-zinc-800">
                    <option value="user">user</option>
                    <option value="guest">guest</option>
                    <option value="admin">admin</option>
                  </select>
                  <button onClick={() => void patchUser(u.id, { blocked: !u.blocked })}
                    className="text-xs rounded-lg border px-2 py-1">
                    {u.blocked ? "Desbloquear" : "Bloquear"}
                  </button>
                  <button onClick={() => void deleteUser(u.id, u.email)}
                    className="text-xs rounded-lg border border-red-300 text-red-600 px-2 py-1">Excluir</button>
                </div>
              ))}
            </>
          )}

          {tab === "usage" && usage && (
            <>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <h3 className="font-semibold text-sm mb-1">Cotas diárias (hoje)</h3>
                <p className="text-xs text-zinc-500 mb-2">Limites: {usage.limits.chat} chats/dia · {usage.limits.images} imagens/dia por usuário.</p>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead><tr className="text-left text-zinc-500">
                      <th className="py-1 pr-3">Usuário</th><th className="pr-3">Chat</th><th className="pr-3">Imagens</th><th>Transcrições</th>
                    </tr></thead>
                    <tbody>
                      {Object.values(usage.todayUsage).map((t) => (
                        <tr key={t.email} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-1 pr-3">{t.email}</td>
                          <td className="pr-3">{t.chat}/{usage.limits.chat}</td>
                          <td className="pr-3">{t.image}/{usage.limits.images}</td>
                          <td>{t.transcription}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <h3 className="font-semibold text-sm mb-1">Histórico por dia · usuário · modelo (30 dias)</h3>
                <p className="text-[11px] text-zinc-500 mb-1">≈$ = estimativa pela tabela de preços (não é fatura). $ real = custo informado pelo provedor (imagens OpenRouter).</p>
                <div className="overflow-x-auto max-h-96 overflow-y-auto">
                  <table className="text-xs w-full">
                    <thead><tr className="text-left text-zinc-500">
                      <th className="py-1 pr-2">Dia</th><th className="pr-2">Usuário</th><th className="pr-2">Modelo</th>
                      <th className="pr-2">Tipo</th><th className="pr-2">Qtd</th><th className="pr-2">Tok in/out</th><th className="pr-2">≈$</th><th>$ real</th>
                    </tr></thead>
                    <tbody>
                      {usage.rows.map((r, i) => (
                        <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-1 pr-2 font-mono">{r.day}</td>
                          <td className="pr-2">{r.email}</td>
                          <td className="pr-2 font-mono">{r.modelId}</td>
                          <td className="pr-2">{r.kind}</td>
                          <td className="pr-2">{r.count}</td>
                          <td className="pr-2">{r.tokensIn}/{r.tokensOut}</td>
                          <td className="pr-2">{estimateRow(r.modelId, r.tokensIn, r.tokensOut)}</td>
                          <td>{r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {usage.rows.length === 0 && <p className="text-xs text-zinc-500">Sem uso registrado no período.</p>}
              </div>
            </>
          )}

          {tab === "logs" && (
            <div className="space-y-1">
              {audit.map((l) => (
                <div key={l.id} className="text-xs font-mono rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-2 py-1.5 break-all">
                  <span className="text-zinc-400">{new Date(l.createdAt).toLocaleString("pt-BR")}</span>{" "}
                  <span className="text-indigo-600 dark:text-indigo-400">{l.action}</span>{" "}
                  <span className="text-zinc-600 dark:text-zinc-300">{l.detail}</span>
                </div>
              ))}
              {audit.length === 0 && <p className="text-sm text-zinc-500">Sem registros.</p>}
            </div>
          )}

          {tab === "updates" && <UpdateCenter />}
          {tab === "system" && stats && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  ["👥 Usuários", stats.users],
                  ["📊 Chamadas IA", stats.usage.total],
                  ["🤖 Tarefas", stats.tasks.total],
                  ["✅ Concluídas", stats.tasks.byStatus.done ?? 0],
                ].map(([label, v]) => (
                  <div key={label as string} className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-center">
                    <div className="text-2xl font-bold">{v as number}</div>
                    <div className="text-xs text-zinc-500">{label as string}</div>
                  </div>
                ))}
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <h3 className="font-semibold text-sm mb-1">Uso por modelo</h3>
                <pre className="text-xs overflow-x-auto">{JSON.stringify(stats.usage.byModel, null, 2)}</pre>
                <h3 className="font-semibold text-sm mt-2 mb-1">Uso por tipo</h3>
                <pre className="text-xs overflow-x-auto">{JSON.stringify(stats.usage.byKind, null, 2)}</pre>
              </div>
              <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <h3 className="font-semibold text-sm mb-1">Infraestrutura</h3>
                <pre className="text-xs overflow-x-auto">{JSON.stringify({ drivers: stats.drivers, integrations }, null, 2)}</pre>
              </div>
              {system && (
                <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                  <h3 className="font-semibold text-sm mb-1">Servidor agora ({new Date(system.time).toLocaleString("pt-BR")})</h3>
                  <div className="grid sm:grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-zinc-50 dark:bg-black/30 p-2">
                      <div className="font-semibold">🟢 API (Node {system.node.version})</div>
                      <div>Heap: {system.node.heapUsedMB} MB · RSS: {system.node.rssMB} MB</div>
                      <div>Uptime: {Math.floor(system.uptimeSec / 3600)}h {Math.floor((system.uptimeSec % 3600) / 60)}min</div>
                    </div>
                    <div className="rounded-lg bg-zinc-50 dark:bg-black/30 p-2">
                      <div className="font-semibold">🖥 SO (carga {system.os.load1}/{system.os.load5})</div>
                      <div>RAM: {system.os.totalMemMB - system.os.freeMemMB}/{system.os.totalMemMB} MB em uso</div>
                      <div>Disco{system.disk ? ` (${system.disk.path})` : ""}: {system.disk?.freeMB != null && system.disk?.totalMB != null ? `${system.disk.freeMB}/${system.disk.totalMB} MB livres` : "n/d"}</div>
                    </div>
                    <div className="rounded-lg bg-zinc-50 dark:bg-black/30 p-2 sm:col-span-2">
                      <div className="font-semibold">🗄 Banco ({system.database.driver}{system.database.sizeMB != null ? `, ${system.database.sizeMB} MB` : ""})</div>
                      <div className="font-mono text-[11px]">{system.database.tables ? Object.entries(system.database.tables).map(([t, n]) => `${t}=${n}`).join(" · ") : "n/d"}</div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
