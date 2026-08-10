import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { PRODUCT_PACKAGE_SOURCE_SYSTEM } from "../lib/data-foundation/unified-data-contracts.mjs";
import { createGrowthRadarAccessPolicy, GROWTH_RADAR_PERMISSIONS } from "../lib/growth-radar/growth-radar-access-policy.mjs";
import { growthRadarParseOutputLimit } from "../lib/growth-radar/growth-radar-parser.mjs";
import { GrowthRadarService } from "../lib/growth-radar/growth-radar-service.mjs";
import { describeAuditRequest } from "../lib/security/audit-http.mjs";

const projectRoot = path.resolve(".");
const ORDER_SHA = "a".repeat(64);
const ORDER_SEMANTIC_KEY = "c".repeat(64);
const ORDER_SHA_2 = "e".repeat(64);
const INVENTORY_SHA = "b".repeat(64);
const AT = "2026-07-15T02:53:01.000Z";

test("Growth Radar parser transport scales to the supported workbook row limit", () => {
  assert.equal(growthRadarParseOutputLimit(1000), 128 * 1024 * 1024);
  assert.equal(growthRadarParseOutputLimit(200000), 512 * 1024 * 1024);
  assert.equal(growthRadarParseOutputLimit(1000000), 512 * 1024 * 1024);
});

test("Growth Radar batches product candidate summaries for large previews", async () => {
  let bulkCalls = 0;
  let singleCalls = 0;
  const service = new GrowthRadarService({
    repository: {
      async productCandidateSummaries(skus) {
        bulkCalls += 1;
        assert.deepEqual(skus, ["sku-1", "SKU-2"]);
        return [{ normalizedSku: "SKU-1", candidateCount: 2, countryCount: 1 }];
      },
      async productCandidates() {
        singleCalls += 1;
        return [];
      },
    },
  });

  const summaries = await service.productCandidateSummaryMap(new Set(["sku-1", "SKU-2"]));

  assert.equal(bulkCalls, 1);
  assert.equal(singleCalls, 0);
  assert.deepEqual(summaries.get("SKU-1"), {
    normalizedSku: "SKU-1",
    candidateCount: 2,
    countryCount: 1,
  });
  assert.equal(summaries.has("SKU-2"), false);
});

function normalizedOrder(overrides = {}) {
  return {
    sourceOrderId: "ORDER-001",
    sourceShopName: "Thai Home",
    platform: "lazada",
    orderStatus: "已发货",
    paidAt: "2026-07-14T08:00:00.000Z",
    cancelledAt: null,
    orderCurrency: "CNY",
    orderAmount: 100,
    orderAmountSourceField: "订单核算金额（人民币）",
    effectiveStatus: "valid",
    sourceSku: "SKU-1",
    platformSku: "PLATFORM-SKU-1",
    quantity: 1,
    productName: "Test Product",
    warehouseName: "WH-A",
    skuDetail: "default",
    unitSalePrice: 10,
    orderSkuTotal: null,
    lineAmount: null,
    lineAmountStatus: "unavailable",
    refundDataStatus: "unavailable",
    ...overrides,
  };
}

function parsedRow(sourceRowNumber, normalized, overrides = {}) {
  return {
    sourceRowNumber,
    rawPayload: { 订单编号: normalized.sourceOrderId, 店铺名: normalized.sourceShopName, SKU: normalized.sourceSku },
    rawTypes: { 订单编号: "string", 店铺名: "string", SKU: "string" },
    redactedFields: ["客户姓名", "电话1", "邮寄地址"],
    rowHash: String(sourceRowNumber).padStart(64, "0"),
    parseStatus: "parsed",
    issueCodes: [],
    formulaFields: [],
    normalized,
    ...overrides,
  };
}

