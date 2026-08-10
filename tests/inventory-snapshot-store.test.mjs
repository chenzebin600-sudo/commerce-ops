import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InventorySnapshotStore } from "../lib/inventory-sync/inventory-snapshot-store.mjs";

test("inventory snapshots persist by account without credentials", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "inventory-snapshots-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new InventorySnapshotStore({ rootDir });
  const snapshot = {
    id: "snapshot-1",
    accountProfileId: "account-1",
    capturedAt: "2026-08-06T10:00:00.000Z",
    expiresAt: "2026-08-06T10:15:00.000Z",
    records: [{ 库存SKU编号: "SKU-1", 仓库: "仓库 A", 可用库存量: 10 }],
    shops: [{ id: "shop-1", name: "Shop 1", site: "MY" }],
  };
  await store.save(snapshot);
  assert.deepEqual(await store.loadLatest("account-1"), snapshot);
  await store.save({ ...snapshot, id: "snapshot-2" });
  assert.equal((await store.loadLatest("account-1")).id, "snapshot-2");
  assert.equal(await store.loadLatest("account-2"), null);
  const lazada = { ...snapshot, id: "snapshot-lazada", platform: "lazada" };
  await store.save(lazada);
  assert.equal((await store.loadLatest("account-1", "lazada")).id, "snapshot-lazada");
  assert.equal((await store.loadLatest("account-1", "shopee")).id, "snapshot-2");
  const files = await import("node:fs/promises").then((fs) => fs.readdir(rootDir));
  const raw = await readFile(path.join(rootDir, files[0]), "utf8");
  assert.doesNotMatch(raw, /password|cookie|authorization/i);
});
