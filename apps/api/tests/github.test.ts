/**
 * Cliente GitHub (§5): contrato HTTP (URLs, métodos, headers, erros).
 * Rede = stub; GitHub real só na VPS com token do dono (não homologado aqui).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRepoAllowed, githubCommitChecks, githubCreatePull, githubListActionsRuns,
  githubListTree, githubMergePull, githubReadFile, githubRepoInfo,
} from "../src/services/github.js";
import type { Env } from "../src/types.js";

const env: Env = { GITHUB_TOKEN: "tok-test", GITHUB_ALLOWED_REPOS: "dono/repo-a" } as Env;
const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];

function stubFetch(responses: Array<{ status: number; json?: unknown; text?: string }>) {
  let i = 0;
  calls.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined, auth: headers.get("authorization") ?? undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), {
      status: r.status, headers: { "content-type": "application/json" },
    });
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("assertRepoAllowed", () => {
  it("autoriza allowlist, recusa fora e sem token", () => {
    expect(() => assertRepoAllowed(env, "dono/repo-a")).not.toThrow();
    expect(() => assertRepoAllowed(env, "evil/x")).toThrow(/NÃO autorizado/);
    expect(() => assertRepoAllowed({ ...env, GITHUB_TOKEN: "" }, "dono/repo-a")).toThrow(/GITHUB_TOKEN/);
  });
});

describe("leitura", () => {
  it("repoInfo/tree/read/actions: GET correto + parse + auth", async () => {
    stubFetch([{ status: 200, json: { default_branch: "main" } }]);
    expect(((await githubRepoInfo(env, "dono/repo-a")) as { default_branch: string }).default_branch).toBe("main");
    expect(calls[0].url).toBe("https://api.github.com/repos/dono/repo-a");
    expect(calls[0].auth).toBe("Bearer tok-test");

    // tree: 1ª chamada descobre o branch padrão, 2ª lista a árvore.
    // Branch explícito ("dev") é respeitado; "main" cai no default_branch.
    stubFetch([
      { status: 200, json: { default_branch: "main" } },
      { status: 200, json: { tree: [{ path: "a.ts", type: "blob", size: 10, sha: "s" }] } },
    ]);
    const tree = await githubListTree(env, "dono/repo-a", "dev");
    expect(tree).toEqual([{ path: "a.ts", type: "file", size: 10, sha: "s" }]);
    expect(calls[1].url).toContain("git/trees/dev");

    stubFetch([
      { status: 200, json: { default_branch: "trunk" } },
      { status: 200, json: { tree: [] } },
    ]);
    await githubListTree(env, "dono/repo-a"); // "main" → resolve para o padrão real
    expect(calls[1].url).toContain("git/trees/trunk");

    const b64 = Buffer.from("conteúdo").toString("base64");
    stubFetch([{ status: 200, json: { content: b64, encoding: "base64", sha: "s2" } }]);
    const f = await githubReadFile(env, "dono/repo-a", "a.ts");
    expect(f.content).toBe("conteúdo");
    expect(calls[0].url).toContain("/contents/a.ts");

    stubFetch([{ status: 200, json: { workflow_runs: [{ id: 1 }] } }]);
    expect((await githubListActionsRuns(env, "dono/repo-a")).length).toBe(1);
  });
});

describe("escrita (PR/checks/merge)", () => {
  it("createPull: POST com head/base + parse", async () => {
    stubFetch([{ status: 201, json: { html_url: "https://github.com/dono/repo-a/pull/7", number: 7, head: { sha: "abc" } } }]);
    const pr = await githubCreatePull(env, "dono/repo-a", { title: "t", body: "b", head: "cr-ia/x", base: "main" });
    expect(pr).toEqual({ url: "https://github.com/dono/repo-a/pull/7", number: 7, headSha: "abc" });
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(calls[0].body!).head).toBe("cr-ia/x");
  });

  it("recusa head vazia ou igual à base (sem chamar a rede)", async () => {
    stubFetch([{ status: 201, json: {} }]);
    await expect(githubCreatePull(env, "dono/repo-a", { title: "t", body: "", head: "main", base: "main" }))
      .rejects.toThrow(/origem inválida/);
    expect(calls.length).toBe(0);
  });

  it("commitChecks agrega statuses + check-runs", async () => {
    stubFetch([
      { status: 200, json: { statuses: [{ context: "lint", state: "failure", target_url: "u1" }] } },
      { status: 200, json: { check_runs: [{ name: "build", status: "completed", conclusion: "success", html_url: "u2" }] } },
    ]);
    const checks = await githubCommitChecks(env, "dono/repo-a", "abc123");
    expect(calls[0].url).toContain("/commits/abc123/status");
    expect(calls[1].url).toContain("/commits/abc123/check-runs");
    expect(checks.length).toBe(2);
    expect(checks[0]).toMatchObject({ name: "lint", conclusion: "failure" });
    expect(checks[1]).toMatchObject({ name: "build", conclusion: "success" });
  });

  it("mergePull: PUT + mensagens honestas", async () => {
    stubFetch([{ status: 200, json: { merged: true, message: "ok" } }]);
    expect(await githubMergePull(env, "dono/repo-a", 7, "merge")).toEqual({ merged: true, message: "ok" });
    expect(calls[0].method).toBe("PUT");
  });
});

describe("erros honestos", () => {
  it("401/404/422 viram mensagens claras", async () => {
    stubFetch([{ status: 401, text: "x" }]);
    await expect(githubRepoInfo(env, "dono/repo-a")).rejects.toThrow(/inválido ou expirado/);
    stubFetch([{ status: 404, text: "x" }]);
    await expect(githubRepoInfo(env, "dono/repo-a")).rejects.toThrow(/não encontrado/);
    stubFetch([{ status: 422, text: "no commits" }]);
    await expect(githubCreatePull(env, "dono/repo-a", { title: "t", body: "", head: "h", base: "b" })).rejects.toThrow(/inválida/);
  });
});
