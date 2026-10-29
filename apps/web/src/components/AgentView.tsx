/** Agente desenvolvedor: criar execuções, acompanhar fases/logs e aprovar. */
import { useEffect, useState } from "react";
import type { AgentApprovalKind, AgentRun } from "@cr-ia/shared";
import { ApiError, api, post } from "../lib/api";

interface Policy {
  allowedRepos: string[];
  approvalsAlwaysRequired: boolean;
  protectedBranches: string[];
  maxParallel: number;
  timeoutMin: number;
  runnable: boolean;
  engine: string;
  isolationDetail: string;
  disabledReason: string;
}

const PHASE_LABELS: Record<string, string> = {
  validate: "1️⃣ Validar", clone: "2️⃣ Clonar", analyze: "3️⃣ Analisar", plan: "4️⃣ Planejar",
  edit: "5️⃣ Editar", test: "6️⃣ Testar", commit: "7️⃣ Commit", push: "8️⃣ Push ⏸️",
  pr: "9️⃣ Abrir PR ⏸️", checks: "🔟 Checks", merge: "1️⃣1️⃣ Merge ⏸️", done: "✅ Fim",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "⏳ na fila", running: "▶️ executando", awaiting_approval: "⏸️ aguardando aprovação",
  done: "✅ concluído", failed: "❌ falhou", cancelled: "🚫 cancelado",
};

