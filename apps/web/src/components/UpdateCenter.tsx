import { useCallback, useEffect, useState } from "react";
import { ApiError, api, post } from "../lib/api";

interface UpdateStatus {
  configured: boolean;
  current: string;
  latest: string | null;
  notes: string | null;
  staged: string | null;
  checkedAt: string | null;
  updateAvailable: boolean;
  error: string | null;
  updater: { active: boolean; lastBeatAt: string | null } | null;
}

interface UploadReport {
  version: string;
  files: number;
  bytes: number;
  migrations: string[];
  irreversibleDb: boolean;
  notes: string | null;
  warnings: string[];
}

interface StagingChecks {
  passed: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

interface ReleaseInfo {
  name: string;
  version: string;
  at: string;
  kind: string;
}

/**
 * Central de Atualizações (§4):
 * - Upload de ZIP assinado → validação → staging → aprovação → updater aplica.
 * - Descoberta opcional por manifesto remoto (só avisa; nunca aplica sozinho).
 */
export function UpdateCenter() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState("");
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [signature, setSignature] = useState("");
  const [report, setReport] = useState<UploadReport | null>(null);
  const [checks, setChecks] = useState<StagingChecks | null>(null);
  const [releases, setReleases] = useState<ReleaseInfo[]>([]);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);

  const refresh = useCallback(async () => {
    try {
      const [st, rel, hist] = await Promise.all([
        api<UpdateStatus>("/api/admin/updates/status"),
        api<{ releases: ReleaseInfo[] }>("/api/admin/updates/releases"),
        api<{ items: Array<Record<string, unknown>> }>("/api/admin/updates/history?limit=20"),
      ]);
      setStatus(st);
      setReleases(rel.releases);
      setHistory(hist.items);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar status.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(kind: string, fn: () => Promise<unknown>) {
    setBusy(kind);
    setError("");
    setLog("");
    try {
      const r = await fn();
      if (kind === "apply" || kind === "test") {
        setLog(String((r as { log?: string; tail?: string }).log ?? (r as { tail?: string }).tail ?? ""));
      }
      if (kind === "upload" && r && typeof r === "object") {
        const d = r as { report?: UploadReport; checks?: StagingChecks };
        setReport(d.report ?? null);
        setChecks(d.checks ?? null);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : `Falha em ${kind}.`);
    } finally {
      setBusy("");
    }
  }

  function confirmApply(version: string): boolean {
    return window.confirm(
      `Aprovar a versão ${version}?\n\n` +
      "• Um backup completo será feito ANTES.\n" +
      "• O serviço updater aplica (a API não toca nos arquivos).\n" +
      "• Falha aplica rollback automático dos arquivos.\n" +
      "• .env, dados e backups são preservados.",
    );
  }

  function confirmRollback(target: string, dbWarn: boolean): boolean {
    return window.confirm(
      `Reverter para ${target}?\n\n` +
      "• Backup do estado atual será feito antes.\n" +
      (dbWarn ? "• ⚠️ A VERSÃO ATUAL MARCOU MIGRAÇÃO DE BANCO IRREVERSÍVEL: arquivos revertem, o BANCO precisa de revisão manual.\n" : "") +
      "• Confirma a reversão?",
    );
  }

  return (
    <div className="space-y-3">
      {/* ---- Sinal de vida do aplicador ---- */}
      {status?.updater && (
        <div className={`rounded-xl border p-3 text-sm ${status.updater.active
          ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"}`}>
          {status.updater.active ? (
            <>🟢 <strong>Aplicador ativo</strong> — pedidos aprovados serão aplicados automaticamente.</>
          ) : (
            <>🟡 <strong>Aplicador parado</strong> — pedidos aprovados vão acumular na fila. Para ligar (uma vez, na VPS):{" "}
              <code className="font-mono text-xs">docker compose --profile updates up -d</code></>
          )}
        </div>
      )}
      {/* ---- Upload de ZIP (fluxo principal) ---- */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
        <h3 className="font-semibold">📤 Atualizar via ZIP assinado</h3>
        <p className="text-xs text-zinc-500">
          1) Envie o ZIP + assinatura minisign → 2) confira o relatório →
          3) aprove → o serviço <code>updater</code> aplica com backup antes.
          ZIP sem assinatura válida é recusado.
        </p>
        <div className="flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Arquivo .zip</span>
            <input
              type="file" accept=".zip,application/zip"
              onChange={(e) => setZipFile(e.target.files?.[0] ?? null)}
              className="text-sm" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Assinatura minisign (conteúdo do .minisig)</span>
            <textarea
              value={signature} onChange={(e) => setSignature(e.target.value)}
              rows={3} placeholder={"untrusted comment: ...\n..."}
              className="font-mono text-xs rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent p-2" />
          </label>
          <div>
            <button
              onClick={() => {
                if (!zipFile) { setError("Escolha o arquivo .zip."); return; }
                const fd = new FormData();
                fd.set("zip", zipFile);
                fd.set("signature", signature);
                void run("upload", () => api("/api/admin/updates/upload", { method: "POST", body: fd }));
              }}
              disabled={busy !== ""}
              className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">
              {busy === "upload" ? "Enviando e validando…" : "📤 Enviar e validar"}
            </button>
          </div>
        </div>
        {report && (
          <div className="text-sm rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3 space-y-1">
            <p>Versão: <code className="font-mono font-bold">{report.version}</code> · {report.files} arquivos · {(report.bytes / 1024 / 1024).toFixed(1)} MB</p>
            {report.notes && <p>📝 {report.notes}</p>}
            <p>Migrações: {report.migrations.length ? report.migrations.join(", ") : "(nenhuma)"}</p>
            {report.irreversibleDb && (
              <p className="text-amber-600 font-medium">⚠️ Banco IRREVERSÍVEL: rollback futuro não desfaz a migração automaticamente.</p>
            )}
            {report.warnings.map((w, i) => <p key={i} className="text-amber-600">⚠️ {w}</p>)}
            {checks && (
              <div className="pt-1">
                <p className="font-medium">Verificações: {checks.passed ? "✅ passaram" : "❌ FALHARAM"}</p>
                {checks.checks.map((ch, i) => (
                  <p key={i} className="text-xs">{ch.ok ? "✅" : "❌"} {ch.name} — {ch.detail}</p>
                ))}
              </div>
            )}
            <div className="flex flex-wrap gap-2 pt-2">
              <button
                onClick={() => void run("test", () => post("/api/admin/updates/test-staging", { version: report.version }))}
                disabled={busy !== ""}
                title="Roda npm ci + testes dentro da nova versão (lento, opt-in no servidor)"
                className="px-3 py-1.5 rounded-lg bg-zinc-200 dark:bg-zinc-700 text-sm font-medium disabled:opacity-50">
                {busy === "test" ? "Testando…" : "🧪 Rodar testes no staging"}
              </button>
              <button
                onClick={() => {
                  if (confirmApply(report.version)) {
                    void run("approve", () => post("/api/admin/updates/approve", { version: report.version }));
                  }
                }}
                disabled={busy !== "" || !checks?.passed}
                title={checks?.passed ? "Enfileira para o updater aplicar" : "Verificações precisam passar"}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium disabled:opacity-50">
                {busy === "approve" ? "Aprovando…" : "🚀 Aprovar e aplicar"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ---- Instalado / manifesto ---- */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
        <h3 className="font-semibold">🔄 Versão e descoberta</h3>
        {!status ? (
          <p className="text-sm text-zinc-500">Carregando…</p>
        ) : (
          <div className="text-sm space-y-1">
            <p>Instalado: <code className="font-mono">{status.current}</code></p>
            {status.configured ? (
              <>
                <p>
                  Manifesto: {status.latest
                    ? <code className="font-mono">{status.latest}</code>
                    : <span className="text-zinc-500">(verifique agora)</span>}{" "}
                  {status.updateAvailable && <span className="text-amber-600 font-medium">⬆ nova versão anunciada!</span>}
                </p>
                {status.notes && <p className="text-zinc-600 dark:text-zinc-400">📝 {status.notes}</p>}
                {status.error && <p className="text-red-600 dark:text-red-400">⚠️ {status.error}</p>}
                <button
                  onClick={() => void run("check", () => post("/api/admin/updates/check", {}))}
                  disabled={busy !== ""}
                  className="px-3 py-1.5 rounded-lg bg-zinc-200 dark:bg-zinc-700 text-sm font-medium disabled:opacity-50">
                  {busy === "check" ? "Verificando…" : "🔍 Verificar manifesto"}
                </button>
              </>
            ) : (
              <p className="text-zinc-500 text-xs">Descoberta por manifesto desligada (sem UPDATES_MANIFEST_URL). O upload acima funciona sem ela.</p>
            )}
          </div>
        )}
      </div>

      {/* ---- Rollback ---- */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
        <h3 className="font-semibold">⏪ Reversão</h3>
        {releases.length === 0 ? (
          <p className="text-sm text-zinc-500">(nenhum snapshot guardado ainda — o primeiro é criado na próxima aplicação)</p>
        ) : (
          <div className="text-sm space-y-1">
            {releases.map((rel) => (
              <div key={rel.name} className="flex items-center gap-2 flex-wrap">
                <code className="font-mono text-xs">{rel.name}</code>
                <span className="text-zinc-500 text-xs">v{rel.version} · {rel.kind}</span>
                {rel.kind !== "current" && (
                  <button
                    onClick={() => {
                      if (confirmRollback(rel.name, false)) {
                        void run(`rb-${rel.name}`, () => post("/api/admin/updates/rollback", { target: rel.name }));
                      }
                    }}
                    disabled={busy !== ""}
                    className="px-2 py-0.5 rounded-lg bg-amber-500 text-white text-xs font-medium disabled:opacity-50">
                    {busy === `rb-${rel.name}` ? "Enfileirando…" : "⏪ Reverter para este"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ---- Histórico ---- */}
      <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
        <h3 className="font-semibold">📋 Histórico</h3>
        {history.length === 0 ? (
          <p className="text-sm text-zinc-500">(vazio)</p>
        ) : (
          <div className="text-xs space-y-1 max-h-48 overflow-y-auto">
            {history.map((h, i) => (
              <p key={i} className="font-mono break-words">
                {String(h.ts ?? "")} · {String(h.action ?? "")}
                {h.version ? ` · v${String(h.version)}` : ""}
                {h.ok === true ? " · ✅" : h.ok === false ? " · ❌" : ""}
              </p>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">⚠️ {error}</p>}
      {log && (
        <pre className="text-xs whitespace-pre-wrap rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 max-h-64 overflow-y-auto">{log}</pre>
      )}
    </div>
  );
}
