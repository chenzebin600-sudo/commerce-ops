import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  FIELD_MAPPING_MODE,
  SOURCE_FIELD_CONTRACTS,
  UNIFIED_IDENTITY_RULES,
  UNIFIED_SOURCE_FIELD_MAPPINGS,
  unifiedFieldMappingSummary,
  validateUnifiedFieldMappings,
} from "../lib/data-foundation/unified-field-mappings.mjs";
import { DATA_SOURCE_CODES } from "../lib/data-foundation/unified-data-contracts.mjs";
import {
  NORMALIZER_GOLDEN_VECTORS,
  normalizeCanonicalShopName,
  normalizeCanonicalSku,
  normalizeCanonicalWarehouse,
} from "../lib/data-foundation/unified-normalizers.mjs";
import { commerceBusinessDate } from "../lib/data-foundation/business-time.mjs";
import { syncUnifiedFieldMappingCatalog } from "../lib/data-foundation/unified-field-mapping-store.mjs";

test("unified field catalogue maps every declared source field exactly once", () => {
  const summary = validateUnifiedFieldMappings();
  assert.deepEqual(summary, unifiedFieldMappingSummary());
  assert.equal(summary.mappingCount, 241);
  assert.equal(summary.sourceFieldCount, 241);
  assert.equal(summary.identityRuleCount, 6);
  assert.deepEqual(summary.bySource, {
    [DATA_SOURCE_CODES.MABANG_ORDERS]: 58,
    [DATA_SOURCE_CODES.MABANG_INVENTORY]: 30,
    [DATA_SOURCE_CODES.PRODUCT_PACKAGE_DB]: 62,
    [DATA_SOURCE_CODES.PRICE_CONTROL_DB]: 27,
    [DATA_SOURCE_CODES.SHOP_MASTER]: 29,
    [DATA_SOURCE_CODES.PLATFORM_CONNECTOR]: 35,
  });
  assert.equal(
    Object.values(SOURCE_FIELD_CONTRACTS).reduce((total, fields) => total + fields.length, 0),
    UNIFIED_SOURCE_FIELD_MAPPINGS.length,
  );
});

test("sensitive order and connector credential fields never enter published datasets", () => {
  const restricted = UNIFIED_SOURCE_FIELD_MAPPINGS.filter((item) => item.mode === FIELD_MAPPING_MODE.REDACT);
  assert.equal(restricted.length, 13);
  assert.equal(restricted.every((item) => item.publicationScope === "NONE"), true);
  assert.equal(restricted.every((item) => item.sensitivity === "RESTRICTED"), true);
  assert.equal(restricted.some((item) => item.sourceField === "客户姓名"), true);
  assert.equal(restricted.some((item) => item.sourceField === "access_token_encrypted"), true);
  assert.equal(restricted.some((item) => item.sourceField === "refresh_token_encrypted"), true);
});

test("identity rules use canonical product, warehouse, shop, and connector keys", () => {
  const byCode = new Map(UNIFIED_IDENTITY_RULES.map((rule) => [rule.code, rule]));
  assert.deepEqual(byCode.get("PRODUCT_COUNTRY_SKU_V1").targetKeys, [
    "product.country_code",
    "product.sku_code_normalized",
  ]);
  assert.deepEqual(byCode.get("INVENTORY_PACKAGE_WAREHOUSE_SKU_V1").sourceKeys, [
    "warehouse.source_warehouse_name",
    "product.source_sku",
  ]);
  assert.deepEqual(byCode.get("CONNECTOR_SHOP_EXTERNAL_ID_V1").sourceKeys, [
    "connector_shop.platform_id",
    "connector_shop.country",
    "connector_shop.seller_id",
  ]);
  assert.deepEqual(byCode.get("CONNECTOR_SHOP_EXTERNAL_ID_V1").targetKeys, [
    "shop.platform",
    "shop.country_code",
    "shop.platform_shop_id",
  ]);
  assert.equal(byCode.get("PRICE_TO_SHOP_SCOPE_V1").cardinality, "ONE_PRICE_SCOPE_TO_MANY_SHOPS");
  assert.equal(byCode.get("CONNECTOR_SHOP_EXTERNAL_ID_V1").conflict, "NEVER_AUTHORIZE_FROM_NAME_ONLY");
  assert.equal(byCode.get("PRICE_TO_SHOP_SCOPE_V1").ruleKind, "RELATIONSHIP");
  assert.equal(byCode.get("CONNECTOR_SHOP_EXTERNAL_ID_V1").ruleKind, "IDENTITY");
});

test("candidate migration keeps V2 governance-only and does not publish or backfill facts", () => {
  const sql = fs.readFileSync(
    new URL("../postgresql/candidate-migrations/014_identity_crosswalk_backfill_candidate.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /'2\.0\.0'/);
  assert.match(sql, /'DRAFT'/);
  assert.match(sql, /data_candidate_migration_history/);
  assert.match(sql, /CREATE TABLE app\.data_source_field_catalog/);
  assert.match(sql, /CREATE TABLE app\.data_field_mappings/);
  assert.match(sql, /CREATE TABLE app\.data_identity_candidate_decisions/);
  assert.match(sql, /CREATE TABLE app\.data_identity_resolutions/);
  assert.match(sql, /PRIMARY KEY \(rule_code,rule_version\)/);
  assert.doesNotMatch(sql, /CREATE (?:OR REPLACE )?VIEW app\.canonical_.*_v2/);
  assert.doesNotMatch(sql, /ALTER TABLE app\.growth_/);
  assert.doesNotMatch(sql, /data_identity_backfill_changes/);
});

test("all core identities share the same NFKC golden normalizer", () => {
  for (const vector of NORMALIZER_GOLDEN_VECTORS) {
    assert.equal(normalizeCanonicalShopName(vector.input), vector.shopName);
    assert.equal(normalizeCanonicalSku(vector.input), vector.sku);
    assert.equal(normalizeCanonicalWarehouse(vector.input), vector.warehouse);
  }
});

test("commerce business dates use Asia/Shanghai without shifting date-only inputs", () => {
  assert.equal(commerceBusinessDate("2026-08-07T15:59:59Z"), "2026-08-07");
  assert.equal(commerceBusinessDate("2026-08-07T16:00:00Z"), "2026-08-08");
  assert.equal(commerceBusinessDate("2026-08-08"), "2026-08-08");
  assert.equal(commerceBusinessDate("2026-08-08 00:30:00"), "2026-08-08");
  assert.equal(commerceBusinessDate("not-a-date"), null);
});

test("ACTIVE mapping publication is rejected until every current contract is quality validated", async () => {
  let transactionStarted = false;
  const provider = {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: "present" }], rowCount: 1 };
      if (sql.includes("information_schema.columns")) return { rows: [{ present: 1 }], rowCount: 1 };
      if (sql.includes("FROM app.data_dataset_registry registry")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
    async transaction() {
      transactionStarted = true;
      throw new Error("transaction must not start");
    },
  };
  await assert.rejects(
    syncUnifiedFieldMappingCatalog({ provider, mappingVersion: "2.0.0", status: "ACTIVE" }),
    /Cannot activate unified mappings before validated current contracts exist/,
  );
  assert.equal(transactionStarted, false);
});
