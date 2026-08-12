import assert from "node:assert/strict";
import test from "node:test";
import { DATABASE_DIALECTS } from "../lib/data/database-provider.mjs";
import { SalesAssortmentRepository } from "../lib/sales-assortment/sales-assortment-repository.mjs";
import { ProductAiContentRepository } from "../lib/data/repositories/product-ai-content-repository.mjs";
import { ProductCatalogRepository } from "../lib/data/repositories/product-catalog-repository.mjs";
import { ProductImportRepository } from "../lib/data/repositories/product-import-repository.mjs";
import { GrowthRadarV2Repository } from "../lib/growth-radar/v2/growth-radar-v2-repository.mjs";
import { FoundationRepository } from "../lib/foundation/foundation-repository.mjs";

class RecordingPostgresqlProvider {
  constructor(responses = []) {
    this.dialect = DATABASE_DIALECTS.POSTGRESQL;
    this.connection = {};
    this.transactionManager = { run: (callback) => callback(this) };
    this.responses = [...responses];
    this.calls = [];
  }
  placeholder(index) { return `$${index}`; }
  async query(text, values = []) {
    this.calls.push({ kind: "query", text, values });
    return this.responses.shift() || { rows: [], rowCount: 0 };
  }
  async execute(text, values = []) { return this.query(text, values); }
  async executeScript(text) { return this.query(text); }
  async transaction(callback) { return callback(this); }
  async migrate() { return []; }
  async close() {}
}

test("PostgreSQL sales assortment inventory lookup uses provider placeholders", async () => {
  const provider = new RecordingPostgresqlProvider([
    { rows: [{ id: "batch-1" }], rowCount: 1 },
    { rows: [{ batch_id: "batch-1", sku: "SKU-1" }], rowCount: 1 },
  ]);
  const repository = new SalesAssortmentRepository({ provider });

  const result = await repository.latestInventoryRows();

  assert.equal(result.rows[0].sku, "SKU-1");
  assert.match(provider.calls[1].text, /WHERE i\.batch_id = \$1/);
  assert.equal(provider.calls[1].text.includes("?"), false);
  assert.deepEqual(provider.calls[1].values, ["batch-1"]);
});

test("PostgreSQL sales assortment orders use booleans and numbered status parameters", async () => {
  const provider = new RecordingPostgresqlProvider([{ rows: [{ latest_paid_at: "2026-08-12T00:00:00Z" }], rowCount: 1 }]);
  const repository = new SalesAssortmentRepository({ provider });

  assert.equal(await repository.latestOrderDay(), "2026-08-12T00:00:00Z");
  assert.match(provider.calls[0].text, /l\.is_current = true/);
  assert.match(provider.calls[0].text, /IN \(\$1, \$2, \$3, \$4\)/);
  assert.equal(provider.calls[0].text.includes("?"), false);
  assert.deepEqual(provider.calls[0].values, ["已发货", "待处理", "配货中", "已完成"]);
});

test("PostgreSQL sales assortment pagination numbers filters without interpolation", async () => {
  const provider = new RecordingPostgresqlProvider([
    { rows: [{ total: "2" }], rowCount: 1 },
    { rows: [{ source_order_id: "ORDER-1" }], rowCount: 1 },
  ]);
  const repository = new SalesAssortmentRepository({ provider });

  const result = await repository.sourceRows("orders", { page: 2, pageSize: 1 });

  assert.equal(result.total, 2);
  assert.match(provider.calls[1].text, /LIMIT \$5 OFFSET \$6/);
  assert.deepEqual(provider.calls[1].values, ["已发货", "待处理", "配货中", "已完成", 1, 1]);
});

