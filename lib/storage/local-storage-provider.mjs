import fs from "node:fs/promises";
import path from "node:path";
import { atomicMoveFile, resolveExistingFile, resolveNewFile } from "../security/file-policy.mjs";
import { StorageProvider, normalizeStorageKey, resolveLocalStoragePath } from "./storage-provider.mjs";

export class LocalStorageProvider extends StorageProvider {
  constructor({ rootDir }) {
    super({ providerName: "local" });
    if (!rootDir) throw new TypeError("Local storage root is required");
    this.rootDir = path.resolve(rootDir);
  }

  async put(key, value) {
    const storageKey = normalizeStorageKey(key);
    const target = resolveLocalStoragePath(this.rootDir, storageKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
    return this.metadata(storageKey);
  }

  async get(key) {
    return fs.readFile(resolveLocalStoragePath(this.rootDir, key));
  }

  async exists(key) {
    try {
      await fs.access(resolveLocalStoragePath(this.rootDir, key));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async stat(key) {
    const result = await fs.stat(resolveLocalStoragePath(this.rootDir, key));
    return Object.freeze({ ...this.metadata(key), size: result.size, modifiedAt: result.mtime.toISOString() });
  }

  async remove(key) {
    await fs.rm(resolveLocalStoragePath(this.rootDir, key), { force: true });
  }

  async ensureRoot() {
    await fs.mkdir(this.rootDir, { recursive: true });
    const stat = await fs.lstat(this.rootDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw Object.assign(new Error("Local storage root is invalid"), { code: "STORAGE_ROOT_INVALID" });
    }
    return this.rootDir;
  }

  async resolveExisting(key, options = {}) {
    return resolveExistingFile(this.rootDir, normalizeStorageKey(key), options);
  }

  async resolveNew(key, options = {}) {
    return resolveNewFile(this.rootDir, normalizeStorageKey(key), options);
  }

  async sameFilesystemAs(other) {
    if (!(other instanceof LocalStorageProvider)) return false;
    const [left, right] = await Promise.all([fs.stat(this.rootDir), fs.stat(other.rootDir)]);
    return left.dev === right.dev;
  }

  async moveTo(key, destinationProvider, destinationKey, options = {}) {
    if (!(destinationProvider instanceof LocalStorageProvider)) {
      throw Object.assign(new Error("Local atomic moves require a local destination provider"), { code: "STORAGE_MOVE_UNSUPPORTED" });
    }
    const moved = await atomicMoveFile({
      sourceRoot: this.rootDir,
      sourcePath: resolveLocalStoragePath(this.rootDir, key),
      destinationRoot: destinationProvider.rootDir,
      destinationRelativePath: normalizeStorageKey(destinationKey),
      allowedExtensions: options.allowedExtensions,
    });
    return Object.freeze({ ...destinationProvider.metadata(destinationKey), ...moved });
  }
}
