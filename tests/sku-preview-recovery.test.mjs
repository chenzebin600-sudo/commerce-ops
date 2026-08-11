import assert from "node:assert/strict";
import test from "node:test";
import { recoverSkuPreviewWithRetry } from "../frontend/commerce-ops-vue/src/services/sku-preview-recovery.ts";

test("SKU 预览回传超时后等待后台落盘并重试恢复", async () => {
  let attempts = 0;
  const waits = [];
  const result = await recoverSkuPreviewWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("尚未落盘");
    return { plans: 90 };
  }, { attempts: 4, delayMs: 10, sleep: async (milliseconds) => { waits.push(milliseconds); } });
  assert.deepEqual(result, { plans: 90 });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 10]);
});
