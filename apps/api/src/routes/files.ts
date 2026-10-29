/** Upload/download de arquivos com validação real + leitura de documentos. */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types.js";
import { fail, ok } from "../lib/respond.js";
import { requireAuth } from "../middleware/auth.js";
import { csv, getNum } from "../lib/config.js";
import { nowIso, uid } from "../lib/ids.js";
import { extractTextFromFile } from "../services/docparse.js";
import { indexFileChunks } from "../services/docindex.js";

export const fileRoutes = new Hono<{ Bindings: Env }>();

const READABLE_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

fileRoutes.post("/", requireAuth, async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const user = c.get("user");

  const maxMb = getNum(c, "MAX_UPLOAD_MB", 25);
  const allowed = csv(c.env.ALLOWED_UPLOAD_MIME, [
    "text/plain", "text/markdown", "text/csv", "application/json",
    "image/png", "image/jpeg", "image/webp", "application/pdf",
  ]);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, "Envie o arquivo como multipart/form-data (campo \"file\").", 400);
  }
  const part = form.get("file");
  if (!(part instanceof File)) return fail(c, "Campo \"file\" ausente.", 400);
  if (!allowed.includes(part.type)) {
    return fail(c, `Tipo não permitido: ${part.type || "desconhecido"}. Permitidos: ${allowed.join(", ")}`, 415);
  }
  if (part.size > maxMb * 1024 * 1024) {
    return fail(c, `Arquivo maior que o limite de ${maxMb} MB.`, 413);
  }
  if (part.size === 0) return fail(c, "Arquivo vazio.", 400);

  const buf = new Uint8Array(await part.arrayBuffer());
  const fileId = uid("fil");
  const safeName = part.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "arquivo";
  const key = `uploads/${user.id}/${fileId}-${safeName}`;
  await storage.put(key, buf, part.type || "application/octet-stream");

  const file = await db.saveFile({
    id: fileId, userId: user.id, name: part.name.slice(0, 160),
    mime: part.type || "application/octet-stream", size: part.size,
    url: storage.urlFor(key), createdAt: nowIso(),
  });
  // Guarda a chave de armazenamento na auditoria apenas como referência interna
  await db.logAudit({ userId: user.id, action: "file.upload", detail: `${file.id} key=${key}` });
  // Indexação best-effort para busca em documentos (nunca quebra o upload).
  let indexed: { chunks: number; semantic: boolean } | null = null;
  if (READABLE_MIMES.has(file.mime)) {
    try {
      const r = await indexFileChunks({ db, storage, models: c.get("models"), file, userId: user.id });
      indexed = { chunks: r.chunks, semantic: r.semantic };
    } catch (e) {
      console.warn(`[CR IA] indexação de ${file.id} falhou (upload preservado):`, e instanceof Error ? e.message : e);
    }
  }
  return ok(c, { file: { ...file, key }, indexed }, 201);
});

fileRoutes.get("/", requireAuth, async (c) => {
  const files = await c.get("db").listFiles(c.get("user").id);
  return ok(c, { files });
});

fileRoutes.get("/content/:key", requireAuth, async (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  const storage = c.get("storage");
  // Autorização: a chave precisa pertencer ao usuário (ou ser admin).
  const user = c.get("user");
  const mine = key.includes(`/${user.id}/`);
  if (!mine && user.role !== "admin") return fail(c, "Sem acesso a este arquivo.", 403);
  const obj = await storage.get(key);
  if (!obj) return fail(c, "Arquivo não encontrado.", 404);
  const body = obj.data.slice().buffer as ArrayBuffer;
  return new Response(body, {
    headers: {
      "content-type": obj.mime,
      "content-length": String(obj.data.byteLength),
      "cache-control": "private, max-age=3600",
    },
  });
});

/** Lê o conteúdo textual de um arquivo próprio (para anexar ao chat). */
fileRoutes.get("/:id/read", requireAuth, async (c) => {
  const db = c.get("db");
  const storage = c.get("storage");
  const user = c.get("user");
  const file = await db.getFile(c.req.param("id"), user.id);
  if (!file) return fail(c, "Arquivo não encontrado.", 404);
  if (!READABLE_MIMES.has(file.mime)) {
    return fail(
      c,
      `Leitura automática disponível para PDF, DOCX, XLSX/XLS/CSV, TXT, MD e JSON. Recebido: ${file.mime}.`,
      415
    );
  }
  // Resolve a chave a partir da URL registrada
  const key = decodeURIComponent(file.url.split("/api/files/content/")[1] ?? "");
  if (!key) return fail(c, "Arquivo sem conteúdo acessível.", 500);
  const obj = await storage.get(key);
  if (!obj) return fail(c, "Conteúdo não encontrado no armazenamento.", 404);
  let parsed: { text: string; meta: { pages?: number; sheets?: string[]; truncated: boolean } };
  try {
    parsed = await extractTextFromFile(file.mime, obj.data, file.name);
  } catch (e) {
    return fail(c, e instanceof Error ? e.message : "Falha ao ler o arquivo.", 415);
  }
  let text = parsed.text;
  const truncated = parsed.meta.truncated || text.length > 20000;
  if (text.length > 20000) text = text.slice(0, 20000);
  return ok(c, {
    name: file.name, mime: file.mime, size: file.size, truncated,
    pages: parsed.meta.pages, sheets: parsed.meta.sheets, content: text,
  });
});

fileRoutes.delete("/:id", requireAuth, async (c) => {
  const db = c.get("db");
  const file = await db.getFile(c.req.param("id"), c.get("user").id);
  if (!file) return fail(c, "Arquivo não encontrado.", 404);
  const key = decodeURIComponent(file.url.split("/api/files/content/")[1] ?? "");
  await db.deleteFile(file.id, c.get("user").id);
  await db.deleteDocumentChunks(file.id, c.get("user").id);
  if (key) await c.get("storage").delete(key).catch(() => undefined);
  return ok(c, { deleted: true });
});

export const deleteFileSchema = z.object({ id: z.string() });
