/**
 * CR IA v0.2.0 — indexação de documentos para busca.
 * Extrai texto do arquivo, divide em trechos e gera embeddings quando o
 * serviço ai-local responde. Sem embeddings, indexa só o texto (busca por
 * palavra-chave). Falhas de embedding NUNCA quebram o upload.
 */
import type { StoredFile } from "@cr-ia/shared";
import type { DbAdapter } from "../adapters/db/types.js";
import type { StorageAdapter } from "../adapters/storage/types.js";
import type { ModelRegistry } from "../adapters/ai/registry.js";
import { chunkText, extractTextFromFile } from "./docparse.js";

const MAX_CHUNKS_PER_FILE = 60;

export interface IndexDeps {
  db: DbAdapter;
  storage: StorageAdapter;
  models: ModelRegistry;
  file: StoredFile;
  userId: string;
}

export interface IndexResult {
  fileId: string;
  chunks: number;
  /** true = trechos com embedding (busca semântica); false = só texto. */
  semantic: boolean;
  chars: number;
  truncated: boolean;
}

export function storageKeyFor(file: StoredFile): string | null {
  const key = decodeURIComponent(file.url.split("/api/files/content/")[1] ?? "");
  return key || null;
}

/** Indexa (substituindo índice anterior do arquivo). Lança erro se o tipo não for legível. */
export async function indexFileChunks(deps: IndexDeps): Promise<IndexResult> {
  const { db, storage, models, file, userId } = deps;
  const key = storageKeyFor(file);
  if (!key) throw new Error("Arquivo sem conteúdo acessível.");
  const obj = await storage.get(key);
  if (!obj) throw new Error("Conteúdo não encontrado no armazenamento.");

  const parsed = await extractTextFromFile(file.mime, obj.data, file.name);
  if (!parsed.text.trim()) throw new Error("Nenhum texto extraído deste arquivo.");
  const chunks = chunkText(parsed.text).slice(0, MAX_CHUNKS_PER_FILE);

  // Embeddings best-effort (ai-local pode estar desligado).
  let vectors: (number[] | null)[] = chunks.map(() => null);
  let semantic = false;
  const adapter = models.transcriptionAdapter();
  if (adapter && (await adapter.ping().catch(() => false))) {
    try {
      const { embeddings } = await adapter.embed({ texts: chunks });
      vectors = embeddings.map((e) => (Array.isArray(e) && e.length ? e : null));
      semantic = vectors.some((v) => v !== null);
    } catch {
      semantic = false;
    }
  }

  await db.deleteDocumentChunks(file.id, userId);
  await db.saveDocumentChunks(chunks.map((text, i) => ({
    fileId: file.id,
    userId,
    fileName: file.name,
    chunkIndex: i,
    text,
    embedding: vectors[i] ? JSON.stringify(vectors[i]) : null,
  })));
  return {
    fileId: file.id, chunks: chunks.length, semantic,
    chars: parsed.text.length, truncated: parsed.meta.truncated,
  };
}
