/**
 * Item 5 — gate fail-closed do agente (agentRunnable): SEM isolamento
 * comprovado (docker OU flag explícita de host fora de produção), o
 * agente NÃO executa nada. (Allowlist/token moram no assertAgentRepo.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { __clearRunnableCache, agentRunnable } from "../src/services/agent.js";
import type { Env } from "../src/types.js";

const base: Env = {
  NODE_ENV: "test",
  AGENT_RUNNER: "auto",
  GITHUB_TOKEN: "K-TESTE-12345",
  GITHUB_ALLOWED_REPOS: "owner/repo",
};
const noDocker = async () => false;
const yesDocker = async () => true;

beforeEach(() => __clearRunnableCache());

describe("agentRunnable (fail-closed, só isolamento)", () => {
  it("host sem flag explícita: bloqueado", async () => {
    const r = await agentRunnable({ ...base, AGENT_RUNNER: "host" }, noDocker);
    expect(r.runnable).toBe(false);
    expect(r.engine).toBe("none");
    expect(r.reason).toMatch(/AGENT_ALLOW_HOST_EXEC/);
  });

  it("host + flag em dev/teste: executável (sem isolamento)", async () => {
    const r = await agentRunnable(
      { ...base, AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true" }, noDocker,
    );
    expect(r.runnable).toBe(true);
    expect(r.engine).toBe("host");
    expect(r.detail).toMatch(/SEM isolamento/);
  });

  it("host + flag em PRODUÇÃO: bloqueado", async () => {
    const r = await agentRunnable(
      { ...base, NODE_ENV: "production", AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true" },
      noDocker,
    );
    expect(r.runnable).toBe(false);
    expect(r.reason).toMatch(/PROIBIDA em produção/);
  });

  it("docker sem Docker: bloqueado com instrução", async () => {
    const r = await agentRunnable({ ...base, AGENT_RUNNER: "docker" }, noDocker);
    expect(r.runnable).toBe(false);
    expect(r.reason).toMatch(/Docker indisponível/);
  });

  it("docker com Docker: executável isolado", async () => {
    const r = await agentRunnable({ ...base, AGENT_RUNNER: "docker" }, yesDocker);
    expect(r.runnable).toBe(true);
    expect(r.engine).toBe("docker");
  });

  it("auto sem docker e sem flag de host: bloqueado", async () => {
    const r = await agentRunnable({ ...base, AGENT_RUNNER: "auto" }, noDocker);
    expect(r.runnable).toBe(false);
    expect(r.reason).toMatch(/Sem Docker e sem permissão/);
  });

  it("auto com docker: executável isolado", async () => {
    const r = await agentRunnable({ ...base, AGENT_RUNNER: "auto" }, yesDocker);
    expect(r.runnable).toBe(true);
    expect(r.engine).toBe("docker");
  });

  it("auto sem docker mas com flag de host (dev): fallback de host honesto", async () => {
    const r = await agentRunnable(
      { ...base, AGENT_RUNNER: "auto", AGENT_ALLOW_HOST_EXEC: "true" }, noDocker,
    );
    expect(r.runnable).toBe(true);
    expect(r.engine).toBe("host");
    expect(r.detail).toMatch(/fallback/);
  });

  it("sonda de Docker é cacheada por 60s", async () => {
    const check = vi.fn(async () => true);
    await agentRunnable({ ...base, AGENT_RUNNER: "docker" }, check);
    await agentRunnable({ ...base, AGENT_RUNNER: "docker" }, check);
    expect(check).toHaveBeenCalledTimes(1);
  });
});
