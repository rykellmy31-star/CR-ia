/**
 * Testes da lib R2 (rode: npm run test:scripts). Sem rede, sem credenciais.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock, backupKeyName, decryptBuffer, encryptBuffer,
  selectForDeletion, sortNewestFirst, weeklyOrDaily,
} from "./r2-lib.mjs";

describe("r2-lib: nomes e retenção", () => {
  it("domingo=weekly, outros=daily", () => {
    assert.equal(weeklyOrDaily(new Date("2026-10-25T12:00:00Z")), "weekly"); // domingo
    assert.equal(weeklyOrDaily(new Date("2026-10-22T12:00:00Z")), "daily"); // quinta
  });

  it("nome da chave no padrão", () => {
    assert.equal(
      backupKeyName(new Date("2026-10-22T12:00:00Z"), "daily"),
      "daily/cr-ia-backup-2026-10-22.tar.gz.enc",
    );
  });

  it("retenção apaga os mais antigos além de keep", () => {
    const objs = [1, 2, 3, 4, 5].map((d) => ({
      Key: `daily/f${d}`, LastModified: new Date(`2026-10-0${d}T00:00:00Z`),
    }));
    const del = selectForDeletion(objs, 2);
    assert.deepEqual(del.map((o) => o.Key), ["daily/f3", "daily/f2", "daily/f1"]);
  });

  it("retenção tolera sem-data (trata como mais antigo) e lista vazia", () => {
    const objs = [{ Key: "a" }, { Key: "b", LastModified: new Date("2026-10-20T00:00:00Z") }];
    assert.deepEqual(selectForDeletion(objs, 1).map((o) => o.Key), ["a"]);
    assert.deepEqual(selectForDeletion([], 7), []);
  });

  it("sortNewestFirst ordena sem remover", () => {
    const objs = [
      { Key: "old", LastModified: new Date("2026-01-01T00:00:00Z") },
      { Key: "new", LastModified: new Date("2026-10-22T00:00:00Z") },
      { Key: "nodate" },
    ];
    assert.deepEqual(sortNewestFirst(objs).map((o) => o.Key), ["new", "old", "nodate"]);
  });
});

describe("r2-lib: criptografia (formato IV||ct||tag)", () => {
  const key = randomBytes(32).toString("hex");

  it("round-trip exato", () => {
    const plain = Buffer.from("backup secreto com acentuação çãõ\n".repeat(100));
    const enc = encryptBuffer(plain, key);
    assert.equal(enc.length, plain.length + 28); // 12 IV + 16 tag
    assert.deepEqual(decryptBuffer(enc, key), plain);
  });

  it("chave errada e byte adulterado falham (GCM autentica)", () => {
    const enc = encryptBuffer(Buffer.from("dados"), key);
    assert.throws(() => decryptBuffer(enc, randomBytes(32).toString("hex")));
    const tampered = Buffer.from(enc);
    tampered[20] ^= 1;
    assert.throws(() => decryptBuffer(tampered, key));
    assert.throws(() => decryptBuffer(Buffer.alloc(10), key));
  });

  it("IV aleatório: mesma entrada gera saídas diferentes", () => {
    const a = encryptBuffer(Buffer.from("x"), key);
    const b = encryptBuffer(Buffer.from("x"), key);
    assert.notDeepEqual(a, b);
  });
});

describe("r2-lib: trava entre execuções", () => {
  it("adquire, libera e re-adquire", () => {
    const r1 = acquireLock("teste-a");
    assert.ok(r1, "deveria adquirir");
    r1();
    const r2 = acquireLock("teste-a");
    assert.ok(r2, "deveria re-adquirir após liberar");
    r2();
  });

  it("recusa quando outro processo vivo detém (pid do pai)", () => {
    const dir = join(tmpdir(), "cr-ia-teste-b.lockdir");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pid"), String(process.ppid)); // pai (vivo) como dono
    assert.equal(acquireLock("teste-b"), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("re-colhe trava de processo morto", () => {
    const dir = join(tmpdir(), "cr-ia-teste-c.lockdir");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pid"), "424242"); // pid inexistente
    const r = acquireLock("teste-c");
    assert.ok(r, "deveria re-colher trava órfã");
    r();
  });
});
