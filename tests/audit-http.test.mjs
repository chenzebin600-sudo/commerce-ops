import test from "node:test";
import assert from "node:assert/strict";
import {
  completeHttpAudit,
  createHttpAuditContext,
  describeAuditRequest,
} from "../lib/security/audit-http.mjs";

function request({ authorization = "Bearer temporary-test-token", remoteAddress = "::ffff:127.0.0.1", method = "POST" } = {}) {
  return { method, headers: authorization ? { authorization } : {}, socket: { remoteAddress } };
}

function collector() {
  const events = [];
  return { events, audit: { recordSafely(event) { events.push(event); return event; } } };
}

test("HTTP audit uses one stable request id for a primary operation and related AI event", () => {
  const req = request();
  const context = createHttpAuditContext(req, new URL("http://localhost/api/extract-and-analyze"), { now: () => new Date("2026-07-16T00:00:00Z") });
  const { events, audit } = collector();
  completeHttpAudit(audit, context, { httpStatus: 200, now: () => new Date("2026-07-16T00:00:01Z") });
  assert.deepEqual(events.map((event) => event.action), ["competitor.link_analysis.run", "deepseek.call"]);
  assert.equal(new Set(events.map((event) => event.requestId)).size, 1);
  assert.equal(events[0].durationMs, 1000);
});

test("failed authentication and invalid tokens use dedicated stable actions", () => {
  for (const [authorization, expected] of [["", "auth.access.denied"], ["Bearer wrong", "auth.token.invalid"]]) {
    const context = createHttpAuditContext(request({ authorization }), new URL("http://localhost/api/audit/events"));
    const { events, audit } = collector();
    completeHttpAudit(audit, context, { httpStatus: 401 });
    assert.equal(events[0].action, expected);
    assert.equal(events[0].status, "failed");
  }
});

test("authentication verification records success and failure without request content", () => {
  for (const [httpStatus, expected] of [[200, "auth.verify.success"], [401, "auth.verify.failed"]]) {
    const context = createHttpAuditContext(request(), new URL("http://localhost/api/auth/verify"));
    const { events, audit } = collector();
    completeHttpAudit(audit, context, { httpStatus });
    assert.equal(events[0].action, expected);
    assert.equal("body" in events[0], false);
    assert.equal("headers" in events[0], false);
  }
});

test("successful audit queries do not recursively create audit events", () => {
  const context = createHttpAuditContext(request({ method: "GET" }), new URL("http://localhost/api/audit/events"));
  const { events, audit } = collector();
  completeHttpAudit(audit, context, { httpStatus: 200 });
  assert.deepEqual(events, []);
});

test("sensitive endpoint mappings cover security, advertising, Mabang and files", () => {
  assert.equal(describeAuditRequest("POST", "/api/chrome/navigate").action, "chrome.navigation.run");
  assert.equal(describeAuditRequest("GET", "/api/image").action, "image.proxy.fetch");
  assert.equal(describeAuditRequest("POST", "/api/ads/analyze").action, "ads.analysis.run");
  assert.equal(describeAuditRequest("POST", "/api/mabang/scheduled-tasks/task_1/run-now").action, "mabang.task.run_now");
  assert.equal(describeAuditRequest("GET", "/api/mabang/export-files/file_1/download").action, "file.download");
  assert.equal(describeAuditRequest("GET", "/api/files/file_1/download").action, "file.download");
  assert.equal(describeAuditRequest("POST", "/api/files/lifecycle/scan").action, "file.lifecycle.scan.requested");
  assert.equal(describeAuditRequest("POST", "/api/files/lifecycle/reports/scan_1/export").action, "file.lifecycle.report.exported");
  assert.equal(describeAuditRequest("GET", "/api/files"), null);
});

test("lifecycle report downloads receive a dedicated audit action", () => {
  const context = createHttpAuditContext(request({ method: "GET" }), new URL("http://localhost/api/files/00000000-0000-0000-0000-000000000000/download"));
  context.annotate({ metadata: { sourceType: "system_file_lifecycle_report" } });
  const { events, audit } = collector();
  completeHttpAudit(audit, context, { httpStatus: 200 });
  assert.equal(events[0].action, "file.lifecycle.report.downloaded");
});

test("rejected Chrome, image and file operations receive rejection actions", () => {
  for (const [pathname, expected] of [
    ["/api/chrome/navigate", "chrome.navigation.rejected"],
    ["/api/image", "image.proxy.rejected"],
    ["/api/mabang/export-files/file_1/download", "file.download.rejected"],
  ]) {
    const method = pathname === "/api/image" || pathname.includes("/download") ? "GET" : "POST";
    const context = createHttpAuditContext(request({ method }), new URL(`http://localhost${pathname}`));
    const { events, audit } = collector();
    completeHttpAudit(audit, context, { httpStatus: 400 });
    assert.equal(events[0].action, expected);
  }
});

test("download path policy failures use the dedicated path rejection action", () => {
  const context = createHttpAuditContext(request({ method: "GET" }), new URL("http://localhost/api/mabang/export-files/file_1/download"));
  context.annotate({ errorCode: "FILE_ACCESS_DENIED" });
  const { events, audit } = collector();
  completeHttpAudit(audit, context, { httpStatus: 403 });
  assert.equal(events[0].action, "file.path.rejected");
});

test("product-knowledge review and release writes have durable audit descriptors", () => {
  const cases = [
    ["/api/product-knowledge/candidates/pkc_1/reviews", "product_knowledge.candidate.reviewed"],
    ["/api/product-knowledge/releases", "product_knowledge.release.created"],
    ["/api/product-knowledge/releases/pkrel_1/publish", "product_knowledge.release.published"],
  ];
  for (const [pathname, action] of cases) {
    const context = createHttpAuditContext(request(), new URL(`http://localhost${pathname}`));
    context.annotate({
      actorIdentifier: "knowledge-reviewer",
      metadata: { candidateId: "pkc_1", releaseId: "pkrel_1" },
    });
    const { events, audit } = collector();
    completeHttpAudit(audit, context, { httpStatus: 200 });
    assert.equal(events[0].module, "product_knowledge");
    assert.equal(events[0].action, action);
    assert.equal(events[0].actorIdentifier, "knowledge-reviewer");
    assert.equal(events[0].metadata.releaseId, "pkrel_1");
  }
});
