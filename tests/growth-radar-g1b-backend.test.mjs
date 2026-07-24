import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { createGrowthRadarAccessPolicy } from "../lib/growth-radar/growth-radar-access-policy.mjs";
import { createGrowthRadarApi } from "../lib/growth-radar/growth-radar-api.mjs";
import { GrowthRadarService } from "../lib/growth-radar/growth-radar-service.mjs";
import { RUNTIME_PROFILES, RuntimeIsolationError, resolveRuntimeConfig } from "../lib/runtime-config.mjs";

const projectRoot = path.resolve(".");
const AT = "2026-07-22T04:00:00.000Z";
const ORDER_SHA = "1".repeat(64);
const INVENTORY_SHA = "2".repeat(64);

function rowHash(value) {
  return String(value).padStart(64, "0").slice(-64);
}

function orderNormalized(index, overrides = {}) {
  return {
    sourceOrderId: `ORDER-${String(index).padStart(3, "0")}`,
    sourceShopName: `Sample Shop ${String(index).padStart(2, "0")}`,
    platform: "lazada",
    orderStatus: "shipped",
    paidAt: "2026-07-21T04:00:00.000Z",
    cancelledAt: null,
    orderCurrency: "CNY",
    orderAmount: 10,
    orderAmountSourceField: "order_amount",
    effectiveStatus: "valid",
    sourceSku: index === 16 ? "SKU-MISSING" : "SKU-OK",
    platformSku: `PLATFORM-${index}`,
    quantity: 1,
    productName: `Safe product ${index}`,
    warehouseName: index % 2 ? "WH-A" : "WH-B",
    skuDetail: "default",
    unitSalePrice: 10,
    orderSkuTotal: 1,
    lineAmount: null,
    lineAmountStatus: "unavailable",
    refundDataStatus: "unavailable",
    ...overrides,
  };
}

function parsedOrderRow(sourceRowNumber, normalized, overrides = {}) {
  return {
    sourceRowNumber,
    rawPayload: { order_id: normalized.sourceOrderId, shop: normalized.sourceShopName, sku: normalized.sourceSku },
    rawTypes: { order_id: "text", shop: "text", sku: "text" },
    redactedFields: ["买家", "buyer", "收件地址", "电话", "邮箱", "客户备注"],
    rowHash: rowHash(sourceRowNumber),
    parseStatus: "parsed",
    issueCodes: [],
    formulaFields: [],
    normalized,
    ...overrides,
  };
}

function orderWorkbook() {
  const rows = Array.from({ length: 16 }, (_, offset) => {
    const item = parsedOrderRow(offset + 2, orderNormalized(offset + 1));
    if (offset === 1) {
      item.formulaFields = ["客户备注"];
      item.issueCodes = ["FORMULA_CELL_REDACTED"];
      item.rawTypes = { ...item.rawTypes, note: "formula_risk" };
    }
    return item;
  });
  rows.push(parsedOrderRow(18, orderNormalized(1), { rowHash: rows[0].rowHash }));
  rows.push(parsedOrderRow(19, orderNormalized(1, { sourceOrderId: "ORDER-INVALID", orderStatus: "unknown", effectiveStatus: "unconfirmed" })));
  rows.push(parsedOrderRow(20, orderNormalized(1, { sourceOrderId: "ORDER-CANCELLED", orderStatus: "cancelled",
    effectiveStatus: "invalid_cancelled", cancelledAt: "2026-07-21T05:00:00.000Z", quantity: 99 })));
  return {
    sheetName: "orders",
    headers: ["order_id", "shop", "sku", "买家", "buyer", "收件地址", "电话", "邮箱", "客户备注"],
    redactedHeaders: ["买家", "buyer", "收件地址", "电话", "邮箱", "客户备注"],
    piiFilteredHeaders: ["买家", "buyer", "收件地址", "电话", "邮箱", "客户备注"],
    formulaCellCount: 1,
    collectionMetadata: { dateFrom: "2026-07-21", dateTo: "2026-07-21", exportedAt: AT },
    rowCount: rows.length,
    rows,
  };
}

