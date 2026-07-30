import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MabangDataPersistenceService,
  mabangCollectionFingerprint,
} from "../lib/mabang-data/persistence-service.mjs";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mabang-persistence-"));
  const calls = [];
  const growthRadarService = {
    async previewFile(sourceType, input) {
      calls.push({ stage: "preview", sourceType, input: { ...input } });
      assert.equal((await fs.stat(input.filename)).isFile(), true);
      return {
        previewId: `${sourceType}-preview`,
        sourceSha256: input.sourceSha256 || "a".repeat(64),
        rowCount: sourceType === "mabang_order" ? 2 : 1,
      };
    },
    async applyPreview(sourceType, input, audit) {
      calls.push({ stage: "apply", sourceType, input, audit });
      return {
        reused: false,
        batch: { id: `${sourceType}-batch`, rowCount: sourceType === "mabang_order" ? 2 : 1 },
        applicationResult: { createdCount: 1, updatedCount: 0, ignoredCount: 0 },
      };
    },
  };
  const runWorker = async (payload) => {
    calls.push({ stage: "write", payload: { ...payload } });
    await fs.writeFile(payload.outputPath, "test workbook");
    return { ok: true, rows: payload.records.length };
  };
  const service = new MabangDataPersistenceService({
    growthRadarService,
    runWorker,
    tempRoot: root,
    now: () => new Date("2026-07-24T08:00:00.000Z"),
  });
  return { root, calls, service };
}

test("manual order collection is converted, confirmed and persisted", async () => {
  const context = await setup();
  try {
    const result = await context.service.persistCollected({
      kind: "orders",
      columns: ["订单编号", "SKU"],
      records: [
        { 订单编号: "O-1", SKU: "SKU-1" },
        { 订单编号: "O-2", SKU: "SKU-2" },
      ],
      sourceScope: { dateFrom: "2026-07-23", dateTo: "2026-07-24", queryType: "manual_collect" },
      actorLabel: "manual_test",
    });
    assert.deepEqual(result, {
      status: "applied",
      sourceType: "mabang_order",
      batchId: "mabang_order-batch",
      rowCount: 2,
      createdCount: 1,
      updatedCount: 0,
      ignoredCount: 0,
      reused: false,
    });
    const preview = context.calls.find((item) => item.stage === "preview");
    assert.equal(preview.sourceType, "mabang_order");
    assert.equal(preview.input.sourceSha256, null);
    assert.match(preview.input.sourceIdempotencyKey, /^[a-f0-9]{64}$/);
    const apply = context.calls.find((item) => item.stage === "apply");
    assert.equal(apply.audit.confirmationGranted, true);
    assert.equal(apply.audit.actorLabel, "manual_test");
    assert.equal((await fs.readdir(context.root)).length, 0);
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("inventory fingerprint uses source snapshot time and empty collections do not create a batch", async () => {
  const context = await setup();
  try {
    const input = {
      kind: "inventory",
      columns: ["库存SKU", "仓库", "可用库存"],
      records: [{ 库存SKU: "SKU-1", 仓库: "PH", 可用库存: 12 }],
      sourceScope: { snapshotAt: "2026-07-24T08:00:00.000Z", queryType: "manual_collect" },
    };
    await context.service.persistCollected({ ...input, collectedAt: "2026-07-24T08:00:00.000Z" });
    const firstHash = context.calls.find((item) => item.stage === "preview").input.sourceIdempotencyKey;
    context.calls.length = 0;
    await context.service.persistCollected({ ...input, collectedAt: "2026-07-24T09:00:00.000Z" });
    const secondHash = context.calls.find((item) => item.stage === "preview").input.sourceIdempotencyKey;
    assert.equal(firstHash, secondHash);
    context.calls.length = 0;
    await context.service.persistCollected({
      ...input,
      sourceScope: { ...input.sourceScope, snapshotAt: "2026-07-24T09:00:00.000Z" },
      collectedAt: "2026-07-24T09:00:00.000Z",
    });
    const thirdHash = context.calls.find((item) => item.stage === "preview").input.sourceIdempotencyKey;
    assert.notEqual(firstHash, thirdHash);

    context.calls.length = 0;
    const empty = await context.service.persistCollected({
      kind: "inventory",
      columns: ["库存SKU"],
      records: [],
    });
    assert.equal(empty.status, "empty");
    assert.equal(empty.batchId, null);
    assert.equal(context.calls.length, 0);
  } finally {
    await fs.rm(context.root, { recursive: true, force: true });
  }
});

test("scheduled lineage identifiers do not defeat collection idempotency", () => {
  const base = {
    kind: "orders",
    columns: ["订单编号", "SKU"],
    records: [{ 订单编号: "O-1", SKU: "SKU-1" }],
  };
  const first = mabangCollectionFingerprint({
    ...base,
    sourceScope: {
      queryType: "scheduled_export",
      taskId: "task-1",
      runId: "run-1",
      dateFrom: "2026-07-23",
      dateTo: "2026-07-24",
    },
  });
  const repeated = mabangCollectionFingerprint({
    ...base,
    sourceScope: {
      queryType: "scheduled_export",
      taskId: "task-1",
      runId: "run-2",
      dateFrom: "2026-07-23",
      dateTo: "2026-07-24",
    },
  });
  const nextWindow = mabangCollectionFingerprint({
    ...base,
    sourceScope: {
      queryType: "scheduled_export",
      taskId: "task-1",
      runId: "run-3",
      dateFrom: "2026-07-24",
      dateTo: "2026-07-25",
    },
  });
  assert.equal(first, repeated);
  assert.notEqual(first, nextWindow);
});
