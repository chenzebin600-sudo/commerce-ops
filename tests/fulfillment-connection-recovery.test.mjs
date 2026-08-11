import assert from "node:assert/strict";
import test from "node:test";

import { createFulfillmentConnectionRecovery } from "../frontend/commerce-ops-vue/src/services/fulfillment-connection-recovery.ts";

test("短暂断线后健康探测成功会自动清除连接错误且只通知一次", async () => {
  const scheduled = [];
  let attempts = 0;
  let recovered = 0;
  const recovery = createFulfillmentConnectionRecovery({
    probe: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary disconnect");
    },
    onRecovered: () => { recovered += 1; },
    schedule: (callback) => { scheduled.push(callback); return scheduled.length; },
    cancel: () => undefined,
  });

  recovery.start();
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(recovered, 0);
  assert.equal(scheduled.length, 1);
  await scheduled.shift()();
  assert.equal(recovered, 1);
  assert.equal(scheduled.length, 0);

  recovery.start();
  recovery.start();
  assert.equal(scheduled.length, 1);
  recovery.stop();
});
