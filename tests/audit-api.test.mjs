import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createAccessPolicy, protectedApiAccessResponse } from "../lib/app-access.mjs";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createAuditApi } from "../lib/security/audit-api.mjs";
import { createOperationAuditService } from "../lib/security/audit-service.mjs";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "commerce-ops-audit-api-"));
  const db = new SchedulerDatabase({ databasePath: path.join(root, "api.sqlite"), migrationsDir: path.resolve("migrations") });
  db.migrate();
  const audit = createOperationAuditService({ db, env: {} });
  return { db, audit, api: createAuditApi({ audit, retentionDays: 180 }) };
}

function responseCapture() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk = "") { this.body += chunk; },
  };
}

async function invoke(api, { method = "GET", path = "/api/audit/events", body = null } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.auditContext = { requestId: "request_1", startedAt: new Date(), sourceIp: "127.0.0.1", actorType: "test" };
  const res = responseCapture();
  await api(req, res, new URL(path, "http://localhost"));
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

test("audit APIs are protected by the main access policy", () => {
  const policy = createAccessPolicy({ host: "127.0.0.1", accessToken: "temporary-token" });
  assert.equal(protectedApiAccessResponse({}, policy).status, 401);
  assert.equal(protectedApiAccessResponse({ authorization: "Bearer temporary-token" }, policy), null);
});

test("audit list, detail and summary return only serialized safe fields", async () => {
  const { db, audit, api } = fixture();
  const event = await audit.recordAuditEvent({
    module: "mabang", action: "mabang.orders.fetch", status: "success",
    sourceIp: "203.0.113.8", metadata: { kind: "orders", forbiddenBody: "secret body" },
  });
  const list = await invoke(api, { path: "/api/audit/events?pageSize=500&module=mabang" });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.pageSize, 100);
  assert.equal(list.body.events[0].source, "203.0.*.*");
  assert.equal(JSON.stringify(list.body).includes("secret body"), false);
  const detail = await invoke(api, { path: `/api/audit/events/${event.id}` });
  assert.equal(detail.body.event.id, event.id);
  const summary = await invoke(api, { path: "/api/audit/summary" });
  assert.equal(summary.body.summary.total, 1);
  db.close();
});

test("client-side export audit accepts only fixed allowlisted actions", async () => {
  const { db, audit, api } = fixture();
  const accepted = await invoke(api, { method: "POST", path: "/api/audit/client-action", body: { action: "competitor.export.download", password: "not-stored" } });
  assert.equal(accepted.status, 200);
  assert.equal((await audit.queryEvents({ action: "competitor.export.download" })).total, 1);
  const rejected = await invoke(api, { method: "POST", path: "/api/audit/client-action", body: { action: "arbitrary.action" } });
  assert.equal(rejected.status, 400);
  assert.equal(JSON.stringify(await audit.queryEvents({})).includes("not-stored"), false);
  db.close();
});

test("manual cleanup records itself and deletes only expired audit events", async () => {
  const { db, audit, api } = fixture();
  await audit.recordAuditEvent({ occurredAt: "2025-01-01", module: "auth", action: "auth.logout", status: "success" });
  const result = await invoke(api, { method: "POST", path: "/api/audit/cleanup" });
  assert.equal(result.status, 200);
  assert.equal(result.body.deleted, 1);
  assert.equal((await audit.queryEvents({ action: "audit.retention.cleanup" })).total, 1);
  db.close();
});
