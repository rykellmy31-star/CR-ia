/**
 * CR IA — integração GitHub (módulo desenvolvedor, fase 1: somente leitura).
 * - Lista arquivos e lê conteúdo de repositórios AUTORIZADOS.
 * - Qualquer escrita (branch/commit/PR) gera proposta e exige aprovação explícita.
 * - Nunca toca em repositórios fora de GITHUB_ALLOWED_REPOS.
 */
import type { Env } from "../types.js";
import { csv } from "../lib/config.js";

export interface GithubFileEntry {
  path: string;
  type: "file" | "dir";
  size?: number;
  sha?: string;
}

function allowedRepos(env: Env): string[] {
  return csv(env.GITHUB_ALLOWED_REPOS);
}

export function assertRepoAllowed(env: Env, repo: string): void {
  const allowed = allowedRepos(env);
  if (!allowed.includes(repo)) {
    throw new Error(
      `Repositório "${repo}" NÃO autorizado. Autorizados: ${allowed.join(", ") || "(nenhum)"}.`
    );
  }
  if (!env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN não configurado. O administrador deve configurar o token no servidor.");
  }
}

async function gh(env: Env, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: init?.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "cr-ia/0.2",
      ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401) throw new Error("GitHub: token inválido ou expirado.");
  if (res.status === 403) throw new Error("GitHub: limite de requisições excedido ou sem permissão.");
  if (res.status === 404) throw new Error("GitHub: repositório ou caminho não encontrado.");
  if (res.status === 422) throw new Error(`GitHub: operação inválida: ${(await res.text()).slice(0, 300)}`);
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

export async function githubRepoInfo(env: Env, repo: string): Promise<Record<string, unknown>> {
  assertRepoAllowed(env, repo);
  return (await (await gh(env, `/repos/${repo}`)).json()) as Record<string, unknown>;
}

export async function githubListTree(env: Env, repo: string, branch = "main"): Promise<GithubFileEntry[]> {
  assertRepoAllowed(env, repo);
  let ref = branch;
  // Descobre o branch padrão se "main" não existir
  const info = await githubRepoInfo(env, repo);
  if (branch === "main" && typeof info.default_branch === "string") ref = info.default_branch;
  const res = await gh(env, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  const data = (await res.json()) as { tree?: { path?: string; type?: string; size?: number; sha?: string }[]; truncated?: boolean };
  return (data.tree ?? [])
    .filter((e) => e.path && (e.type === "blob" || e.type === "tree"))
    .slice(0, 2000)
    .map((e) => ({
      path: e.path!,
      type: e.type === "blob" ? "file" : "dir",
      size: e.size,
      sha: e.sha,
    }));
}

export async function githubReadFile(env: Env, repo: string, path: string, branch?: string): Promise<{ content: string; sha: string; truncated: boolean }> {
  assertRepoAllowed(env, repo);
  const q = branch ? `?ref=${encodeURIComponent(branch)}` : "";
  const res = await gh(env, `/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`);
  const data = (await res.json()) as { content?: string; encoding?: string; sha?: string; size?: number };
  if (data.encoding !== "base64" || !data.content) throw new Error("GitHub: conteúdo não textual ou indisponível.");
  const binary = atob(data.content.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  let text = new TextDecoder().decode(bytes);
  const truncated = text.length > 60000;
  if (truncated) text = text.slice(0, 60000);
  return { content: text, sha: data.sha ?? "", truncated };
}

export async function githubListActionsRuns(env: Env, repo: string): Promise<Record<string, unknown>[]> {
  assertRepoAllowed(env, repo);
  const res = await gh(env, `/repos/${repo}/actions/runs?per_page=10`);
  const data = (await res.json()) as { workflow_runs?: Record<string, unknown>[]; message?: string };
  if (!data.workflow_runs) throw new Error(`GitHub Actions indisponível: ${data.message ?? "sem acesso"}`);
  return data.workflow_runs;
}

export interface GithubPullSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  branch: string;
  createdAt: string;
  url: string;
}

export interface GithubCreatedPull {
  number: number;
  url: string;
  headSha: string;
}

/**
 * Cria um PR de verdade. Só deve ser chamado após aprovação explícita
 * (o agente garante isso na fase "pr"). Nunca aponta para fora do repo.
 */
export async function githubCreatePull(
  env: Env, repo: string, input: { title: string; body: string; head: string; base: string }
): Promise<GithubCreatedPull> {
  assertRepoAllowed(env, repo);
  if (!input.head || input.head === input.base) {
    throw new Error("GitHub: branch de origem inválida para o PR.");
  }
  const res = await gh(env, `/repos/${repo}/pulls`, { method: "POST", body: input });
  const data = (await res.json()) as { number?: number; html_url?: string; head?: { sha?: string } };
  return { number: data.number ?? 0, url: data.html_url ?? "", headSha: data.head?.sha ?? "" };
}

export interface GithubCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

/** Checks + status combinados de um commit (resultado do Actions). */
export async function githubCommitChecks(env: Env, repo: string, sha: string): Promise<GithubCheck[]> {
  assertRepoAllowed(env, repo);
  const out: GithubCheck[] = [];
  const combined = (await (await gh(env, `/repos/${repo}/commits/${sha}/status`)).json()) as {
    statuses?: { context?: string; state?: string; target_url?: string }[];
  };
  for (const s of combined.statuses ?? []) {
    out.push({ name: s.context ?? "status", status: "completed", conclusion: s.state ?? null, url: s.target_url ?? null });
  }
  const runs = (await (await gh(env, `/repos/${repo}/commits/${sha}/check-runs`)).json()) as {
    check_runs?: { name?: string; status?: string; conclusion?: string | null; html_url?: string }[];
  };
  for (const r of runs.check_runs ?? []) {
    out.push({ name: r.name ?? "check", status: r.status ?? "", conclusion: r.conclusion ?? null, url: r.html_url ?? null });
  }
  return out;
}

/** Merge de PR. Só chamado após aprovação "merge" explícita do admin. */
export async function githubMergePull(
  env: Env, repo: string, prNumber: number, method: "merge" | "squash" = "merge"
): Promise<{ merged: boolean; message: string }> {
  assertRepoAllowed(env, repo);
  const res = await gh(env, `/repos/${repo}/pulls/${prNumber}/merge`, {
    method: "PUT", body: { merge_method: method },
  });
  const data = (await res.json()) as { merged?: boolean; message?: string };
  return { merged: Boolean(data.merged), message: data.message ?? "" };
}

export async function githubListPulls(env: Env, repo: string, state: "open" | "closed" | "all" = "open"): Promise<GithubPullSummary[]> {
  assertRepoAllowed(env, repo);
  const res = await gh(env, `/repos/${repo}/pulls?state=${state}&per_page=10&sort=updated&direction=desc`);
  const data = (await res.json()) as {
    number?: number; title?: string; state?: string;
    user?: { login?: string }; head?: { ref?: string };
    created_at?: string; html_url?: string;
  }[];
  if (!Array.isArray(data)) throw new Error("GitHub: resposta inesperada ao listar PRs.");
  return data.map((pr) => ({
    number: pr.number ?? 0,
    title: pr.title ?? "",
    state: pr.state ?? "",
    author: pr.user?.login ?? "",
    branch: pr.head?.ref ?? "",
    createdAt: pr.created_at ?? "",
    url: pr.html_url ?? "",
  }));
}
