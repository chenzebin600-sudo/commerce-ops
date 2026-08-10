import assert from "node:assert/strict";
import test from "node:test";
import {
  DATASET_CODES,
  DATA_MODULES,
  DEFAULT_MODULE_BINDINGS,
  PRODUCT_PACKAGE_SOURCE_SYSTEM,
  UNIFIED_DATASET_CATALOG,
  defineModuleBinding,
  moduleDatasetMatrix,
} from "../lib/data-foundation/unified-data-contracts.mjs";
import { summarizeUnifiedDataAudit } from "../lib/data-foundation/unified-data-audit.mjs";
import { SalesAssortmentRepository } from "../lib/sales-assortment/sales-assortment-repository.mjs";

function fakeProvider(queryImpl) {
  return {
    dialect: "postgresql",
    connection: {},
    transactionManager: { run: async (callback) => callback({}) },
    query: queryImpl,
    execute: async () => ({ rows: [] }),
    executeScript: async () => ({ rows: [] }),
    placeholder: (index) => `$${index}`,
    transaction: async (callback) => callback({}),
    migrate: async () => [],
  };
}

test("unified data catalogue publishes the requested module dependencies", () => {
  assert.equal(PRODUCT_PACKAGE_SOURCE_SYSTEM, "ai_project_a_product_package");
  assert.equal(Object.keys(UNIFIED_DATASET_CATALOG).length, 8);
  const matrix = moduleDatasetMatrix(DEFAULT_MODULE_BINDINGS);
  assert.deepEqual([...matrix[DATA_MODULES.SALES_ASSORTMENT]].sort(), [
    DATASET_CODES.MABANG_INVENTORY_CURRENT,
    DATASET_CODES.MABANG_ORDER_FACTS,
    DATASET_CODES.PRODUCT_MASTER_CURRENT,
    DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
    DATASET_CODES.SHOP_MASTER_CURRENT,
  ].sort());
  assert.deepEqual([...matrix[DATA_MODULES.PRICE_CONTROL]].sort(), [
    DATASET_CODES.PRICE_CONTROL_CURRENT,
    DATASET_CODES.PRICE_CONTROL_SHOP_SCOPE,
    DATASET_CODES.SHOP_MASTER_CURRENT,
  ].sort());
  assert.deepEqual([...matrix[DATA_MODULES.PRODUCT_CENTER]].sort(), [
    DATASET_CODES.PRODUCT_MASTER_CURRENT,
    DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
  ].sort());
});

test("module-local API control data cannot be bound to another module", () => {
  const apiContract = UNIFIED_DATASET_CATALOG[DATASET_CODES.PLATFORM_API_CONTROL];
  assert.equal(apiContract.sourceRelation,
    "app.platform_api_application_profiles + app.commerce_shop_account_bindings + app.shop_external_identities");
  assert.deepEqual(apiContract.businessKeys, ["shop_id", "account_id"]);
  assert.throws(() => defineModuleBinding({
    datasetCode: DATASET_CODES.PLATFORM_API_CONTROL,
    moduleId: DATA_MODULES.PRICE_CONTROL,
  }), /local to platform_connections/);
});

test("sales assortment reads the authoritative product package source through parameters", async () => {
  const calls = [];
  const repository = new SalesAssortmentRepository({
    provider: fakeProvider(async (sql, parameters = []) => {
      calls.push({ sql, parameters });
      return /COUNT\(\*\)/.test(sql) ? { rows: [{ total: 1 }] } : { rows: [{ source_row_key: "row-1" }] };
    }),
  });

  assert.equal((await repository.productPackageRows()).length, 1);
  const page = await repository.sourceRows("product-package", { page: 1, pageSize: 10 });
  assert.equal(page.total, 1);
  assert.equal(page.rows.length, 1);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].parameters, [PRODUCT_PACKAGE_SOURCE_SYSTEM]);
  assert.match(calls[0].sql, /normalized_payload_json->>'product_name' AS product_name/);
  assert.doesNotMatch(calls[0].sql, /\snormalized_payload_json\s*\n\s*FROM/);
  assert.deepEqual(calls[1].parameters, [PRODUCT_PACKAGE_SOURCE_SYSTEM]);
  assert.deepEqual(calls[2].parameters, [PRODUCT_PACKAGE_SOURCE_SYSTEM, 10, 0]);
  assert.equal(calls.every((call) => !call.sql.includes("company_product_center")), true);
});