function inventoryRow(sourceRowNumber, sourceSku, warehouseName, overrides = {}) {
  return {
    sourceRowNumber,
    rawPayload: { sku: sourceSku, warehouse: warehouseName },
    rawTypes: { sku: "text", warehouse: "text" },
    redactedFields: [],
    rowHash: rowHash(100 + sourceRowNumber),
    parseStatus: "parsed",
    issueCodes: [],
    formulaFields: [],
    normalized: {
      sourceSku,
      warehouseName,
      availableQuantity: 10,
      physicalQuantity: 12,
      lockedQuantity: 2,
      inTransitQuantity: 3,
      pendingShipmentQuantity: 1,
      productStatus: "active",
      categoryLevel1: "test",
      categoryLevel2: null,
      categoryLevel3: null,
      sourceVisibleSales7d: 7,
      sourceVisibleSales28d: 28,
      sourceVisibleSales42d: 42,
      sourceVisibleSalesStatus: "confirmed",
      sourcePredictedDailySales: 1.5,
      snapshotAt: AT,
      sellableQuantity: null,
      sellableQuantityStatus: "unconfirmed",
      daysOfSupply: null,
      daysOfSupplyStatus: "unavailable",
    },
    ...overrides,
  };
}

function inventoryWorkbook() {
  const first = inventoryRow(2, "SKU-OK", "WH-A");
  const rows = [
    first,
    inventoryRow(3, "SKU-OK", "WH-B"),
    inventoryRow(4, "SKU-OK", "WH-A", { rowHash: rowHash(104) }),
    inventoryRow(5, "", "WH-C", { parseStatus: "rejected", issueCodes: ["INVENTORY_SKU_MISSING"] }),
    inventoryRow(6, "SKU-OK", "", { parseStatus: "rejected", issueCodes: ["INVENTORY_WAREHOUSE_MISSING"] }),
    inventoryRow(7, "NO-PRODUCT", "WH-X"),
  ];
  return {
    sheetName: "inventory",
    headers: ["sku", "warehouse", "available", "sales", "prediction"],
    redactedHeaders: [],
    piiFilteredHeaders: [],
    formulaCellCount: 0,
    collectionMetadata: { inventorySnapshotAt: AT, exportedAt: AT },
    rowCount: rows.length,
    rows,
  };
}

function rollbackWorkbook() {
  return {
    sheetName: "orders",
    headers: ["order_id", "shop", "sku"],
    redactedHeaders: [],
    piiFilteredHeaders: [],
    formulaCellCount: 0,
    collectionMetadata: { dateFrom: "2026-07-22", dateTo: "2026-07-22" },
    rowCount: 1,
    rows: [parsedOrderRow(2, orderNormalized(99, { sourceOrderId: "ROLLBACK-001", sourceShopName: "Rollback Shop" }))],
  };
}

