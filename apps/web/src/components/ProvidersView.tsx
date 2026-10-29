/** CR IA v0.3.0 — Administração → Provedores de IA (OpenRouter primário). */
import { useEffect, useMemo, useState } from "react";
import type { ModelInfo } from "@cr-ia/shared";
import { ApiError, api, post } from "../lib/api";

interface Props {
  models: ModelInfo[];
  refreshModels: () => Promise<void>;
}

interface NvidiaStatus {
  configured: boolean;
  source: "env" | "vault" | "none";
  catalog: { at: string; models: string[] } | null;
  approved: string[];
  notice: string;
  image?: { modelId: string; enabled: boolean; freeEndpointVerified: boolean; note: string };
}

interface OrStatus {
  key: { configured: boolean; source: string; masked: string | null } | null;
  ping: { ok: boolean; label: string | null; usage: number | null; limit: number | null; error?: string } | null;
  catalog: { total: number; text: number; image: number; free: number; paidOrUnknown: number; at: string } | null;
  sync: { auto: boolean; intervalHours: number; lastSync: string | null };
  report: {
    at: string; source: string; total: number; text: number; image: number; free: number;
    added: string[]; updated: string[]; removed: string[]; imageErrors: string[];
  } | null;
}

const STATUS_PT: Record<string, string> = {
  installed: "🟢 Pronto",
  available: "🟡 Ativável",
  limited: "⏳ Grátis·cotas",
  unavailable: "🔴 Indisponível",
  testing: "🔵 Testando…",
  "needs-credentials": "🔑 Configurar API",
  incompatible: "⛔ Incompatível",
};

function fmt1M(v: number): string {
  return v === 0 ? "$0" : `$${v.toFixed(v < 1 ? 3 : 2)}`;
}

