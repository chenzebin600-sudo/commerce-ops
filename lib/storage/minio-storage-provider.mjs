import { StorageProvider, normalizeStorageKey } from "./storage-provider.mjs";

export class MinioStorageProvider extends StorageProvider {
  constructor({ client, bucket }) {
    super({ providerName: "minio" });
    if (!client || typeof client.putObject !== "function" || typeof client.getObject !== "function") {
      throw new TypeError("MinIO-compatible client is required");
    }
    if (!bucket) throw new TypeError("MinIO bucket is required");
    this.client = client;
    this.bucket = bucket;
  }

  async put(key, value, metadata = {}) {
    const storageKey = normalizeStorageKey(key);
    await this.client.putObject(this.bucket, storageKey, value, metadata);
    return this.metadata(storageKey);
  }

  async get(key) {
    return this.client.getObject(this.bucket, normalizeStorageKey(key));
  }

  async exists(key) {
    try {
      await this.stat(key);
      return true;
    } catch (error) {
      if (["NoSuchKey", "NotFound"].includes(error?.code) || error?.statusCode === 404) return false;
      throw error;
    }
  }

  async stat(key) {
    const storageKey = normalizeStorageKey(key);
    const result = await this.client.statObject(this.bucket, storageKey);
    return Object.freeze({ ...this.metadata(storageKey), size: Number(result.size), etag: result.etag || null });
  }

  async remove(key) {
    await this.client.removeObject(this.bucket, normalizeStorageKey(key));
  }
}
