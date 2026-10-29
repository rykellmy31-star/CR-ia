import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileAdapter } from "../src/adapters/db/json-file.js";

let n = 0;
async function freshDb() {
  n += 1;
  const dir = mkdtempSync(join(tmpdir(), `cr-ia-test-${n}-`));
  const db = new JsonFileAdapter(join(dir, "db.json"));
  await db.init();
  return db;
}

describe("JsonFileAdapter", () => {
  let db: Awaited<ReturnType<typeof freshDb>>;
  beforeEach(async () => { db = await freshDb(); });

  it("CRUD de usuários", async () => {
    const u = await db.createUser({ email: "a@b.c", name: "A", role: "admin", passwordHash: "h" });
    expect(await db.getUserByEmail("a@b.c")).toMatchObject({ id: u.id });
    expect(await db.getUserByEmail("A@B.C")).toMatchObject({ id: u.id }); // case-insensitive
    const upd = await db.updateUser(u.id, { blocked: true });
    expect(upd?.blocked).toBe(true);
    expect(await db.deleteUser(u.id)).toBe(true);
    expect(await db.getUserById(u.id)).toBeNull();
  });

  it("conversas + mensagens + busca + exclusão em cascata", async () => {
    const u = await db.createUser({ email: "u@u.u", name: "U", role: "user", passwordHash: "h" });
    const c = await db.createConversation({ userId: u.id, title: "Plano de marketing" });
    await db.addMessage({ conversationId: c.id, role: "user", content: "oi" });
    await db.addMessage({ conversationId: c.id, role: "assistant", content: "olá!" });
    expect((await db.listMessages(c.id)).length).toBe(2);
    expect((await db.listConversations(u.id, "market")).length).toBe(1);
    expect((await db.listConversations(u.id, "zzz")).length).toBe(0);
    expect(await db.deleteConversation(c.id, u.id)).toBe(true);
    expect(await db.listMessages(c.id)).toEqual([]);
  });

  it("isolamento entre usuários", async () => {
    const a = await db.createUser({ email: "a@a.a", name: "A", role: "user", passwordHash: "h" });
    const b = await db.createUser({ email: "b@b.b", name: "B", role: "user", passwordHash: "h" });
    const c = await db.createConversation({ userId: a.id, title: "secreta" });
    expect(await db.getConversation(c.id, b.id)).toBeNull();
    expect(await db.deleteConversation(c.id, b.id)).toBe(false);
  });

  it("fila de tarefas: claim é atômico por instância", async () => {
    const u = await db.createUser({ email: "w@w.w", name: "W", role: "user", passwordHash: "h" });
    await db.createTask({ userId: u.id, type: "echo", title: "t1" });
    await db.createTask({ userId: u.id, type: "echo", title: "t2", runAfter: new Date(Date.now() + 60000).toISOString() });
    const claimed = await db.claimNextTask(new Date().toISOString());
    expect(claimed?.status).toBe("running");
    expect(claimed?.title).toBe("t1");
    expect(await db.claimNextTask(new Date().toISOString())).toBeNull(); // t2 agendada p/ futuro
    await db.updateTask(claimed!.id, { status: "done", result: { ok: true } });
    expect((await db.getTask(claimed!.id))?.status).toBe("done");
  });

  it("uso + auditoria + settings", async () => {
    const u = await db.createUser({ email: "s@s.s", name: "S", role: "user", passwordHash: "h" });
    await db.logUsage({ userId: u.id, modelId: "mock-cr-1", kind: "chat", tokensIn: 10, tokensOut: 20, costFlag: false });
    const since = new Date(Date.now() - 86400000).toISOString();
    expect(await db.countUsageSince(u.id, "chat", since)).toBe(1);
    expect(await db.countUsageSince(u.id, "image", since)).toBe(0);
    await db.logAudit({ userId: u.id, action: "x", detail: "y" });
    expect((await db.listAudit()).length).toBe(1);
    await db.setSetting("k", "v");
    expect(await db.getSetting("k")).toBe("v");
  });
});
