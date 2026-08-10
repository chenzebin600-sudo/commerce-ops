import { createHash } from "node:crypto";

export const SALES_ASSORTMENT_ANALYSIS_STORE_CONTRACT = "COMMERCE-OPS-SALES-ASSORTMENT-AI-LATEST-1.0.0";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validAnalysis(value) {
  return isObject(value)
    && typeof value.id === "string"
    && typeof value.generatedAt === "string"
    && typeof value.provider === "string"
    && typeof value.model === "string"
    && typeof value.promptVersion === "string"
    && isObject(value.analysis);
}

export class SalesAssortmentAnalysisStore {
  constructor({
    storage,
    latestKey = "latest.json",
    backupKey = "latest.backup.json",
    pendingKey = "latest.pending.json",
    maxBytes = 2 * 1024 * 1024,
    now = () => new Date(),
  } = {}) {
    for (const method of ["get", "put", "exists", "remove", "moveTo"]) {
      if (!storage || typeof storage[method] !== "function") {
        throw new TypeError(`Sales assortment analysis storage requires ${method}()`);
      }
    }
    this.storage = storage;
    this.latestKey = latestKey;
    this.backupKey = backupKey;
    this.pendingKey = pendingKey;
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 2 * 1024 * 1024);
    this.now = now;
    this.writeQueue = Promise.resolve();
  }

  #decode(buffer) {
    if (!buffer || buffer.length <= 0 || buffer.length > this.maxBytes) return null;
    try {
      const envelope = JSON.parse(buffer.toString("utf8"));
      if (!isObject(envelope)
        || envelope.contract !== SALES_ASSORTMENT_ANALYSIS_STORE_CONTRACT
        || envelope.version !== 1
        || !validAnalysis(envelope.value)
        || envelope.sha256 !== checksum(envelope.value)) {
        return null;
      }
      return envelope.value;
    } catch {
      return null;
    }
  }

  #encode(value) {
    if (!validAnalysis(value)) throw new TypeError("Sales assortment analysis is invalid");
    const encoded = Buffer.from(`${JSON.stringify({
      contract: SALES_ASSORTMENT_ANALYSIS_STORE_CONTRACT,
      version: 1,
      savedAt: this.now().toISOString(),
      sha256: checksum(value),
      value,
    })}\n`, "utf8");
    if (encoded.length > this.maxBytes) {
      throw Object.assign(new Error("Sales assortment analysis exceeds the persistence size limit"), {
        code: "AI_ANALYSIS_TOO_LARGE",
      });
    }
    return encoded;
  }

  async #loadKey(key) {
    if (!await this.storage.exists(key)) return null;
    return this.#decode(await this.storage.get(key));
  }

  async load() {
    await this.writeQueue.catch(() => {});
    return await this.#loadKey(this.latestKey) || await this.#loadKey(this.backupKey);
  }

  async save(value) {
    const write = async () => {
      const encoded = this.#encode(value);
      if (await this.storage.exists(this.latestKey)) {
        const current = await this.storage.get(this.latestKey);
        if (this.#decode(current)) {
          await this.storage.remove(this.backupKey);
          await this.storage.put(this.backupKey, current);
        }
      }
      await this.storage.remove(this.pendingKey);
      await this.storage.put(this.pendingKey, encoded);
      await this.storage.remove(this.latestKey);
      await this.storage.moveTo(this.pendingKey, this.storage, this.latestKey, {
        allowedExtensions: [".json"],
      });
      return value;
    };
    this.writeQueue = this.writeQueue.then(write, write);
    return this.writeQueue;
  }
}