test("PostgreSQL AI content writes native booleans", async () => {
  const provider = new RecordingPostgresqlProvider([
    { rows: [{ next_version: 1 }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [{
      id: "content-1", product_sku_id: "sku-1", country: "CN", sku: "SKU-1", provider: "deepseek",
      model: "model", content_type: "listing", input_context_json: {}, output_content_json: {}, prompt_version: "v1",
      status: "draft", version: 1, created_by: "developer", is_manually_modified: true,
    }], rowCount: 1 },
  ]);
  const repository = new ProductAiContentRepository({ provider });
  const created = await repository.create({
    productId: "sku-1", country: "CN", sku: "SKU-1", provider: "deepseek", model: "model",
    contentType: "listing", inputContext: {}, outputContent: {}, promptVersion: "v1", status: "draft",
    createdBy: "developer", isManuallyModified: true,
  });
  assert.equal(created.isManuallyModified, true);
  const insert = provider.calls.find(({ text }) => text.includes("INSERT INTO app.product_ai_contents"));
  assert.equal(insert.values[26], true);
});

test("PostgreSQL product image primary flag is a native boolean", async () => {
  const provider = new RecordingPostgresqlProvider([
    { rows: [{ total: "0" }], rowCount: 1 },
    { rows: [], rowCount: 1 },
    { rows: [{ id: "image-1", sku_id: "sku-1", is_primary: true, sort_order: 0 }], rowCount: 1 },
  ]);
  const repository = new ProductCatalogRepository({ provider });
  const image = await repository.createImage({
    id: "image-1", productId: "sku-1", originalFilename: "one.jpg", storageFilename: "one-safe.jpg",
    relativePath: "product-media/one-safe.jpg", mimeType: "image/jpeg", fileSize: 10, fileHash: "hash",
    source: "upload", isPrimary: false,
  });
  assert.equal(image.isPrimary, true);
  const insert = provider.calls.find(({ text }) => text.includes("INSERT INTO app.product_images"));
  assert.equal(insert.values[8], true);
});

test("PostgreSQL product import field changes write native override booleans", async () => {
  const provider = new RecordingPostgresqlProvider(Array.from({ length: 8 }, () => ({ rows: [], rowCount: 1 })));
  const repository = new ProductImportRepository({ provider });
  await repository.replaceValidation("batch-1", {
    rows: [], issues: [],
    fieldChanges: [{
      id: "change-1", importRowId: "row-1", productPackageRowId: null, sourceRowNumber: 1,
      country: "CN", sku: "SKU-1", warehouse: "WH", productName: "Product", sourceHeader: "产品名称",
      fieldCode: "product_name", oldValue: "Old", newValue: "New", oldType: "string", newType: "string",
      hasManualOverride: true,
    }],
    summary: { sourcePeriod: null, sourceCountryRaw: "CN" }, headerFingerprint: "header",
    counts: { rowCount: 0, newCount: 0, updatedCount: 0, unchangedCount: 0, conflictCount: 0, exceptionCount: 0, unmatchedCount: 0, willWriteCount: 0, blockerCount: 0, reminderCount: 0, informationCount: 0 },
    mapping: [], unknownFields: [],
  });
  const insert = provider.calls.find(({ text }) => text.includes("INSERT INTO app.product_import_field_changes"));
  assert.equal(insert.values[15], true);
});

test("PostgreSQL growth metrics write native boolean flags", async () => {
  const provider = new RecordingPostgresqlProvider();
  const repository = new GrowthRadarV2Repository({ provider });
  await repository.insertSkuMetric({
    id: "metric-1", analysisRunId: "run-1", analysisDate: "2026-08-12", scopeType: "global", scopeKey: "global",
    sourceHighPerformance: true, isNew: false, evidence: {}, warehouseSupplySummary: {}, calculatedAt: "2026-08-12T00:00:00Z",
  });
  const insert = provider.calls[0];
  assert.equal(insert.values[35], true);
  assert.equal(insert.values[36], false);
});

test("PostgreSQL foundation readiness checks the configured schema catalog", async () => {
  const provider = new RecordingPostgresqlProvider([{ rows: [{ ready: 1 }], rowCount: 1 }]);
  const repository = new FoundationRepository({ provider });
  assert.equal(await repository.isReady(), true);
  assert.match(provider.calls[0].text, /to_regclass\(\$1\)/);
  assert.deepEqual(provider.calls[0].values, ["app.foundation_tasks"]);
  assert.equal(provider.calls[0].text.includes("sqlite_master"), false);
});

test("PostgreSQL foundation account filters use numbered parameters", async () => {
  const provider = new RecordingPostgresqlProvider([{ rows: [{
    id: "account-1", source_system_code: "mabang", display_name: "Mabang", credential_ref_type: "encrypted",
    status: "active", metadata_json: {},
  }], rowCount: 1 }]);
  const repository = new FoundationRepository({ provider });
  const accounts = await repository.listAccounts({ sourceSystem: "mabang", capability: "orders.read", status: "active" });
  assert.equal(accounts[0].id, "account-1");
  assert.match(provider.calls[0].text, /capability_code=\$1/);
  assert.match(provider.calls[0].text, /source_system_code=\$2/);
  assert.match(provider.calls[0].text, /account\.status=\$3/);
  assert.deepEqual(provider.calls[0].values, ["orders.read", "mabang", "active"]);
});

test("PostgreSQL foundation account upsert and lookup contain no SQLite placeholders", async () => {
  const provider = new RecordingPostgresqlProvider([
    { rows: [], rowCount: 1 },
    { rows: [{ id: "account-1", source_system_code: "mabang", display_name: "Mabang", credential_ref_type: "encrypted", status: "active", metadata_json: {} }], rowCount: 1 },
  ]);
  const repository = new FoundationRepository({ provider });
  const account = await repository.upsertAccount({
    id: "account-1", sourceSystem: "mabang", displayName: "Mabang", credentialRefType: "encrypted", metadata: {},
  }, new Date("2026-08-12T00:00:00Z"));
  assert.equal(account.id, "account-1");
  assert.match(provider.calls[0].text, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10\)/);
  assert.match(provider.calls[1].text, /WHERE id=\$1/);
  assert.equal(provider.calls.some(({ text }) => text.includes("?")), false);
});

test("PostgreSQL foundation lease acquisition locks and uses server time", async () => {
  const provider = new RecordingPostgresqlProvider([{ rows: [{
    task_id: "task-1", lease_owner: "host-b", lease_token: "old", expires_at: "2026-08-11T00:00:00Z",
  }], rowCount: 1 }, { rows: [], rowCount: 1 }]);
  const repository = new FoundationRepository({ provider });
  const lease = await repository.acquireTaskLease("task-1", { leaseOwner: "host-c", leaseToken: "token", ttlMs: 30_000 });
  assert.equal(lease.leaseOwner, "host-c");
  assert.match(provider.calls[0].text, /FOR UPDATE/);
  assert.match(provider.calls[1].text, /clock_timestamp\(\)/);
  assert.equal(provider.calls.some(({ text }) => text.includes("?")), false);
});
