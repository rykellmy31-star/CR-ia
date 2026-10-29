/**
 * CR IA — executor de tarefas (usado pelo worker da VPS e pelo consumer da fila CF).
 * Cada tipo executa de forma real e registra resultado/erro no banco.
 * Operações sensíveis (GitHub escrita, produção, custos) exigem aprovação.
 */
import { IMAGE_DIMENSIONS } from "@cr-ia/shared";
import type { AgentTask } from "@cr-ia/shared";
import type { Env } from "../types.js";
import type { DbAdapter } from "../adapters/db/types.js";
import type { StorageAdapter } from "../adapters/storage/types.js";
import { ModelRegistry } from "../adapters/ai/registry.js";
import { githubListTree, githubReadFile, githubRepoInfo } from "./github.js";
import { advanceAgentRun, RequeueError } from "./agent.js";
import { nowIso, uid } from "../lib/ids.js";
import { getBool } from "../lib/config.js";

export interface RunnerDeps {
  env: Env;
  db: DbAdapter;
  storage: StorageAdapter;
  models: ModelRegistry;
}

export async function executeTask(deps: RunnerDeps, task: AgentTask): Promise<void> {
  const { db } = deps;
  try {
    switch (task.type) {
      case "echo": {
        await db.updateTask(task.id, {
          status: "done",
          result: { echo: task.payload, executedAt: nowIso() },
        });
        break;
      }
      case "chat": {
        const prompt = String(task.payload.prompt ?? "");
        if (!prompt) throw new Error("payload.prompt ausente.");
        const modelId = await deps.models.autoSelectText("chat");
        const adapter = deps.models.findTextAdapter(modelId);
        if (!adapter) throw new Error("Nenhum modelo de texto disponível.");
        const result = await adapter.chat({ model: modelId, messages: [{ role: "user", content: prompt }] });
        await db.logUsage({
          userId: task.userId, modelId, kind: "chat",
          tokensIn: result.tokensIn, tokensOut: result.tokensOut, costFlag: result.paid,
        });
        await db.updateTask(task.id, { status: "done", result: { model: modelId, text: result.text } });
        break;
      }
      case "image-batch": {
        const prompts = task.payload.prompts as string[];
        const format = (task.payload.format as keyof typeof IMAGE_DIMENSIONS) ?? "1:1";
        const dims = IMAGE_DIMENSIONS[format] ?? IMAGE_DIMENSIONS["1:1"];
        const modelId = await deps.models.autoSelectImage();
        const adapter = deps.models.findImageAdapter(modelId);
        if (!adapter) throw new Error("Nenhum modelo de imagem disponível.");
        const images: unknown[] = [];
        for (const [i, prompt] of prompts.entries()) {
          const gen = await adapter.generate({
            model: modelId, prompt: String(prompt), format,
            width: dims.w, height: dims.h, seed: i,
          });
          const ext = gen.mime === "image/svg+xml" ? "svg" : "jpg";
          const fileId = uid("fil");
          const key = `images/${task.userId}/${fileId}.${ext}`;
          await deps.storage.put(key, gen.data, gen.mime);
          const file = await db.saveFile({
            id: fileId, userId: task.userId, name: `lote-${Date.now()}-${i}.${ext}`,
            mime: gen.mime, size: gen.data.byteLength, url: deps.storage.urlFor(key), createdAt: nowIso(),
          });
          const image = await db.saveImage({
            id: uid("img"), userId: task.userId, prompt: String(prompt),
            format, modelId, fileId: file.id, url: file.url,
            width: dims.w, height: dims.h, createdAt: nowIso(),
          });
          images.push({ id: image.id, url: image.url });
        }
        await db.logUsage({
          userId: task.userId, modelId, kind: "image",
          tokensIn: 0, tokensOut: 0, costFlag: false,
        });
        await db.updateTask(task.id, { status: "done", result: { model: modelId, images } });
        break;
      }
      case "github-inspect": {
        const repo = String(task.payload.repo ?? "");
        const [info, tree] = await Promise.all([
          githubRepoInfo(deps.env, repo),
          githubListTree(deps.env, repo),
        ]);
        const files = tree.filter((t) => t.type === "file").slice(0, 500);
        // Lê arquivos-chave para entender a arquitetura (somente leitura)
        const keyNames = ["package.json", "README.md", "pyproject.toml", "requirements.txt", "Dockerfile", "docker-compose.yml", "composer.json", "pom.xml", "go.mod", "Gemfile"];
        const keyFiles: Record<string, string> = {};
        for (const f of files) {
          const base = f.path.split("/").pop() ?? "";
          if (keyNames.includes(base)) {
            try {
              const read = await githubReadFile(deps.env, repo, f.path);
              keyFiles[f.path] = read.content.slice(0, 4000);
            } catch { /* segue sem o arquivo */ }
          }
        }
        await db.updateTask(task.id, {
          status: "done",
          result: {
            repo,
            language: info.language,
            defaultBranch: info.default_branch,
            totalFiles: files.length,
            sample: files.slice(0, 100).map((f) => f.path),
            keyFiles,
            inspectedAt: nowIso(),
          },
        });
        break;
      }
      case "github-fix-proposal": {
        // Fase 1: gera PROPOSTA de correção (diff/plan) e aguarda aprovação.
        // Nenhuma escrita é executada sem POST /tasks/:id/approve.
        const repo = String(task.payload.repo ?? "");
        const issue = String(task.payload.issue ?? "");
        if (!issue) throw new Error("payload.issue ausente: descreva o problema a corrigir.");
        if (task.payload.approved === true || getBool({ env: deps.env }, "GITHUB_REQUIRE_APPROVAL", true) === false) {
          // Caminho de execução pós-aprovação (fase 2 implementa PR real).
          // Por segurança, a fase 1 registra que a execução real está pendente.
          await db.updateTask(task.id, {
            status: "failed",
            error: "Execução de escrita no GitHub (branch/commit/PR) será liberada na fase 2. Proposta aprovada registrada na auditoria.",
          });
          await db.logAudit({ userId: task.userId, action: "github.fix.approved_pending_phase2", detail: `${repo} :: ${issue.slice(0, 200)}` });
          break;
        }
        const [info, tree] = await Promise.all([
          githubRepoInfo(deps.env, repo),
          githubListTree(deps.env, repo),
        ]);
        const files = tree.filter((t) => t.type === "file").map((f) => f.path);
        // Heurística: ranqueia arquivos provavelmente relacionados ao problema
        const keywords = issue.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
        const candidates = files
          .map((p) => ({ path: p, score: keywords.filter((k) => p.toLowerCase().includes(k)).length }))
          .filter((c) => c.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 15)
          .map((c) => c.path);

        // v0.1.1: lê os 3 melhores candidatos e pede ao modelo uma SUGESTÃO de
        // patch (texto). Continua 100% somente-leitura: nada é escrito no repo.
        const excerpts: Record<string, string> = {};
        for (const p of candidates.slice(0, 3)) {
          try {
            const read = await githubReadFile(deps.env, repo, p);
            excerpts[p] = read.content.slice(0, 3000);
          } catch { /* segue sem o trecho */ }
        }
        let patchSuggestion: string | null = null;
        let patchModel: string | null = null;
        if (Object.keys(excerpts).length > 0) {
          try {
            patchModel = await deps.models.autoSelectText("code");
            const adapter = deps.models.findTextAdapter(patchModel);
            if (adapter) {
              const context = Object.entries(excerpts)
                .map(([p, code]) => `--- ${p} ---\n${code}`)
                .join("\n\n");
              const suggestion = await adapter.chat({
                model: patchModel,
                messages: [{
                  role: "user",
                  content:
                    `Você é um revisor de código sênior. Repositório ${repo} (${String(info.language ?? "linguagem?")}).\n` +
                    `Problema relatado: "${issue}"\n\nTrechos de código:\n${context}\n\n` +
                    `Responda em português, curto e direto:\n` +
                    `1) Causa provável (1-3 frases).\n` +
                    `2) Sugestão de correção em formato de diff unificado (apenas os trechos alterados).\n` +
                    `3) Como testar a correção (1-3 passos).`,
                }],
                maxTokens: 1500,
              });
              patchSuggestion = suggestion.text;
              await db.logUsage({
                userId: task.userId, modelId: patchModel, kind: "chat",
                tokensIn: suggestion.tokensIn, tokensOut: suggestion.tokensOut, costFlag: false,
              });
            }
          } catch (e) {
            patchSuggestion = `Não foi possível gerar a sugestão automática: ${e instanceof Error ? e.message : "erro"}`;
          }
        }
        await db.updateTask(task.id, {
          status: "awaiting_approval",
          result: {
            repo,
            issue,
            language: info.language,
            candidateFiles: candidates,
            excerpts,
            patchSuggestion,
            patchModel,
            plan: [
              "1. Revise os arquivos candidatos e a sugestão de patch acima.",
              "2. Aprove para autorizar a próxima etapa (na v0.1.x, a escrita real — branch/commit/PR — ainda é registrada como pendente de implementação).",
              "3. Futuro: criação de branch, commit, PR e acompanhamento do Actions.",
            ],
            note: "NENHUMA alteração foi feita no repositório. Tudo acima é análise + sugestão.",
            proposedAt: nowIso(),
          },
        });
        break;
      }
      case "agent-run": {
        const runId = String(task.payload.runId ?? "");
        if (!runId) throw new Error("payload.runId ausente.");
        let outcome: { status: string; paused: boolean };
        try {
          outcome = await advanceAgentRun({ env: deps.env, db, models: deps.models }, runId);
        } catch (e) {
          if (e instanceof RequeueError) {
            // Outro agente rodando: tenta de novo em 1 min, sem gastar tentativa.
            await db.updateTask(task.id, {
              status: "pending",
              error: e.message,
              attempts: Math.max(0, (task.attempts ?? 1) - 1),
              runAfter: new Date(Date.now() + 60_000).toISOString(),
            });
            await db.logAudit({ userId: task.userId, action: "agent.requeued", detail: `${runId} :: ${e.message}` });
            return;
          }
          throw e;
        }
        const run = await db.getAgentRun(runId);
        if (outcome.status === "awaiting_approval") {
          await db.updateTask(task.id, { status: "awaiting_approval", result: { runId, phase: run?.currentPhase ?? null } });
        } else if (outcome.status === "done") {
          await db.updateTask(task.id, { status: "done", result: { runId, prUrl: run?.prUrl ?? null, summary: run?.result ?? null } });
        } else if (outcome.status === "failed" || outcome.status === "cancelled") {
          await db.updateTask(task.id, { status: "failed", error: run?.error ?? "Agente falhou." });
        } else {
          // Ainda rodando (não deveria sobrar, mas garante continuidade)
          await db.updateTask(task.id, { status: "pending" });
        }
        break;
      }
      default:
        throw new Error(`Tipo de tarefa desconhecido: ${String((task as AgentTask).type)}`);
    }
    await db.logAudit({ userId: task.userId, action: "task.done", detail: `${task.id} ${task.type}` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Erro desconhecido";
    const attempts = task.attempts ?? 1;
    const max = task.maxAttempts ?? 3;
    if (attempts < max && task.status === "running") {
      // Reenfileira para nova tentativa (retomada após falha transitória)
      await db.updateTask(task.id, { status: "pending", error: `Tentativa ${attempts}/${max} falhou: ${msg}` });
    } else {
      await db.updateTask(task.id, { status: "failed", error: msg });
    }
    await db.logAudit({ userId: task.userId, action: "task.failed", detail: `${task.id} :: ${msg.slice(0, 300)}` });
  }
}

/** Processa a próxima tarefa pendente (retorna false quando não há nada). */
export async function processNext(deps: RunnerDeps): Promise<boolean> {
  const task = await deps.db.claimNextTask(nowIso());
  if (!task) return false;
  await executeTask(deps, task);
  return true;
}
