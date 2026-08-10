import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InventoryScopeStore } from "../lib/inventory-sync/inventory-scope-store.mjs";

test("inventory pool scope persists by Mabang account", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "inventory-scopes-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new InventoryScopeStore({ rootDir });
  const pools = [{ id: "pool-my", name: "马来库存池", shopIds: ["shop-1"], warehouseNames: ["马来 A 仓"] }];
  await store.save("account-1", pools, "2026-08-06T10:00:00.000Z");
  assert.deepEqual((await store.load("account-1")).inventoryPools, pools);
  const lazadaPools = [{ id: "pool-lazada", name: "Lazada", shopIds: ["lazada-1"], warehouseNames: ["马来 A 仓"] }];
  await store.save("account-1", lazadaPools, "2026-08-06T10:01:00.000Z", "lazada");
  assert.deepEqual((await store.load("account-1", "lazada")).inventoryPools, lazadaPools);
  assert.deepEqual((await store.load("account-1", "shopee")).inventoryPools, pools);
  assert.equal(await store.load("account-2"), null);
});
