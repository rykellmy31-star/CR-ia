/**
 * Testes REAIS do adaptador PostgreSQL (mesmo código do Docker da VPS).
 * Executa somente com TEST_DATABASE_URL definido:
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/cr_ia_test npm test
 * O schema é recriado do zero (DROP + migration oficial) a cada rodada.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { PostgresAdapter } from "../src/adapters/db/postgres.js";

const URL = process.env.TEST_DATABASE_URL ?? "";
const LIVE = URL.length > 0;

describe.runIf(LIVE)("PostgresAdapter (BANCO REAL)", () => {
  let pool: Pool;
  let db: PostgresAdapter;

  beforeAll(async () => {
    pool = new Pool({ connectionString: URL });
    const here = dirname(fileURLToPath(import.meta.url));
    const schema1 = readFileSync(join(here, "..", "migrations", "0001_init_postgres.sql"), "utf-8");
    const schema2 = readFileSync(join(here, "..", "migrations", "0002_v020_docs_agent.sql"), "utf-8");
    // Recria tudo do zero para um teste determinístico
    await pool.query(`
      DROP TABLE IF EXISTS document_chunks, agent_runs, usage_events, audit_log, settings, tasks, images, files, messages, conversations, users CASCADE;
    `);
    await pool.query(schema1);
    await pool.query(schema2);
    db = new PostgresAdapter(URL);
    await db.init();
  });

  afterAll(async () => {
    try { await db?.close(); } catch { /* setup pode ter falhado */ }
    try { await pool?.end(); } catch { /* setup pode ter falhado */ }
  });

  it("driver é postgres", () => {
    expect(db.driver).toBe("postgres");
  });

  it("CRUD de usuários + e-mail case-insensitive", async () => {
    const u = await db.createUser({ email: "Pg@Teste.com", name: "PG", role: "admin", passwordHash: "h" });
    expect(u.email).toBe("pg@teste.com");
    expect(await db.getUserByEmail("PG@TESTE.COM")).toMatchObject({ id: u.id });
    expect((await db.updateUser(u.id, { blocked: true }))?.blocked).toBe(true);
    expect(await db.deleteUser(u.id)).toBe(true);
  });

  it("conversas + mensagens + busca ILIKE", async () => {
    const u = await db.createUser({ email: "c@t.com", name: "C", role: "user", passwordHash: "h" });
    const c = await db.createConversation({ userId: u.id, title: "Marketing Digital" });
    await db.addMessage({ conversationId: c.id, role: "user", content: "oi", tokensIn: 1, tokensOut: 2 });
    expect((await db.listMessages(c.id)).length).toBe(1);
    expect((await db.listConversations(u.id, "market")).length).toBe(1);
    expect((await db.listConversations(u.id, "zzz")).length).toBe(0);
    expect(await db.deleteConversation(c.id, u.id)).toBe(true);
    expect(await db.listMessages(c.id)).toEqual([]);
  });

  it("fila: claim com SKIP LOCKED + retry", async () => {
    const u = await db.createUser({ email: "w@t.com", name: "W", role: "user", passwordHash: "h" });
    await db.createTask({ userId: u.id, type: "echo", title: "t1" });
    const claimed = await db.claimNextTask(new Date().toISOString());
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(await db.claimNextTask(new Date().toISOString())).toBeNull();
    await db.updateTask(claimed!.id, { status: "done", result: { ok: 1 } });
    expect((await db.getTask(claimed!.id))?.status).toBe("done");
  });

  it("arquivos + imagens + isolamento", async () => {
    const a = await db.createUser({ email: "a@t.com", name: "A", role: "user", passwordHash: "h" });
    const b = await db.createUser({ email: "b@t.com", name: "B", role: "user", passwordHash: "h" });
    const f = await db.saveFile({ id: "f1", userId: a.id, name: "n.txt", mime: "text/plain", size: 3, url: "/u", createdAt: new Date().toISOString() });
    expect(await db.getFile(f.id, b.id)).toBeNull();
    expect((await db.listFiles(a.id)).length).toBe(1);
    const now = new Date().toISOString();
    await db.saveImage({ id: "i1", userId: a.id, prompt: "p", format: "1:1", modelId: "m", fileId: f.id, url: "/i", width: 8, height: 8, createdAt: now });
    expect((await db.listImages(a.id)).length).toBe(1);
    expect(await db.getImage("i1", b.id)).toBeNull();
    expect(await db.deleteImage("i1", a.id)).toBe(true);
    expect(await db.deleteFile(f.id, a.id)).toBe(true);
  });

  it("uso + auditoria + settings (upsert)", async () => {
    const u = await db.createUser({ email: "s@t.com", name: "S", role: "user", passwordHash: "h" });
    await db.logUsage({ userId: u.id, modelId: "qwen3:4b", kind: "chat", tokensIn: 5, tokensOut: 6, costFlag: false });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(await db.countUsageSince(u.id, "chat", since)).toBe(1);
    const sum = await db.usageSummary();
    expect(sum.total).toBeGreaterThanOrEqual(1);
    expect(sum.byModel["qwen3:4b"]).toBeGreaterThanOrEqual(1);
    await db.logAudit({ userId: u.id, action: "t", detail: "d" });
    expect((await db.listAudit()).length).toBeGreaterThanOrEqual(1);
    await db.setSetting("k", "v1");
    await db.setSetting("k", "v2");
    expect(await db.getSetting("k")).toBe("v2");
  });

  it("document_chunks: salva, lista e apaga (v0.2.0)", async () => {
    const u = await db.createUser({ email: "doc@t.com", name: "D", role: "user", passwordHash: "h" });
    const now = new Date().toISOString();
    const f = await db.saveFile({ id: "fdoc", userId: u.id, name: "a.txt", mime: "text/plain", size: 3, url: "/f", createdAt: now });
    const saved = await db.saveDocumentChunks([
      { fileId: f.id, userId: u.id, fileName: "a.txt", chunkIndex: 0, text: "trecho um", embedding: "[0.1,0.2]" },
      { fileId: f.id, userId: u.id, fileName: "a.txt", chunkIndex: 1, text: "trecho dois", embedding: null },
    ]);
    expect(saved.length).toBe(2);
    expect((await db.listDocumentChunks(u.id)).length).toBe(2);
    await db.deleteDocumentChunks(f.id, u.id);
    expect(await db.listDocumentChunks(u.id)).toEqual([]);
  });

  it("agent_runs: ciclo de estado + breakdown + contagens (v0.2.0)", async () => {
    const u = await db.createUser({ email: "ag@t.com", name: "AG", role: "admin", passwordHash: "h" });
    const run = await db.createAgentRun({
      userId: u.id, repo: "dono/r", baseBranch: "main", workBranch: "cr-ia/x",
      goal: "teste de persistência", commands: ["npm test"],
    });
    expect(run.status).toBe("pending");
    expect(run.steps).toEqual([]);
    const upd = await db.updateAgentRun(run.id, {
      status: "awaiting_approval", currentPhase: "push",
      steps: [{ phase: "validate", status: "done", startedAt: null, finishedAt: null, log: "ok", awaitingApproval: null }],
      approvals: { push: { by: u.id, at: new Date().toISOString() } },
    });
    expect(upd?.approvals.push?.by).toBe(u.id);
    expect((await db.listAgentRuns(u.id)).length).toBe(1);
    expect(await db.getAgentRun(run.id, "outro")).toBeNull();

    await db.logUsage({ userId: u.id, modelId: "whisper-small", kind: "transcription", tokensIn: 0, tokensOut: 0, costFlag: false });
    const rows = await db.usageBreakdown(30);
    expect(rows.some((r) => r.email === "ag@t.com" && r.modelId === "whisper-small")).toBe(true);
    const counts = await db.tableCounts();
    expect(counts.agent_runs).toBeGreaterThanOrEqual(1);
    expect(counts.users).toBeGreaterThanOrEqual(1);
    expect(await db.dbSizeMB()).toBeGreaterThan(0);
  });
});

describe.runIf(!LIVE)("PostgresAdapter", () => {
  it("pulados sem TEST_DATABASE_URL (rode com banco real na auditoria)", () => {
    expect(true).toBe(true);
  });
});
