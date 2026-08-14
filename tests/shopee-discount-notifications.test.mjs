import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ShopeeDiscountNotifications, buildDingTalkSummary } from "../lib/shopee-discount/notifications.mjs";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";

function notificationRepository() {
  const rows = new Map();
  const dueJobs = [];
  return {
    rows, dueJobs,
    async getNotificationByDedupeKey(key) { return rows.get(key) || null; },
    async createNotification(input) {
      if (rows.has(input.dedupeKey)) return rows.get(input.dedupeKey);
      const row = { id: `notification-${rows.size + 1}`, status: "PENDING", attemptCount: 0, ...input };
      rows.set(input.dedupeKey, row);
      return row;
    },
    async claimNotificationDelivery({ notificationId, expectedAttemptCount }) {
      const row = [...rows.values()].find((entry) => entry.id === notificationId);
      if (!row || row.attemptCount !== expectedAttemptCount || !["PENDING", "RETRY_WAIT"].includes(row.status)) return null;
      Object.assign(row, { status: "SENDING", attemptCount: row.attemptCount + 1, deliveryLeaseUntil: "2026-08-14T01:01:00.000Z" });
      return row;
    },
    async markNotificationDelivery(input) {
      const row = [...rows.values()].find((entry) => entry.id === input.notificationId);
      Object.assign(row, input.patch);
      return row;
    },
    async markNotificationUnknown({ notificationId, reasonCode }) {
      const row = [...rows.values()].find((entry) => entry.id === notificationId);
      if (!row || row.status !== "SENDING" || new Date(row.deliveryLeaseUntil) > new Date("2026-08-14T01:02:00.000Z")) return null;
      Object.assign(row, { status: "FAILED", coordinationState: "UNKNOWN", lastErrorCode: reasonCode });
      return row;
    },
    async createDueJob(input) {
      if (!dueJobs.some((job) => job.dedupeKey === input.dedupeKey)) dueJobs.push(input);
      return input;
    },
  };
}

test("DingTalk sends one configured group only a safe summary and fixed internal entry link", async () => {
  const repository = notificationRepository();
  const sends = [];
  const notifications = new ShopeeDiscountNotifications({
    repository, groupId: "ops-price-control", entryBaseUrl: "https://ops.internal.example",
    transport: async (request) => { sends.push(request); return { ok: true, messageId: "msg-1" }; },
  });
  const result = await notifications.sendReminder({
    dueJobId: "due-1", planId: "plan-1", shopId: "shop-1", severity: "WARNING", hoursBefore: 6,
    counts: { shops: 2, links: 20, variants: 30, exceptions: 1 },
    token: "plain-secret", webhookUrl: "https://evil.invalid/token", prices: [{ sku: "SKU-SECRET", target: "100" }],
    entryUrl: "https://evil.invalid/redirect",
  });

  assert.equal(result.status, "DELIVERED");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].groupId, "ops-price-control");
  const serialized = JSON.stringify(sends[0]);
  assert.match(serialized, /shops: 2/);
  assert.match(serialized, /https:\/\/ops\.internal\.example\/shopee-discount\/plans\/plan-1/);
  assert.doesNotMatch(serialized, /plain-secret|evil\.invalid|SKU-SECRET|"target"/);
});

test("delivered notification is idempotent and retry state is bounded without duplicate fan-out", async () => {
  const repository = notificationRepository();
  let calls = 0;
  const notifications = new ShopeeDiscountNotifications({
    repository, groupId: "ops", entryBaseUrl: "https://ops.internal.example", maxAttempts: 3,
    transport: async () => { calls += 1; if (calls < 2) throw Object.assign(new Error("temporary"), { code: "HTTP_503" }); return { ok: true }; },
    now: () => new Date("2026-08-14T01:00:00.000Z"),
  });
  const first = await notifications.sendReminder({ dueJobId: "due-1", planId: "plan-1", shopId: "1", severity: "INFO", hoursBefore: 24, counts: {} });
  assert.equal(first.status, "RETRY_WAIT");
  assert.equal(repository.dueJobs.length, 1);
  assert.deepEqual(first.businessResult, undefined);

  const retry = await notifications.retry(repository.dueJobs[0].payload);
  assert.equal(retry.status, "DELIVERED");
  const duplicate = await notifications.sendReminder({ dueJobId: "due-1", planId: "plan-1", shopId: "1", severity: "INFO", hoursBefore: 24, counts: {} });
  assert.equal(duplicate.reused, true);
  assert.equal(calls, 2);
  assert.equal(repository.dueJobs.length, 1);
});

test("notification failure never changes the supplied scan, preview, or execution business result", async () => {
  const repository = notificationRepository();
  const notifications = new ShopeeDiscountNotifications({
    repository, groupId: "ops", entryBaseUrl: "https://ops.internal.example", maxAttempts: 1,
    transport: async () => { throw new Error("offline"); },
  });
  const businessResult = Object.freeze({ status: "SUCCEEDED", planId: "plan-1", written: 10 });
  const outcome = await notifications.sendBusinessSummary({
    dedupeKey: "business:plan-1", planId: "plan-1", severity: "INFO", title: "Execution complete",
    counts: { variants: 10 }, businessResult,
  });
  assert.equal(outcome.notification.status, "FAILED");
  assert.strictEqual(outcome.businessResult, businessResult);
});

