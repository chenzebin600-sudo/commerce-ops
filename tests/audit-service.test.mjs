import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import {
  OperationAuditService,
  createOperationAuditService,
  maskAuditIdentifier,
  normalizeSourceIp,
  parseTrustedProxies,
  redactAuditText,
  resolveAuditSourceIp,
} from "../lib/security/audit-service.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-audit-"));
  const db = new SchedulerDatabase({ databasePath: path.join(root, "audit.sqlite"), migrationsDir: path.resolve("migrations") });
  db.migrate();
  const audit = createOperationAuditService({
    db,
    env: {
      APP_ACCESS_TOKEN: "app-token-never-store",
      AD_SERVICE_INTERNAL_TOKEN: "ad-token-never-store",
      DEEPSEEK_API_KEY: "deepseek-never-store",
      APP_ENCRYPTION_KEY: "encryption-never-store",
    },
  });
  return { root, db, audit };
}

test("successful and failed operations use stable names and generated request ids", async () => {
  const { db, audit } = fixture();
  const success = await audit.recordAuditEvent({ module: "mabang", action: "mabang.orders.fetch", status: "success" });
  const failed = await audit.recordAuditEvent({ module: "ads", action: "ads.analysis.run", status: "failed", errorCode: "ANALYZE_FAILED" });
  assert.match(success.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(success.action, "mabang.orders.fetch");
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "ANALYZE_FAILED");
  db.close();
});

test("audit redaction removes credentials, headers, webhooks, phones, paths and stacks", async () => {
  const { db, audit } = fixture();
  const secretText = [
    "password=hunter2",
    "token=app-token-never-store",
    "api_key=deepseek-never-store",
    "secret=ding-secret",
    "Cookie=session-cookie",
    "Authorization=Bearer abc.def",
    "https://oapi.dingtalk.com/robot/send?access_token=webhook-token",
    "C:\\Users\\PC\\private\\orders.xlsx",
    "18912341369",
  ].join(" ");
  const event = await audit.recordAuditEvent({
    module: "security",
    action: "file.upload.rejected",
    status: "failed",
    actorIdentifier: "18912341369",
    errorSummary: new Error(`${secretText}\nSTACK SHOULD NOT APPEAR`),
    metadata: {
      reason: secretText,
      requestBody: JSON.stringify({ order: "complete business body" }),
      authorization: "Bearer raw-header",
    },
  });
  const stored = JSON.stringify(event);
  for (const forbidden of [
    "hunter2", "app-token-never-store", "deepseek-never-store", "ding-secret",
    "session-cookie", "abc.def", "webhook-token", "C:\\Users", "18912341369",
    "STACK SHOULD NOT APPEAR", "complete business body", "raw-header",
  ]) assert.equal(stored.includes(forbidden), false, forbidden);
  assert.equal(event.actorIdentifier, "189****1369");
  assert.deepEqual(Object.keys(event.metadata), ["reason"]);
  db.close();
});

test("standalone redaction and identifier masking are reusable", () => {
  assert.equal(maskAuditIdentifier("18912341369"), "189****1369");
  const output = redactAuditText("Bearer private-token password=private-pass\nprivate-stack");
  assert.equal(output.includes("private-token"), false);
  assert.equal(output.includes("private-pass"), false);
  assert.equal(output.includes("private-stack"), false);
});

test("source IP normalization ignores forwarded headers unless the exact proxy is trusted", () => {
  const request = {
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.2" },
  };
  assert.equal(normalizeSourceIp("::ffff:192.0.2.4"), "192.0.2.4");
  assert.equal(resolveAuditSourceIp(request), "127.0.0.1");
  assert.equal(resolveAuditSourceIp(request, parseTrustedProxies("127.0.0.1")), "203.0.113.8");
  assert.throws(() => parseTrustedProxies("proxy.local"), /exact IP/);
});

