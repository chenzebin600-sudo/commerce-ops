import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { GrowthRadarService } from "../lib/growth-radar/growth-radar-service.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PII_HEADER_PATTERN = /所属地区|所属城市|客户|买家|收件|收货|地址|电话|手机|邮箱|邮编|邮政编码|身份证|证件|联系人|账号|customer|buyer|receiver|recipient|address|phone|mobile|email|postcode|postal|identity|contact|account/i;
const PII_HEADERS = ["所属地区（省/州）", "所属城市", "客户账号", "客户姓名",
  "邮寄地址1(按逗号分隔导出2列)", "电话1", "电话2", "邮政编码"];

function argumentsByName(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    result[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function scalar(provider, sql, parameters = []) {
  return Number((await provider.query(sql, parameters)).rows[0]?.value || 0);
}

async function main() {
  const args = argumentsByName(process.argv.slice(2));
  if (!args.orders || !args.inventory || !args.python) {
    throw new Error("Usage: --orders <xlsx> --inventory <xlsx> --python <python executable>");
  }
  const [orderStat, inventoryStat] = await Promise.all([fs.stat(args.orders), fs.stat(args.inventory)]);
  assert.equal(orderStat.isFile(), true);
  assert.equal(inventoryStat.isFile(), true);

  const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-g1a5-"));
  const dataAccess = openCommerceDataAccess({ rootDir: projectRoot, databasePath: path.join(isolatedRoot, "isolated.sqlite") });
  const service = new GrowthRadarService({
    repository: dataAccess.repositories.growthRadar,
    pythonExecutable: args.python,
    parserScript: path.join(projectRoot, "scripts", "growth-radar-parser.py"),
    fileStorageConfig: { tempRoot: path.join(isolatedRoot, "uploads") },
  });

  try {
    const orderPreview = await service.previewFile("mabang_order", {
      filename: args.orders,
      sourceFilename: path.basename(args.orders),
    });
    assert.deepEqual({
      orders: orderPreview.summary.standardOrderCount,
      rows: orderPreview.summary.rawRowCount,
      skus: orderPreview.summary.uniqueSkuCount,
      shops: orderPreview.summary.sourceShopCount,
      dateFrom: orderPreview.summary.orderDateFrom,
      dateTo: orderPreview.summary.orderDateTo,
      piiFields: orderPreview.piiFilteredFieldCount,
    }, { orders: 1582, rows: 2659, skus: 229, shops: 16, dateFrom: "2026-07-15", dateTo: "2026-07-21", piiFields: 8 });
    const orderApplied = await service.applyPreview("mabang_order", {
      previewId: orderPreview.previewId,
      idempotencyKey: orderPreview.sourceSha256,
    }, { actorLabel: "g1a5_isolated_validator", confirmationGranted: true });

    const inventoryPreview = await service.previewFile("mabang_inventory", {
      filename: args.inventory,
      sourceFilename: path.basename(args.inventory),
      sourceScope: { platform: "mabang" },
    });
    assert.deepEqual({
      rows: inventoryPreview.summary.rawRowCount,
      snapshots: inventoryPreview.summary.snapshotCandidateCount,
      skus: inventoryPreview.summary.uniqueSkuCount,
      warehouses: inventoryPreview.summary.warehouseCount,
      multiWarehouseSkus: inventoryPreview.summary.multiWarehouseSkuCount,
      matched: inventoryPreview.summary.matchedOrderLineCount,
      unmatched: inventoryPreview.summary.unmatchedOrderLineCount,
      snapshotAt: inventoryPreview.summary.snapshotAt,
    }, { rows: 1440, snapshots: 1438, skus: 952, warehouses: 6, multiWarehouseSkus: 278, matched: 2113,
      unmatched: 1, snapshotAt: "2026-07-21 20:20:37" });
    const inventoryApplied = await service.applyPreview("mabang_inventory", {
      previewId: inventoryPreview.previewId,
      idempotencyKey: inventoryPreview.sourceSha256,
    }, { actorLabel: "g1a5_isolated_validator", confirmationGranted: true });

    const provider = dataAccess.provider;
    const linkCounts = await provider.query(`SELECT match_status,COUNT(*) AS total
      FROM growth_order_inventory_links WHERE is_current=1 GROUP BY match_status ORDER BY match_status`);
    const links = Object.fromEntries(linkCounts.rows.map((row) => [row.match_status, Number(row.total)]));
    const unmatched = await provider.query(`SELECT l.source_sku,l.source_warehouse_name,h.order_status,
      oi.unmatched_reason FROM growth_order_inventory_links oi
      JOIN growth_order_lines l ON l.id=oi.order_line_id
      JOIN growth_order_headers h ON h.id=l.order_header_id
      WHERE oi.is_current=1 AND oi.match_status='unmatched' ORDER BY l.source_sku`);
    const rawRows = await provider.query("SELECT raw_values_json FROM growth_order_raw_rows");
    const piiKeysWritten = rawRows.rows.reduce((count, row) => count + Object.keys(JSON.parse(row.raw_values_json))
      .filter((key) => PII_HEADER_PATTERN.test(key)).length, 0);
    const metadataRows = await provider.query(`SELECT source_headers_json AS source_json,redacted_headers_json AS redacted_json
      FROM growth_source_batches UNION ALL SELECT '[]' AS source_json,redacted_fields_json AS redacted_json
      FROM growth_order_raw_rows`);
    const piiMetadataHeadersWritten = metadataRows.rows.reduce((count, row) => {
      const keys = [...JSON.parse(row.source_json), ...JSON.parse(row.redacted_json)];
      return count + keys.filter((key) => PII_HEADERS.includes(key)).length;
    }, 0);
    const schemaColumns = await provider.query(`SELECT name FROM pragma_table_info('growth_inventory_snapshots')
      UNION ALL SELECT name FROM pragma_table_info('growth_sku_warehouse_sales_metrics')`);
    const companySalesColumns = schemaColumns.rows.filter((row) => /company_sales/i.test(row.name));
    const metricStatus = (await provider.query(`SELECT
      COUNT(*) AS rows_total,
      SUM(CASE WHEN own_sales_quantity_7d_status='confirmed' THEN 1 ELSE 0 END) AS own_confirmed,
      SUM(CASE WHEN source_predicted_daily_sales_status='source_prediction_not_actual' THEN 1 ELSE 0 END) AS prediction_rows,
      SUM(own_sales_quantity_7d) AS own_sales_quantity_7d
      FROM growth_sku_warehouse_sales_metrics`)).rows[0];
    const scopeStatuses = await provider.query("SELECT DISTINCT source_scope_status FROM growth_source_batches ORDER BY source_scope_status");
    const shopState = (await service.summary());
    const currentOnlineCoverageRows = await scalar(provider, `SELECT COUNT(*) AS value
      FROM growth_shop_sku_coverage_snapshots WHERE coverage_semantic='current_online'`);

    assert.equal(await scalar(provider, "SELECT COUNT(*) AS value FROM growth_order_raw_rows"), 2659);
    assert.equal(await scalar(provider, "SELECT COUNT(*) AS value FROM growth_inventory_raw_rows"), 1440);
    assert.equal(await scalar(provider, "SELECT COUNT(*) AS value FROM growth_inventory_snapshots"), 1438);
    assert.deepEqual(links, { matched: 2113, unmatched: 1 });
    assert.equal(unmatched.rows.length, 1);
    assert.equal(unmatched.rows[0].source_sku, "P4GG1790785");
    assert.equal(unmatched.rows[0].order_status, "已作废");
    assert.equal(piiKeysWritten, 0);
    assert.equal(piiMetadataHeadersWritten, 0);
    assert.equal(companySalesColumns.length, 0);
    assert.equal(Number(metricStatus.rows_total), 1438);
    assert.equal(Number(metricStatus.own_confirmed), 1438);
    assert.equal(Number(metricStatus.prediction_rows), 1438);
    assert.equal(Number(metricStatus.own_sales_quantity_7d), 1859);
    assert.deepEqual(scopeStatuses.rows.map((row) => row.source_scope_status), ["confirmed"]);
    assert.equal(currentOnlineCoverageRows, 0);

    process.stdout.write(`${JSON.stringify({
      validation: "passed",
      databaseMode: "temporary_isolated_deleted_after_validation",
      sourceScopeStatus: "confirmed",
      order: {
        sourceFilename: orderApplied.batch.sourceFilename,
        sourceSha256: orderApplied.batch.sourceSha256,
        importedRows: 2659,
        uniqueOrders: 1582,
        uniqueSkus: 229,
        shops: 16,
        dateFrom: "2026-07-15",
        dateTo: "2026-07-21",
        piiFilteredFieldCount: orderApplied.batch.piiFilteredFieldCount,
        customerInformationWritten: false,
      },
      inventory: {
        sourceFilename: inventoryApplied.batch.sourceFilename,
        sourceSha256: inventoryApplied.batch.sourceSha256,
        importedRows: 1440,
        snapshotFacts: 1438,
        rejectedMissingSkuRows: 2,
        uniqueSkus: 952,
        warehouses: 6,
        multiWarehouseSkus: 278,
        snapshotAt: inventoryPreview.summary.snapshotAt,
      },
      linkage: {
        key: "source_sku + source_warehouse",
        matchedRows: links.matched,
        unmatchedRows: links.unmatched,
        unmatched: unmatched.rows.map((row) => ({ sourceSku: row.source_sku, sourceWarehouse: row.source_warehouse_name,
          orderStatus: row.order_status, reason: row.unmatched_reason })),
      },
      salesLayers: {
        ownSalesQuantity7dField: "own_sales_quantity_7d",
        ownSalesQuantity7d: Number(metricStatus.own_sales_quantity_7d),
        sourceVisibleFields: ["source_visible_sales_7d", "source_visible_sales_28d", "source_visible_sales_42d"],
        predictedField: "source_predicted_daily_sales",
        predictedStatus: "source_prediction_not_actual",
        metricRows: Number(metricStatus.rows_total),
      },
      shopMapping: {
        sourceShops: shopState.sourceShops,
        confirmed: shopState.confirmedShopMappings,
        unresolved: shopState.unresolvedShopMappings,
        associationBlockedByMapping: false,
      },
      coverage: { currentOnlineRows: currentOnlineCoverageRows, historicalOrdersPromoted: false },
      prohibitedSemantics: { companySalesColumns: 0, orderPlusInventorySalesMetric: false },
    }, null, 2)}\n`);
  } finally {
    dataAccess.close();
    await fs.rm(isolatedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.name || "Error"}: ${String(error?.message || "G1A.5 validation failed").split(/\r?\n/, 1)[0]}\n`);
  process.exitCode = 1;
});
