import assert from "node:assert/strict";
import test from "node:test";
import { OperationDrainController } from "../lib/operation-drain.mjs";

test("排空模式等待现有任务并拒绝新任务", async () => {
  const controller = new OperationDrainController({ now: () => new Date("2026-08-10T08:00:00.000Z") });
  let finish;
  const running = controller.run("warehouse-batch-execute", { write: true }, () => new Promise((resolve) => { finish = resolve; }));
  assert.deepEqual(controller.status(), { draining: false, activeOperations: 1, activeWriteOperations: 1,
    operationKinds: ["warehouse-batch-execute"] });
  controller.beginDrain();
  await assert.rejects(controller.run("sku-plan", {}, async () => null), (error) => error.code === "FULFILLMENT_DRAINING");
  const idle = controller.waitForIdle(1000);
  finish("done");
  assert.equal(await running, "done");
  assert.equal(await idle, true);
  assert.equal(controller.status().activeOperations, 0);
});

test("同步门禁在创建持久后台任务前拒绝排空期请求", () => {
  const controller = new OperationDrainController();
  controller.assertAccepting();
  controller.beginDrain();
  assert.throws(() => controller.assertAccepting(), (error) => error.code === "FULFILLMENT_DRAINING");
});
