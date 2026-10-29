/** Armazenamento Cloudflare R2 (produção serverless). */
import type { R2BucketLike } from "../../types.js";
import type { StorageAdapter, StoredObject } from "./types.js";

export class R2Adapter implements StorageAdapter {
  readonly driver = "r2" as const;
  constructor(private bucket: R2BucketLike) {}

  async put(key: string, data: Uint8Array, mime: string): Promise<StoredObject> {
    // cópia defensiva: R2 exige ArrayBuffer "limpo"
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    await this.bucket.put(key, copy, { httpMetadata: { contentType: mime } });
    return { key, mime, size: data.byteLength };
  }

  async get(key: string): Promise<{ data: Uint8Array; mime: string } | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    const buf = await new Response(obj.body).arrayBuffer();
    return { data: new Uint8Array(buf), mime: obj.httpMetadata?.contentType ?? "application/octet-stream" };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  urlFor(key: string): string {
    return `/api/files/content/${encodeURIComponent(key)}`;
  }
}