export function ProvidersView({ models, refreshModels }: Props) {
  const [st, setSt] = useState<OrStatus | null>(null);
  const [nv, setNv] = useState<NvidiaStatus | null>(null);
  const [nvKey, setNvKey] = useState("");
  const [nvStatus, setNvStatus] = useState("");
  const [nvBusy, setNvBusy] = useState(false);
  const [nvImageBusy, setNvImageBusy] = useState(false);
  const [nvRetrievalBusy, setNvRetrievalBusy] = useState(false);
  const [nvRetrievalText, setNvRetrievalText] = useState("Como funciona a fidelização de clientes?");
  const [nvRetrievalResult, setNvRetrievalResult] = useState("");
  const [nvFilter, setNvFilter] = useState("");
  const [nvSelected, setNvSelected] = useState<Set<string>>(new Set());
  const [nvConfirmed, setNvConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [newKey, setNewKey] = useState("");
  const [keyMsg, setKeyMsg] = useState("");
  const [auto, setAuto] = useState(true);
  const [intervalH, setIntervalH] = useState(24);
  const [syncMsg, setSyncMsg] = useState("");
  // Seleção local (salva de uma vez em /models/select)
  const [disabled, setDisabled] = useState<Set<string>>(new Set());
  const [paidAck, setPaidAck] = useState<Set<string>>(new Set());
  const [defChat, setDefChat] = useState("");
  const [defImg, setDefImg] = useState("");
  const [dirty, setDirty] = useState(false);
  // Filtros
  const [q, setQ] = useState("");
  const [fCat, setFCat] = useState<"all" | "chat" | "image" | "edit">("all");
  const [fCost, setFCost] = useState<"all" | "free" | "paid">("all");
  const [fStatus, setFStatus] = useState<"all" | "active" | "activatable" | "nokey" | "off">("all");
  const [fProvider, setFProvider] = useState<"all" | "openrouter" | "nvidia" | "other">("all");

  const load = async () => {
    setError("");
    try {
      const [s, settings, m] = await Promise.all([
        api<OrStatus>("/api/admin/openrouter/status"),
        api<{ settings: Record<string, string | null> }>("/api/admin/settings"),
        api<{ defaults: { chat: string | null; image: string | null } }>("/api/models"),
      ]);
      setSt(s);
      try {
        const n = await api<NvidiaStatus>("/api/admin/nvidia/status");
        setNv(n);
        setNvSelected(new Set(n.approved));
      } catch { setNv(null); }
      setAuto(s.sync.auto);
      setIntervalH(s.sync.intervalHours);
      try {
        setDisabled(new Set(JSON.parse(settings.settings["models.disabled"] ?? "[]") as string[]));
      } catch { setDisabled(new Set()); }
      try {
        setPaidAck(new Set(JSON.parse(settings.settings["models.paidAck"] ?? "[]") as string[]));
      } catch { setPaidAck(new Set()); }
      setDefChat(m.defaults.chat ?? "");
      setDefImg(m.defaults.image ?? "");
      setDirty(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar provedores.");
    }
  };

  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return models.filter((m) => {
      if (fProvider === "openrouter" && m.provider !== "openrouter") return false;
      if (fProvider === "nvidia" && m.provider !== "nvidia") return false;
      if (fProvider === "other" && (m.provider === "openrouter" || m.provider === "nvidia")) return false;
      if (fCat === "chat" && !m.capabilities.includes("chat")) return false;
      if (fCat === "image" && !m.capabilities.includes("image-gen")) return false;
      if (fCat === "edit" && !m.capabilities.includes("image-edit")) return false;
      if (fCost === "free" && m.paid) return false;
      if (fCost === "paid" && !m.paid) return false;
      if (fStatus === "active" && !(m.status === "installed" || m.status === "limited")) return false;
      if (fStatus === "activatable" && m.status !== "available") return false;
      if (fStatus === "nokey" && m.status !== "needs-credentials") return false;
      if (fStatus === "off" && !(m.status === "unavailable" || m.status === "incompatible")) return false;
      if (needle && !(m.id.toLowerCase().includes(needle) || m.label.toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [models, q, fCat, fCost, fStatus, fProvider]);

  const toggle = (set: Set<string>, apply: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
    setDirty(true);
  };

  const saveModels = async () => {
    setBusy("save");
    setError("");
    try {
      await post("/api/models/select", {
        defaultChat: defChat || undefined,
        defaultImage: defImg || undefined,
        disabled: [...disabled],
        paidAck: [...paidAck],
      });
      await refreshModels();
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar.");
    } finally {
      setBusy("");
    }
  };

  const saveKey = async () => {
    if (newKey.trim().length < 8) { setKeyMsg("Chave curta demais."); return; }
    setBusy("key");
    setKeyMsg("");
    try {
      const r = await post<{ masked: string }>("/api/admin/openrouter/key", { key: newKey.trim() });
      setKeyMsg(`✅ Guardada no cofre (${r.masked}).`);
      setNewKey("");
      await load();
    } catch (e) {
      setKeyMsg(`❌ ${e instanceof ApiError ? e.message : "Falha ao salvar."}`);
    } finally {
      setBusy("");
    }
  };

  const testKey = async () => {
    setBusy("test");
    setKeyMsg("Testando…");
    try {
      const r = await post<{ info: OrStatus["ping"] }>("/api/admin/openrouter/key/test", newKey.trim() ? { key: newKey.trim() } : {});
      const i = r.info;
      setKeyMsg(i?.ok
        ? `✅ Válida${i.label ? ` (${i.label})` : ""} · uso ${i.usage ?? "?"} / limite ${i.limit ?? "?"}.`
        : `❌ ${i?.error ?? "Falhou."}`);
      await load();
    } catch (e) {
      setKeyMsg(`❌ ${e instanceof ApiError ? e.message : "Falha ao testar."}`);
    } finally {
      setBusy("");
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    setSyncMsg("Sincronizando com a OpenRouter…");
    try {
      const r = await post<{ report: NonNullable<OrStatus["report"]> }>("/api/admin/openrouter/sync", {});
      const rp = r.report;
      setSyncMsg(
        `✅ ${rp.total} modelos · +${rp.added.length} novos · ~${rp.updated.length} atualizados · −${rp.removed.length} removidos` +
        (rp.imageErrors.length ? ` · ⚠️ imagens: ${rp.imageErrors[0]}` : ""),
      );
      await refreshModels();
      await load();
    } catch (e) {
      setSyncMsg(`❌ ${e instanceof ApiError ? e.message : "Falha no sync."}`);
    } finally {
      setBusy("");
    }
  };

  const saveSyncCfg = async () => {
    setBusy("synccfg");
    try {
      await post("/api/admin/openrouter/sync-config", { auto, intervalHours: intervalH });
      setSyncMsg(`✅ Sync automático ${auto ? `ligado (a cada ${intervalH}h)` : "desligado"}.`);
      await load();
    } catch (e) {
      setSyncMsg(`❌ ${e instanceof ApiError ? e.message : "Falha ao salvar."}`);
    } finally {
      setBusy("");
    }
  };

  const nvidiaAction = async (action: "key" | "sync" | "approve") => {
    setNvBusy(true);
    setNvStatus("");
    try {
      if (action === "key") {
        if (nvKey.trim().length < 8) throw new Error("Informe uma chave NVIDIA válida.");
        await post("/api/admin/nvidia/key", { key: nvKey.trim() });
        setNvKey("");
        setNvStatus("✅ Chave NVIDIA salva no cofre.");
      } else if (action === "sync") {
        const result = await post<{ catalog: { models: string[] } }>("/api/admin/nvidia/sync", {});
        setNvStatus(`✅ ${result.catalog.models.length} candidatos encontrados. Verifique Free Endpoint no site oficial antes de autorizar.`);
      } else {
        if (!nvConfirmed) throw new Error("Confirme o selo Free Endpoint e uso exclusivo em testes.");
        await post("/api/admin/nvidia/approve", { models: [...nvSelected], confirmFreeEndpointAndDevOnly: true });
        setNvStatus(`✅ ${nvSelected.size} modelos autorizados para testes administrativos.`);
        await refreshModels();
      }
      const n = await api<NvidiaStatus>("/api/admin/nvidia/status");
      setNv(n);
      if (action !== "approve") setNvSelected(new Set(n.approved));
    } catch (e) {
      setNvStatus(`❌ ${e instanceof Error ? e.message : "Operação falhou."}`);
    } finally {
      setNvBusy(false);
    }
  };

  const inputCls = "rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm";

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}

      {/* ---- OpenRouter: chave ---- */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
        <h3 className="font-semibold text-sm mb-1">🔑 OpenRouter — chave de API (provedor primário)</h3>
        <p className="text-xs text-zinc-500 mb-2">
          {st?.key?.configured
            ? <>Configurada ({st.key.source === "env" ? ".env no servidor" : "cofre do painel"}) · <code className="font-mono">{st.key.masked}</code></>
            : "Não configurada — modelos OpenRouter ficam “🔑 Configurar API”."}{" "}
          A chave do .env (se existir) tem prioridade e é preservada. O valor completo nunca é exibido.
        </p>
        {st?.ping && (
          <p className="text-xs mb-2">
            {st.ping.ok
              ? <>🟢 Chave válida{st.ping.label ? <> · <strong>{st.ping.label}</strong></> : null} · uso {st.ping.usage ?? "?"} / limite {st.ping.limit ?? "?"}</>
              : <>🔴 {st.ping.error ?? "Chave inválida."}</>}
          </p>
        )}
        <div className="flex flex-wrap gap-2 items-center">
          <input type="password" value={newKey} onChange={(e) => setNewKey(e.target.value)}
            placeholder="sk-or-v1-… (colar nova chave)" autoComplete="off"
            className={`${inputCls} flex-1 min-w-[200px] font-mono`} />
          <button onClick={() => void saveKey()} disabled={busy !== ""}
            className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-4 py-1.5 disabled:opacity-50">
            {busy === "key" ? "Salvando…" : "💾 Salvar chave"}</button>
          <button onClick={() => void testKey()} disabled={busy !== ""}
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm px-4 py-1.5 disabled:opacity-50">
            {busy === "test" ? "Testando…" : "🧪 Testar (sem gasto)"}</button>
        </div>
        {keyMsg && <p className="text-xs mt-1">{keyMsg}</p>}
      </div>

      {/* ---- NVIDIA NIM — SOMENTE protótipos, sem inferência automática ---- */}
      <section className="rounded-2xl border border-amber-300 dark:border-amber-800 bg-white dark:bg-zinc-900 p-3">
        <h3 className="font-semibold text-sm mb-1">🟢 NVIDIA NIM — Free Endpoints (modo de testes)</h3>
        <p className="text-xs text-amber-700 dark:text-amber-400 mb-2">
          A NVIDIA libera endpoints para prototipagem, não para atender clientes em produção.
          A consulta /v1/models lista candidatos — não comprova gratuidade nem compatibilidade com chat.
          Confira cada modelo em <a className="underline" href="https://build.nvidia.com/models" target="_blank" rel="noreferrer">NVIDIA Build</a>.
          Modelos de chat e Cosmos3 Nano (imagens Physical AI) são integrados separadamente.
          FLUX, Qwen Image e Stable Diffusion não são classificados como Free Endpoint sem comprovação.
        </p>
        <p className="text-xs text-zinc-500 mb-2">Chave: {nv?.configured ? `✅ configurada (${nv.source})` : "🔑 não configurada"} ·
          última consulta: {nv?.catalog?.at ? new Date(nv.catalog.at).toLocaleString("pt-BR") : "nunca"} ·
          {nv?.catalog?.models.length ?? 0} candidatos · {nv?.approved.length ?? 0} autorizados para testes.</p>
        <div className="flex flex-wrap gap-2 items-center mb-2">
          <input type="password" autoComplete="off" className={`${inputCls} flex-1 min-w-[190px]`} value={nvKey}
            onChange={(e) => setNvKey(e.target.value)} placeholder="nvapi-… (API key NVIDIA)" />
          <button disabled={nvBusy} className="rounded-lg bg-indigo-600 text-white text-xs px-3 py-2 disabled:opacity-40"
            onClick={() => void nvidiaAction("key")}>Salvar chave</button>
          <button disabled={nvBusy || !nv?.configured} className="rounded-lg border border-zinc-400 text-xs px-3 py-2 disabled:opacity-40"
            onClick={() => void nvidiaAction("sync")}>🔄 Consultar modelos NVIDIA</button>
        </div>
        <div className="rounded-xl border border-indigo-200 dark:border-indigo-900 p-3 mb-3 space-y-2">
          <div className="text-sm font-semibold">🎨 NVIDIA Cosmos3 Nano — geração de imagens para testes</div>
          <p className="text-xs text-zinc-600 dark:text-zinc-300">
            Free Endpoint verificado no catálogo da NVIDIA. Funciona com text2image (ambientes físicos, robótica e indústria),
            com cotas e uso de prototipagem. Não equivale a um gerador universal de artes comerciais. Formatos: 1:1, 16:9 e 9:16.
          </p>
          <p className="text-xs">Status: {nv?.image?.enabled ? "🟢 Habilitado para testes administrativos" : "🔒 Desabilitado"}</p>
          <button type="button" disabled={nvImageBusy || !nv?.configured}
            className="rounded-lg bg-indigo-600 text-white text-xs px-3 py-2 disabled:opacity-40"
            onClick={async () => {
              const enabling = !nv?.image?.enabled;
              if (enabling && !window.confirm("Confirmo o uso somente pelo administrador para desenvolvimento/testes, sujeito a limites NVIDIA. Ativar Cosmos3 Nano?")) return;
              setNvImageBusy(true);
              try {
                await post("/api/admin/nvidia/image/enable", { enabled: enabling, confirmFreeEndpointAndDevOnly: true });
                const n = await api<NvidiaStatus>("/api/admin/nvidia/status");
                setNv(n);
                setNvStatus(enabling ? "✅ Cosmos3 Nano habilitado para testes no Estúdio de Imagens." : "Cosmos3 Nano desabilitado.");
                await refreshModels();
              } catch (e) {
                setNvStatus(`❌ ${e instanceof Error ? e.message : "Falha ao configurar imagens NVIDIA."}`);
              } finally { setNvImageBusy(false); }
            }}>
            {nvImageBusy ? "Salvando…" : nv?.image?.enabled ? "Desativar Cosmos3 Nano" : "Ativar geração de imagens NVIDIA (testes)"}
          </button>
        </div>
        <div className="rounded-xl border dark:border-zinc-700 p-3 mb-3 space-y-2">
          <strong className="text-sm">🔎 NVIDIA Nemotron Retriever — testes de busca semântica</strong>
          <p className="text-xs text-zinc-500">Free Endpoints de embeddings e reranking para protótipos. Requer acesso na sua conta NVIDIA; nenhuma chamada é feita automaticamente.</p>
          <input className={`${inputCls} w-full`} value={nvRetrievalText} maxLength={1000}
            onChange={(e) => setNvRetrievalText(e.target.value)} placeholder="Digite uma frase de teste" />
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={nvRetrievalBusy || !nv?.configured}
              className="rounded-lg border px-3 py-2 text-xs disabled:opacity-40" onClick={async () => {
                setNvRetrievalBusy(true);
                try {
                  const r = await post<{ dimensions: number; preview: number[] }>("/api/admin/nvidia/retrieval/embed", {
                    model: "nvidia/nemotron-3.5-embed-1b", input: nvRetrievalText, inputType: "query", confirmDevOnly: true,
                  });
                  setNvRetrievalResult(`✅ Embedding gerado: ${r.dimensions} dimensões. Amostra: ${r.preview.map((n) => n.toFixed(3)).join(", ")}`);
                } catch (e) { setNvRetrievalResult(`❌ ${e instanceof Error ? e.message : "Indisponível."}`); }
                finally { setNvRetrievalBusy(false); }
              }}>Testar embeddings</button>
            <button type="button" disabled={nvRetrievalBusy || !nv?.configured}
              className="rounded-lg border px-3 py-2 text-xs disabled:opacity-40" onClick={async () => {
                setNvRetrievalBusy(true);
                try {
                  const r = await post<{ ranking: unknown }>("/api/admin/nvidia/retrieval/rerank", {
                    query: nvRetrievalText,
                    passages: ["Programa de pontos para clientes fiéis", "Receita de bolo de chocolate"], confirmDevOnly: true,
                  });
                  setNvRetrievalResult(`✅ Reranking respondeu: ${JSON.stringify(r.ranking).slice(0, 350)}`);
                } catch (e) { setNvRetrievalResult(`❌ ${e instanceof Error ? e.message : "Indisponível."}`); }
                finally { setNvRetrievalBusy(false); }
              }}>Testar reranking</button>
          </div>
          {nvRetrievalResult && <p className="text-xs break-all">{nvRetrievalResult}</p>}
        </div>
        {nv?.catalog && <>
          <input className={`${inputCls} w-full mb-2`} placeholder="🔍 Filtrar candidatos…" value={nvFilter} onChange={(e) => setNvFilter(e.target.value)} />
          <div className="max-h-52 overflow-auto text-xs space-y-1 border rounded-lg p-2 dark:border-zinc-700">
            {nv.catalog.models.filter((id) => id.toLowerCase().includes(nvFilter.trim().toLowerCase())).slice(0, 250).map((id) => (
              <label key={id} className="flex gap-2 items-center cursor-pointer">
                <input type="checkbox" checked={nvSelected.has(id)} onChange={() => {
                  const next = new Set(nvSelected); if (next.has(id)) next.delete(id); else next.add(id);
                  setNvSelected(next); setNvConfirmed(false);
                }} />
                <code className="break-all">{id}</code>
              </label>
            ))}
          </div>
          <label className="flex items-start gap-2 text-xs mt-3 mb-2 cursor-pointer">
            <input type="checkbox" className="mt-0.5" checked={nvConfirmed} onChange={(e) => setNvConfirmed(e.target.checked)} />
            <span>Confirmei no catálogo oficial que os selecionados são <b>Free Endpoint</b>, compatíveis com chat,
              e serão utilizados somente por mim para desenvolvimento/testes.</span>
          </label>
          <button disabled={nvBusy || !nvConfirmed} onClick={() => void nvidiaAction("approve")}
            className="rounded-lg bg-amber-600 text-white text-xs font-semibold px-3 py-2 disabled:opacity-40">
            ✅ Autorizar {nvSelected.size} modelo(s) somente para testes
          </button>
        </>}
        {nvStatus && <p className="text-xs mt-2">{nvStatus}</p>}
      </section>

      {/* ---- Catálogo dinâmico ---- */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
        <h3 className="font-semibold text-sm mb-1">🔄 Catálogo de modelos (sincronizado da OpenRouter oficial)</h3>
        <p className="text-xs text-zinc-500 mb-2">
          {st?.catalog
            ? <>{st.catalog.total} modelos · {st.catalog.text} texto · {st.catalog.image} imagem · {st.catalog.free} grátis · {st.catalog.paidOrUnknown} pagos/sem preço · sync em {new Date(st.catalog.at).toLocaleString("pt-BR")}</>
            : "Nunca sincronizado — rode “Atualizar modelos de IA”."}{" "}
          Sync automático: {st?.sync.auto ? `ligado (a cada ${st?.sync.intervalHours}h)` : "desligado"}.
          Suas ativações e padrões são preservados no sync.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <button onClick={() => void syncNow()} disabled={busy !== ""}
            className="rounded-lg bg-emerald-600 text-white text-sm font-semibold px-4 py-1.5 disabled:opacity-50">
            {busy === "sync" ? "Sincronizando…" : "🔄 ATUALIZAR MODELOS DE IA"}</button>
          <label className="text-xs flex items-center gap-1">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="w-4 h-4" />
            Sync automático a cada</label>
          <input type="number" min={1} max={168} value={intervalH}
            onChange={(e) => setIntervalH(Math.min(168, Math.max(1, Number(e.target.value) || 24)))}
            className={`${inputCls} w-20`} />
          <span className="text-xs">h</span>
          <button onClick={() => void saveSyncCfg()} disabled={busy !== ""}
            className="rounded-lg border border-zinc-300 dark:border-zinc-700 text-sm px-3 py-1.5 disabled:opacity-50">
            Salvar sync</button>
        </div>
        {syncMsg && <p className="text-xs mt-1">{syncMsg}</p>}
        {st?.report && (
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-indigo-600 dark:text-indigo-400">
              Último sync ({new Date(st.report.at).toLocaleString("pt-BR")}, {st.report.source}): +{st.report.added.length} ~{st.report.updated.length} −{st.report.removed.length} — ver listas
            </summary>
            <div className="grid md:grid-cols-3 gap-2 mt-1 max-h-48 overflow-y-auto">
              <div><strong className="text-emerald-600">+ Adicionados ({st.report.added.length})</strong>
                <ul className="font-mono break-all">{st.report.added.slice(0, 200).map((id) => <li key={id}>{id}</li>)}</ul></div>
              <div><strong className="text-amber-600">~ Atualizados ({st.report.updated.length})</strong>
                <ul className="font-mono break-all">{st.report.updated.slice(0, 200).map((id) => <li key={id}>{id}</li>)}</ul></div>
              <div><strong className="text-red-600">− Removidos ({st.report.removed.length})</strong>
                <ul className="font-mono break-all">{st.report.removed.slice(0, 200).map((id) => <li key={id}>{id}</li>)}</ul></div>
            </div>
            {st.report.imageErrors.length > 0 && <p className="text-amber-600 mt-1">⚠️ {st.report.imageErrors.join(" · ")}</p>}
          </details>
        )}
      </div>

      {/* ---- Modelos ---- */}
      <div className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
        <h3 className="font-semibold text-sm mb-1">🧠 Modelos ({filtered.length} de {models.length})</h3>
        <div className="flex flex-wrap gap-2 mb-2 text-xs">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 buscar id/nome…"
            className={`${inputCls} flex-1 min-w-[140px]`} />
          <select value={fProvider} onChange={(e) => setFProvider(e.target.value as typeof fProvider)} className={inputCls}>
            <option value="all">Todos provedores</option>
            <option value="openrouter">OpenRouter</option>
            <option value="nvidia">NVIDIA NIM</option>
            <option value="other">Outros</option>
          </select>
          <select value={fCat} onChange={(e) => setFCat(e.target.value as typeof fCat)} className={inputCls}>
            <option value="all">Todas categorias</option>
            <option value="chat">💬 Texto</option>
            <option value="image">🎨 Imagem</option>
            <option value="edit">✏️ Edição</option>
          </select>
          <select value={fCost} onChange={(e) => setFCost(e.target.value as typeof fCost)} className={inputCls}>
            <option value="all">Grátis + pagos</option>
            <option value="free">🆓 Grátis</option>
            <option value="paid">💰 Pagos</option>
          </select>
          <select value={fStatus} onChange={(e) => setFStatus(e.target.value as typeof fStatus)} className={inputCls}>
            <option value="all">Todos status</option>
            <option value="active">🟢 Ativos</option>
            <option value="activatable">🟡 Ativáveis (pagos)</option>
            <option value="nokey">🔑 Sem chave</option>
            <option value="off">🔴 Indisponíveis</option>
          </select>
        </div>
        <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
          <table className="text-xs w-full min-w-[760px]">
            <thead className="sticky top-0 bg-white dark:bg-zinc-900"><tr className="text-left text-zinc-500">
              <th className="py-1 pr-2">Modelo</th><th className="pr-2">Capacidades</th><th className="pr-2">Custo/1M</th>
              <th className="pr-2">Status</th><th className="pr-2">Ativo</th>
              <th className="pr-2">Padrão</th><th>Pago autorizado</th>
            </tr></thead>
            <tbody>
              {filtered.slice(0, 400).map((m) => (
                <tr key={m.id} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="py-1 pr-2">
                    <div className="font-mono break-all">{m.id}</div>
                    <div className="text-zinc-500">{m.provider}{m.external ? " 🌐" : ""}</div>
                    {m.requirements && <div className="text-amber-600 dark:text-amber-400">{m.requirements}</div>}
                  </td>
                  <td className="pr-2 whitespace-nowrap">
                    {m.capabilities.includes("chat") && "💬"}{m.capabilities.includes("code") && "💻"}
                    {m.capabilities.includes("image-gen") && "🎨"}{m.capabilities.includes("image-edit") && "✏️"}
                    {m.capabilities.includes("transcription") && "🎙️"}{m.capabilities.includes("embeddings") && "🧬"}
                  </td>
                  <td className="pr-2 whitespace-nowrap">
                    {m.paid ? "💰 " : "🆓 "}
                    {m.pricePer1M ? `${fmt1M(m.pricePer1M.in)}/${fmt1M(m.pricePer1M.out)}` : m.paid ? "s/ preço*" : "—"}
                  </td>
                  <td className="pr-2 whitespace-nowrap">{STATUS_PT[m.status] ?? m.status}</td>
                  <td className="pr-2">
                    <input type="checkbox" checked={!disabled.has(m.id)}
                      onChange={() => toggle(disabled, setDisabled, m.id)} className="w-4 h-4" />
                  </td>
                  <td className="pr-2 whitespace-nowrap">
                    {m.capabilities.includes("chat") && m.provider !== "nvidia" && (
                      <label className="mr-2" title="Padrão de chat">
                        <input type="radio" name="defChat" checked={defChat === m.id}
                          onChange={() => { setDefChat(m.id); setDirty(true); }} /> 💬</label>
                    )}
                    {m.capabilities.includes("image-gen") && m.provider !== "nvidia" && (
                      <label title="Padrão de imagem">
                        <input type="radio" name="defImg" checked={defImg === m.id}
                          onChange={() => { setDefImg(m.id); setDirty(true); }} /> 🎨</label>
                    )}
                  </td>
                  <td>
                    {m.paid ? (
                      <input type="checkbox" checked={paidAck.has(m.id)} title="Autorizar cobrança neste modelo"
                        onChange={() => toggle(paidAck, setPaidAck, m.id)} className="w-4 h-4" />
                    ) : <span className="text-zinc-400">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 400 && <p className="text-[11px] text-zinc-500 mt-1">Mostrando 400 de {filtered.length} — refine a busca/filtros.</p>}
        <p className="text-[11px] text-zinc-500 mt-1">s/ preço* = sem preço divulgado → tratado como pago (nunca liberado sem “Pago autorizado”).</p>
        <button onClick={() => void saveModels()} disabled={busy !== "" || !dirty}
          className="mt-2 rounded-xl bg-indigo-600 text-white font-semibold px-5 py-2 text-sm disabled:opacity-50">
          {busy === "save" ? "Salvando…" : "💾 Salvar seleção"}</button>
      </div>
    </div>
  );
}
