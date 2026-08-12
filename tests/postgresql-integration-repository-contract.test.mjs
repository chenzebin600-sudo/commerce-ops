import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DATABASE_DIALECTS } from "../lib/data/database-provider.mjs";
import { PostgresqlShopeeHealthRepository } from "../lib/shopee-health/postgresql-repository.mjs";
import { PostgresqlShopeeAdvertisingRepository } from "../lib/advertising/postgresql-shopee-advertising-repository.mjs";
import { MabangImageRepository } from "../lib/mabang-images/repository.mjs";

class RecordingProvider {
  constructor(responses = []) {
    this.dialect = DATABASE_DIALECTS.POSTGRESQL;
    this.config = { schema: "app" };
    this.connection = {};
    this.transactionManager = { run: (callback) => callback(this) };
    this.responses = [...responses];
    this.calls = [];
  }
  placeholder(index) { return `$${index}`; }
  async query(text, values = []) { this.calls.push({ text, values }); return this.responses.shift() || { rows: [], rowCount: 0 }; }
  async execute(text, values = []) { return this.query(text, values); }
  async executeScript(text) { return this.query(text); }
  async transaction(callback) { return callback(this); }
  async migrate() { return []; }
  async close() {}
}

test("PostgreSQL health settings baseline keeps the fixed default id and booleans representable", async () => {
  const sql = await fs.readFile(path.resolve("migrations/postgresql/001_shared_baseline.sql"), "utf8");
  const table = sql.match(/CREATE TABLE "app"\."shopee_health_settings" \([\s\S]*?\n\);/)?.[0] || "";
  assert.match(table, /"id" text/);
  assert.match(table, /"site_notifications_enabled" boolean NOT NULL DEFAULT TRUE/);
  assert.match(table, /"dingtalk_notifications_enabled" boolean NOT NULL DEFAULT FALSE/);
  assert.doesNotMatch(table, /"id" uuid/);
});

test("PostgreSQL health settings preserve encrypted credentials and native booleans", async () => {
  const provider = new RecordingProvider([
    { rows: [{ id: "default", encrypted_token_key: "cipher", site_notifications_enabled: true, dingtalk_notifications_enabled: false, enabled: true, retry_count: 2, warning_ratio: "0.5" }], rowCount: 1 },
    { rows: [{ id: "default", encrypted_token_key: "cipher", site_notifications_enabled: true, dingtalk_notifications_enabled: false, enabled: true, retry_count: 2, warning_ratio: "0.5" }], rowCount: 1 },
    { rows: [{ id: "default", encrypted_token_key: "cipher", site_notifications_enabled: false, dingtalk_notifications_enabled: false, enabled: true, retry_count: 2, warning_ratio: "0.5" }], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeHealthRepository({ provider });
  const settings = await repository.getSettings({ includeSecret: true });
  assert.equal(settings.encryptedTokenKey, "cipher");
  const saved = await repository.saveSettings({ siteNotificationsEnabled: false });
  assert.equal(saved.siteNotificationsEnabled, false);
  assert.equal(provider.calls[2].text.includes("cipher"), false);
  assert.equal(provider.calls[2].values.includes("cipher"), true);
  assert.equal(provider.calls[2].values.includes(false), true);
});

test("PostgreSQL health repository exposes the complete health workflow", () => {
  const repository = new PostgresqlShopeeHealthRepository({ provider: new RecordingProvider() });
  const methods = [
    "listThresholds", "saveThresholds", "createRun", "getRun", "latestRun", "listRuns",
    "hasRunForDate", "activeRun", "updateRun", "upsertSnapshot", "latestSnapshots", "trend",
    "upsertIssue", "resolveMissingIssues", "listIssues", "createNotification", "listNotifications",
    "unreadNotificationCount", "markNotificationsRead", "createAppeal", "getAppeal", "listAppeals",
    "updateAppeal", "addAppealEvent", "listAppealEvents",
  ];
  for (const method of methods) assert.equal(typeof repository[method], "function", method);
});

test("PostgreSQL advertising batch and facts commit in one provider transaction", async () => {
  const provider = new RecordingProvider([
    { rows: [], rowCount: 1 }, { rows: [], rowCount: 1 },
    { rows: [{ id: "batch-1", platform: "shopee", report_type: "overall", shop_id: "shop-1", period_days: 7, row_count: 1, summary_json: {} }], rowCount: 1 },
  ]);
  const repository = new PostgresqlShopeeAdvertisingRepository({ provider });
  const batch = await repository.createBatch({
    id: "batch-1", shopId: "shop-1", shopName: "Shop", accountName: "Account", originalFilename: "ads.xlsx",
    reportCreatedAt: "2026-08-12", periodFrom: "2026-08-05", periodTo: "2026-08-12", periodDays: 7,
    rawSha256: "hash", summary: {}, importedBy: "developer", importedAt: "2026-08-12T00:00:00Z",
  }, [{ id: "fact-1", sequence: 1, adKey: "ad-1" }]);
  assert.equal(batch.id, "batch-1");
  assert.match(provider.calls[0].text, /INSERT INTO "app"\."advertising_source_batches"/);
  assert.match(provider.calls[1].text, /INSERT INTO "app"\."advertising_performance_facts"/);
  assert.equal(provider.calls.some(({ text }) => text.includes("?")), false);
});

test("PostgreSQL advertising repository exposes read, delete, and target workflows", () => {
  const repository = new PostgresqlShopeeAdvertisingRepository({ provider: new RecordingProvider() });
  for (const method of ["listBatches", "listFacts", "deleteBatch", "listTargets", "upsertTargets"]) {
    assert.equal(typeof repository[method], "function", method);
  }
});

test("existing Mabang media repository already emits PostgreSQL schema and placeholders", async () => {
  const provider = new RecordingProvider([
    { rows: [], rowCount: 1 },
    { rows: [{ id: "run-1", account_id: "account-1", status: "pending", next_page: 1, created_by: "developer" }], rowCount: 1 },
  ]);
  const repository = new MabangImageRepository({ provider });
  const run = await repository.createSyncRun({ accountId: "account-1", createdBy: "developer" });
  assert.equal(run.accountId, "account-1");
  assert.match(provider.calls[0].text, /INSERT INTO app\.mabang_sku_image_sync_runs/);
  assert.match(provider.calls[0].text, /\$1/);
});
