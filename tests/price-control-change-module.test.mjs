import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { FoundationService } from "../lib/foundation/foundation-service.mjs";
import {
  buildChangeText,
  calculateChange,
  expandSourcePriceRow,
  formatPrice,
  nextAlignedAutomationRunAt,
  parsePriceToCents,
} from "../lib/price-control/price-control-contracts.mjs";
import { PriceControlService } from "../lib/price-control/price-control-service.mjs";
import { MysqlPriceControlSource } from "../lib/price-control/mysql-price-control-source.mjs";
import { PriceControlScheduleRunner } from "../lib/price-control/price-control-schedule-runner.mjs";
import { buildPriceControlChangeNotification } from "../lib/price-control/price-control-dingtalk.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sourceRow({ applyNo, price, name = "折叠收纳架", category = "家具用品", sku = "T3AA2041455", prices = {} }) {
  return {
    id: `${applyNo}-1`,
    apply_no: applyNo,
    country_code: "TW",
    categrory: category,
    sku,
    sku_status: "平销款",
    shopee_rc_price: price,
    ...prices,
    seq: 0,
    product_name_cn: name,
  };
}

class FakePriceSource {
  constructor() {
    this.batches = [];
    this.rows = new Map();
    this.lastDiscoveryOptions = null;
  }

  async fetchLatestApprovedBatches(options) { this.lastDiscoveryOptions = options; return this.batches; }
  async fetchApprovedBatch(batch) { return this.rows.get(batch.applyNo) || []; }
  async fetchMetadata() {
    return { sourceCheckedAt: "2026-08-05 16:00:00", tableUpdatedAt: "2026-08-05 15:58:00" };
  }
  sourceVersion(batches) { return batches.map((batch) => batch.applyNo).join("|"); }
}