function orderWorkbook() {
  const rows = [
    parsedRow(2, normalizedOrder()),
    parsedRow(3, normalizedOrder({
      sourceSku: "SKU-2",
      platformSku: "PLATFORM-SKU-2",
      quantity: 2,
      productName: "Second Product",
      orderAmount: 100.000004,
      orderAmountSourceField: "订单核算金额（原始货币）×汇率（原始货币）",
    })),
    parsedRow(4, normalizedOrder({ sourceOrderId: "ORDER-002", orderStatus: "已作废", cancelledAt: "2026-07-14T10:00:00.000Z", effectiveStatus: "invalid_cancelled", sourceSku: "SKU-1", quantity: 4, orderAmount: 50 })),
    parsedRow(5, normalizedOrder({ sourceOrderId: "ORDER-003", sourceShopName: "Unknown Shop", sourceSku: "SKU-9", platformSku: "PLATFORM-SKU-9", orderAmount: 30 })),
    parsedRow(6, normalizedOrder({ sourceOrderId: "", sourceSku: "" }), {
      rawPayload: { SKU: null },
      rawTypes: { SKU: "blank" },
      parseStatus: "rejected",
      issueCodes: ["MISSING_ORDER_ID"],
    }),
  ];
  return {
    sheetName: "订单明细",
    headers: ["订单编号", "店铺名", "平台", "SKU", "客户姓名", "电话1", "邮寄地址"],
    redactedHeaders: ["客户姓名", "电话1", "邮寄地址"],
    piiFilteredHeaders: ["客户姓名", "电话1", "邮寄地址"],
    formulaCellCount: 0,
    rowCount: rows.length,
    rows,
  };
}

function inventoryWorkbook() {
  return {
    sheetName: "库存明细",
    headers: ["SKU", "仓库", "可用库存"],
    redactedHeaders: [],
    piiFilteredHeaders: [],
    formulaCellCount: 0,
    rowCount: 1,
    rows: [{
      sourceRowNumber: 2,
      rawPayload: { SKU: "SKU-1", 仓库: "WH-A", 可用库存: 12 },
      rawTypes: { SKU: "string", 仓库: "string", 可用库存: "number" },
      redactedFields: [], rowHash: "c".repeat(64), parseStatus: "parsed", issueCodes: [], formulaFields: [],
      normalized: {
        sourceSku: "SKU-1", warehouseName: "WH-A", availableQuantity: 12, physicalQuantity: 15,
        lockedQuantity: 3, inTransitQuantity: null, pendingShipmentQuantity: 2,
        transferPendingShipmentQuantity: 7,
        productStatus: "正常销售", categoryLevel1: "测试类目", categoryLevel2: null, categoryLevel3: null,
        sourceVisibleSales7d: 5, sourceVisibleSales28d: 18, sourceVisibleSales42d: 25,
        sourceVisibleSalesStatus: "confirmed", sourcePredictedDailySales: 0.5, snapshotAt: AT,
        sellableQuantityStatus: "unconfirmed", daysOfSupplyStatus: "unavailable",
      },
    }],
  };
}

