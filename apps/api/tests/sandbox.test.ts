/**
 * Sandbox de testes do agente (item 3): contêiner descartável com UM volume,
 * sem segredos, com tetos — e recusa honesta sem docker/host permitido.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDockerArgs, dockerAvailable, runUserCommand, selectSandboxImage,
} from "../src/services/sandbox.js";
import type { Env } from "../src/types.js";

const baseEnv: Env = { NODE_ENV: "test" };

describe("selectSandboxImage", () => {
  it("escolhe pela stack do repo", () => {
    const d = mkdtempSync(join(tmpdir(), "cr-ia-sbx-"));
    expect(selectSandboxImage(d)).toBeNull();
    writeFileSync(join(d, "package.json"), "{}");
    expect(selectSandboxImage(d)).toBe("node:22-alpine");
  });

  it("python e go", () => {
    const p = mkdtempSync(join(tmpdir(), "cr-ia-sbx-py-"));
    writeFileSync(join(p, "pyproject.toml"), "[x]");
    expect(selectSandboxImage(p)).toBe("python:3.12-alpine");
    const g = mkdtempSync(join(tmpdir(), "cr-ia-sbx-go-"));
    writeFileSync(join(g, "go.mod"), "module x");
    expect(selectSandboxImage(g)).toBe("golang:1.24-alpine");
  });
});

describe("buildDockerArgs (isolamento)", () => {
  const args = buildDockerArgs({
    image: "node:22-alpine", dir: "/agentwork/run-1",
    bin: "npm", args: ["test"], network: "bridge", uid: 1000, gid: 1000,
  });

  it("descartável, um volume, sem segredos, com tetos", () => {
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    // UM único -v, só o clone, em /work:
    const vols = args.filter((a, i) => args[i - 1] === "-v");
    expect(vols).toEqual(["/agentwork/run-1:/work:rw"]);
    expect(args).toContain("--cap-drop");
    expect(args).toContain("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("2g");
    expect(args).toContain("--pids-limit");
    // Nenhum -e além de CI/HOME (sem DATABASE_URL, sem tokens):
    const envs = args.filter((a, i) => args[i - 1] === "-e");
    expect(envs.sort()).toEqual(["CI=true", "HOME=/tmp"]);
    // Usuário não-root do host (não suja dono dos arquivos):
    expect(args).toContain("1000:1000");
    // Imagem + comando por último:
    expect(args.slice(-3)).toEqual(["node:22-alpine", "npm", "test"]);
  });

  it("rede configurável (padrão bridge fora do compose)", () => {
    const i = args.indexOf("--network");
    expect(args[i + 1]).toBe("bridge");
    const none = buildDockerArgs({
      image: "node:22-alpine", dir: "/w", bin: "npm", args: ["t"],
      network: "none", uid: 0, gid: 0,
    });
    expect(none[none.indexOf("--network") + 1]).toBe("none");
  });
});

describe("runUserCommand (motores)", () => {
  it("host exige permissão explícita", async () => {
    await expect(runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "host" }, dir: tmpdir(), command: "node --version",
    })).rejects.toThrow(/AGENT_ALLOW_HOST_EXEC/);
  });

  it("host permitido executa de verdade (log avisa sem isolamento)", async () => {
    const r = await runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true" },
      dir: tmpdir(), command: "node --version",
    });
    expect(r.engine).toBe("host");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/v\d+/);
    expect(r.detail).toMatch(/sem isolamento/);
  });

  it("auto sem docker e sem host: skipped honesto (nada executa)", async () => {
    const r = await runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "auto" }, dir: tmpdir(),
      command: "node --version", dockerCheck: async () => false,
    });
    expect(r.engine).toBe("skipped");
    expect(r.detail).toMatch(/NÃO executados/);
  });

  it("docker exigido mas ausente: erro claro", async () => {
    await expect(runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "docker" }, dir: tmpdir(),
      command: "node --version", dockerCheck: async () => false,
    })).rejects.toThrow(/não responde/);
  });

  it("stack sem imagem: skipped honesto", async () => {
    const d = mkdtempSync(join(tmpdir(), "cr-ia-sbx-unk-"));
    const r = await runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "docker" }, dir: d,
      command: "ls", dockerCheck: async () => true,
    });
    expect(r.engine).toBe("skipped");
    expect(r.detail).toMatch(/sem imagem sandbox/);
  });

  it("allowlist continua valendo em qualquer motor", async () => {
    await expect(runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true" },
      dir: tmpdir(), command: "curl http://x",
    })).rejects.toThrow(/bloqueado|allowlist/);
    await expect(runUserCommand({
      env: { ...baseEnv, AGENT_RUNNER: "host", AGENT_ALLOW_HOST_EXEC: "true" },
      dir: tmpdir(), command: "docker ps",
    })).rejects.toThrow(/bloqueado/);
  });

  it("dockerAvailable responde booleano sem lançar", async () => {
    await expect(dockerAvailable(2000)).resolves.toEqual(expect.any(Boolean));
  });

  it("cria a pasta do teste sem reclamar (smoke do sandbox dir)", () => {
    const d = mkdtempSync(join(tmpdir(), "cr-ia-sbx-smoke-"));
    mkdirSync(join(d, "sub"), { recursive: true });
    expect(selectSandboxImage(join(d, "sub"))).toBeNull();
  });
});