async function context(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "price-control-"));
  const access = openCommerceDataAccess({ rootDir, databasePath: path.join(directory, "isolated.sqlite") });
  t.after(async () => {
    access.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const foundation = new FoundationService({ repository: access.repositories.foundation });
  const source = new FakePriceSource();
  const service = new PriceControlService({
    repository: access.repositories.priceControl,
    source,
    foundationRepository: access.repositories.foundation,
    foundationTaskService: foundation.tasks,
    notificationConfigRepository: access.repositories.scheduler,
    manualSyncEnabled: true,
    now: () => new Date("2026-08-05T08:00:00.000Z"),
  });
  return { access, source, service };
}

test("price contract expands the 15 source columns and compares decimal prices exactly", () => {
  const points = expandSourcePriceRow(sourceRow({ applyNo: "PC-A", price: "199.90" }));
  assert.equal(points.length, 15);
  const shopeeRegular = points.find((point) => point.platform === "SHOPEE" && point.shopType === "STANDARD" && point.priceType === "REGULAR");
  assert.equal(shopeeRegular.priceValue, "199.90");
  assert.equal(parsePriceToCents("199.90"), 19990n);
  assert.equal(formatPrice(-105n), "-1.05");
  assert.deepEqual(calculateChange("199.90", "189.90"), {
    direction: "DOWN", oldPrice: "199.90", newPrice: "189.90", deltaValue: "-10.00", deltaPercent: -5,
  });
});

test("hourly automation aligns to the next whole hour without execution drift", () => {
  assert.equal(
    nextAlignedAutomationRunAt(new Date("2026-08-06T02:48:20.683Z"), 60).toISOString(),
    "2026-08-06T03:00:00.000Z",
  );
  assert.equal(
    nextAlignedAutomationRunAt(new Date("2026-08-06T03:00:00.000Z"), 60).toISOString(),
    "2026-08-06T04:00:00.000Z",
  );
});

test("MySQL adapter wraps every source operation in a read-only snapshot and rollback", async () => {
  const calls = [];
  const connection = {
    async query(input) { calls.push(input); return [[{ value: 1 }]]; },
    async rollback() { calls.push("ROLLBACK"); },
    release() { calls.push("RELEASE"); },
  };
  const source = new MysqlPriceControlSource({ configured: true, queryTimeout: 45_000 }, {
    pool: { async getConnection() { calls.push("GET_CONNECTION"); return connection; } },
  });
  const result = await source.withReadOnlySnapshot(async () => "ok");
  assert.equal(result, "ok");
  assert.deepEqual(calls, [
    "GET_CONNECTION",
    { sql: "SET TRANSACTION READ ONLY", timeout: 45_000 },
    { sql: "START TRANSACTION WITH CONSISTENT SNAPSHOT", timeout: 45_000 },
    "ROLLBACK",
    "RELEASE",
  ]);
});

test("MySQL discovery enforces one latest approved batch per country and category", async () => {
  const queries = [];
  const connection = {
    async query(input) {
      queries.push(input);
      if (String(input?.sql || "").includes("WITH approved_batches")) return [[]];
      return [[{ value: 1 }]];
    },
    async rollback() {},
    release() {},
  };
  const source = new MysqlPriceControlSource({ configured: true, queryTimeout: 45_000 }, {
    pool: { async getConnection() { return connection; } },
  });
  await source.fetchLatestApprovedBatches({ limit: 200, perCountry: 5 });
  const discovery = queries.find((input) => String(input?.sql || "").includes("WITH approved_batches"));
  assert.match(discovery.sql, /country_rank<=1/);
  assert.doesNotMatch(discovery.sql, /country_rank<=5/);
});

test("stale price-control runs are atomically failed with their Foundation source run", async (t) => {
  const { access, service } = await context(t);
  const staleAt = new Date("2026-08-05T07:00:00.000Z");
  const stale = await access.repositories.priceControl.createRun({
    triggerType: "scheduled",
    syncMode: "incremental",
    inputFingerprint: "stale-run",
  }, staleAt);
  const sourceRun = await access.repositories.foundation.upsertSourceRun({
    sourceSystem: "ai_project_a",
    accountId: "foundation:account:ai_project_a:environment",
    domain: "product",
    sourceRefType: "price_control_sync_run",
    sourceRefId: stale.id,
    status: "RUNNING",
    inputFingerprint: "stale-run",
    evidence: { requestedBy: "test" },
    startedAt: staleAt.toISOString(),
  }, staleAt);
  await access.repositories.priceControl.updateRun(stale.id, {
    foundationSourceRunId: sourceRun.id,
  }, staleAt);

  const recovered = await service.recoverStaleRun({ requestedBy: "test-recovery" });
  assert.equal(recovered.run.status, "FAILED");
  assert.equal(recovered.run.errorCode, "PRICE_CONTROL_STALE_RUN_RECOVERED");
  assert.equal(recovered.foundationRecovered, true);
  assert.equal(await access.repositories.priceControl.getActiveRun(), null);
  const foundationResult = await access.provider.query(
    "SELECT status,finished_at FROM foundation_source_runs WHERE id=?",
    [sourceRun.id],
  );
  assert.equal(foundationResult.rows[0].status, "FAILED");
  assert.equal(foundationResult.rows[0].finished_at, "2026-08-05T08:00:00.000Z");
  assert.equal(await service.recoverStaleRun({ requestedBy: "test-recovery" }), null);

  const fresh = await access.repositories.priceControl.createRun({
    triggerType: "scheduled",
    syncMode: "incremental",
    inputFingerprint: "fresh-run",
  }, new Date("2026-08-05T07:45:00.000Z"));
  assert.equal(await service.recoverStaleRun({ requestedBy: "test-recovery" }), null);
  assert.equal((await access.repositories.priceControl.getActiveRun()).id, fresh.id);
});

test("change text contains the required country, category, sku, Chinese name, platform, shop and direction", () => {
  const text = buildChangeText({
    countryCode: "TW", categoryName: "家具用品", sku: "T3AA2041455", productNameCn: "折叠收纳架",
    platform: "SHOPEE", shopType: "MALL", priceType: "CAMPAIGN",
    oldPrice: "199.00", newPrice: "189.00", deltaValue: "-10.00", deltaPercent: -5.03, direction: "DOWN",
  });
  assert.equal(text, "国家：TW；类目：家具用品；SKU：T3AA2041455；商品中文名：折叠收纳架；平台：Shopee；店铺类型：Mall 店；价格类型：活动价；从原价 199.00 变更到现价 189.00，下调 10.00（5.03%）。");
});

test("baseline is silent, incremental sync creates one deterministic change and one Foundation task", async (t) => {
  const { access, source, service } = await context(t);
  source.batches = [{
    applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", sourceRowCount: 1,
    applyCreatedAt: "2026-08-01 10:00:00", submittedAt: "2026-08-01 10:01:00",
    approvedAt: "2026-08-01 10:02:00", effectiveAt: "2026-08-01 10:02:00",
  }];
  source.rows.set("PC-A", [sourceRow({ applyNo: "PC-A", price: "100.00" })]);

  const baseline = await service.sync({ mode: "baseline", triggerType: "manual", requestedBy: "test" });
  assert.equal(baseline.run.changeCount, 0);
  assert.equal(baseline.run.sourceTableUpdatedAt, "2026-08-05 15:58:00");
  assert.equal(baseline.run.sourceBusinessUpdatedAt, "2026-08-01 10:02:00");
  assert.equal(baseline.run.fetchedAt, "2026-08-05T08:00:00.000Z");
  assert.equal(await access.repositories.priceControl.currentPriceCount(), 1);
  const current = await service.listCurrentPrices({ page: 1, pageSize: 20 });
  assert.equal(current.total, 1);
  assert.equal(current.prices[0].priceValue, "100.00");

  source.batches = [...source.batches, {
    applyNo: "PC-B", countryCode: "TW", approvalStatus: "CA", sourceRowCount: 1,
    applyCreatedAt: "2026-08-02 10:00:00", submittedAt: "2026-08-02 10:01:00",
    approvedAt: "2026-08-02 10:02:00", effectiveAt: "2026-08-02 10:02:00",
  }];
  source.rows.set("PC-B", [sourceRow({ applyNo: "PC-B", price: "110.00" })]);

  const incremental = await service.sync({ mode: "incremental", triggerType: "manual", requestedBy: "test" });
  assert.equal(source.lastDiscoveryOptions.perCountry, 1);
  assert.equal(incremental.run.changeCount, 1);
  assert.equal(incremental.changes[0].direction, "UP");
  assert.match(incremental.notificationText, /国家：TW.*SKU：T3AA2041455.*从原价 100\.00 变更到现价 110\.00，上涨 10\.00/);

  const listed = await service.listChanges({ page: 1, pageSize: 20 });
  assert.equal(listed.total, 1);
  assert.equal(listed.changes[0].adjustmentStatus, "UNADJUSTED");
  assert.ok(listed.changes[0].foundationTaskId);
  const task = await access.repositories.foundation.getTask(listed.changes[0].foundationTaskId);
  assert.equal(task.taskKind, "price_control_change_review");
  assert.equal(task.state, "READY");
  assert.equal(task.sourceRunId, incremental.run.foundationSourceRunId);

  const roundResult = await service.listChangeRounds({ limit: 10 });
  assert.equal(roundResult.rounds.length, 1);
  assert.equal(roundResult.rounds[0].id, incremental.run.id);
  assert.equal(roundResult.rounds[0].changeCount, 1);
  assert.equal(roundResult.rounds[0].affectedSkuCount, 1);
  assert.equal(roundResult.rounds[0].unadjustedCount, 1);
  const initialCopy = await service.copyChangeRound(incremental.run.id, { requestedBy: "test" });
  assert.equal(initialCopy.count, 1);
  assert.match(initialCopy.text, /涉及 SKU：1；有效变更：1；已调整：0；未调整：1/);
  assert.match(initialCopy.text, /处理状态：未调整/);

  const adjusted = await service.updateAdjustment(listed.changes[0].id, {
    status: "ADJUSTED",
    remark: "已在马帮人工调整并复核",
  }, { requestedBy: "test-user" });
  assert.equal(adjusted.adjustmentStatus, "ADJUSTED");
  assert.equal(adjusted.adjustmentRemark, "已在马帮人工调整并复核");
  assert.equal((await service.listChanges({ adjustmentStatus: "UNADJUSTED" })).total, 0);
  assert.equal((await service.listChanges({ adjustmentStatus: "ADJUSTED" })).total, 1);
  const updatedRound = (await service.listChangeRounds({ limit: 10 })).rounds[0];
  assert.equal(updatedRound.adjustedCount, 1);
  assert.equal(updatedRound.unadjustedCount, 0);
  const updatedCopy = await service.copyChangeRound(incremental.run.id, { requestedBy: "test" });
  assert.match(updatedCopy.text, /处理状态：已调整；备注：已在马帮人工调整并复核/);
  const taskEvents = await access.repositories.foundation.listTaskEvents(task.id);
  assert.equal(taskEvents.at(-1).eventType, "PRICE_CONTROL_ADJUSTMENT_UPDATED");
  assert.equal(taskEvents.at(-1).evidence.changeId, listed.changes[0].id);
  const updatedTask = await access.repositories.foundation.getTask(task.id);
  assert.deepEqual(updatedTask.result.priceControlAdjustment, {
    total: 1,
    adjustedCount: 1,
    unadjustedCount: 0,
    lastChangeId: listed.changes[0].id,
    lastStatus: "ADJUSTED",
    updatedAt: "2026-08-05T08:00:00.000Z",
    updatedBy: "test-user",
  });

  const replay = await service.sync({ mode: "incremental", triggerType: "manual", requestedBy: "test" });
  assert.equal(replay.run.changeCount, 0);
  assert.equal((await service.listChanges({})).total, 1);
});

test("incremental sync compares every platform independently and does not alert without a previous price", async (t) => {
  const { source, service } = await context(t);
  source.batches = [{
    applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-01 10:02:00",
  }];
  source.rows.set("PC-A", [sourceRow({
    applyNo: "PC-A", price: "100.00",
    prices: { lazada_rc_price: "200.00", tiktok_rc_price: "300.00" },
  })]);
  await service.sync({ mode: "baseline", triggerType: "manual", requestedBy: "test" });

  source.batches = [...source.batches, {
    applyNo: "PC-B", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-02 10:02:00",
  }];
  source.rows.set("PC-B", [
    sourceRow({
      applyNo: "PC-B", price: "110.00",
      prices: { lazada_rc_price: "210.00", tiktok_rc_price: "310.00" },
    }),
    sourceRow({ applyNo: "PC-B", sku: "NEW-SKU", price: "99.00" }),
  ]);
  const incremental = await service.sync({ mode: "incremental", triggerType: "manual", requestedBy: "test" });

  assert.equal(incremental.run.changeCount, 3);
  assert.deepEqual(new Set(incremental.changes.map((change) => change.platform)), new Set(["LAZADA", "SHOPEE", "TIKTOK"]));
  assert.ok(incremental.changes.every((change) => change.direction === "UP" && change.oldPrice !== null));
  assert.equal((await service.listChanges({ sku: "NEW-SKU", validityStatus: "ALL" })).total, 0);
  assert.equal((await service.listCurrentPrices({ sku: "NEW-SKU" })).total, 1);
});

test("incremental sync keeps only the newest price transition when source scopes overlap", async (t) => {
  const { source, service } = await context(t);
  source.batches = [{
    applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-01 10:02:00",
  }];
  source.rows.set("PC-A", [sourceRow({ applyNo: "PC-A", price: "100.00" })]);
  await service.sync({ mode: "baseline", triggerType: "manual", requestedBy: "test" });

  source.batches = [...source.batches,
    { applyNo: "PC-B", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-02 10:02:00" },
    { applyNo: "PC-C", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-03 10:02:00" },
  ];
  source.rows.set("PC-B", [sourceRow({ applyNo: "PC-B", price: "110.00" })]);
  source.rows.set("PC-C", [sourceRow({ applyNo: "PC-C", price: "120.00" })]);
  const incremental = await service.sync({ mode: "incremental", triggerType: "manual", requestedBy: "test" });

  assert.equal(incremental.run.changeCount, 1);
  assert.equal(incremental.changes[0].applyNo, "PC-C");
  assert.equal(incremental.changes[0].oldPrice, "100.00");
  assert.equal(incremental.changes[0].newPrice, "120.00");
});

test("incremental sync refuses to turn the first snapshot into false NEW alerts", async (t) => {
  const { source, service } = await context(t);
  source.batches = [{ applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-01 10:02:00" }];
  source.rows.set("PC-A", [sourceRow({ applyNo: "PC-A", price: "100.00" })]);
  await assert.rejects(
    service.sync({ mode: "incremental", triggerType: "manual" }),
    (error) => error.code === "PRICE_CONTROL_BASELINE_REQUIRED",
  );
});

test("NULL in a later batch carries the prior price forward and creates no removal", async (t) => {
  const { source, service } = await context(t);
  source.batches = [{
    applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-01 10:02:00",
  }];
  source.rows.set("PC-A", [sourceRow({ applyNo: "PC-A", price: "100.00" })]);
  await service.sync({ mode: "baseline", triggerType: "manual", requestedBy: "test" });

  source.batches = [...source.batches, {
    applyNo: "PC-B", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-02 10:02:00",
  }];
  source.rows.set("PC-B", [sourceRow({ applyNo: "PC-B", price: null })]);
  const incremental = await service.sync({ mode: "incremental", triggerType: "manual", requestedBy: "test" });

  assert.equal(incremental.run.changeCount, 0);
  assert.equal((await service.listChanges({ validityStatus: "ALL" })).total, 0);
  const current = await service.listCurrentPrices({ page: 1, pageSize: 20 });
  assert.equal(current.total, 1);
  assert.equal(current.prices[0].priceValue, "100.00");
  assert.equal(current.prices[0].sourceApplyNo, "PC-A");
});

test("repair preserves false events as invalid, restores baseline, and cancels invalid-only tasks", async (t) => {
  const { access, source, service } = await context(t);
  source.batches = [{
    applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", effectiveAt: "2026-08-01 10:02:00",
  }];
  source.rows.set("PC-A", [sourceRow({ applyNo: "PC-A", price: "100.00" })]);
  await service.sync({ mode: "baseline", triggerType: "manual", requestedBy: "test" });

  const current = await service.listCurrentPrices({ page: 1, pageSize: 20 });
  const price = current.prices[0];
  const task = await new FoundationService({ repository: access.repositories.foundation }).tasks.create({
    domain: "product",
    taskKind: "price_control_change_review",
    executionMode: "human",
    domainRefType: "price_control_batch_country",
    domainRefId: "PC-B:TW",
    sourceState: "approved_price_changed",
    state: "READY",
    priority: "P1",
    idempotencyKey: "price-control-change:PC-B:TW",
    input: {}, evidence: {}, createdBy: "test",
  });
  await access.provider.execute(
    `INSERT INTO product_price_change_events (
      id,sync_run_id,source_apply_no,price_key,country_code,sku,platform,shop_type,price_type,
      old_price,new_price,direction,change_text,change_fingerprint,foundation_task_id,detected_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["false-removed", (await service.listRuns({})).runs[0].id, "PC-A", price.priceKey, "TW", price.sku,
      price.platform, price.shopType, price.priceType, "100.00", null, "REMOVED", "false removal",
      "false-removal-fingerprint", task.id, "2026-08-05T08:00:00.000Z", "2026-08-05T08:00:00.000Z"],
  );
  await access.provider.execute("DELETE FROM product_sku_current_prices WHERE price_key=?", [price.priceKey]);

  const repaired = await service.repairNullSemantics({ requestedBy: "test" });
  assert.equal(repaired.invalidRemoved, 1);
  assert.equal(repaired.currentPriceCount, 1);
  assert.equal((await service.listChanges({})).total, 0);
  const history = await service.listChanges({ validityStatus: "ALL" });
  assert.equal(history.total, 1);
  assert.equal(history.changes[0].validityStatus, "INVALID");
  assert.equal(history.changes[0].invalidReason, "SOURCE_NULL_NOT_MAINTAINED");
  assert.equal((await access.repositories.foundation.getTask(task.id)).state, "CANCELLED");
});

test("automation defaults to one hour and sends DingTalk only when a scheduled sync finds changes", async (t) => {
  const { access, source, service } = await context(t);
  const robot = access.repositories.scheduler.saveDingtalkConfig({
    name: "Price Control Test Robot",
    encryptedWebhookUrl: "encrypted-test-webhook",
    encryptedSecret: "",
    enabled: true,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnEmpty: false,
    atAll: false,
    atMobiles: [],
  });
  const initial = await service.automation();
  assert.equal(initial.ready, true);
  assert.equal(initial.settings.enabled, false);
  assert.equal(initial.settings.intervalMinutes, 60);

  source.batches = [{
    applyNo: "PC-A", countryCode: "TW", approvalStatus: "CA", sourceRowCount: 1,
    approvedAt: "2026-08-01 10:02:00", effectiveAt: "2026-08-01 10:02:00",
  }];
  source.rows.set("PC-A", [sourceRow({ applyNo: "PC-A", price: "100.00" })]);
  await service.sync({ mode: "baseline", triggerType: "manual", requestedBy: "test" });
  const saved = await service.saveAutomation({
    enabled: true,
    intervalMinutes: 60,
    dingtalkConfigId: robot.id,
    notifyOnChange: true,
    notifyOnFailure: true,
  }, { requestedBy: "test" });
  assert.equal(saved.intervalMinutes, 60);
  assert.equal(saved.nextRunAt, "2026-08-05T09:00:00.000Z");

  source.batches = [...source.batches, {
    applyNo: "PC-B", countryCode: "TW", approvalStatus: "CA", sourceRowCount: 1,
    approvedAt: "2026-08-02 10:02:00", effectiveAt: "2026-08-02 10:02:00",
  }];
  source.rows.set("PC-B", [sourceRow({ applyNo: "PC-B", price: "110.00" })]);
  const dueAt = new Date("2026-08-05T09:01:00.000Z");
  const settings = await service.claimDueAutomation(dueAt);
  assert.equal(settings.dingtalkConfigId, robot.id);
  assert.equal(settings.nextRunAt, "2026-08-05T10:00:00.000Z");
  const sent = [];
  const runner = new PriceControlScheduleRunner({
    service,
    notifier: { async sendChanges(payload) { sent.push(payload); } },
    now: () => dueAt,
  });
  const result = await runner.runOnce(settings);
  assert.equal(result.run.changeCount, 1);
  assert.equal(result.notificationStatus, "SENT");
  assert.equal(sent.length, 1);
  const completed = await service.automation();
  assert.equal(completed.settings.lastRunStatus, "SUCCEEDED");
  assert.equal(completed.settings.lastNotificationStatus, "SENT");
});

test("DingTalk change notification includes timestamps and bounded copy-ready change text", () => {
  const notification = buildPriceControlChangeNotification({
    run: {
      sourceBusinessUpdatedAt: "2026-08-05 18:00:00",
      sourceTableUpdatedAt: "2026-08-05 18:01:00",
      fetchedAt: "2026-08-05T10:02:00.000Z",
    },
    changes: [{ countryCode: "TW", direction: "UP", changeText: "国家：TW；SKU：SKU-1；从原价 10.00 变更到现价 11.00，上涨。" }],
  });
  assert.match(notification.title, /1 条/);
  assert.match(notification.markdown, /最新审批数据时间/);
  assert.match(notification.markdown, /国家：TW；SKU：SKU-1/);
  assert.match(notification.markdown, /不会自动刊登/);
});

test("DingTalk notification represents every changed platform instead of slicing only Lazada", () => {
  const changes = [
    ...Array.from({ length: 40 }, (_, index) => ({
      platform: "LAZADA", countryCode: "ID", direction: "UP", changeText: `Lazada-${index + 1}`,
    })),
    { platform: "SHOPEE", countryCode: "TH", direction: "DOWN", changeText: "Shopee-visible" },
    { platform: "TIKTOK", countryCode: "VN", direction: "UP", changeText: "TikTok-visible" },
  ];
  const notification = buildPriceControlChangeNotification({ run: {}, changes }, { visibleLimit: 6 });
  assert.match(notification.markdown, /平台分布：Lazada 40、Shopee 1、TikTok Shop 1/);
  assert.match(notification.markdown, /Shopee-visible/);
  assert.match(notification.markdown, /TikTok-visible/);
  assert.match(notification.markdown, /另有 36 条变更/);
});
