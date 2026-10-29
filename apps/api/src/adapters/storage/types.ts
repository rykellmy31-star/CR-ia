/**
 * CR IA — adaptador de armazenamento de arquivos.
 * Implementações: disco local (dev/VPS) e R2 (Cloudflare).
 */
export interface StoredObject {
  key: string;
  mime: string;
  size: number;
}

export interface StorageAdapter {
  readonly driver: "local" | "r2";
  put(key: string, data: Uint8Array, mime: string): Promise<StoredObject>;
  get(key: string): Promise<{ data: Uint8Array; mime: string } | null>;
  delete(key: string): Promise<void>;
  /** URL pública/relativa para acesso ao objeto pela API. */
  urlFor(key: string): string;
}