export function AgentView({ isAdmin, onOpenSidebar }: { isAdmin: boolean; onOpenSidebar: () => void }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [selected, setSelected] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // formulário
  const [repo, setRepo] = useState("");
  const [goal, setGoal] = useState("");
  const [commands, setCommands] = useState("");
  const [patch, setPatch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [indexMsg, setIndexMsg] = useState("");

  const indexCode = async (run: AgentRun) => {
    setBusy(true);
    setError("");
    setIndexMsg("");
    try {
      const r = await api<{ repo: string; files: number; chunks: number; semantic: boolean }>(
        "/api/ai/code/index", { method: "POST", body: JSON.stringify({ runId: run.id }) }
      );
      setIndexMsg(`✅ ${r.files} arquivo(s), ${r.chunks} trecho(s) indexados${r.semantic ? " (busca semântica)" : " (palavra-chave)"}. Busque na aba Código.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao indexar código.");
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    try {
      const [pol, list] = await Promise.all([
        api<Policy>("/api/agent/policy"),
        api<{ runs: AgentRun[] }>("/api/agent/runs"),
      ]);
      setPolicy(pol);
      setRuns(list.runs);
      if (!repo && pol.allowedRepos.length) setRepo(pol.allowedRepos[0]);
      if (selected) {
        const still = list.runs.find((r) => r.id === selected.id);
        if (still) setSelected(still);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Falha ao carregar agente.");
    }
  };

  useEffect(() => { void refresh(); }, []);
  // Auto-atualiza enquanto houver execução ativa
  useEffect(() => {
    if (!runs.some((r) => r.status === "running" || r.status === "pending")) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [runs]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const cmds = commands.split("\n").map((c) => c.trim()).filter(Boolean);
      const r = await post<{ run: AgentRun }>("/api/agent/runs", {
        repo, goal, commands: cmds, patch: patch.trim() || undefined,
      });
      setShowForm(false);
      setGoal("");
      setCommands("");
      setPatch("");
      setSelected(r.run);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao criar execução.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (run: AgentRun, kind: AgentApprovalKind) => {
    if (!confirm(`Aprovar "${kind}" na execução ${run.id}?\nRepo: ${run.repo}\nBranch: ${run.workBranch}`)) return;
    setBusy(true);
    try {
      const r = await post<{ run: AgentRun }>(`/api/agent/runs/${run.id}/approve`, { kind });
      setSelected(r.run);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao aprovar.");
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (run: AgentRun) => {
    if (!confirm("Cancelar esta execução? O trabalho não enviado é descartado.")) return;
    setBusy(true);
    try {
      await post(`/api/agent/runs/${run.id}/cancel`, {});
      setSelected(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha ao cancelar.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-zinc-200 dark:border-zinc-800">
        <button onClick={onOpenSidebar} className="md:hidden text-xl px-1">☰</button>
        <h2 className="font-semibold text-sm flex-1">🛠️ Agente desenvolvedor</h2>
        <button onClick={() => setShowForm(!showForm)} disabled={policy !== null && !policy.runnable}
          className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-40"
          title={policy && !policy.runnable ? policy.disabledReason : undefined}>
          {showForm ? "Fechar" : "＋ Nova execução"}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto p-3">
        <div className="max-w-5xl mx-auto space-y-3">
          {error && <p className="text-sm text-red-600">⚠️ {error}</p>}
          {policy && !policy.runnable && (
            <p className="text-sm rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2">
              🚫 <strong>Agente desativado:</strong> {policy.disabledReason || "sem ambiente de execução isolado."}
            </p>
          )}
          {policy?.runnable && (
            <p className="text-xs text-zinc-500">⚙️ Motor: {policy.engine} ({policy.isolationDetail}).</p>
          )}
          <p className="text-xs text-zinc-500">
            O agente trabalha num clone isolado (nunca no app, nunca direto na main).
            Push, PR e merge <strong>exigem sua aprovação</strong> — sem exceção.
            {policy && <> Limite: {policy.maxParallel} por vez · timeout {policy.timeoutMin} min.</>}
          </p>

          {showForm && (
            <form onSubmit={create} className="rounded-2xl border border-indigo-300 dark:border-indigo-800 bg-indigo-50/50 dark:bg-indigo-950/20 p-3 space-y-2">
              <div>
                <label className="text-xs font-semibold">Repositório autorizado</label>
                <select value={repo} onChange={(e) => setRepo(e.target.value)} required
                  className="w-full rounded-lg border px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700">
                  {(policy?.allowedRepos ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold">Tarefa (mín. 10 caracteres)</label>
                <textarea value={goal} onChange={(e) => setGoal(e.target.value)} required minLength={10} rows={2}
                  placeholder="Ex.: corrigir o cálculo de horas extras no fechamento mensal e rodar os testes"
                  className="w-full rounded-lg border px-2 py-1.5 text-sm bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700" />
              </div>
              <div>
                <label className="text-xs font-semibold">Comandos de teste (1 por linha, opcional)</label>
                <textarea value={commands} onChange={(e) => setCommands(e.target.value)} rows={2}
                  placeholder={"npm test\nnpx tsc --noEmit"}
                  className="w-full rounded-lg border px-2 py-1.5 text-sm font-mono bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700" />
                <p className="text-[11px] text-zinc-500">Só comandos de teste/build da allowlist. Vazio = o agente detecta (npm test, pytest…).</p>
              </div>
              <div>
                <label className="text-xs font-semibold">Patch unificado (opcional — diff que o agente aplica e testa)</label>
                <textarea value={patch} onChange={(e) => setPatch(e.target.value)} rows={4}
                  placeholder={"diff --git a/arquivo.js b/arquivo.js\n--- a/arquivo.js\n+++ b/arquivo.js\n@@ ..."}
                  className="w-full rounded-lg border px-2 py-1.5 text-xs font-mono bg-white dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700" />
              </div>
              <button disabled={busy} className="rounded-lg bg-indigo-600 text-white text-sm font-semibold px-4 py-2 disabled:opacity-50">
                {busy ? "Criando…" : "▶ Iniciar execução"}
              </button>
            </form>
          )}

          <div className="grid md:grid-cols-2 gap-2">
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-zinc-500">EXECUÇÕES</h3>
              {runs.map((r) => (
                <button key={r.id} onClick={() => setSelected(r)}
                  className={`w-full text-left rounded-xl border p-2 text-sm ${selected?.id === r.id ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30" : "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900"}`}>
                  <div className="font-medium truncate">{r.goal}</div>
                  <div className="text-[11px] text-zinc-500">{r.repo} · {r.workBranch}</div>
                  <div className="text-[11px] mt-1">{STATUS_LABEL[r.status]} · fase {PHASE_LABELS[r.currentPhase] ?? r.currentPhase}</div>
                </button>
              ))}
              {runs.length === 0 && <p className="text-sm text-zinc-500">Nenhuma execução ainda.</p>}
            </div>

            <div>
              <h3 className="text-xs font-semibold text-zinc-500">DETALHE</h3>
              {!selected ? (
                <p className="text-sm text-zinc-500 mt-2">Selecione uma execução para ver fases, logs e aprovações.</p>
              ) : (
                <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 mt-1 space-y-2">
                  <div className="text-sm font-medium">{selected.goal}</div>
                  <div className="text-[11px] text-zinc-500">
                    {selected.repo} · {selected.baseBranch} → {selected.workBranch} ·
                    {" "}{new Date(selected.createdAt).toLocaleString("pt-BR")}
                  </div>
                  <div className="text-sm">{STATUS_LABEL[selected.status]}</div>
                  {selected.prUrl && (
                    <a href={selected.prUrl} target="_blank" rel="noreferrer" className="text-sm text-indigo-600 hover:underline">
                      🔗 {selected.prUrl}
                    </a>
                  )}
                  {selected.error && <p className="text-xs text-red-600">❌ {selected.error}</p>}
                  {selected.result && <p className="text-xs text-emerald-700 dark:text-emerald-300">✅ {selected.result}</p>}
                  {(selected.status === "done" || selected.status === "awaiting_approval") && (
                    <div>
                      <button disabled={busy} onClick={() => void indexCode(selected)}
                        className="rounded-lg border border-indigo-300 text-indigo-700 dark:text-indigo-300 text-xs font-semibold px-3 py-1.5 disabled:opacity-50">
                        💻 Indexar código deste run
                      </button>
                      {indexMsg && <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">{indexMsg}</p>}
                    </div>
                  )}
                  {selected.checks.length > 0 && (
                    <div className="text-xs">
                      <span className="font-semibold">Checks:</span>
                      {selected.checks.map((ch, i) => (
                        <div key={i}>• {ch.name}: {ch.conclusion ?? ch.status}</div>
                      ))}
                    </div>
                  )}
                  {/* Aprovações pendentes */}
                  {selected.status === "awaiting_approval" && selected.steps.some((s) => s.awaitingApproval) && (
                    <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 p-2">
                      <div className="text-xs font-semibold mb-1">⏸️ Aguardando sua aprovação:</div>
                      {selected.steps.filter((s) => s.awaitingApproval).map((s) => (
                        <div key={s.phase} className="flex items-center gap-2 text-sm">
                          <span className="flex-1">Fase {PHASE_LABELS[s.phase]} — aprovar <strong>{s.awaitingApproval}</strong>?</span>
                          {isAdmin ? (
                            <button disabled={busy} onClick={() => void approve(selected, s.awaitingApproval!)}
                              className="rounded-lg bg-emerald-600 text-white text-xs font-semibold px-3 py-1 disabled:opacity-50">
                              Aprovar
                            </button>
                          ) : (
                            <span className="text-xs text-zinc-500">(só o admin aprova)</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Fases + logs */}
                  <div className="space-y-1">
                    {selected.steps.map((s) => (
                      <details key={s.phase} className="text-xs rounded-lg bg-zinc-50 dark:bg-black/30 p-2">
                        <summary className="cursor-pointer font-medium">
                          {s.status === "done" ? "✅" : s.status === "failed" ? "❌" : s.status === "skipped" ? "⏭️" : "▶️"}{" "}
                          {PHASE_LABELS[s.phase] ?? s.phase}
                        </summary>
                        <pre className="whitespace-pre-wrap max-h-48 overflow-y-auto mt-1 text-[11px]">{s.log || "(sem log)"}</pre>
                      </details>
                    ))}
                  </div>
                  {(selected.status === "pending" || selected.status === "running" || selected.status === "awaiting_approval") && (
                    <button disabled={busy} onClick={() => void cancel(selected)}
                      className="text-xs text-red-600 hover:underline disabled:opacity-50">
                      🚫 Cancelar execução
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