async function seedProduct(provider) {
  await provider.execute(`INSERT INTO product_import_batches (
    id,file_sha256,status,operator_label,created_at,updated_at
  ) VALUES (?,?,?,?,?,?)`, ["g1b-product-batch", "9".repeat(64), "applied", "test", AT, AT]);
  await provider.execute(`INSERT INTO product_categories (
    id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ["g1b-category", "root", 1, "company_product_center", "Test", "Test", "active",
    "g1b-product-batch", "g1b-product-batch", AT, AT]);
  await provider.execute(`INSERT INTO product_import_rows (
    id,batch_id,source_row_number,source_sku,row_sha256,raw_payload_json,normalized_payload_json,
    validation_codes_json,outcome,created_at,source_country_raw,product_key,product_sha256
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ["g1b-product-row", "g1b-product-batch", 2, "SKU-OK", "8".repeat(64), "{}", "{}", "[]",
    "new", AT, "TH", "TH|SKU-OK", "7".repeat(64)]);
  await provider.execute(`INSERT INTO product_skus (
    id,source_system,source_sku,normalized_sku,category_id,source_product_name,source_main_sku,
    source_status_raw,current_source_row_id,first_seen_batch_id,last_seen_batch_id,created_at,updated_at,country_raw,sku_code_normalized
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ["g1b-product", "company_product_center", "SKU-OK", "TH|SKU-OK", "g1b-category",
    "Safe test product", "MAIN-OK", "active", "g1b-product-row", "g1b-product-batch", "g1b-product-batch", AT, AT, "TH", "SKU-OK"]);
  await provider.execute("UPDATE product_import_rows SET target_sku_id=? WHERE id=?", ["g1b-product", "g1b-product-row"]);
}

async function invoke(api, { method, pathname, body, actor = "authenticated_session" }) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = Readable.from(payload);
  req.method = method;
  req.headers = { "content-type": "application/json" };
  req.auditContext = { actorType: actor, annotations: {}, requestId: "g1b-api-request", annotate(values) { Object.assign(this.annotations, values); } };
  let status = 0;
  let output = "";
  const res = {
    writeHead(nextStatus) { status = nextStatus; },
    end(chunk = "") { output += String(chunk); },
  };
  await api(req, res, new URL(pathname, "http://127.0.0.1"));
  return { status, body: JSON.parse(output) };
}

function a2Env(root, overrides = {}) {
  const storageRoot = path.join(root, "storage", "development");
  return {
    COMMERCE_OPS_RUNTIME_PROFILE: RUNTIME_PROFILES.GROWTH_RADAR_G1B,
    DATABASE_PATH: path.join(storageRoot, "growth-radar-g1b.sqlite"),
    STORAGE_ROOT: storageRoot,
    APP_HOST: "127.0.0.1",
    APP_PORT: "3193",
    AD_SERVICE_MODE: "external",
    ...overrides,
  };
}

test("G1B1 shop scope and source confirmation backend", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-g1b-backend-"));
  const databasePath = path.join(root, "g1b-test.sqlite");
  const dataAccess = openCommerceDataAccess({ rootDir: projectRoot, databasePath });
  let parsed = orderWorkbook();
  let currentTime = new Date(AT);
  const service = new GrowthRadarService({
    repository: dataAccess.repositories.growthRadar,
    pythonExecutable: "python",
    parserScript: "unused.py",
    fileStorageConfig: { tempRoot: path.join(root, "temp") },
    parseWorkbook: async () => parsed,
    now: () => new Date(currentTime),
  });
  const api = createGrowthRadarApi({ service, accessPolicy: createGrowthRadarAccessPolicy() });
  let orderPreview;
  let orderApplied;
  let inventoryPreview;
  let inventoryApplied;
  let firstShop;
  const packageRowsBefore = Number((await dataAccess.provider.query("SELECT COUNT(*) AS total FROM product_package_rows")).rows[0].total);

  try {
    await seedProduct(dataAccess.provider);
    orderPreview = await service.previewFile("mabang_order", { filename: "orders.xlsx", sourceFilename: "orders.xlsx",
      sourceSha256: ORDER_SHA, sourceScope: { platform: "lazada", countryCode: "TH", dateFrom: "2026-07-21", dateTo: "2026-07-21" } });
    orderApplied = await service.applyPreview("mabang_order", { previewId: orderPreview.previewId },
      { actorLabel: "authenticated:test-user", confirmationGranted: true });

    await t.test("01 sixteen discovered shops start pending", async () => {
      const pending = await service.listShops({ confirmationStatus: "pending", pageSize: 100 });
      const confirmed = await service.listShops({ confirmationStatus: "confirmed", pageSize: 100 });
      assert.equal(pending.total, 16);
      assert.equal(pending.shops.every((shop) => shop.confirmationStatus === "pending"), true);
      assert.equal(confirmed.total, 0);
      firstShop = pending.shops.find((shop) => shop.displayName === "Sample Shop 01");
    });

    await t.test("02 pending shops stay outside formal opportunity scope", async () => {
      assert.equal((await service.listObservations({ formalScopeOnly: true })).total, 0);
      assert.equal((await service.semanticStatus()).opportunity_scope.confirmed_observation_count, 0);
    });

    await t.test("03 request body cannot forge confirmedBy", async () => {
      const response = await invoke(api, { method: "POST", pathname: `/api/growth-radar/shops/${firstShop.id}/confirm`,
        body: { confirmedBy: "forged-client-user" } });
      assert.equal(response.status, 200);
      assert.equal(response.body.confirmedBy, "authenticated_session");
      assert.notEqual(response.body.confirmedBy, "forged-client-user");
    });

    await t.test("04 repeated shop confirmation is idempotent", async () => {
      const result = await service.confirmShopScope(firstShop.id, { actorLabel: "authenticated_session" });
      assert.equal(result.reused, true);
      assert.equal(result.confirmedBy, "authenticated_session");
    });

    await t.test("05 revocation retains a server-side reason in history", async () => {
      const result = await service.revokeShopScope(firstShop.id, { reason: "scope ownership changed" },
        { actorLabel: "authenticated:test-user", requestId: "revoke-request" });
      assert.equal(result.reason, "scope ownership changed");
      assert.equal(result.history.some((event) => event.action === "revoked" && event.after.reason === "scope ownership changed"), true);
    });

    await t.test("06 permission policy blocks unauthorized scope confirmation", () => {
      const denied = createGrowthRadarAccessPolicy({ GROWTH_RADAR_PERMISSIONS: "growth_radar.data.view" });
      assert.throws(() => denied.assert("growth_radar.scope.confirm", firstShop.id), { code: "GROWTH_RADAR_PERMISSION_DENIED" });
    });

    await t.test("07 historical_observed is not current_online", async () => {
      const semantics = await service.semanticStatus();
      assert.equal(semantics.historical_observed.semantic_type, "historical_observed");
      assert.equal(semantics.historical_observed.availability_status, "available");
      assert.equal(semantics.current_online.semantic_type, "current_online");
      assert.notDeepEqual(semantics.historical_observed, semantics.current_online);
    });

    await t.test("08 current_online without an authoritative source is unavailable", async () => {
      const value = (await service.semanticStatus()).current_online;
      assert.equal(value.value, null);
      assert.equal(value.source, null);
      assert.equal(value.availability_status, "unavailable");
    });

    await t.test("09 prediction is labeled non-actual and does not enter own_sales", async () => {
      const ownBefore = (await service.semanticStatus()).own_sales.value;
      parsed = inventoryWorkbook();
      inventoryPreview = await service.previewFile("mabang_inventory", { filename: "inventory.xlsx", sourceFilename: "inventory.xlsx",
        sourceSha256: INVENTORY_SHA, sourceScope: { platform: "lazada", countryCode: "TH" }, collectedAt: AT });
      assert.equal(inventoryPreview.summary.predictedDailySalesStatus, "source_prediction_not_actual");
      assert.equal((await service.semanticStatus()).own_sales.value, ownBefore);
    });

    await t.test("10 source-visible sales never becomes company_sales", async () => {
      assert.equal(inventoryPreview.sampleRows[0].normalized.sourceVisibleSales7d, 7);
      const company = (await service.semanticStatus()).company_sales;
      assert.equal(company.value, null);
      assert.equal(company.source, null);
    });

    await t.test("11 unavailable company_sales is null rather than a fabricated zero", async () => {
      const company = (await service.semanticStatus()).company_sales;
      assert.equal(company.value, null);
      assert.equal(company.availability_status, "unavailable");
    });

    await t.test("12 own_sales counts only valid order lines", async () => {
      const own = (await service.semanticStatus()).own_sales;
      assert.equal(own.value, 16);
      assert.equal(own.confirmation_status, "confirmed");
    });

    await t.test("13 order preview filters PII fields", () => {
      assert.equal(orderPreview.piiFilteredFieldCount, 6);
      assert.equal(orderPreview.issues.some((item) => item.issueCode === "pii_field_filtered"), true);
    });

    await t.test("14 Chinese buyer and English buyer headers are both recognized", async () => {
      const parserSource = await fs.readFile(path.join(projectRoot, "scripts", "growth-radar-parser.py"), "utf8");
      assert.equal(parserSource.includes("买家"), true);
      assert.match(parserSource, /buyer/i);
    });

    await t.test("15 Excel formula injection is classified and redacted", () => {
      assert.equal(orderPreview.formulaCellCount, 1);
      assert.equal(orderPreview.issues.some((item) => item.issueCode === "formula_injection_risk"), true);
      assert.equal(orderPreview.sampleRows.some((item) => item.issueCodes.includes("FORMULA_CELL_REDACTED")), true);
    });

    await t.test("16 exact duplicate source rows are rejected", () => {
      assert.equal(orderPreview.summary.duplicateRowCount, 1);
      assert.equal(orderPreview.issues.some((item) => item.issueCode === "duplicate_source_row"), true);
    });

    await t.test("17 unrecognized order status is excluded", () => {
      assert.equal(orderPreview.summary.invalidRowCount, 2);
      assert.equal(orderPreview.issues.some((item) => item.issueCode === "invalid_order_status"), true);
    });

    await t.test("18 unmatched shops produce standardized issues", () => {
      const issue = orderPreview.issues.find((item) => item.issueCode === "missing_shop_mapping");
      assert.equal(issue.affectedCount, 16);
      assert.equal(issue.blocking, false);
    });

    await t.test("19 unmatched SKU produces a standardized issue", () => {
      const issue = orderPreview.issues.find((item) => item.issueCode === "missing_sku");
      assert.equal(issue.affectedCount, 1);
      assert.equal(typeof issue.recommendedAction, "string");
    });

    await t.test("20 order preview writes no additional facts", async () => {
      const before = await service.summary();
      parsed = orderWorkbook();
      await service.previewFile("mabang_order", { filename: "orders-preview-only.xlsx", sourceFilename: "orders-preview-only.xlsx",
        sourceSha256: "3".repeat(64), sourceScope: { platform: "lazada", countryCode: "TH" } });
      assert.deepEqual(await service.summary(), before);
    });

    await t.test("21 source SKU plus source warehouse drives inventory linkage", async () => {
      inventoryApplied = await service.applyPreview("mabang_inventory", { previewId: inventoryPreview.previewId },
        { actorLabel: "authenticated:test-user", confirmationGranted: true });
      const links = await dataAccess.provider.query("SELECT match_status,normalized_source_sku,normalized_source_warehouse_name FROM growth_order_inventory_links WHERE is_current=1");
      assert.equal(links.rows.some((item) => item.match_status === "matched" && item.normalized_source_sku === "SKU-OK"
        && ["WH-A", "WH-B"].includes(item.normalized_source_warehouse_name)), true);
    });

    await t.test("22 the same SKU in multiple warehouses is not deduplicated", async () => {
      const rows = await dataAccess.provider.query("SELECT normalized_warehouse_name FROM growth_inventory_snapshots WHERE normalized_source_sku='SKU-OK' ORDER BY normalized_warehouse_name");
      assert.deepEqual(rows.rows.map((row) => row.normalized_warehouse_name), ["WH-A", "WH-B"]);
      assert.equal(inventoryPreview.summary.multiWarehouseSkuCount, 1);
    });

    await t.test("23 empty inventory SKU emits an issue", () => {
      assert.equal(inventoryPreview.summary.emptySkuCount, 1);
      assert.equal(inventoryPreview.issues.some((item) => item.issueCode === "empty_source_sku"), true);
    });

    await t.test("24 duplicate inventory snapshot is rejected", () => {
      assert.equal(inventoryPreview.summary.duplicateRecordCount, 1);
      assert.equal(inventoryPreview.issues.some((item) => item.issueCode === "duplicate_source_row"), true);
    });

    await t.test("25 applied prediction retains non-actual semantics", async () => {
      const semantics = await service.semanticStatus();
      assert.equal(semantics.source_predicted_daily_sales.availability_status, "source_prediction_not_actual");
      assert.equal(semantics.own_sales.value, 16);
      assert.notEqual(semantics.source_predicted_daily_sales.value, semantics.own_sales.value);
    });

    await t.test("26 inventory preview writes no additional facts", async () => {
      const before = await service.summary();
      parsed = inventoryWorkbook();
      await service.previewFile("mabang_inventory", { filename: "inventory-preview-only.xlsx", sourceFilename: "inventory-preview-only.xlsx",
        sourceSha256: "4".repeat(64), sourceScope: { platform: "lazada", countryCode: "TH" }, collectedAt: AT });
      assert.deepEqual(await service.summary(), before);
    });

    let pendingApplicationPreview;
    await t.test("27 application without server confirmation is rejected", async () => {
      parsed = rollbackWorkbook();
      pendingApplicationPreview = await service.previewFile("mabang_order", { filename: "unconfirmed.xlsx", sourceFilename: "unconfirmed.xlsx",
        sourceSha256: "5".repeat(64), sourceScope: { platform: "lazada", countryCode: "TH" } });
      await assert.rejects(service.applyPreview("mabang_order", { previewId: pendingApplicationPreview.previewId },
        { actorLabel: "authenticated:test-user" }), { code: "GROWTH_RADAR_PREVIEW_NOT_CONFIRMED" });
    });

    await t.test("28 expired preview cannot be applied", async () => {
      let staleClock = new Date(AT);
      const staleService = new GrowthRadarService({ repository: dataAccess.repositories.growthRadar, pythonExecutable: "python",
        parserScript: "unused.py", fileStorageConfig: { tempRoot: path.join(root, "temp-stale") }, parseWorkbook: async () => rollbackWorkbook(),
        previewTtlMs: 10, now: () => new Date(staleClock) });
      const stale = await staleService.previewFile("mabang_order", { filename: "stale.xlsx", sourceFilename: "stale.xlsx",
        sourceSha256: "6".repeat(64), sourceScope: { platform: "lazada", countryCode: "TH" } });
      staleClock = new Date(new Date(AT).getTime() + 11);
      await assert.rejects(staleService.applyPreview("mabang_order", { previewId: stale.previewId },
        { actorLabel: "authenticated:test-user", confirmationGranted: true }), { code: "GROWTH_RADAR_PREVIEW_STALE" });
    });

    await t.test("29 application failure rolls the transaction back", async () => {
      parsed = rollbackWorkbook();
      const preview = await service.previewFile("mabang_order", { filename: "rollback.xlsx", sourceFilename: "rollback.xlsx",
        sourceSha256: "7".repeat(64), sourceScope: { platform: "lazada", countryCode: "TH" } });
      const before = await service.summary();
      const original = dataAccess.repositories.growthRadar.insertOrderLine;
      dataAccess.repositories.growthRadar.insertOrderLine = async () => { throw new Error("forced transaction failure"); };
      try {
        await assert.rejects(service.applyPreview("mabang_order", { previewId: preview.previewId },
          { actorLabel: "authenticated:test-user", confirmationGranted: true }), /forced transaction failure/);
      } finally {
        dataAccess.repositories.growthRadar.insertOrderLine = original;
      }
      assert.deepEqual(await service.summary(), before);
    });

    await t.test("30 repeated application is idempotent", async () => {
      const repeatedOrder = await service.applyPreview("mabang_order", { previewId: orderPreview.previewId },
        { actorLabel: "authenticated:test-user", confirmationGranted: true });
      const repeatedInventory = await service.applyPreview("mabang_inventory", { previewId: inventoryPreview.previewId },
        { actorLabel: "authenticated:test-user", confirmationGranted: true });
      assert.equal(repeatedOrder.reused, true);
      assert.equal(repeatedInventory.reused, true);
      assert.equal(repeatedOrder.applicationResult.createdCount, 0);
    });

    await t.test("31 server records confirmation actor and time", async () => {
      const detail = await service.batchDetail(orderApplied.batch.id);
      assert.equal(detail.batch.confirmedBy, "authenticated:test-user");
      assert.equal(detail.batch.confirmedAt, AT);
      assert.equal(detail.batch.confirmationStatus, "confirmed");
    });

    await t.test("32 unconfirmed shop observations remain outside opportunity scope", async () => {
      const semantics = await service.semanticStatus();
      assert.equal(semantics.opportunity_scope.confirmed_observation_count, 0);
      assert.equal((await service.listObservations({ formalScopeOnly: false })).total > 0, true);
      assert.equal((await service.listObservations({ formalScopeOnly: true })).total, 0);
    });

    await t.test("33 applied Growth Radar rows contain no customer PII", async () => {
      const rows = await dataAccess.provider.query("SELECT raw_values_json FROM growth_order_raw_rows");
      const serialized = rows.rows.map((row) => row.raw_values_json).join("\n");
      assert.doesNotMatch(serialized, /买家|buyer|address|phone|email|客户备注/i);
    });

    await t.test("34 product_package_rows is unchanged", async () => {
      const after = Number((await dataAccess.provider.query("SELECT COUNT(*) AS total FROM product_package_rows")).rows[0].total);
      assert.equal(after, packageRowsBefore);
    });

    await t.test("35 G1B migration baseline remains complete from 001 through 014", async () => {
      const migrations = (await fs.readdir(path.join(projectRoot, "migrations"))).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
      const baselineMigrations = migrations.filter((name) => Number.parseInt(name.slice(0, 3), 10) <= 14);
      assert.deepEqual(
        baselineMigrations.map((name) => Number.parseInt(name.slice(0, 3), 10)),
        Array.from({ length: 14 }, (_, index) => index + 1),
      );
      assert.equal(baselineMigrations.at(-1), "014_deterministic_growth_radar_scope_and_linkage.sql");
      const applied = await dataAccess.provider.query("SELECT version FROM schema_migrations ORDER BY version");
      const appliedBaseline = applied.rows
        .map((row) => row.version)
        .filter((name) => Number.parseInt(name.slice(0, 3), 10) <= 14);
      assert.deepEqual(appliedBaseline, baselineMigrations);
    });

    await t.test("36 A2 profile accepts only its isolated development database", async () => {
      const a2Root = await fs.mkdtemp(path.join(os.tmpdir(), "g1b-a2-profile-"));
      try {
        await fs.mkdir(path.join(a2Root, "storage", "development"), { recursive: true });
        const config = resolveRuntimeConfig({ bootstrapRoot: a2Root, env: a2Env(a2Root) });
        assert.equal(config.databasePath, path.join(a2Root, "storage", "development", "growth-radar-g1b.sqlite"));
        assert.equal(config.appPort, 3193);
      } finally {
        await fs.rm(a2Root, { recursive: true, force: true });
      }
    });

    await t.test("37 A2 profile rejects a formal database path", async () => {
      const a2Root = await fs.mkdtemp(path.join(os.tmpdir(), "g1b-a2-reject-"));
      const formalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g1b-formal-reject-"));
      try {
        await fs.mkdir(path.join(a2Root, "storage", "development"), { recursive: true });
        await fs.mkdir(path.join(formalRoot, "storage"), { recursive: true });
        assert.throws(() => resolveRuntimeConfig({ bootstrapRoot: a2Root,
          env: a2Env(a2Root, { DATABASE_PATH: path.join(formalRoot, "storage", "commerce-ops.sqlite") }) }),
        (error) => error instanceof RuntimeIsolationError && error.checks.some((check) => check.id === "default_database_rejected" || check.id === "database_inside_worktree"));
      } finally {
        await fs.rm(a2Root, { recursive: true, force: true });
        await fs.rm(formalRoot, { recursive: true, force: true });
      }
    });

    await t.test("38 A2 profile rejects port 3101", async () => {
      const a2Root = await fs.mkdtemp(path.join(os.tmpdir(), "g1b-a2-port-"));
      try {
        await fs.mkdir(path.join(a2Root, "storage", "development"), { recursive: true });
        assert.throws(() => resolveRuntimeConfig({ bootstrapRoot: a2Root, env: a2Env(a2Root, { APP_PORT: "3101" }) }),
          (error) => error instanceof RuntimeIsolationError && error.checks.some((check) => check.id === "formal_port_rejected" && !check.ok));
      } finally {
        await fs.rm(a2Root, { recursive: true, force: true });
      }
    });

    await t.test("39 temporary test databases can be fully cleaned", async () => {
      const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "g1b-cleanup-"));
      const cleanupAccess = openCommerceDataAccess({ rootDir: projectRoot, databasePath: path.join(cleanupRoot, "cleanup.sqlite") });
      cleanupAccess.close();
      await fs.rm(cleanupRoot, { recursive: true, force: true });
      await assert.rejects(fs.stat(cleanupRoot), { code: "ENOENT" });
    });

    await t.test("40 source batches expose complete scope confirmation provenance", async () => {
      const detail = await service.batchDetail(inventoryApplied.batch.id);
      for (const key of ["sourceType", "sourceSystem", "sourceFile", "sourceBatch", "importedAt", "snapshotAt",
        "dataWindowStart", "dataWindowEnd", "shopScope", "countryScope", "warehouseScope", "semanticScope",
        "confirmationStatus", "confirmedBy", "confirmedAt"]) assert.equal(Object.hasOwn(detail.batch, key), true, key);
    });

    await t.test("41 every metric uses the explicit semantic envelope", async () => {
      const semantics = await service.semanticStatus();
      for (const name of ["historical_observed", "current_online", "own_sales", "company_sales", "source_visible_sales", "source_predicted_daily_sales"]) {
        for (const key of ["value", "semantic_type", "source", "observed_at", "snapshot_at", "confirmation_status", "availability_status"]) {
          assert.equal(Object.hasOwn(semantics[name], key), true, `${name}.${key}`);
        }
      }
    });

    await t.test("42 standardized quality samples expose row numbers but no raw customers", async () => {
      const issues = await service.listQualityIssues({ pageSize: 200 });
      assert.equal(issues.issues.length > 0, true);
      assert.equal(issues.issues.every((item) => item.issueCode && item.severity && Array.isArray(item.sampleRows)
        && typeof item.blocking === "boolean" && item.recommendedAction), true);
      assert.doesNotMatch(JSON.stringify(issues.issues), /forged-client-user|完整原始订单|customer@example/i);
    });

    await t.test("43 apply result reports created, updated and ignored counts", () => {
      for (const key of ["createdCount", "updatedCount", "ignoredCount"]) {
        assert.equal(Number.isInteger(orderApplied.applicationResult[key]), true);
        assert.equal(Number.isInteger(inventoryApplied.applicationResult[key]), true);
      }
      assert.equal(orderApplied.applicationResult.ignoredCount, 2);
      assert.equal(inventoryApplied.applicationResult.ignoredCount, 3);
    });

    await t.test("44 read APIs expose shops, batches, results, issues and semantics", async () => {
      const paths = [
        "/api/growth-radar/shops?confirmation_status=pending",
        `/api/growth-radar/shops/${firstShop.id}`,
        `/api/growth-radar/shops/${firstShop.id}/history`,
        `/api/growth-radar/source-batches/${orderApplied.batch.id}`,
        `/api/growth-radar/source-batches/${orderApplied.batch.id}/result`,
        `/api/growth-radar/data-quality/issues?batch_id=${orderApplied.batch.id}`,
        "/api/growth-radar/observations",
        "/api/growth-radar/semantics/status",
      ];
      for (const pathname of paths) {
        const response = await invoke(api, { method: "GET", pathname });
        assert.equal(response.status, 200, pathname);
        assert.equal(response.body.ok, true, pathname);
      }
    });

    await t.test("45 shop master API edits scope attributes without confirming it", async () => {
      const response = await invoke(api, { method: "PATCH", pathname: `/api/growth-radar/shops/${firstShop.id}`,
        body: { displayName: "Sample Shop 01 Reviewed", platform: "lazada", countryCode: "TH", countryName: "Thailand",
          ownerUserId: "growth-team-a" } });
      assert.equal(response.status, 200);
      assert.equal(response.body.shop.displayName, "Sample Shop 01 Reviewed");
      assert.equal(response.body.shop.ownerUserId, "growth-team-a");
      assert.equal(response.body.shop.confirmationStatus, "pending");
    });
  } finally {
    dataAccess.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
