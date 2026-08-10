import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function accountFile(accountProfileId, platform = "shopee") {
  const digest = createHash("sha256").update(`${String(accountProfileId || "")}:${String(platform || "shopee").toLowerCase()}`).digest("hex").slice(0, 32);
  return `${digest}.json`;
}

function legacyAccountFile(accountProfileId) {
  const digest = createHash("sha256").update(String(accountProfileId || "")).digest("hex").slice(0, 32);
  return `${digest}.json`;
}

export class InventorySnapshotStore {
  constructor({ rootDir }) {
    if (!rootDir) throw new TypeError("Inventory snapshot rootDir is required");
    this.rootDir = path.resolve(rootDir);
  }

  async save(snapshot) {
    await mkdir(this.rootDir, { recursive: true });
    const target = path.join(this.rootDir, accountFile(snapshot?.accountProfileId, snapshot?.platform));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, snapshot })}\n`, "utf8");
    await rename(temporary, target);
    return snapshot;
  }

  async loadLatest(accountProfileId, platform = "shopee") {
    const normalizedPlatform = String(platform || "shopee").toLowerCase();
    const targets = [path.join(this.rootDir, accountFile(accountProfileId, normalizedPlatform))];
    if (normalizedPlatform === "shopee") targets.push(path.join(this.rootDir, legacyAccountFile(accountProfileId)));
    for (const target of targets) {
    try {
      const payload = JSON.parse(await readFile(target, "utf8"));
      const snapshot = payload?.version === 1 ? payload.snapshot : null;
      if (!snapshot || String(snapshot.accountProfileId) !== String(accountProfileId)) return null;
      if (String(snapshot.platform || "shopee").toLowerCase() !== normalizedPlatform) return null;
      if (!Array.isArray(snapshot.records) || !snapshot.id || !snapshot.expiresAt) return null;
      return snapshot;
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    }
    return null;
  }
}
