/**
 * Central de Atualizações (item 4): manifesto, verificação minisign+sha256,
 * staging com recibo e aplicação fail-closed. Rede = stub; ed25519 e zip = reais.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdates, compareVersions, currentVersion, fetchManifest,
  stageUpdate, applyStaged, verifyMinisign,
} from "../src/services/updates.js";
import type { Env } from "../src/types.js";

// Fixture minisign válida gerada em memória com Ed25519 + comentário assinado.
const FIXTURE_MSG = Buffer.from("CR-IA-UPDATE-FIXTURE-v0.2.1", "utf8");
function minisignFixture(data: Uint8Array): { pub: string; sig: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  const keynum = randomBytes(8);
  const fileSig = sign(null, createHash("blake2b512").update(data).digest(), privateKey);
  const trusted = "fixture: CR IA";
  const globalSig = sign(null, Buffer.concat([fileSig, Buffer.from(trusted)]), privateKey);
  return {
    pub: "untrusted comment: test key\n" + Buffer.concat([Buffer.from("Ed"), keynum, pubRaw]).toString("base64"),
    sig: `untrusted comment: signature\n${Buffer.concat([Buffer.from("ED"), keynum, fileSig]).toString("base64")}\ntrusted comment: ${trusted}\n${globalSig.toString("base64")}\n`,
  };
}
const FIXTURE = minisignFixture(FIXTURE_MSG);
const FIXTURE_PUB = FIXTURE.pub;
const FIXTURE_SIG = FIXTURE.sig;

function mkEnv(updatesDir: string, extra: Partial<Env> = {}): Env {
  return { NODE_ENV: "test", UPDATES_DIR: updatesDir, ...extra };
}

describe("compareVersions", () => {
  it("ordena numérico por parte", () => {
    expect(compareVersions("0.2.1", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
  });
});

describe("verifyMinisign", () => {
  it("aceita assinatura real sobre os bytes exatos", () => {
    expect(verifyMinisign(FIXTURE_MSG, FIXTURE_SIG, FIXTURE_PUB).keynum).toMatch(/^[0-9a-f]{16}$/);
  });

  it("recusa bytes adulterados", () => {
    const tampered = Buffer.from(FIXTURE_MSG);
    tampered[0] ^= 1;
    expect(() => verifyMinisign(tampered, FIXTURE_SIG, FIXTURE_PUB)).toThrow(/INVÁLIDA/);
  });

  it("recusa assinatura incompleta de duas linhas", () => {
    const truncated = FIXTURE_SIG.trim().split("\n").slice(0, 2).join("\n");
    expect(() => verifyMinisign(FIXTURE_MSG, truncated, FIXTURE_PUB)).toThrow(/4 linhas/);
  });

  it("recusa comentário confiável adulterado", () => {
    const tampered = FIXTURE_SIG.replace("fixture: CR IA", "fixture: adulterado");
    expect(() => verifyMinisign(FIXTURE_MSG, tampered, FIXTURE_PUB)).toThrow(/global INVÁLIDA/);
  });

  it("recusa chave errada (keynum divergente)", () => {
    const other = minisignFixture(FIXTURE_MSG);
    expect(() => verifyMinisign(FIXTURE_MSG, FIXTURE_SIG, other.pub)).toThrow(/keynum/);
  });

  it("recusa formato inválido", () => {
    expect(() => verifyMinisign(FIXTURE_MSG, "lixo", FIXTURE_PUB)).toThrow();
    expect(() => verifyMinisign(FIXTURE_MSG, FIXTURE_SIG, "lixo")).toThrow();
  });
});

describe("checkForUpdates", () => {
  it("sem manifesto: não configurado (nada é baixado)", async () => {
    const st = await checkForUpdates(mkEnv(mkdtempSync(join(tmpdir(), "cr-ia-upd-"))));
    expect(st.configured).toBe(false);
    expect(st.current).toBe(currentVersion());
    expect(st.updateAvailable).toBe(false);
  });

  it("manifesto com versão maior: updateAvailable + cache em disco", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-upd-"));
    const fetchImpl = (async () => new Response(JSON.stringify({
      version: "9.9.9", notes: "novidades", zipUrl: "https://x/y.zip",
      sha256: "a".repeat(64), signature: "untrusted comment: s\n" + "b".repeat(96),
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const st = await checkForUpdates(mkEnv(dir, { UPDATES_MANIFEST_URL: "https://x/manifest.json" }), fetchImpl);
    expect(st.configured).toBe(true);
    expect(st.latest).toBe("9.9.9");
    expect(st.updateAvailable).toBe(true);
    expect(existsSync(join(dir, "last-check.json"))).toBe(true);
  });

  it("manifestos inválidos e rede falha: erro honesto, sem exceção", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-upd-"));
    const bad = (async () => new Response(JSON.stringify({ version: "" }), { status: 200 })) as unknown as typeof fetch;
    const st1 = await checkForUpdates(mkEnv(dir, { UPDATES_MANIFEST_URL: "https://x/m.json" }), bad);
    expect(st1.error).toMatch(/Manifesto|version/);
    const down = (async () => { throw new Error("rede caiu"); }) as unknown as typeof fetch;
    const st2 = await checkForUpdates(mkEnv(dir, { UPDATES_MANIFEST_URL: "https://x/m.json" }), down);
    expect(st2.error).toMatch(/rede caiu/);
  });

  it("fetchManifest valida zipUrl e sha", async () => {
    const mk = (body: object) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchManifest("https://x/m",
      mk({ version: "1.0.0", zipUrl: "ftp://x/y.zip", sha256: "a".repeat(64), signature: "untrusted comment: s\nx" }),
    )).rejects.toThrow(/zipUrl/);
    await expect(fetchManifest("https://x/m",
      mk({ version: "1.0.0", zipUrl: "https://x/y.zip", sha256: "zzz", signature: "untrusted comment: s\nx" }),
    )).rejects.toThrow(/sha256/);
  });
});

describe("stageUpdate", () => {
  /** Monta um ZIP real (via python3) e manifesto válido assinado sobre ele. */
  function makeZipCase(topDir: boolean): { dir: string; zip: Buffer; manifest: { version: string; notes?: string; zipUrl: string; sha256: string; signature: string } } {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-upd-"));
    const src = join(dir, "src");
    const inner = topDir ? join(src, "release", "app.txt") : join(src, "app.txt");
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(join(inner, ".."), { recursive: true });
    writeFileSync(inner, "conteúdo verificado\n");
    const zipPath = join(dir, "rel.zip");
    execFileSync("python3", ["-m", "zipfile", "-c", zipPath, ...(topDir ? ["release"] : ["app.txt"])], { cwd: src });
    const zip = readFileSync(zipPath);
    const { pub, sig } = minisignFixture(zip);
    (makeZipCase as { lastPub?: string }).lastPub = pub;
    return {
      dir,
      zip,
      manifest: {
        version: "9.9.9", zipUrl: "https://x/rel.zip",
        sha256: createHash("sha256").update(zip).digest("hex"), signature: sig,
      },
    };
  }

  it("recusa sem chave pública configurada (fail-closed)", async () => {
    const { dir, zip, manifest } = makeZipCase(false);
    const f = (async () => new Response(zip, { status: 200 })) as unknown as typeof fetch;
    await expect(stageUpdate(mkEnv(dir), manifest, f)).rejects.toThrow(/UPDATE_SIGNING_PUBLIC_KEY/);
  });

  it("baixa, confere sha+assinatura, extrai e grava recibo", async () => {
    const { dir, zip, manifest } = makeZipCase(false);
    const pub = (makeZipCase as { lastPub?: string }).lastPub!;
    const f = (async () => new Response(zip as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const out = await stageUpdate(mkEnv(dir, { UPDATE_SIGNING_PUBLIC_KEY: pub }), manifest, f);
    expect(out.version).toBe("9.9.9");
    expect(readFileSync(join(out.dir, "app.txt"), "utf8")).toBe("conteúdo verificado\n");
    const receipt = JSON.parse(readFileSync(join(dir, "pending-9.9.9", ".cr-ia-receipt.json"), "utf8")) as { sha256: string };
    expect(receipt.sha256).toBe(manifest.sha256);
  });

  it("normaliza zip com pasta única no topo", async () => {
    const { dir, zip, manifest } = makeZipCase(true);
    const pub = (makeZipCase as { lastPub?: string }).lastPub!;
    const f = (async () => new Response(zip as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const out = await stageUpdate(mkEnv(dir, { UPDATE_SIGNING_PUBLIC_KEY: pub }), manifest, f);
    expect(readFileSync(join(out.dir, "app.txt"), "utf8")).toBe("conteúdo verificado\n");
  });

  it("recusa sha divergente e assinatura de outros bytes", async () => {
    const { dir, zip, manifest } = makeZipCase(false);
    const pub = (makeZipCase as { lastPub?: string }).lastPub!;
    const f = (async () => new Response(zip as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    await expect(stageUpdate(
      mkEnv(dir, { UPDATE_SIGNING_PUBLIC_KEY: pub }),
      { ...manifest, sha256: "b".repeat(64) }, f,
    )).rejects.toThrow(/sha256 DIVERGE/);
    const other = minisignFixture(Buffer.from("outros bytes"));
    await expect(stageUpdate(
      mkEnv(dir, { UPDATE_SIGNING_PUBLIC_KEY: other.pub }),
      { ...manifest, signature: manifest.signature }, f,
    )).rejects.toThrow(/keynum/);
  });
});

describe("applyStaged", () => {
  it("recusa aplicar sem staging verificado (sem recibo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cr-ia-upd-"));
    await expect(applyStaged(mkEnv(dir), "1.2.3")).rejects.toThrow(/NÃO está preparada/);
  });
});
