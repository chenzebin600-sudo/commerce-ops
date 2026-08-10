import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";
import { decryptSecret } from "../lib/mabang-scheduler/crypto.mjs";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";
import { FulfillmentRepository } from "../fulfillment-service/repository.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveFulfillmentConfig({ rootDir });
const repository = new FulfillmentRepository(config.databasePath);

function selectedAccount() {
  const profileId = String(repository.getRuntimeSetting("mabangAccountProfileId", "") || "").trim();
  if (!profileId) return config.mabangUsername && config.mabangPassword
    ? { ok: true, username: config.mabangUsername, password: config.mabangPassword }
    : { ok: false, message: "未连接马帮账号" };
  const databasePath = path.resolve(rootDir, process.env.DATABASE_PATH || process.env.SCHEDULER_DB_PATH || "storage/commerce-ops.sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT username,encrypted_password,enabled FROM mabang_account_profiles WHERE id=?").get(profileId);
    if (!row || !Number(row.enabled) || !row.encrypted_password) return { ok: false, message: "所选马帮账号不可用" };
    return { ok: true, username: row.username, password: decryptSecret(row.encrypted_password) };
  } finally { database.close(); }
}

function baseWarehouse(value) {
  return String(value || "").trim().replace(/\/[-\d.]+$/, "").trim();
}

function intersection(lists) {
  if (!lists.length) return [];
  return [...lists.slice(1).reduce((set, list) => new Set([...set].filter((value) => list.has(value))), lists[0])];
}

const references = process.argv.slice(2).map((value) => String(value || "").trim()).filter(Boolean);
if (!references.length) throw new Error("请传入至少一个订单号");
const account = selectedAccount();
if (!account.ok) throw new Error(account.message);
const runWorker = createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
const results = [];
try {
  for (const orderReference of references) {
    const startedAt = Date.now();
    try {
      const inspected = await runWorker({ action: "order-warehouse-inspect", username: account.username,
        password: account.password, orderReference });
      const order = inspected.order || {};
      const policy = repository.getShopPolicy(String(order.shopId || ""));
      const allowedWarehouses = policy?.warehousePolicy === "allowlist" ? policy.allowedWarehouses || [] : [];
      const items = (order.items || []).map((item) => ({ itemId: item.itemId, sku: item.stockSku, quantity: item.quantity,
        currentWarehouse: item.stockWarehouseName,
        selectableWarehouses: [...new Set((item.warehouseOptions || []).map((option) => String(option.text || "").trim()).filter(Boolean))] }));
      const commonSelectable = intersection(items.map((item) => new Set(item.selectableWarehouses.map(baseWarehouse)))).sort();
      const allowedOverlap = allowedWarehouses.filter((warehouse) => commonSelectable.includes(baseWarehouse(warehouse)));
      results.push({ orderReference, elapsedMs: Date.now() - startedAt, shopId: order.shopId,
        platformId: order.platformId, orderStatus: order.orderStatus, allowedWarehouses,
        commonSelectableWarehouses: commonSelectable, allowedOverlap, items });
    } catch (error) {
      results.push({ orderReference, elapsedMs: Date.now() - startedAt,
        error: { code: error.code || "INSPECT_FAILED", message: String(error.message || error).slice(0, 300) } });
    }
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
} finally {
  repository.close();
}
