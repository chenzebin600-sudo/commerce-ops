import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function accountFile(accountProfileId, platform = "shopee") {
  return `${createHash("sha256").update(`${String(accountProfileId || "")}:${String(platform || "shopee").toLowerCase()}`).digest("hex").slice(0, 32)}.json`;
}

function legacyAccountFile(accountProfileId) {
  return `${createHash("sha256").update(String(accountProfileId || "")).digest("hex").slice(0, 32)}.json`;
}

export class InventoryScopeStore {
  constructor({ rootDir }) {
    if (!rootDir) throw new TypeError("Inventory scope rootDir is required");
    this.rootDir = path.resolve(rootDir);
  }

  async save(accountProfileId, inventoryPools, updatedAt = new Date().toISOString(), platform = "shopee") {
    const normalizedPlatform = String(platform || "shopee").toLowerCase();
    await mkdir(this.rootDir, { recursive: true });
    const target = path.join(this.rootDir, accountFile(accountProfileId, normalizedPlatform));
    const temporary = `${target}.${process.pid}.tmp`;
    const payload = { version: 2, accountProfileId: String(accountProfileId), platform: normalizedPlatform, updatedAt, inventoryPools };
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(temporary, target);
    return payload;
  }

  async load(accountProfileId, platform = "shopee") {
    const normalizedPlatform = String(platform || "shopee").toLowerCase();
    const targets = [path.join(this.rootDir, accountFile(accountProfileId, normalizedPlatform))];
    if (normalizedPlatform === "shopee") targets.push(path.join(this.rootDir, legacyAccountFile(accountProfileId)));
    for (const target of targets) {
    try {
      const payload = JSON.parse(await readFile(target, "utf8"));
      if (![1, 2].includes(payload?.version) || String(payload.accountProfileId) !== String(accountProfileId)) return null;
      if (String(payload.platform || "shopee").toLowerCase() !== normalizedPlatform) return null;
      if (!Array.isArray(payload.inventoryPools)) return null;
      return payload;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    }
    return null;
  }
}
