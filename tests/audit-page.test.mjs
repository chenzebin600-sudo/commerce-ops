import test from "node:test";
import assert from "node:assert/strict";
import { auditEventViewModel, renderAuditEventRow } from "../public/audit-page.mjs";

test("operation record page renders only the safe view model", () => {
  const model = auditEventViewModel({
    id: "event_1",
    occurredAt: "2026-07-16T00:00:00Z",
    module: "mabang",
    action: "mabang.orders.fetch",
    actionLabel: "获取马帮订单",
    status: "success",
    source: "127.0.*.*",
    password: "should-never-render",
    authorization: "Bearer should-never-render",
  });
  const text = JSON.stringify(model);
  assert.equal(text.includes("should-never-render"), false);
  assert.equal(model.source, "127.0.*.*");
});

test("operation record rows HTML-escape all server-provided display fields", () => {
  const html = renderAuditEventRow({
    id: 'event"><script>alert(1)</script>',
    occurredAt: "2026-07-16T00:00:00Z",
    module: '<img src=x onerror="alert(1)">',
    action: "auth.verify.failed",
    actionLabel: "<script>bad()</script>",
    status: "failed",
    errorSummary: "password=hunter2 <script>bad()</script>",
  });
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes('data-audit-detail="event\"><script>'), false);
});
