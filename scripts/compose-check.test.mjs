/**
 * Validação estrutural do docker-compose.yml (§2/§4): sem dockerd aqui,
 * então valida por parse YAML + regras (bind só-loopback, updater mínimo
 * privilégio, limites de RAM, porta 3000). `docker compose config/up` real
 * roda só na VPS (documentado). Pula se python3/pyyaml ausentes.
 * Rode: npm run test:scripts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function hasPyYaml() {
  const r = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" });
  return r.status === 0;
}

if (!hasPyYaml()) {
  console.log("SKIP: python3/pyyaml ausentes neste ambiente.");
  process.exit(0);
}

const PY = `
import yaml, json
d = yaml.safe_load(open(${JSON.stringify(join(ROOT, "docker-compose.yml"))}))
svcs = d.get("services", {}) or {}
def ports(s):
    out = []
    for p in (s.get("ports") or []):
        if isinstance(p, dict):
            out.append("%s:%s:%s" % (p.get("host_ip", ""), p.get("published", ""), p.get("target", "")))
        else:
            out.append(str(p))
    return out
out = {"services": sorted(svcs.keys()), "ports": {}, "volumes": {}, "env": {}, "caps": {}, "health": [], "restart": {}, "limits": {}, "dockerfiles": {}, "depends": {}, "profiles": {}}
for name, s in svcs.items():
    out["ports"][name] = ports(s)
    out["volumes"][name] = [str(v) for v in (s.get("volumes") or [])]
    e = s.get("environment") or {}
    out["env"][name] = e if isinstance(e, dict) else dict(kv.split("=", 1) if "=" in kv else (kv, "") for kv in e)
    out["caps"][name] = {"cap_drop": s.get("cap_drop") or [], "security_opt": s.get("security_opt") or [], "read_only": bool(s.get("read_only"))}
    if s.get("healthcheck"): out["health"].append(name)
    out["restart"][name] = s.get("restart") or ""
    out["profiles"][name] = s.get("profiles") or []
    dep = ((s.get("deploy") or {}).get("resources") or {})
    out["limits"][name] = dep.get("limits") or {}
    b = s.get("build")
    if isinstance(b, dict): out["dockerfiles"][name] = b.get("dockerfile") or ""
    elif isinstance(b, str): out["dockerfiles"][name] = "Dockerfile"
print(json.dumps(out))
`;

const r = spawnSync("python3", ["-c", PY], { encoding: "utf8", cwd: ROOT });
assert.equal(r.status, 0, `compose YAML inválido: ${r.stderr}`);
const C = JSON.parse(r.stdout);

describe("docker-compose.yml (parse + regras)", () => {
  it("serviços essenciais existem", () => {
    for (const s of ["db", "api", "worker", "web", "updater"]) {
      assert.ok(C.services.includes(s), `falta serviço: ${s}`);
    }
  });

  it("NENHUMA porta pública: todo bind é 127.0.0.1", () => {
    let n = 0;
    for (const [svc, ports] of Object.entries(C.ports)) {
      for (const p of ports) {
        n++;
        assert.ok(p.startsWith("127.0.0.1:"),
          `${svc}: bind público ou sem IP explícito: ${p}`);
      }
    }
    assert.ok(n > 0, "nenhuma porta declarada?");
  });

  it("site na porta 3000 (padrão do Tunnel), sem 8080 no host", () => {
    const web = C.ports.web.join(" ");
    assert.match(web, /127\.0\.0\.1:.*3000.*:80/, `web fora da 3000: ${web}`);
    for (const [svc, ports] of Object.entries(C.ports)) {
      for (const p of ports) {
        const host = p.split(":")[1] ?? "";
        assert.notEqual(host, "8080", `${svc} expõe 8080 no host: ${p}`);
      }
    }
  });

  it("socket Docker SÓ no updater (nunca na API pública)", () => {
    assert.ok(C.volumes.updater.some((v) => v.includes("docker.sock")), "updater sem socket");
    for (const svc of Object.keys(C.volumes)) {
      if (svc === "updater") continue;
      assert.ok(!C.volumes[svc].some((v) => v.includes("docker.sock")),
        `${svc} com socket Docker!`);
    }
    assert.deepEqual(C.ports.updater, [], "updater não pode publicar porta");
  });

  it("updater com privilégios mínimos + segredo da fila", () => {
    assert.ok(C.caps.updater.cap_drop.includes("ALL"), "sem cap_drop ALL");
    assert.ok(C.caps.updater.security_opt.includes("no-new-privileges:true"), "sem no-new-privileges");
    assert.equal(C.caps.updater.read_only, true, "FS raiz deveria ser só-leitura");
    assert.ok("UPDATER_QUEUE_SECRET" in C.env.updater, "sem UPDATER_QUEUE_SECRET");
  });

  it("API recebe UPDATER_QUEUE_SECRET (aprovação HMAC morre sem ele)", () => {
    assert.ok("UPDATER_QUEUE_SECRET" in C.env.api, "API sem UPDATER_QUEUE_SECRET — aprovar retornaria erro");
  });

  it("updater DESATIVADO por padrão (profile updates), sem bloquear o resto", () => {
    assert.ok(C.profiles.updater.includes("updates"),
      "updater precisa estar atrás de profiles: [updates] na homologação");
    // Serviços essenciais sobem no `up` padrão (sem profile).
    for (const svc of ["db", "api", "worker", "web"]) {
      assert.deepEqual(C.profiles[svc], [], `${svc} não pode exigir profile`);
    }
  });

  it("limites de RAM nos serviços principais (12 GB)", () => {
    for (const svc of ["db", "api", "worker", "web", "updater"]) {
      assert.ok(C.limits[svc]?.memory, `${svc} sem limite de memória`);
    }
  });

  it("restart + healthchecks nos serviços críticos", () => {
    for (const svc of ["db", "api", "worker", "web", "updater"]) {
      assert.match(C.restart[svc], /unless-stopped|always/, `${svc} sem restart`);
    }
    for (const svc of ["db", "api", "web"]) {
      assert.ok(C.health.includes(svc), `${svc} sem healthcheck`);
    }
  });

  it("Dockerfiles referenciados existem no disco", () => {
    for (const [svc, df] of Object.entries(C.dockerfiles)) {
      assert.ok(df, `${svc} sem dockerfile declarado`);
      assert.ok(existsSync(join(ROOT, df)), `${svc}: ${df} não existe`);
    }
  });
});
