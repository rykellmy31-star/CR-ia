/**
 * Execução ISOLADA de comandos de teste do agente (item 3 da auditoria).
 *
 * - AGENT_RUNNER=docker|auto (padrão): cada comando roda num contêiner
 *   DESCARTÁVEL (`docker run --rm`) com SOMENTE o clone montado em /work.
 *   Sem segredos (nenhum -e além de CI/HOME), sem volumes administrativos,
 *   sem acesso à rede do compose (bridge padrão ou none), com teto de
 *   memória/CPU/PIDs, cap-drop ALL e no-new-privileges. O contêiner some
 *   ao final (--rm) — nada persiste fora de /work.
 * - AGENT_RUNNER=host: executa no host, SOMENTE se AGENT_ALLOW_HOST_EXEC=true
 *   explícito (não recomendado; herda o comportamento antigo).
 * - Sem docker e sem permissão de host: NÃO executa — retorna skipped com
 *   instrução honesta (o agente falha a fase de testes em vez de fingir).
 *
 * O binário `docker` aqui é uso INTERNO com argumentos fixos — comandos do
 * usuário continuam proibidos de chamar docker (CMD_DENY) e passam pela
 * allowlist (validateUserCommand) antes de entrar no contêiner.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../types.js";
import { validateUserCommand } from "./agent.js";

export type SandboxEngine = "docker" | "host" | "skipped";

export interface SandboxResult {
  code: number;
  out: string;
  engine: SandboxEngine;
  /** Explica o motor escolhido (vai para o log do run). */
  detail: string;
}

const SANDBOX_IMAGES: Array<{ image: string; markers: string[] }> = [
  { image: "node:22-alpine", markers: ["package.json"] },
  { image: "python:3.12-alpine", markers: ["pyproject.toml", "pytest.ini", "requirements.txt", "setup.py"] },
  { image: "golang:1.24-alpine", markers: ["go.mod"] },
];

/** Imagem pelo manifesto do repo. null = stack sem sandbox (pula honesto). */
export function selectSandboxImage(dir: string): string | null {
  for (const c of SANDBOX_IMAGES) {
    if (c.markers.some((m) => existsSync(join(dir, m)))) return c.image;
  }
  return null;
}

/** Passo de instalação de dependências (precisa de rede; só se faltar). */
function installStep(dir: string, image: string): string[] | null {
  if (image.startsWith("node:") && !existsSync(join(dir, "node_modules"))) {
    return ["npm", "install", "--no-audit", "--no-fund"];
  }
  if (image.startsWith("python:")) {
    if (existsSync(join(dir, "requirements.txt"))) return ["pip", "install", "-r", "requirements.txt"];
    return ["pip", "install", "pytest"];
  }
  return null; // go: `go test` baixa módulos sozinho
}

export interface DockerArgsOpts {
  image: string;
  dir: string;
  bin: string;
  args: string[];
  network: string;
  uid: number;
  gid: number;
  memory?: string;
  cpus?: string;
}

/** Monta o `docker run` isolado (pura — 100% testável sem docker). */
export function buildDockerArgs(o: DockerArgsOpts): string[] {
  return [
    "run", "--rm", "-i",
    "--network", o.network,
    "--memory", o.memory ?? "2g",
    "--cpus", o.cpus ?? "1.5",
    "--pids-limit", "256",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", `${o.uid}:${o.gid}`,
    "-v", `${o.dir}:/work:rw`,
    "-w", "/work",
    "-e", "CI=true",
    "-e", "HOME=/tmp",
    o.image,
    o.bin, ...o.args,
  ];
}

