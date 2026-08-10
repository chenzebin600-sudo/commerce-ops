import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { ShopeeHealthService } from "../lib/shopee-health/service.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-shop-health-"));
  const data = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath: path.join(root, "test.sqlite") });
  return { data, cleanup: () => { data.close(); rmSync(root, { recursive: true, force: true }); } };
}

const shops = [
  { country: "新加坡", code: "SS0001", name: "Risk Shop", shopId: "101" },
  { country: "马来", code: "MS0001", name: "Healthy Shop", shopId: "102" },
];

function mockClient() {
  return {
    async verifyToken() { return { shopIds: ["101", "102"] }; },
    async call({ shopId, apiPath }) {
      const risky = shopId === "101";
      if (apiPath.endsWith("get_shop_performance")) return { data: { response: {
        overall_performance: { rating: risky ? 2 : 4, fulfillment_failed: 0, listing_failed: risky ? 1 : 0, custom_service_failed: 0 },
        metric_list: [{ metric_id: 12, metric_name: "pre_order_listing_rate", metric_type: 2, current_period: risky ? 9 : 4, last_period: 3, unit: 2, target: { comparator: "<=", value: 10 } }],
      } } };
      if (apiPath.endsWith("get_metric_source_detail")) return { data: { response: { metric_id: 12, pre_order_listing_list: [{ item_id: 99 }], total_count: 1 } } };
      if (apiPath.endsWith("get_penalty_point_history")) return { data: { response: { penalty_point_list: risky ? [{ reference_id: 88, latest_point_num: 2, original_point_num: 2, violation_type: 16 }] : [], total_count: risky ? 1 : 0 } } };
      if (apiPath.endsWith("get_punishment_history")) return { data: { response: { punishment_list: [], total_count: 0 } } };
      if (apiPath.endsWith("get_listings_with_issues")) return { data: { response: { listing_list: risky ? [{ item_id: 99, reason: 5 }] : [], total_count: risky ? 1 : 0 } } };
      if (apiPath.endsWith("get_late_orders")) return { data: { response: { late_order_list: risky ? [{ order_sn: "ORDER-1", late_by_days: 1 }] : [], total_count: risky ? 1 : 0 } } };
      throw new Error(`Unexpected API: ${apiPath}`);
    },
  };
}

test("shop health stores encrypted settings, daily snapshots, issues and appeal lifecycle", async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "shop-health-test-key";
  const { data, cleanup } = fixture();
  try {
    const service = new ShopeeHealthService({ repository: data.repositories.shopeeHealth, client: mockClient(), shops, concurrency: 2, now: () => new Date("2026-08-08T01:10:00.000Z") });
    const settings = await service.saveSettings({ tokenKey: "replaceable-key-123456", scheduleTime: "09:00", retryCount: 3, warningRatio: 0.1, siteNotificationsEnabled: true, dingtalkNotificationsEnabled: false });
    assert.equal(settings.tokenConfigured, true);
    assert.equal(settings.tokenShopCount, 2);
    assert.match(settings.tokenHint, /^repl/);
    assert.equal(data.repositories.shopeeHealth.getSettings().encryptedTokenKey, undefined);

    const started = service.startCollection("manual");
    assert.equal(started.started, true);
    await service.activePromise;

    const dashboard = service.dashboard();
    assert.equal(dashboard.summary.healthy, 1);
    assert.equal(dashboard.summary.critical, 1);
    assert.equal(dashboard.summary.activeIssues, 4);
    assert.equal(dashboard.shops.find((shop) => shop.shopId === "101").penaltyPoints, 2);
    assert.ok(dashboard.notifications.length >= 4);

    const penalty = dashboard.issues.find((issue) => issue.issueType === "penalty");
    const appeal = data.repositories.shopeeHealth.createAppeal({ issueId: penalty.id, assigneeUserId: "u1", assigneeName: "运营A" });
    assert.equal(appeal.status, "pending_review");
    const submitted = data.repositories.shopeeHealth.updateAppeal(appeal.id, { status: "submitted", sellerCenterReference: "SC-1", eventNote: "材料已提交" }, { userId: "u1", name: "运营A" });
    assert.equal(submitted.status, "submitted");
    assert.equal(submitted.sellerCenterReference, "SC-1");
    assert.equal(data.repositories.shopeeHealth.listAppealEvents(appeal.id).length, 2);
  } finally {
    cleanup();
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

test("shop health scheduler becomes due once after configured Beijing time", async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "shop-health-test-key";
  const { data, cleanup } = fixture();
  try {
    let current = new Date("2026-08-08T00:59:00.000Z");
    const service = new ShopeeHealthService({ repository: data.repositories.shopeeHealth, client: mockClient(), shops, now: () => current });
    await service.saveSettings({ tokenKey: "replaceable-key-123456", scheduleTime: "09:00", retryCount: 3, warningRatio: 0.1 });
    assert.equal(service.dueForSchedule(current), false);
    current = new Date("2026-08-08T01:00:00.000Z");
    assert.equal(service.dueForSchedule(current), true);
    const result = service.runScheduledIfDue(current);
    assert.equal(result.started, true);
    await service.activePromise;
    assert.equal(service.dueForSchedule(current), false);
  } finally {
    cleanup();
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

test("notifications are optional and DingTalk stays disabled without a robot", async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = "shop-health-test-key";
  const { data, cleanup } = fixture();
  try {
    const service = new ShopeeHealthService({ repository: data.repositories.shopeeHealth, client: mockClient(), shops, concurrency: 2, now: () => new Date("2026-08-08T01:10:00.000Z") });
    const settings = await service.saveSettings({
      tokenKey: "replaceable-key-123456",
      siteNotificationsEnabled: false,
      dingtalkNotificationsEnabled: true,
      dingtalkConfigId: "",
    });
    assert.equal(settings.siteNotificationsEnabled, false);
    assert.equal(settings.dingtalkNotificationsEnabled, false);
    assert.equal(settings.dingtalkConfigId, null);

    service.startCollection("manual");
    await service.activePromise;
    assert.equal(data.repositories.shopeeHealth.listNotifications(20).length, 0);
    assert.equal(service.dashboard().summary.activeIssues, 4);
  } finally {
    cleanup();
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});
