/**
 * Índice de código dos repositórios (Fase 3 / memória §8).
 * Caminha um diretório isolado (clone do agente), extrai texto de arquivos
 * de código/docs e indexa em trechos — com embeddings quando o ai-local
 * responde, senão só texto (busca por palavra-chave). Isolado por
 * usuário + repo. Limites rígidos (nº de arquivos, tamanho, trechos).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { DbAdapter } from "../adapters/db/types.js";
import type { ModelRegistry } from "../adapters/ai/registry.js";
import { chunkText } from "./docparse.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 60_000;
const MAX_CHUNKS = 400;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", ".next", ".nuxt",
  ".venv", "venv", "__pycache__", "vendor", "coverage", ".cache", ".turbo",
]);

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc", ".py", ".go",
  ".rs", ".java", ".rb", ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".swift",
  ".kt", ".kts", ".scala", ".sh", ".bash", ".zsh", ".sql", ".md", ".mdx",
  ".txt", ".rst", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env",
  ".html", ".htm", ".css", ".scss", ".less", ".vue", ".svelte", ".xml",
  ".gradle", ".dockerfile", "dockerfile", ".gitignore", ".editorconfig",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function walk(dir: string, base: string, out: string[]): void {
  if (out.length >= MAX_FILES) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  entries.sort();
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.startsWith(".") && e !== ".env" && e !== ".gitignore") {
      if (SKIP_DIRS.has(e) || !TEXT_EXTS.has(extOf(e))) continue;
    }
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(e)) continue;
      walk(full, base, out);
    } else if (st.isFile()) {
      if (st.size === 0 || st.size > MAX_FILE_BYTES) continue;
      if (!TEXT_EXTS.has(extOf(e)) && e.toLowerCase() !== "dockerfile" && e.toLowerCase() !== "license") continue;
      out.push(relative(base, full));
    }
  }
}

export interface CodeIndexResult {
  repo: string;
  files: number;
  chunks: number;
  semantic: boolean;
  truncated: boolean;
}

/** Indexa (substituindo índice anterior deste repo+usuário). */
export async function indexRepoCode(
  db: DbAdapter, models: ModelRegistry, userId: string, repo: string, dir: string
): Promise<CodeIndexResult> {
  const files: string[] = [];
  walk(dir, dir, files);
  const texts: { path: string; text: string }[] = [];
  for (const rel of files) {
    let raw: Buffer;
    try {
      raw = readFileSync(join(dir, rel));
    } catch {
      continue;
    }
    if (raw.includes(0)) continue; // binário
    const text = raw.toString("utf-8").replace(/\0/g, "");
    if (text.trim().length < 20) continue;
    texts.push({ path: rel, text: text.slice(0, MAX_FILE_BYTES) });
  }

  const items: { path: string; chunkIndex: number; text: string }[] = [];
  for (const f of texts) {
    const parts = chunkText(f.text, 1500, 200);
    for (const [i, p] of parts.entries()) {
      if (items.length >= MAX_CHUNKS) break;
      items.push({ path: f.path, chunkIndex: i, text: `Arquivo: ${f.path}\n\n${p}` });
    }
    if (items.length >= MAX_CHUNKS) break;
  }

  let vectors: (number[] | null)[] = items.map(() => null);
  let semantic = false;
  const adapter = models.transcriptionAdapter();
  if (adapter && items.length && (await adapter.ping().catch(() => false))) {
    try {
      const { embeddings } = await adapter.embed({ texts: items.map((x) => x.text) });
      vectors = embeddings.map((e) => (Array.isArray(e) && e.length ? e : null));
      semantic = vectors.some((v) => v !== null);
    } catch {
      semantic = false;
    }
  }

  await db.deleteCodeChunks(repo, userId);
  if (items.length) {
    await db.saveCodeChunks(items.map((x, i) => ({
      userId, repo, path: x.path, chunkIndex: x.chunkIndex, text: x.text,
      embedding: vectors[i] ? JSON.stringify(vectors[i]) : null,
    })));
  }
  return {
    repo, files: texts.length, chunks: items.length, semantic,
    truncated: files.length >= MAX_FILES || items.length >= MAX_CHUNKS,
  };
}
