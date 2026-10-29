/** Centro multimodelo: estado real, licenças, custo e teste de cada modelo. */
import { useState } from "react";
import type { ModelInfo, ModelStatus } from "@cr-ia/shared";
import { ApiError, post } from "../lib/api";
import { ProviderCatalogPicker } from "./ProviderCatalogPicker";

interface Props {
  models: ModelInfo[];
  refreshModels: () => Promise<void>;
  isAdmin: boolean;
  onOpenSidebar: () => void;
}

const STATUS: Record<ModelStatus, { label: string; cls: string }> = {
  installed: { label: "Instalado", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" },
  available: { label: "Disponível p/ instalar", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" },
  limited: { label: "⏳ Grátis, limitado", cls: "bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200" },
  unavailable: { label: "Indisponível", cls: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
  testing: { label: "Testando…", cls: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 animate-pulse" },
  "needs-credentials": { label: "🔑 Configurar API", cls: "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200" },
  incompatible: { label: "⛔ Incompatível", cls: "bg-zinc-300 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-400" },
};

export function ModelsView(p: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ model: string; text: string; ok: boolean } | null>(null);
  const [error, setError] = useState("");
  const [provider, setProvider] = useState("all");
  const [filter, setFilter] = useState<"all" | "chat" | "image" | "voice">("all");
  const [costF, setCostF] = useState<"all" | "free" | "paid">("all");
  const [statusF, setStatusF] = useState<"all" | "ready" | "nokey" | "off">("all");

  const test = async (m: ModelInfo) => {
    setBusy(m.id);
    setError("");
    setResult(null);
    try {
      const r = await post<{ latencyMs: number; sample?: string; bytes?: number; kind: string }>(
        "/api/models/test", { model: m.id }
      );
      setResult({
        model: m.id, ok: true,
        text: `OK em ${r.latencyMs}ms` +
          (r.sample ? ` — "${r.sample.slice(0, 120)}"` : "") +
          (r.bytes ? ` — ${Math.round(r.bytes / 1024)} KB` : ""),
      });
    } catch (e) {
      setResult({ model: m.id, ok: false, text: e instanceof ApiError ? e.message : "Falha no teste." });
    } finally {
      setBusy(null);
      await p.refreshModels();
    }
  };

  const toggleDisable = async (m: ModelInfo) => {
    setBusy(m.id);
    try {
      const disabled = p.models.filter((x) => !x.enabled).map((x) => x.id);
      const next = m.enabled ? [...disabled, m.id] : disabled.filter((d) => d !== m.id);
      await post("/api/models/select", { disabled: next });
      await p.refreshModels();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao salvar.");
    } finally {
      setBusy(null);
    }
  };

  const visible = p.models.filter((m) => provider === "all" || m.provider === provider).filter((m) => {
    if (filter === "chat") return m.capabilities.some((c) => ["chat", "reasoning", "code"].includes(c));
    if (filter === "image") return m.capabilities.some((c) => ["image-gen", "image-edit"].includes(c));
    if (filter === "voice") return m.capabilities.some((c) => ["transcription", "embeddings"].includes(c));
    return true;
  }).filter((m) => {
    if (costF === "free" && m.paid) return false;
    if (costF === "paid" && !m.paid) return false;
    if (statusF === "ready") return m.status === "installed" || m.status === "limited" || m.status === "available";
    if (statusF === "nokey") return m.status === "needs-credentials";
    if (statusF === "off") return m.status === "unavailable" || m.status === "incompatible";
    return true;
  });

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={p.onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h2 className="font-semibold text-sm flex-1">🧠 Centro multimodelo</h2>
        <div className="flex flex-wrap gap-1 text-xs items-center">
          {(["all", "chat", "image", "voice"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-2 py-1 rounded-lg ${filter === f ? "bg-indigo-600 text-white" : "bg-zinc-200 dark:bg-zinc-800"}`}>
              {f === "all" ? "Todos" : f === "chat" ? "Texto" : f === "image" ? "Imagem" : "Voz/Docs"}
            </button>
          ))}
          <select value={costF} onChange={(e) => setCostF(e.target.value as typeof costF)}
            className="px-2 py-1 rounded-lg bg-zinc-200 dark:bg-zinc-800">
            <option value="all">Grátis + pagos</option>
            <option value="free">🆓 Grátis</option>
            <option value="paid">💰 Pagos</option>
          </select>
          <select value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)}
            className="px-2 py-1 rounded-lg bg-zinc-200 dark:bg-zinc-800">
            <option value="all">Todos status</option>
            <option value="ready">🟢 Prontos</option>
            <option value="nokey">🔑 Sem chave</option>
            <option value="off">🔴 Indisponíveis</option>
          </select>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-5xl mx-auto space-y-2">
          {error && <p className="text-sm text-red-600">⚠️ {error}</p>}
          <ProviderCatalogPicker models={p.models} selected={provider} onSelect={setProvider}
            isAdmin={p.isAdmin} refreshModels={p.refreshModels} />
          <p className="text-xs text-zinc-500">
            {provider === "all" ? "Todos os provedores" : "Catálogo: " + provider} · {visible.length} modelo(s). Estado verificado agora no servidor (ping real). 🧪 executa uma inferência de verdade.
            Modelos pagos ficam bloqueados por padrão — o admin libera em cada caso.
            🔑 = API por chave ainda não configurada (Administração → Credenciais).
          </p>
          {visible.map((m) => {
            const st = STATUS[m.status] ?? STATUS.unavailable;
            return (
              <div key={m.id} className={`rounded-2xl border p-3 ${m.enabled ? "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900" : "border-dashed opacity-70 bg-zinc-50 dark:bg-zinc-900/50"}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm">{m.label}</span>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cls}`}>{st.label}</span>
                  {m.cost === "paid"
                    ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200">💰 pago</span>
                    : m.cost === "free-tier"
                      ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-cyan-50 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300" title={m.limits ?? "Cotas do plano grátis"}>⏳ grátis, limitado</span>
                      : <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">🆓 grátis</span>}
                  {m.local
                    ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300">🏠 no servidor</span>
                    : <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-700 dark:bg-orange-950/50 dark:text-orange-300">☁️ externo</span>}
                  {!m.enabled && <span className="text-[11px] text-zinc-500">(desabilitado pelo admin)</span>}
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-1">{m.description}</p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 mt-1">
                  <span>🔑 {m.license}</span>
                  <span>🏷️ {m.id}</span>
                  {m.sizeNote && <span>💾 {m.sizeNote}</span>}
                  {m.limits && <span title="Cotas do plano gratuito">⏳ {m.limits}</span>}
                  <span>⚙️ {m.capabilities.join(", ")}</span>
                  {m.pricePer1M && (
                    <span title="Estimativa — confirme o preço no provedor">
                      💲 ~${m.pricePer1M.in}/${m.pricePer1M.out} por 1M tokens in/out (tab. {m.pricePer1M.asOf})
                    </span>
                  )}
                  {m.lastTest && (
                    <span>{m.lastTest.ok ? "✅" : "❌"} último teste: {m.lastTest.ok ? "ok" : "falhou"} em {m.lastTest.latencyMs}ms
                      ({new Date(m.lastTest.at).toLocaleString("pt-BR")})</span>
                  )}
                </div>
                {m.requirements && m.status !== "installed" && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1">➡️ Para ativar: {m.requirements}</p>
                )}
                {result?.model === m.id && (
                  <p className={`text-xs mt-1 ${result.ok ? "text-emerald-700 dark:text-emerald-300" : "text-red-600"}`}>
                    {result.ok ? "✅" : "❌"} {result.text}
                  </p>
                )}
                {p.isAdmin && (
                  <div className="flex gap-3 mt-2 text-xs">
                    {(m.status === "installed" || m.status === "available" || m.status === "limited") && (
                      <button onClick={() => void test(m)} disabled={busy === m.id}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50">
                        {busy === m.id ? "Testando…" : "🧪 Testar de verdade"}
                      </button>
                    )}
                    <button onClick={() => void toggleDisable(m)} disabled={busy === m.id}
                      className="text-zinc-600 dark:text-zinc-400 hover:underline disabled:opacity-50">
                      {m.enabled ? "Desabilitar" : "Habilitar"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {visible.length === 0 && <p className="text-sm text-zinc-500 text-center">Nenhum modelo deste provedor disponível no catálogo atual. Configure a API ou consulte/autorize modelos no painel acima.</p>}
        </div>
      </div>
    </div>
  );
}
