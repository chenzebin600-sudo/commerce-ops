import path from "node:path";

export const STORAGE_PROVIDER_CONTRACT = "COMMERCE-OPS-STORAGE-1.0.0";

export function normalizeStorageKey(value) {
  const key = String(value || "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!key || key.includes("\0") || key.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("Storage key is invalid");
  }
  return key;
}

export class StorageProvider {
  constructor({ providerName }) {
    if (!providerName) throw new TypeError("Storage provider name is required");
    this.providerName = providerName;
  }

  async put() { throw new Error("StorageProvider.put is not implemented"); }
  async get() { throw new Error("StorageProvider.get is not implemented"); }
  async exists() { throw new Error("StorageProvider.exists is not implemented"); }
  async stat() { throw new Error("StorageProvider.stat is not implemented"); }
  async remove() { throw new Error("StorageProvider.remove is not implemented"); }
  async delete(key) { return this.remove(key); }

  metadata(key) {
    return Object.freeze({ provider: this.providerName, storageKey: normalizeStorageKey(key), contract: STORAGE_PROVIDER_CONTRACT });
  }
}

export function resolveLocalStoragePath(rootDir, key) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, ...normalizeStorageKey(key).split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("Storage key escapes the configured root");
  return target;
}
