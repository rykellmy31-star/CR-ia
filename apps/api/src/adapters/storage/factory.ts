/** Fábrica do adaptador de armazenamento. */
import type { Env } from "../../types.js";
import type { StorageAdapter } from "./types.js";
import { LocalDiskAdapter } from "./local-disk.js";
import { R2Adapter } from "./r2.js";

export function createStorage(env: Env): StorageAdapter {
  const driver = env.STORAGE_DRIVER ?? "local";
  if (driver === "r2") {
    if (!env.FILES) throw new Error("STORAGE_DRIVER=r2 exige binding FILES (R2).");
    return new R2Adapter(env.FILES);
  }
  return new LocalDiskAdapter(env.LOCAL_STORAGE_DIR ?? "./data/uploads");
}
