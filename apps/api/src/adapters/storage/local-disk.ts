/** Armazenamento em disco local (dev + VPS com volume persistente). */
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { StorageAdapter, StoredObject } from "./types.js";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "application/json": "json",
  "application/pdf": "pdf",
};

export class LocalDiskAdapter implements StorageAdapter {
  readonly driver = "local" as const;
  private dir: string;

  constructor(dir = "./data/uploads") {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true });
  }

  private safePath(key: string): string {
    const clean = key.replace(/[^a-zA-Z0-9/_.-]/g, "_");
    const full = resolve(join(this.dir, clean));
    if (!full.startsWith(this.dir)) throw new Error("Chave de arquivo inválida.");
    return full;
  }

  async put(key: string, data: Uint8Array, mime: string): Promise<StoredObject> {
    const full = this.safePath(key);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
    return { key, mime, size: data.byteLength };
  }

  async get(key: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const full = this.safePath(key);
    if (!existsSync(full)) return null;
    const buf = readFileSync(full);
    return { data: new Uint8Array(buf), mime: this.guessMime(full) };
  }

  async delete(key: string): Promise<void> {
    try { unlinkSync(this.safePath(key)); } catch { /* já ausente */ }
  }

  urlFor(key: string): string {
    return `/api/files/content/${encodeURIComponent(key)}`;
  }

  private guessMime(path: string): string {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    for (const [mime, e] of Object.entries(MIME_EXT)) {
      if (e === ext) return mime;
    }
    return "application/octet-stream";
  }
}