test("recovered SENDING delivery becomes explicit UNKNOWN coordination and is never blindly resent", async () => {
  const repository = notificationRepository();
  repository.rows.set("reminder:due-crash", {
    id: "notification-crash", dedupeKey: "reminder:due-crash", notificationType: "RENEWAL_REMINDER",
    status: "SENDING", coordinationState: null, attemptCount: 1, deliveryLeaseUntil: "2026-08-14T01:01:00.000Z",
    metadata: { summaryInput: { planId: "plan-1", shopId: "1", severity: "WARNING", hoursBefore: 6, counts: {} } },
  });
  let sends = 0;
  const notifications = new ShopeeDiscountNotifications({ repository, groupId: "ops", entryBaseUrl: "https://ops.internal.example",
    transport: async () => { sends += 1; return { ok: true }; } });
  await assert.rejects(notifications.sendReminder({ dueJobId: "due-crash", planId: "plan-1", shopId: "1", severity: "WARNING", hoursBefore: 6, counts: {} }), {
    code: "SHOPEE_DISCOUNT_NOTIFICATION_COORDINATION_REQUIRED",
  });
  assert.equal(sends, 0);
  assert.equal(repository.rows.get("reminder:due-crash").coordinationState, "UNKNOWN");
  assert.equal(repository.rows.get("reminder:due-crash").lastErrorCode, "DINGTALK_DELIVERY_UNKNOWN");
});

test("summary builder rejects unsafe configuration and ignores arbitrary caller fields", () => {
  assert.throws(() => buildDingTalkSummary({ planId: "plan-1", severity: "INFO", counts: {} }, { entryBaseUrl: "https://evil.invalid", allowedEntryHost: "ops.internal.example" }), {
    code: "SHOPEE_DISCOUNT_NOTIFICATION_CONFIG_INVALID",
  });
  const payload = buildDingTalkSummary({ planId: "plan-1", severity: "CRITICAL", counts: { variants: 2 }, markdown: "secret" }, {
    entryBaseUrl: "https://ops.internal.example", allowedEntryHost: "ops.internal.example",
  });
  assert.doesNotMatch(JSON.stringify(payload), /secret/);
});

test("SQLite notification delivery state and dedupe survive a database restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-discount-notification-"));
  const databasePath = path.join(root, "commerce.sqlite");
  let access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
  try {
    const repository = access.repositories.shopeeDiscount;
    const created = await repository.createNotification({
      dedupeKey: "reminder:durable-1", planId: null, notificationType: "RENEWAL_REMINDER", severity: "INFO",
      title: "Shopee Discount INFO", message: "Safe operational summary", channel: "DINGTALK_GROUP",
      metadata: { summaryInput: { planId: "plan-1", severity: "INFO", counts: {} } },
    });
    await repository.claimNotificationDelivery({ notificationId: created.id, expectedAttemptCount: 0 });
    await repository.markNotificationDelivery({ notificationId: created.id, patch: {
      status: "RETRY_WAIT", attemptCount: 1, lastErrorCode: "HTTP_503",
    } });
    access.close();
    access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
    const restored = await access.repositories.shopeeDiscount.getNotificationByDedupeKey("reminder:durable-1");
    assert.equal(restored.status, "RETRY_WAIT");
    assert.equal(restored.attemptCount, 1);
    assert.equal(restored.lastErrorCode, "HTTP_503");
    await assert.rejects(access.repositories.shopeeDiscount.createNotification({
      dedupeKey: "reminder:durable-1", planId: null, notificationType: "RENEWAL_REMINDER", severity: "INFO",
      title: "duplicate", message: "duplicate", channel: "DINGTALK_GROUP", metadata: {},
    }), /UNIQUE/);
    const crashed = await access.repositories.shopeeDiscount.createNotification({
      dedupeKey: "reminder:crashed", planId: null, notificationType: "RENEWAL_REMINDER", severity: "WARNING",
      title: "Shopee Discount WARNING", message: "Safe operational summary", channel: "DINGTALK_GROUP", metadata: {},
    });
    await access.repositories.shopeeDiscount.claimNotificationDelivery({ notificationId: crashed.id, expectedAttemptCount: 0 });
    access.provider.connection.prepare("UPDATE shopee_discount_notifications SET delivery_lease_until=? WHERE id=?")
      .run("2000-01-01T00:00:00.000Z", crashed.id);
    await access.repositories.shopeeDiscount.markNotificationUnknown({ notificationId: crashed.id, evidence: { recovery: true } });
    access.close();
    access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath, migrationsDir: path.resolve("migrations") });
    const coordinated = await access.repositories.shopeeDiscount.getNotificationByDedupeKey("reminder:crashed");
    assert.equal(coordinated.status, "FAILED");
    assert.equal(coordinated.coordinationState, "UNKNOWN");
    assert.deepEqual(coordinated.coordinationEvidence, { recovery: true });
  } finally {
    access.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