async function seedProducts(provider) {
  const batch = "product-batch-g1a";
  const category = "product-category-g1a";
  await provider.execute(`INSERT INTO product_import_batches (
    id,file_sha256,status,operator_label,created_at,updated_at
  ) VALUES (?,?,?,?,?,?)`, [batch, "d".repeat(64), "applied", "test", AT, AT]);
  await provider.execute(`INSERT INTO product_categories (
    id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [category, "root", 1, "company_product_center", "测试", "测试", "active", batch, batch, AT, AT]);
  for (const [index, country, sku] of [[1, "TH", "SKU-1"], [2, "MY", "SKU-1"], [3, "TH", "SKU-2"]]) {
    const rowId = `product-row-${index}`;
    const skuId = `product-sku-${index}`;
    await provider.execute(`INSERT INTO product_import_rows (
      id,batch_id,source_row_number,source_sku,row_sha256,raw_payload_json,normalized_payload_json,
      validation_codes_json,outcome,created_at,source_country_raw,product_key,product_sha256
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [rowId, batch, index + 1, sku, String(index).repeat(64), "{}", "{}", "[]", "new", AT, country, `${country}|${sku}`, String(index + 3).repeat(64)]);
    await provider.execute(`INSERT INTO product_skus (
      id,source_system,source_sku,normalized_sku,category_id,source_product_name,source_main_sku,
      source_status_raw,current_source_row_id,first_seen_batch_id,last_seen_batch_id,created_at,updated_at,
      country_raw,sku_code_normalized
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [skuId, PRODUCT_PACKAGE_SOURCE_SYSTEM, sku, `${country}|${sku}`, category,
      `Product ${country} ${sku}`, `MAIN-${index}`, "正常销售", rowId, batch, batch, AT, AT, country, sku]);
    await provider.execute("UPDATE product_import_rows SET target_sku_id=? WHERE id=?", [skuId, rowId]);
  }
}

test("G1A deterministic growth radar foundation", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-g1a-"));
  const dataAccess = openCommerceDataAccess({ rootDir: projectRoot, databasePath: path.join(root, "commerce.sqlite") });
  let parsed = orderWorkbook();
  const service = new GrowthRadarService({
    repository: dataAccess.repositories.growthRadar,
    pythonExecutable: "python",
    parserScript: "unused-parser.py",
    fileStorageConfig: { tempRoot: path.join(root, "temp") },
    parseWorkbook: async () => parsed,
    now: () => new Date(AT),
  });
  let orderPreview;
  let orderApplied;
  let thaiShop;
  let thaiMapping;
  let skuMapping;
  let stateInventoryPreview;

  try {
    await seedProducts(dataAccess.provider);

    await t.test("01 default policy exposes all nine permissions", () => {
      const policy = createGrowthRadarAccessPolicy();
      assert.equal(GROWTH_RADAR_PERMISSIONS.length, 9);
      assert.equal(GROWTH_RADAR_PERMISSIONS.every((permission) => policy.has(permission)), true);
    });

    await t.test("02 configured policy denies permissions outside its allowlist", () => {
      const policy = createGrowthRadarAccessPolicy({ GROWTH_RADAR_PERMISSIONS: "growth_radar.data.view" });
      assert.equal(policy.has("growth_radar.data.view"), true);
      assert.throws(() => policy.assert("growth_radar.data.import"), { code: "GROWTH_RADAR_PERMISSION_DENIED" });
    });

    await t.test("03 shop scope rejects an out-of-scope shop", () => {
      const policy = createGrowthRadarAccessPolicy({ GROWTH_RADAR_ALLOWED_SHOP_IDS: "shop-a" });
      assert.equal(policy.shopInScope("shop-a"), true);
      assert.throws(() => policy.assert("growth_radar.shop.manage", "shop-b"), { code: "GROWTH_RADAR_PERMISSION_DENIED" });
    });

    await t.test("04 migration creates the complete G1A table set", async () => {
      const rows = await dataAccess.provider.query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'growth_%' OR name='product_identity_mappings')");
      const actual = new Set(rows.rows.map((row) => row.name));
      const expected = [
        "growth_source_batches",
        "growth_shops",
        "growth_shop_source_mappings",
        "growth_order_headers",
        "growth_order_raw_rows",
        "product_identity_mappings",
        "growth_order_lines",
        "growth_mapping_issues",
        "growth_inventory_raw_rows",
        "growth_inventory_snapshots",
        "growth_data_quality_issues",
        "growth_mapping_events",
        "growth_shop_sku_observations",
        "growth_shop_sku_coverage_snapshots",
        "growth_order_inventory_links",
        "growth_sku_warehouse_sales_metrics",
      ];
      assert.deepEqual(expected.filter((name) => !actual.has(name)), []);
    });

    await t.test("05 historical observations reject current-online semantics", async () => {
      await assert.rejects(dataAccess.provider.execute(`INSERT INTO growth_shop_sku_observations (
        id,observation_key,coverage_semantic,platform,source_shop_name,normalized_source_shop_name,source_sku,
        normalized_source_sku,first_source_batch_id,last_source_batch_id,created_at,updated_at
      ) VALUES ('bad','bad','current_online','lazada','x','x','x','x','missing','missing',?,?)`, [AT, AT]));
    });

    await t.test("06 preview creates no database batch", async () => {
      orderPreview = await service.previewFile("mabang_order", { filename: "C:/outside/订单样本.xlsx", sourceFilename: "订单样本.xlsx",
        sourceSha256: ORDER_SHA, sourceIdempotencyKey: ORDER_SEMANTIC_KEY,
        sourceScope: { dateFrom: "2026-07-09", dateTo: "2026-07-15" } });
      const summary = await service.summary();
      assert.equal(summary.batches, 0);
    });

    await t.test("07 order preview retains every raw source row", () => assert.equal(orderPreview.summary.rawRowCount, 5));
    await t.test("08 order preview produces three standard order headers", () => assert.equal(orderPreview.summary.standardOrderCount, 3));
    await t.test("09 order preview produces four usable standard lines", () => assert.equal(orderPreview.summary.standardLineCount, 4));
    await t.test("10 order preview detects the multi-line order", () => assert.equal(orderPreview.summary.multiLineOrders, 1));
    await t.test("11 order preview reports the maximum lines per order", () => assert.equal(orderPreview.summary.maxLinesPerOrder, 2));
    await t.test("12 order preview retains the cancelled order count", () => assert.equal(orderPreview.summary.cancelledOrders, 1));
    await t.test("13 order preview detects two source shops", () => assert.equal(orderPreview.summary.sourceShopCount, 2));
    await t.test("14 order line amount remains unavailable", () => assert.equal(orderPreview.summary.lineAmountStatus, "unavailable"));
    await t.test("15 current-online coverage is explicitly unavailable", () => assert.equal(orderPreview.summary.currentOnlineStatus, "unavailable"));
    await t.test("15a direct CNY order amount takes precedence over a rounded fallback", () => {
      assert.equal(orderPreview.summary.orderAmountConflictCount, 0);
      assert.equal(orderPreview.issues.some((item) => item.issueCode === "order_amount_conflict"), false);
    });

    await t.test("16 apply creates one auditable source batch", async () => {
      orderApplied = await service.applyPreview("mabang_order", { previewId: orderPreview.previewId, idempotencyKey: ORDER_SHA },
        { actorLabel: "test_actor", confirmationGranted: true });
      assert.equal(orderApplied.reused, false);
      assert.equal(orderApplied.batch.status, "applied");
    });

    await t.test("17 apply stores all raw rows including rejected rows", async () => {
      assert.equal((await service.summary()).orderRawRows, 5);
    });

    await t.test("18 apply stores three canonical order headers", async () => assert.equal((await service.summary()).orderHeaders, 3));
    await t.test("19 apply stores four current order lines", async () => assert.equal((await service.summary()).orderLines, 4));
    await t.test("20 cancelled facts remain queryable", async () => assert.equal((await service.summary()).cancelledOrders, 1));

    await t.test("21 cancelled orders are excluded from historical observed quantity", async () => {
      const result = await dataAccess.provider.query("SELECT observed_quantity,observed_order_count FROM growth_shop_sku_observations WHERE normalized_source_shop_name='thai home' AND normalized_source_sku='SKU-1'");
      assert.equal(Number(result.rows[0].observed_quantity), 1);
      assert.equal(Number(result.rows[0].observed_order_count), 1);
    });

    await t.test("22 raw storage excludes sensitive source values", async () => {
      const result = await dataAccess.provider.query("SELECT raw_values_json,redacted_fields_json FROM growth_order_raw_rows ORDER BY source_row_number LIMIT 1");
      assert.equal(result.rows[0].raw_values_json.includes("客户姓名"), false);
      assert.equal(JSON.parse(result.rows[0].redacted_fields_json).includes("客户姓名"), false);
    });

    await t.test("22a batch metadata stores only the PII field count", async () => {
      const row = (await dataAccess.provider.query(`SELECT source_headers_json,redacted_headers_json,
        pii_filtered_field_count FROM growth_source_batches WHERE source_type='mabang_order'`)).rows[0];
      assert.equal(JSON.stringify([row.source_headers_json, row.redacted_headers_json]).includes("客户姓名"), false);
      assert.equal(Number(row.pii_filtered_field_count), 3);
    });

    await t.test("23 source batch stores basename instead of an absolute path", () => assert.equal(orderApplied.batch.sourceFilename, "订单样本.xlsx"));
    await t.test("24 source batch retains its SHA-256 evidence", () => assert.equal(orderApplied.batch.sourceSha256, ORDER_SHA));

    await t.test("24a source evidence hash and semantic idempotency key remain distinct", async () => {
      const row = (await dataAccess.provider.query(
        "SELECT source_sha256,idempotency_key FROM growth_source_batches WHERE id=?",
        [orderApplied.batch.id],
      )).rows[0];
      assert.equal(row.source_sha256, ORDER_SHA);
      assert.equal(row.idempotency_key, ORDER_SEMANTIC_KEY);
    });

    await t.test("24a order amount is stored once and never allocated to lines", async () => {
      const header = (await dataAccess.provider.query("SELECT order_amount FROM growth_order_headers WHERE source_order_id='ORDER-001'")).rows[0];
      const lines = await dataAccess.provider.query(`SELECT l.line_amount,l.line_amount_status FROM growth_order_lines l
        JOIN growth_order_headers h ON h.id=l.order_header_id WHERE h.source_order_id='ORDER-001' AND l.is_current=1`);
      assert.equal(Number(header.order_amount), 100);
      assert.equal(lines.rows.length, 2);
      assert.equal(lines.rows.every((line) => line.line_amount === null && line.line_amount_status === "unavailable"), true);
    });

    await t.test("24b unavailable refund data never becomes a metric", () => assert.equal(orderPreview.summary.refundDataStatus, "unavailable"));

    await t.test("25 same domain and idempotency key never duplicate facts", async () => {
      const repeated = await service.applyPreview("mabang_order", { previewId: orderPreview.previewId, idempotencyKey: ORDER_SHA },
        { actorLabel: "test_actor", confirmationGranted: true });
      assert.equal(repeated.reused, true);
      assert.equal((await service.summary()).batches, 1);
    });

    await t.test("25a a later source batch updates status without duplicating standard facts", async () => {
      parsed = orderWorkbook();
      const changed = parsed.rows.find((row) => row.normalized.sourceOrderId === "ORDER-002");
      changed.normalized.orderStatus = "已发货";
      changed.normalized.cancelledAt = null;
      changed.normalized.effectiveStatus = "valid";
      const preview = await service.previewFile("mabang_order", { filename: "orders-second.xlsx", sourceFilename: "orders-second.xlsx",
        sourceSha256: ORDER_SHA_2, sourceScope: { dateFrom: "2026-07-09", dateTo: "2026-07-15" } });
      await service.applyPreview("mabang_order", { previewId: preview.previewId, idempotencyKey: ORDER_SHA_2 },
        { actorLabel: "test_actor", confirmationGranted: true });
      const summary = await service.summary();
      assert.equal(summary.orderHeaders, 3);
      assert.equal(summary.orderLines, 4);
      assert.equal(summary.orderRawRows, 10);
      const status = (await dataAccess.provider.query("SELECT effective_status,revision FROM growth_order_headers WHERE source_order_id='ORDER-002'")).rows[0];
      assert.equal(status.effective_status, "valid");
      assert.equal(Number(status.revision) >= 2, true);
    });

    await t.test("26 rejected source rows emit stable data-quality issues", async () => {
      const issues = await service.listQualityIssues({ status: "open" });
      const issue = issues.issues.find((item) => item.code === "missing_order_id");
      assert.equal(Boolean(issue), true);
      assert.equal(issue.sourceContext.sourceRowNumber, 6);
    });

    await t.test("26a permission denial never deletes complete raw facts", async () => {
      const before = (await service.summary()).orderRawRows;
      const policy = createGrowthRadarAccessPolicy({ GROWTH_RADAR_PERMISSIONS: "growth_radar.data.view" });
      assert.throws(() => policy.assert("growth_radar.mapping.confirm"), { code: "GROWTH_RADAR_PERMISSION_DENIED" });
      assert.equal((await service.summary()).orderRawRows, before);
    });

    await t.test("27 unresolved shop mappings are created without guessing", async () => {
      const mappings = await service.listShopMappings({ unresolved: true });
      assert.equal(mappings.total, 2);
      assert.equal(mappings.mappings.every((item) => item.internalShopId !== null && item.confirmationStatus === "pending"), true);
    });

    await t.test("28 invalid shop master data is rejected", async () => {
      await assert.rejects(service.createShop({ internalShopCode: "x", displayName: "", platform: "lazada", countryCode: "TH", countryName: "泰国" }), { code: "GROWTH_RADAR_SHOP_INVALID" });
    });

    await t.test("29 valid shop master data is normalized and persisted", async () => {
      thaiShop = await service.createShop({ internalShopCode: "th-laz-001", displayName: "Thai Home", platform: "Lazada", countryCode: "th", countryName: "泰国" });
      assert.equal(thaiShop.internalShopCode, "TH-LAZ-001");
      assert.equal(thaiShop.countryCode, "TH");
      assert.equal(thaiShop.confirmationStatus, "pending");
    });

    await t.test("30 confirming a shop mapping writes a business audit event", async () => {
      const mapping = (await service.listShopMappings({ unresolved: true })).mappings.find((item) => item.sourceShopName === "Thai Home");
      const result = await service.confirmShopMapping({ mappingId: mapping.id, internalShopId: thaiShop.id }, { actorLabel: "operator", requestId: "request-shop-confirm" });
      thaiMapping = result.mapping;
      assert.equal(result.mapping.mappingStatus, "manually_confirmed");
      assert.equal(result.history[0].action, "confirmed");
      assert.equal(result.history[0].requestId, "request-shop-confirm");
      const scope = await service.confirmShopScope(thaiShop.id, { actorLabel: "operator", requestId: "request-scope-confirm" });
      assert.equal(scope.shop.confirmationStatus, "confirmed");
    });

    await t.test("31 shop confirmation backfills order country", async () => {
      const result = await dataAccess.provider.query("SELECT DISTINCT mapped_country FROM growth_order_headers WHERE normalized_source_shop_name='thai home'");
      assert.deepEqual(result.rows.map((row) => row.mapped_country), ["TH"]);
    });

    await t.test("32 exact country plus SKU mapping is deterministic", async () => {
      const mappings = await service.listProductMappings({});
      skuMapping = mappings.mappings.find((item) => item.sourceSku === "SKU-1" && item.countryCode === "TH");
      assert.equal(skuMapping.mappingStatus, "matched");
      assert.equal(skuMapping.internalProductId, "product-sku-1");
    });

    await t.test("33 revoking a product mapping clears current facts", async () => {
      const result = await service.revokeProductMapping({ mappingId: skuMapping.id }, { actorLabel: "operator", requestId: "request-product-revoke" });
      assert.equal(result.mapping.mappingStatus, "revoked");
      assert.equal(result.history[0].action, "revoked");
      const lines = await dataAccess.provider.query("SELECT mapped_product_id,mapping_status FROM growth_order_lines WHERE normalized_source_sku='SKU-1' AND mapped_country='TH'");
      assert.equal(lines.rows.every((line) => line.mapped_product_id === null && line.mapping_status === "revoked"), true);
    });

    await t.test("34 manually confirming a product mapping restores exact facts", async () => {
      const result = await service.confirmProductMapping({ mappingId: skuMapping.id, internalProductId: "product-sku-1" }, { actorLabel: "operator", requestId: "request-product-confirm" });
      assert.equal(result.mapping.mappingStatus, "manually_confirmed");
      assert.equal(result.history.some((event) => event.action === "confirmed" && event.requestId === "request-product-confirm"), true);
    });

    await t.test("35 revoking a shop mapping removes country authority", async () => {
      const result = await service.revokeShopMapping({ mappingId: thaiMapping.id }, { actorLabel: "operator", requestId: "request-shop-revoke" });
      assert.equal(result.mapping.mappingStatus, "revoked");
      const orders = await dataAccess.provider.query("SELECT internal_shop_id,mapped_country FROM growth_order_headers WHERE normalized_source_shop_name='thai home'");
      assert.equal(orders.rows.every((order) => order.internal_shop_id === null && order.mapped_country === null), true);
    });

    await t.test("36 inventory preview exposes unconfirmed semantic status", async () => {
      parsed = inventoryWorkbook();
      const preview = await service.previewFile("mabang_inventory", { filename: "inventory.xlsx", sourceFilename: "inventory.xlsx", sourceSha256: INVENTORY_SHA, sourceScope: { platform: "mabang", countryCode: "TH" }, collectedAt: AT });
      assert.equal(preview.summary.sellableQuantityStatus, "unconfirmed");
      assert.equal(preview.summary.daysOfSupplyStatus, "unavailable");
      stateInventoryPreview = preview;
    });

    await t.test("37 inventory apply stores raw row and snapshot framework", async () => {
      const applied = await service.applyPreview("mabang_inventory", { previewId: stateInventoryPreview.previewId, idempotencyKey: INVENTORY_SHA },
        { actorLabel: "test_actor", confirmationGranted: true });
      assert.equal(applied.reused, false);
      const summary = await service.summary();
      assert.equal(summary.inventoryRawRows, 1);
      assert.equal(summary.inventorySnapshots, 1);
    });

    await t.test("38 inventory snapshot never fabricates sellable stock or days of supply", async () => {
      const result = await dataAccess.provider.query(`SELECT pending_shipment_quantity,
        transfer_pending_shipment_quantity,sellable_quantity,sellable_quantity_status,
        days_of_supply,days_of_supply_status FROM growth_inventory_snapshots`);
      assert.equal(result.rows[0].pending_shipment_quantity, 2);
      assert.equal(result.rows[0].transfer_pending_shipment_quantity, 7);
      assert.equal(result.rows[0].sellable_quantity, null);
      assert.equal(result.rows[0].sellable_quantity_status, "unconfirmed");
      assert.equal(result.rows[0].days_of_supply, null);
      assert.equal(result.rows[0].days_of_supply_status, "unavailable");
    });

    await t.test("38a applied source scope is confirmed for both source domains", async () => {
      const result = await dataAccess.provider.query("SELECT DISTINCT source_scope_status FROM growth_source_batches ORDER BY source_scope_status");
      assert.deepEqual(result.rows.map((row) => row.source_scope_status), ["confirmed"]);
    });

    await t.test("38b order lines persist the normalized source warehouse", async () => {
      const result = await dataAccess.provider.query("SELECT DISTINCT source_warehouse_name,normalized_source_warehouse_name FROM growth_order_lines");
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].source_warehouse_name, "WH-A");
      assert.equal(result.rows[0].normalized_source_warehouse_name, "WH-A");
    });

    await t.test("38c inventory sales fields stay source-visible and warehouse-grained", async () => {
      const row = (await dataAccess.provider.query(`SELECT normalized_warehouse_name,source_visible_sales_7d,
        source_visible_sales_28d,source_visible_sales_42d,source_predicted_daily_sales,source_scope_status
        FROM growth_inventory_snapshots`)).rows[0];
      assert.equal(row.normalized_warehouse_name, "WH-A");
      assert.deepEqual([Number(row.source_visible_sales_7d), Number(row.source_visible_sales_28d),
        Number(row.source_visible_sales_42d), Number(row.source_predicted_daily_sales)], [5, 18, 25, 0.5]);
      assert.equal(row.source_scope_status, "confirmed");
    });

    await t.test("38c1 inventory grain accepts another warehouse and rejects a duplicate SKU warehouse", async () => {
      const batchId = (await dataAccess.provider.query("SELECT id FROM growth_source_batches WHERE source_type='mabang_inventory'")).rows[0].id;
      const values = ["inventory-wh-b", batchId, 3, "SKU-1", "SKU-1", "WH-B", "WH-B", AT,
        "country_unresolved", "confirmed", AT];
      await dataAccess.provider.execute(`INSERT INTO growth_inventory_snapshots (
        id,batch_id,source_row_number,source_sku,normalized_source_sku,warehouse_name,normalized_warehouse_name,
        snapshot_at,mapping_status,quality_status,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, values);
      await assert.rejects(dataAccess.provider.execute(`INSERT INTO growth_inventory_snapshots (
        id,batch_id,source_row_number,source_sku,normalized_source_sku,warehouse_name,normalized_warehouse_name,
        snapshot_at,mapping_status,quality_status,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ["inventory-duplicate", batchId, 4, "SKU-1", "SKU-1", "WH-A", "WH-A", AT,
        "country_unresolved", "confirmed", AT]));
      await dataAccess.provider.execute("DELETE FROM growth_inventory_snapshots WHERE id='inventory-wh-b'");
    });

    await t.test("38d SKU plus warehouse linkage is independent from shop-country mapping", async () => {
      const result = await dataAccess.provider.query(`SELECT match_status,COUNT(*) AS total
        FROM growth_order_inventory_links WHERE is_current=1 GROUP BY match_status ORDER BY match_status`);
      assert.deepEqual(result.rows.map((row) => [row.match_status, Number(row.total)]), [["matched", 2], ["unmatched", 2]]);
    });

    await t.test("38e sales layers never add source-visible sales to own sales", async () => {
      const row = (await dataAccess.provider.query(`SELECT own_sales_quantity_7d,own_sales_order_count_7d,
        own_sales_effective_line_count_7d,own_sales_quantity_7d_status,source_visible_sales_7d,
        source_predicted_daily_sales_status FROM growth_sku_warehouse_sales_metrics`)).rows[0];
      assert.equal(Number(row.own_sales_quantity_7d), 5);
      assert.equal(Number(row.own_sales_order_count_7d), 2);
      assert.equal(Number(row.own_sales_effective_line_count_7d), 2);
      assert.equal(row.own_sales_quantity_7d_status, "confirmed");
      assert.equal(Number(row.source_visible_sales_7d), 5);
      assert.equal(row.source_predicted_daily_sales_status, "source_prediction_not_actual");
    });

    await t.test("38f no company-sales naming exists before scope confirmation", async () => {
      const tables = ["growth_inventory_snapshots", "growth_sku_warehouse_sales_metrics"];
      for (const table of tables) {
        const columns = await dataAccess.provider.query(`PRAGMA table_info(${table})`);
        assert.equal(columns.rows.some((column) => /company_sales/i.test(column.name)), false);
      }
    });

    await t.test("39 freshness reports order and inventory independently", async () => {
      const freshness = await service.freshness();
      assert.deepEqual(freshness.map((item) => item.sourceType).sort(), ["mabang_inventory", "mabang_order"]);
    });

    await t.test("40 reserved current-online table remains empty", async () => assert.equal((await service.summary()).currentOnline, 0));

    await t.test("41 growth radar import and mapping requests have stable audit actions", () => {
      assert.equal(describeAuditRequest("POST", "/api/growth-radar/import/orders/apply").action, "growth_radar.order.applied");
      assert.equal(describeAuditRequest("POST", "/api/growth-radar/mappings/products/revoke").action, "growth_radar.product_mapping.revoked");
      assert.equal(describeAuditRequest("POST", "/api/growth-radar/shops/shop-id/confirm").action, "growth_radar.shop.confirmed");
      assert.equal(describeAuditRequest("POST", "/api/growth-radar/shops/shop-id/revoke").action, "growth_radar.shop.confirmation_revoked");
    });

    await t.test("42 frontend exposes exactly eight G1B data views", async () => {
      const source = await fs.readFile(path.join(projectRoot, "public", "growth-radar-page.mjs"), "utf8");
      assert.equal((source.match(/^  \["[^"]+", "[^"]+"\],$/gm) || []).length, 8);
      assert.match(source, /无权威数据源，不显示为 0/);
      assert.match(source, /生成只读预览/);
    });

    await t.test("43 migration and repository preserve provider-neutral placeholders", async () => {
      const source = await fs.readFile(path.join(projectRoot, "lib", "data", "repositories", "growth-radar-repository.mjs"), "utf8");
      assert.match(source, /client\.placeholder/);
      assert.doesNotMatch(source, /\?\s*(?:AND|OR|ORDER|LIMIT)/);
    });

    await t.test("44 parser contract redacts identity and contact headers", async () => {
      const source = await fs.readFile(path.join(projectRoot, "scripts", "growth-radar-parser.py"), "utf8");
      for (const sensitive of ["customer", "address", "phone", "email", "客户", "地址", "电话"]) assert.match(source, new RegExp(sensitive, "i"));
      assert.match(source, /ORDER_ALLOWED_HEADERS/);
      assert.match(source, /header not in ORDER_ALLOWED_HEADERS/);
      assert.match(source, /FORMULA_CELL_REDACTED/);
    });
  } finally {
    dataAccess.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
