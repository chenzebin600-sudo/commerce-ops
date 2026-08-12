import assert from "node:assert/strict";
import test from "node:test";
import { PostgresqlSchedulerRepository } from "../lib/data/postgresql/postgresql-scheduler-repository.mjs";
import { PostgresqlAuditRepository } from "../lib/data/postgresql/postgresql-audit-repository.mjs";
import { PostgresqlExportFileRepository } from "../lib/data/postgresql/postgresql-file-repositories.mjs";
import { MabangSchedulerService } from "../lib/mabang-scheduler/service.mjs";
import { OperationAuditService } from "../lib/security/audit-service.mjs";

class ScriptedProvider {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
    this.config = { schema: "app" };
  }

  async query(text, values = []) {
    this.calls.push({ kind: "query", text, values });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response || { rows: [], rowCount: 0 };
  }

  async execute(text, values = []) {
    this.calls.push({ kind: "execute", text, values });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response || { rows: [], rowCount: 0 };
  }

  async transaction(callback) { return callback(this); }
}

test("PostgreSQL scheduler account reads preserve the public repository shape", async () => {
  const provider = new ScriptedProvider([{ rows: [{
    id: "account-1",
    name: "共享开发账号",
    username: "developer@example.com",
    encrypted_password: "ciphertext",
    enabled: true,
    last_verified_at: new Date("2026-08-12T01:02:03Z"),
    last_verify_status: "success",
    last_verify_message: "ok",
    created_at: new Date("2026-08-11T00:00:00Z"),
    updated_at: new Date("2026-08-12T00:00:00Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });

  const rows = await repository.listAccountProfiles();

  assert.deepEqual(rows, [{
    id: "account-1",
    name: "共享开发账号",
    username: "developer@example.com",
    usernameMasked: "de***om",
    passwordConfigured: true,
    enabled: true,
    lastVerifiedAt: "2026-08-12T01:02:03.000Z",
    lastVerifyStatus: "success",
    lastVerifyMessage: "ok",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  }]);
  assert.match(provider.calls[0].text, /FROM "app"\."mabang_account_profiles"/);
});

test("PostgreSQL account save parameterizes encrypted credentials", async () => {
  const provider = new ScriptedProvider([
    { rows: [], rowCount: 1 },
    { rows: [{
      id: "account-1", name: "A", username: "a@example.com", encrypted_password: "ciphertext",
      enabled: true, created_at: new Date("2026-08-12T00:00:00Z"), updated_at: new Date("2026-08-12T00:00:00Z"),
    }], rowCount: 1 },
  ]);
  const repository = new PostgresqlSchedulerRepository({ provider, randomUUID: () => "account-1", now: () => new Date("2026-08-12T00:00:00Z") });

  const saved = await repository.saveAccountProfile({ name: "A", username: "a@example.com", encryptedPassword: "ciphertext", enabled: true });

  assert.equal(saved.id, "account-1");
  const insert = provider.calls.find(({ text }) => text.includes("INSERT INTO"));
  assert.equal(insert.text.includes("ciphertext"), false);
  assert.equal(insert.values.includes("ciphertext"), true);
});

test("PostgreSQL scheduler lease acquisition is one atomic server-time statement", async () => {
  const provider = new ScriptedProvider([{ rows: [{ name: "mabang_scheduler" }], rowCount: 1 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });

  const acquired = await repository.acquireLease("mabang_scheduler", "developer-b", new Date("2026-08-12T00:00:00Z"), 30_000);

  assert.equal(acquired, true);
  assert.equal(provider.calls.length, 1);
  assert.match(provider.calls[0].text, /ON CONFLICT \("name"\) DO UPDATE/);
  assert.match(provider.calls[0].text, /clock_timestamp\(\)/);
  assert.match(provider.calls[0].text, /RETURNING "name"/);
  assert.deepEqual(provider.calls[0].values, ["mabang_scheduler", "developer-b", 30_000]);
});

test("PostgreSQL scheduler lease reports contention when no row is returned", async () => {
  const provider = new ScriptedProvider([{ rows: [], rowCount: 0 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });
  assert.equal(await repository.acquireLease("mabang_scheduler", "developer-b", new Date(), 30_000), false);
});

test("PostgreSQL DingTalk reads preserve JSONB and secret redaction", async () => {
  const provider = new ScriptedProvider([{ rows: [{
    id: "robot-1", name: "开发通知", encrypted_webhook_url: "cipher-webhook", encrypted_secret: "cipher-secret",
    enabled: true, notify_on_success: true, notify_on_failure: false, notify_on_empty: true,
    at_all: false, at_mobiles_json: ["13800000000"],
    created_at: new Date("2026-08-11T00:00:00Z"), updated_at: new Date("2026-08-12T00:00:00Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });
  const rows = await repository.listDingtalkConfigs();
  assert.deepEqual(rows, [{
    id: "robot-1", name: "开发通知", webhookConfigured: true, secretConfigured: true,
    enabled: true, notifyOnSuccess: true, notifyOnFailure: false, notifyOnEmpty: true,
    atAll: false, atMobiles: ["13800000000"],
    createdAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z",
  }]);
  assert.equal(JSON.stringify(rows).includes("cipher-webhook"), false);
  assert.equal(JSON.stringify(rows).includes("cipher-secret"), false);
});

test("PostgreSQL filter cache returns the existing grouped option contract", async () => {
  const provider = new ScriptedProvider([{ rows: [
    { manager: "店长乙", shop_name: "店铺二", platform: "Shopee", region: "MY", warehouse: "WH-B", order_status: "paid", sku: "SKU-2", logistics_channel: "海运" },
    { manager: "店长甲", shop_name: "店铺一", platform: "Lazada", region: "SG", warehouse: "WH-A", order_status: "ready", sku: "SKU-1", logistics_channel: "空运" },
  ], rowCount: 2 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });
  const options = await repository.filterOptions("account-1");
  assert.deepEqual(options.managers, ["店长甲", "店长乙"]);
  assert.deepEqual(options.shops, ["店铺二", "店铺一"]);
  assert.deepEqual(options.managerShops, { 店长乙: ["店铺二"], 店长甲: ["店铺一"] });
  assert.deepEqual(provider.calls[0].values, ["account-1"]);
});

test("PostgreSQL scheduler status uses server-computed liveness", async () => {
  const provider = new ScriptedProvider([{ rows: [{
    online: true,
    lease_until: new Date("2026-08-12T00:01:00Z"),
    updated_at: new Date("2026-08-12T00:00:00Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });
  assert.deepEqual(await repository.schedulerStatus(), {
    online: true,
    leaseUntil: "2026-08-12T00:01:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.match(provider.calls[0].text, /lease_until>clock_timestamp\(\)/);
});

test("PostgreSQL scheduled task reads normalize JSONB, booleans, and timestamps", async () => {
  const provider = new ScriptedProvider([{ rows: [{
    id: "task-1", task_type: "order_export", name: "共享任务", description: "",
    account_profile_id: "account-1", account_name: "账号", account_username: "developer@example.com",
    account_profile_found: "account-1", account_enabled: true,
    dingtalk_config_id: null, dingtalk_name: null, schedule_type: "daily", schedule_config_json: { hour: 9 },
    timezone: "Asia/Shanghai", payment_date_mode: "today", payment_date_config_json: {}, filters_json: [{ field: "status" }],
    enabled: true, file_retention_days: null, notify_enabled: false, catch_up_enabled: true,
    last_run_at: null, last_run_status: null, next_run_at: new Date("2026-08-13T01:00:00Z"),
    deleted_at: null, deleted_by: null, delete_reason: null,
    created_at: new Date("2026-08-12T00:00:00Z"), updated_at: new Date("2026-08-12T00:00:00Z"),
  }], rowCount: 1 }]);
  const repository = new PostgresqlSchedulerRepository({ provider });
  const tasks = await repository.listTasks();
  assert.equal(tasks[0].id, "task-1");
  assert.deepEqual(tasks[0].scheduleConfig, { hour: 9 });
  assert.deepEqual(tasks[0].filters, [{ field: "status" }]);
  assert.equal(tasks[0].fileRetentionDays, "forever");
  assert.equal(tasks[0].nextRunAt, "2026-08-13T01:00:00.000Z");
  assert.equal(tasks[0].accountUsernameMasked, "de***om");
  assert.match(provider.calls[0].text, /deleted_at IS NULL/);
});

test("PostgreSQL createRunIfAbsent treats only unique violations as an existing run", async () => {
  const unique = Object.assign(new Error("duplicate"), { code: "23505" });
  const provider = new ScriptedProvider([
    { rows: [{ id: "task-1", deleted_at: null }], rowCount: 1 },
    unique,
  ]);
  const repository = new PostgresqlSchedulerRepository({ provider, randomUUID: () => "run-1", now: () => new Date("2026-08-12T00:00:00Z") });
  assert.equal(await repository.createRunIfAbsent({ taskId: "task-1", triggerType: "scheduled", scheduledRunAt: new Date("2026-08-12T01:00:00Z") }), null);
});

test("PostgreSQL claimRun locks the candidate and transitions it once", async () => {
  const provider = new ScriptedProvider([
    { rows: [{ id: "run-1", task_id: "task-1", status: "pending" }], rowCount: 1 },
    { rows: [{ deleted_at: null }], rowCount: 1 },
    { rows: [], rowCount: 0 },
    { rows: [], rowCount: 1 },
    { rows: [{ id: "run-1", task_id: "task-1", status: "running", task_name: "任务", task_type: "order_export" }], rowCount: 1 },
  ]);
  const repository = new PostgresqlSchedulerRepository({ provider });
  const result = await repository.claimRun("run-1");
  assert.equal(result.claimed, true);
  assert.equal(result.run.status, "running");
  assert.match(provider.calls[0].text, /FOR UPDATE/);
  assert.match(provider.calls[2].text, /status='running'/);
});

test("PostgreSQL audit append parameterizes metadata and returns the inserted event", async () => {
  const row = {
    id: "audit-1", request_id: "request-1", occurred_at: new Date("2026-08-12T00:00:00Z"),
    module: "scheduler", action: "scheduler.started", status: "success", metadata_json: { owner: "B" },
    created_at: new Date("2026-08-12T00:00:00Z"),
  };
  const provider = new ScriptedProvider([{ rows: [row], rowCount: 1 }]);
  const repository = new PostgresqlAuditRepository({ provider });

  const inserted = await repository.create({
    id: "audit-1", requestId: "request-1", occurredAt: "2026-08-12T00:00:00.000Z",
    module: "scheduler", action: "scheduler.started", status: "success",
    metadataJson: JSON.stringify({ owner: "B" }), createdAt: "2026-08-12T00:00:00.000Z",
  });

  assert.equal(inserted.id, "audit-1");
  assert.deepEqual(inserted.metadata_json, { owner: "B" });
  assert.match(provider.calls[0].text, /INSERT INTO "app"\."operation_audit_events"/);
  assert.match(provider.calls[0].text, /RETURNING \*/);
  assert.equal(provider.calls[0].text.includes("scheduler.started"), false);
  assert.equal(provider.calls[0].values.includes("scheduler.started"), true);
});

test("audit service accepts PostgreSQL JSONB rows without discarding metadata", async () => {
  const provider = new ScriptedProvider([{ rows: [{
    id: "audit-1", request_id: "request-1", occurred_at: new Date("2026-08-12T00:00:00Z"),
    module: "scheduler", action: "scheduler.started", status: "success", metadata_json: { owner: "B" },
  }], rowCount: 1 }]);
  const service = new OperationAuditService({ repository: new PostgresqlAuditRepository({ provider }) });
  const event = await service.getEvent("audit-1");
  assert.deepEqual(event.metadata, { owner: "B" });
});

test("PostgreSQL audit query uses independent count and page statements", async () => {
  const provider = new ScriptedProvider([
    { rows: [{ total: "3" }], rowCount: 1 },
    { rows: [{ id: "audit-1", metadata_json: {} }], rowCount: 1 },
  ]);
  const repository = new PostgresqlAuditRepository({ provider });
  const result = await repository.query({ module: "scheduler", page: 2, pageSize: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.rows[0].id, "audit-1");
  assert.deepEqual(provider.calls[0].values, ["scheduler"]);
  assert.deepEqual(provider.calls[1].values, ["scheduler", 1, 1]);
});

test("PostgreSQL export metadata creation preserves virtual source type without interpolating values", async () => {
  const row = {
    id: "file-1", file_type: "excel", source_type: "mabang_manual_order", task_id: null, run_id: null,
    request_key: "request-1", original_filename: "report.xlsx", storage_filename: "safe.xlsx",
    relative_path: "exports/safe.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    file_size: "42", file_hash: "sha256", status: "available", expires_at: null, missing_at: null,
    metadata_json: { generatedBy: "product_package_import", rowCount: 2 },
    created_at: new Date("2026-08-12T00:00:00Z"), updated_at: new Date("2026-08-12T00:00:00Z"),
  };
  const provider = new ScriptedProvider([{ rows: [row], rowCount: 1 }]);
  const repository = new PostgresqlExportFileRepository({ provider, randomUUID: () => "file-1", now: () => new Date("2026-08-12T00:00:00Z") });
  const file = await repository.create({
    sourceType: "product_package_import", requestKey: "request-1", originalFilename: "report.xlsx",
    storageFilename: "safe.xlsx", relativePath: "exports/safe.xlsx", fileSize: 42, fileHash: "sha256",
    metadata: { rowCount: 2, ignoredSecret: "do-not-store" },
  });
  assert.equal(file.sourceType, "product_package_import");
  assert.deepEqual(file.metadata, { generatedBy: "product_package_import", rowCount: 2 });
  assert.match(provider.calls[0].text, /INSERT INTO "app"\."export_files"/);
  assert.equal(provider.calls[0].text.includes("report.xlsx"), false);
  assert.equal(JSON.stringify(provider.calls[0].values).includes("ignoredSecret"), false);
});

test("PostgreSQL export metadata list uses JSONB filters and bounded pagination", async () => {
  const provider = new ScriptedProvider([
    { rows: [{ total: "1" }], rowCount: 1 },
    { rows: [{
      id: "file-1", file_type: "excel", source_type: "mabang_manual_order", original_filename: "report.xlsx",
      storage_filename: "safe.xlsx", relative_path: "exports/safe.xlsx", file_size: 42, status: "available",
      metadata_json: { generatedBy: "product_package_import" }, created_at: new Date("2026-08-12T00:00:00Z"),
    }], rowCount: 1 },
  ]);
  const repository = new PostgresqlExportFileRepository({ provider });
  const result = await repository.list({ sourceType: "product_package_import", page: 2, pageSize: 500 });
  assert.equal(result.total, 1);
  assert.equal(result.files[0].sourceType, "product_package_import");
  assert.equal(result.pageSize, 100);
  assert.match(provider.calls[0].text, /metadata_json->>'generatedBy'/);
  assert.deepEqual(provider.calls[1].values.slice(-2), [100, 100]);
});

test("scheduler service awaits shared-database leases and queued runs", async () => {
  const calls = [];
  const db = {
    acquireLease: async () => { calls.push("lease"); return true; },
    dueTasks: async () => [],
    pendingRuns: async () => [{ id: "run-1" }],
    expiredFiles: async () => [],
  };
  const executor = { executeRun: async (id) => calls.push(`run:${id}`) };
  const service = new MabangSchedulerService({ db, executor, exportRoot: "D:/exports" });
  assert.equal(await service.tick(), true);
  assert.deepEqual(calls, ["lease", "run:run-1"]);
});
