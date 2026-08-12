import assert from "node:assert/strict";
import test from "node:test";
import { PostgresqlFileLifecycleRepository } from "../lib/data/postgresql/postgresql-file-lifecycle-repository.mjs";
import { PostgresqlFileReviewRepository } from "../lib/data/postgresql/postgresql-file-review-repository.mjs";
import { FileLifecycleService } from "../lib/files/file-lifecycle-service.mjs";
import { FileReviewService } from "../lib/files/file-review-service.mjs";

class RecordingProvider {
  constructor(responses = []) {
    this.config = { schema: "app" };
    this.responses = [...responses];
    this.calls = [];
  }
  async query(text, values = []) {
    this.calls.push({ text, values });
    return this.responses.shift() || { rows: [], rowCount: 0 };
  }
  async execute(text, values = []) { return this.query(text, values); }
  async transaction(callback) { return callback(this); }
}

test("PostgreSQL lifecycle scan creation returns shared scan state", async () => {
  const provider = new RecordingProvider([{ rows: [{
    id: "scan-1", status: "running", scopes_json: ["exports"], summary_json: {}, scope_errors_json: [],
    total_files: 0, total_bytes: 0, truncated: false, started_at: "2026-08-12T00:00:00Z",
    created_at: "2026-08-12T00:00:00Z", updated_at: "2026-08-12T00:00:00Z",
  }], rowCount: 1 }]);
  const repository = new PostgresqlFileLifecycleRepository({ provider, randomUUID: () => "scan-1" });
  const scan = await repository.createScan(["exports"], new Date("2026-08-12T00:00:00Z"));
  assert.equal(scan.id, "scan-1");
  assert.deepEqual(scan.scopes, ["exports"]);
  assert.match(provider.calls[0].text, /INSERT INTO "app"\."file_lifecycle_scans"/);
  assert.deepEqual(provider.calls[0].values[1], '["exports"]');
});

test("PostgreSQL lifecycle repository preserves the complete scanner interface", () => {
  const repository = new PostgresqlFileLifecycleRepository({ provider: new RecordingProvider() });
  for (const method of ["getRunningScan", "completeScan", "failScan", "attachReport", "getScan", "listScans",
    "listItems", "allItems", "latestSummary", "protectedFileIds", "validateScopes"]) {
    assert.equal(typeof repository[method], "function", method);
  }
});

test("PostgreSQL review evidence uses optimistic scan identity and returns classified item", async () => {
  const provider = new RecordingProvider([{ rows: [{
    id: "item-1", scan_id: "scan-1", classification: "unregistered", categories_json: ["unregistered"],
    scope: "exports", masked_filename: "report.xlsx", file_size: "42", physical_status: "present",
    detected_file_type: "advertising_report", review_status: "pending_review",
  }], rowCount: 1 }]);
  const repository = new PostgresqlFileReviewRepository({ provider });
  const item = await repository.saveEvidence("item-1", {
    scanId: "scan-1", detectedFileType: "advertising_report", rootKey: "exports",
    relativePath: "advertising/report.xlsx", fileHash: "abc", mimeType: "application/vnd.ms-excel",
    signatureCode: "xlsx", reasonCode: "known_report",
  });
  assert.equal(item.detectedFileType, "advertising_report");
  assert.match(provider.calls[0].text, /WHERE id=\$9 AND scan_id=\$10/);
  assert.equal(provider.calls[0].values.at(-1), "scan-1");
});

test("PostgreSQL review repository preserves registration and quarantine interfaces", () => {
  const repository = new PostgresqlFileReviewRepository({ provider: new RecordingProvider() });
  for (const method of ["getItem", "scanItems", "setReviewStatus", "registerManagedFile", "getManagedFile",
    "getManagedFileByItem", "listManagedFiles", "recordQuarantine", "getQuarantineRecord",
    "getActiveQuarantineByItem", "recordRestore", "listQuarantineRecords"]) {
    assert.equal(typeof repository[method], "function", method);
  }
});

test("file lifecycle service awaits an asynchronous shared repository before returning", async () => {
  const scan = { id: "scan-async", status: "running", scopes: ["main_export"] };
  const service = new FileLifecycleService({
    repository: {
      async getRunningScan() { return null; },
      async createScan() { return scan; },
      async completeScan() { return { ...scan, status: "completed" }; },
      async failScan() { return { ...scan, status: "failed" }; },
    },
    scanner: { async scan() { return { items: [], summary: {}, scopeErrors: [], totalFiles: 0, totalBytes: 0 }; } },
  });
  const result = await service.startScan(["main_export"]);
  assert.equal(result.scan.id, "scan-async");
  await service.waitForIdle();
});

test("file review service awaits shared state before enforcing transition rules", async () => {
  const item = { id: "item-1", reviewStatus: "registered", detectedFileType: "advertising_report", categories: [] };
  const service = new FileReviewService({
    repository: {
      async getItem() { return item; },
      async setReviewStatus(_id, status) { return { ...item, reviewStatus: status }; },
    },
    lifecycleRepository: {}, roots: [], storageRoot: process.cwd(), quarantineRoot: `${process.cwd()}\\storage\\quarantine-test`,
  });
  await assert.rejects(() => service.protectItem("item-1"), { code: "REVIEW_STATE_INVALID" });
});
