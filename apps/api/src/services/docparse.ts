/**
 * CR IA v0.2.0 — leitura real de documentos (PDF, DOCX, planilhas, texto).
 * Usado pelo upload (indexação para busca) e pela leitura para o chat.
 * Limites anti-abuso: tamanho de texto e nº de páginas/linhas por arquivo.
 */
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";

export const DOC_TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const XLS_MIME = "application/vnd.ms-excel";

const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_PAGES = 100;
const MAX_SHEET_ROWS = 5_000;

export interface ParsedDocument {
  text: string;
  /** Metadados honestos sobre o que foi extraído. */
  meta: {
    pages?: number;
    sheets?: string[];
    truncated: boolean;
  };
}

/** Extrai texto de PDF/DOCX/XLSX/CSV/TXT/JSON. Lança erro claro se não suportar. */
export async function extractTextFromFile(mime: string, data: Uint8Array, fileName: string): Promise<ParsedDocument> {
  const m = (mime || "").toLowerCase();
  const name = (fileName || "").toLowerCase();

  if (DOC_TEXT_MIMES.has(m) || name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".json")) {
    return finish(new TextDecoder("utf-8", { fatal: false }).decode(data), {});
  }
  if (m === "application/pdf" || name.endsWith(".pdf")) {
    const parser = new PDFParse({ data: Buffer.from(data) });
    try {
      const result = await parser.getText();
      const pages = result.pages?.length ?? 0;
      const limited = pages > MAX_PDF_PAGES
        ? result.pages.slice(0, MAX_PDF_PAGES).map((p) => p.text).join("\n\n")
        : result.text;
      return finish(limited, { pages, truncated: pages > MAX_PDF_PAGES });
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  }
  if (m === DOCX_MIME || name.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(data) });
    return finish(result.value ?? "", {});
  }
  if (m === XLSX_MIME || m === XLS_MIME || name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
    const wb = XLSX.read(data, { type: "array" });
    const sheets: string[] = [];
    const parts: string[] = [];
    for (const sheetName of wb.SheetNames.slice(0, 20)) {
      sheets.push(sheetName);
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: "" });
      const limited = rows.slice(0, MAX_SHEET_ROWS);
      const lines = limited.map((r) =>
        (Array.isArray(r) ? r : [r]).map((c) => String(c ?? "").slice(0, 500)).join(" | ")
      );
      parts.push(`[Planilha: ${sheetName}]\n${lines.join("\n")}`);
    }
    return finish(parts.join("\n\n"), { sheets, truncated: wb.SheetNames.length > 20 });
  }
  throw new Error(
    `Leitura automática não suportada para ${mime || "tipo desconhecido"}. ` +
    `Suportados: PDF, DOCX, XLSX/XLS/CSV, TXT, MD, JSON.`
  );
}

function finish(text: string, meta: { pages?: number; sheets?: string[]; truncated?: boolean }): ParsedDocument {
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  const truncated = Boolean(meta.truncated) || clean.length > MAX_TEXT_CHARS;
  return { text: truncated && clean.length > MAX_TEXT_CHARS ? clean.slice(0, MAX_TEXT_CHARS) : clean, meta: { ...meta, truncated } };
}

/** Divide em trechos com sobreposição (para embeddings). */
export function chunkText(text: string, maxChars = 1500, overlap = 150): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      // Corta em quebra de parágrafo/frase quando possível.
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "));
      if (cut > maxChars * 0.4) end = start + cut + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}