function execTimeout(
  bin: string, args: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, {
      cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
      ...(env ? { env } : {}),
    }, (err, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ? `\n[stderr]\n${stderr}` : ""}`.slice(-8000);
      if (err && "killed" in (err as object) && ((err as { killed?: boolean }).killed)) return resolve({ code: 124, out: `${out}\n[TIMEOUT após ${timeoutMs}ms]` });
      resolve({ code: (err as { code?: number } | null)?.code ?? 0, out });
    });
  });
}

/** Docker acessível deste processo? (socket montado + daemon respondendo) */
export async function dockerAvailable(timeoutMs = 8000): Promise<boolean> {
  try {
    const r = await execTimeout("docker", ["info", "--format", "{{.ServerVersion}}"], process.cwd(), timeoutMs);
    return r.code === 0 && r.out.trim().length > 0;
  } catch {
    return false;
  }
}

export interface RunUserCommandOpts {
  env: Env;
  dir: string;
  command: string;
  timeoutMs?: number;
  /** Injetável para testes (padrão: checa o docker de verdade). */
  dockerCheck?: () => Promise<boolean>;
}

const SKIP_MSG =
  "Docker indisponível neste worker e execução no host não autorizada — testes NÃO executados. " +
  "Para ativar: monte /var/run/docker.sock no worker (ver docker-compose.yml) OU defina " +
  "AGENT_ALLOW_HOST_EXEC=true por sua conta e risco. O run para aqui (nada foi para o git).";

/**
 * Executa um comando de teste do usuário no motor configurado.
 * Lança erro em comando inválido; NUNCA executa silenciosamente no host.
 */
export async function runUserCommand(o: RunUserCommandOpts): Promise<SandboxResult> {
  const [bin, args] = validateUserCommand(o.command); // allowlist + deny (sempre)
  const runner = (o.env.AGENT_RUNNER ?? "auto").trim().toLowerCase();
  const hostAllowed = (o.env.AGENT_ALLOW_HOST_EXEC ?? "false").toLowerCase() === "true";
  const timeoutMs = o.timeoutMs ?? 600_000;

  if (runner === "host") {
    if (!hostAllowed) {
      throw new Error(
        "AGENT_RUNNER=host exige AGENT_ALLOW_HOST_EXEC=true explícito. " +
        "Recomendado: use contêineres (AGENT_RUNNER=docker)."
      );
    }
    const r = await execTimeout(bin, args, o.dir, timeoutMs);
    return {
      ...r,
      engine: "host",
      detail: "host (AGENT_ALLOW_HOST_EXEC=true — sem isolamento; use por sua conta e risco)",
    };
  }

  // docker | auto
  const hasDocker = await (o.dockerCheck ?? dockerAvailable)();
  if (!hasDocker) {
    if (runner === "docker") {
      throw new Error("AGENT_RUNNER=docker mas o Docker não responde neste worker. Monte o socket ou use auto.");
    }
    if (hostAllowed) {
      const r = await execTimeout(bin, args, o.dir, timeoutMs);
      return { ...r, engine: "host", detail: "host (fallback: docker ausente + AGENT_ALLOW_HOST_EXEC=true)" };
    }
    return { code: 125, out: "", engine: "skipped", detail: SKIP_MSG };
  }

  const image = selectSandboxImage(o.dir);
  if (!image) {
    return {
      code: 125, out: "", engine: "skipped",
      detail: "Stack sem imagem sandbox (só node/python/go) — testes NÃO executados. Informe commands manuais ou cancele.",
    };
  }

  const network = (o.env.AGENT_SANDBOX_NETWORK ?? "bridge").trim() || "bridge";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  const parts: string[] = [];

  // Dependências primeiro (se faltarem) — com rede, logado.
  const install = installStep(o.dir, image);
  if (install) {
    parts.push(`$ ${install.join(" ")}  [instalação de dependências no sandbox]`);
    const ins = await execTimeout(
      "docker", buildDockerArgs({ image, dir: o.dir, bin: install[0], args: install.slice(1), network, uid, gid }),
      process.cwd(), timeoutMs,
    );
    parts.push(ins.out.slice(-3000));
    if (ins.code !== 0) {
      return {
        code: ins.code, out: parts.join("\n"), engine: "docker",
        detail: `docker ${image} (instalação falhou, exit ${ins.code})`,
      };
    }
  }

  parts.push(`$ ${o.command}`);
  const r = await execTimeout(
    "docker", buildDockerArgs({ image, dir: o.dir, bin, args, network, uid, gid }),
    process.cwd(), timeoutMs,
  );
  parts.push(r.out.slice(-6000));
  return {
    code: r.code,
    out: parts.join("\n"),
    engine: "docker",
    detail: `docker ${image} (descartável --rm, só /work montado, sem segredos, rede ${network}, 2g/1.5cpu)`,
  };
}