test("queries enforce pagination limits and filter by module, time and task id", async () => {
  const { db, audit } = fixture();
  for (let index = 0; index < 130; index += 1) {
    await audit.recordAuditEvent({
      occurredAt: new Date(Date.UTC(2026, 6, 1, 0, index)),
      module: index % 2 ? "ads" : "mabang",
      action: index % 2 ? "ads.analysis.run" : "mabang.task.run_now",
      status: "success",
      taskId: index === 40 ? "task_40" : null,
    });
  }
  assert.equal((await audit.queryEvents({ pageSize: 500 })).pageSize, 100);
  assert.equal((await audit.queryEvents({ module: "ads" })).total, 65);
  assert.equal((await audit.queryEvents({ taskId: "task_40" })).total, 1);
  assert.equal((await audit.queryEvents({ start: "2026-07-01T00:30:00Z", end: "2026-07-01T00:39:00Z" })).total, 10);
  assert.throws(() => audit.queryEvents({ start: "2025-01-01", end: "2026-07-01" }), /366 days/);
  db.close();
});

test("audit write failures are fail-open and log only a stable error code", async () => {
  const messages = [];
  const audit = new OperationAuditService({
    repository: { create() { throw Object.assign(new Error("password=do-not-log"), { code: "SQLITE_READONLY" }); } },
    logger: { error(message) { messages.push(message); } },
  });
  assert.equal(await audit.recordSafely({ module: "mabang", action: "mabang.orders.fetch", status: "success" }), null);
  assert.deepEqual(messages, ["Audit write failed: SQLITE_READONLY"]);
  assert.equal(messages[0].includes("do-not-log"), false);
});

test("retention cleanup deletes only expired audit rows and preserves business data", async () => {
  const { db, audit } = fixture();
  const before = {
    tasks: db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_tasks").get().count,
    runs: db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_runs").get().count,
    files: db.db.prepare("SELECT COUNT(*) count FROM export_files").get().count,
  };
  await audit.recordAuditEvent({ occurredAt: "2025-01-01T00:00:00Z", module: "audit", action: "audit.retention.cleanup", status: "success" });
  await audit.recordAuditEvent({ occurredAt: "2026-07-15T00:00:00Z", module: "auth", action: "auth.logout", status: "success" });
  assert.equal(await audit.cleanupExpired({ retentionDays: 180, now: new Date("2026-07-16T00:00:00Z") }), 1);
  assert.equal((await audit.queryEvents({})).total, 1);
  assert.deepEqual({
    tasks: db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_tasks").get().count,
    runs: db.db.prepare("SELECT COUNT(*) count FROM scheduled_export_runs").get().count,
    files: db.db.prepare("SELECT COUNT(*) count FROM export_files").get().count,
  }, before);
  db.close();
});

test("audit migration preserves existing rows and a failed migration rolls back", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-audit-migration-"));
  const migrations = path.join(root, "migrations");
  mkdirSync(migrations);
  writeFileSync(path.join(migrations, "001_business.sql"), "CREATE TABLE business_rows(id TEXT PRIMARY KEY, value TEXT NOT NULL);", "utf8");
  const databasePath = path.join(root, "migration.sqlite");
  let db = new SchedulerDatabase({ databasePath, migrationsDir: migrations });
  db.migrate();
  db.db.prepare("INSERT INTO business_rows(id,value) VALUES(?,?)").run("one", "unchanged");
  cpSync(path.resolve("migrations/002_operation_audit_events.sql"), path.join(migrations, "002_operation_audit_events.sql"));
  db.migrate();
  assert.equal(db.db.prepare("SELECT value FROM business_rows WHERE id='one'").get().value, "unchanged");
  assert.equal(db.db.prepare("SELECT COUNT(*) count FROM operation_audit_events").get().count, 0);
  db.close();

  writeFileSync(path.join(migrations, "003_failure.sql"), "CREATE TABLE should_rollback(id TEXT); INSERT INTO missing_table VALUES (1);", "utf8");
  db = new SchedulerDatabase({ databasePath, migrationsDir: migrations });
  assert.throws(() => db.migrate());
  assert.equal(db.db.prepare("SELECT COUNT(*) count FROM business_rows").get().count, 1);
  assert.equal(db.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='should_rollback'").get(), undefined);
  assert.equal(db.db.prepare("SELECT 1 FROM schema_migrations WHERE version='003_failure.sql'").get(), undefined);
  db.close();
});