test("sales assortment order reads carry line amount status and currency without coercing missing amounts", async () => {
  const calls = [];
  const row = {
    source_order_id: "ORDER-1",
    paid_at: "2026-08-08T01:00:00Z",
    source_sku: "SKU-1",
    quantity: "2",
    line_amount: null,
    line_amount_status: "unavailable",
    order_currency: "cny",
  };
  const repository = new SalesAssortmentRepository({
    provider: fakeProvider(async (sql, parameters = []) => {
      calls.push({ sql, parameters });
      return /COUNT\(\*\)/.test(sql) ? { rows: [{ total: 1 }] } : { rows: [row] };
    }),
  });

  const current = await repository.currentOrderRows();
  const page = await repository.sourceRows("orders", { page: 1, pageSize: 10 });

  assert.equal(current[0].line_amount, null);
  assert.equal(current[0].line_amount_status, "unavailable");
  assert.equal(current[0].order_currency, "CNY");
  assert.equal(page.rows[0].line_amount, null);
  const detailQueries = calls.filter((call) => !/COUNT\(\*\)/.test(call.sql));
  assert.equal(detailQueries.length, 2);
  for (const call of detailQueries) {
    assert.match(call.sql, /l\.line_amount/);
    assert.match(call.sql, /l\.line_amount_status/);
    assert.match(call.sql, /h\.order_currency/);
  }
});

test("audit summary keeps missing identity and API relationships as blockers", () => {
  const report = summarizeUnifiedDataAudit({
    relations: {
      "app.growth_order_headers": true,
      "app.growth_order_lines": true,
      "app.growth_inventory_snapshots": true,
      "app.product_identity_mappings": true,
      "app.product_package_rows": true,
      "app.product_skus": true,
      "app.product_sku_current_prices": true,
      "app.commerce_shop_registry": true,
      "app.commerce_shop_account_bindings": true,
      "app.foundation_identity_links": true,
      "app.platform_api_application_profiles": false,
      "app.shop_external_identities": false,
    },
    metrics: {
      orderHeaders: { missing_shop: 2 },
      orderLines: {
        missing_product: 3,
        missing_line_amount: 3,
        unconfirmed_line_amount: 2,
        confirmed_line_amount: 7,
      },
      inventory: {
        missing_product: 4,
        missing_days_of_supply: 5,
        unconfirmed_days_of_supply: 6,
        confirmed_days_of_supply: 9,
      },
      productIdentity: { mapping_rows: 0, new_product_skus: 5, new_foundation_sku_links: 0 },
      shops: { missing_connector: 2 },
    },
    auditedAt: "2026-08-07T00:00:00.000Z",
  });
  assert.equal(report.readOnly, true);
  assert.equal(report.summary.blockerCount >= 7, true);
  assert.equal(report.gaps.some((item) => item.code === "PRODUCT_IDENTITY_BRIDGE_EMPTY"), true);
  assert.equal(report.gaps.some((item) => item.code === "PLATFORM_API_CONFIG_RELATION_MISSING"), true);
  assert.equal(report.gaps.find((item) => item.code === "ORDER_LINE_AMOUNT_UNCONFIRMED")?.count, 2);
  assert.equal(report.gaps.find((item) => item.code === "INVENTORY_DAYS_OF_SUPPLY_UNCONFIRMED")?.count, 6);
  assert.equal(report.metrics.orderLines.confirmed_line_amount, 7);
  assert.equal(report.metrics.inventory.confirmed_days_of_supply, 9);
});
