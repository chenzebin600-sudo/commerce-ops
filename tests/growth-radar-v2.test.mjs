import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { createGrowthRadarAccessPolicy } from "../lib/growth-radar/growth-radar-access-policy.mjs";
import { createGrowthRadarV2Api } from "../lib/growth-radar/v2/growth-radar-v2-api.mjs";
import {
  buildAssistantWorkspace,
  SUPER_MANAGER_CONTRACT_VERSION,
} from "../lib/growth-radar/v2/growth-radar-v2-assistant.mjs";
import { GrowthRadarV2Service } from "../lib/growth-radar/v2/growth-radar-v2-service.mjs";
import { growthRadarV2Internals } from "../lib/growth-radar/v2/growth-radar-v2-engine.mjs";

const FIXED_NOW = new Date("2026-07-28T08:00:00.000Z");

async function createContext({
  countryMapping = true,
  readyForTasks = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-v2-"));
  const databasePath = path.join(root, "growth-radar-v2.sqlite");
  const access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath });
  const db = access.provider.connection;
  seedFacts(db, { countryMapping, readyForTasks });
  const service = new GrowthRadarV2Service({
    repository: access.repositories.growthRadarV2,
    now: () => new Date(FIXED_NOW),
  });
  return {
    root,
    databasePath,
    access,
    db,
    service,
    async close() {
      access.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

function configLeafCount(value) {
  if (Array.isArray(value) || value === null || typeof value !== "object") return 1;
  return Object.values(value).reduce((total, item) => total + configLeafCount(item), 0);
}

function seedFacts(db, { countryMapping, readyForTasks }) {
  const inventoryBatchId = "inventory-v2-001";
  const orderBatchId = "orders-v2-001";
  const createdAt = "2026-07-25T00:00:00.000Z";
  const batch = db.prepare(`INSERT INTO growth_source_batches (
    id,source_type,source_module,source_sha256,idempotency_key,query_started_at,query_ended_at,
    collected_at,imported_at,source_scope_json,source_headers_json,redacted_headers_json,
    row_count,status,created_by,created_at,updated_at,source_scope_status,pii_filtered_field_count
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  batch.run(
    inventoryBatchId,
    "mabang_inventory",
    "mabang_inventory",
    "inventory-v2-sha",
    "inventory-v2-idempotency",
    "2026-07-25T00:00:00.000Z",
    "2026-07-25T00:30:00.000Z",
    "2026-07-25T00:30:00.000Z",
    "2026-07-25T00:31:00.000Z",
    "{}",
    "[]",
    "[]",
    40,
    "applied",
    "test",
    createdAt,
    createdAt,
    "confirmed",
    0,
  );
  batch.run(
    orderBatchId,
    "mabang_order",
    "mabang_order",
    "orders-v2-sha",
    "orders-v2-idempotency",
    "2026-06-28T00:00:00.000Z",
    "2026-07-25T00:00:00.000Z",
    "2026-07-25T00:00:00.000Z",
    "2026-07-25T00:01:00.000Z",
    "{}",
    "[]",
    "[]",
    readyForTasks ? 14 : 10,
    "applied",
    "test",
    createdAt,
    createdAt,
    "confirmed",
    0,
  );

  const insertRaw = db.prepare(`INSERT INTO growth_inventory_raw_rows (
    id,batch_id,sheet_name,source_row_number,raw_values_json,raw_types_json,redacted_fields_json,
    row_hash,parse_status,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insertInventory = db.prepare(`INSERT INTO growth_inventory_snapshots (
    id,batch_id,source_row_number,source_sku,normalized_source_sku,mapped_product_id,warehouse_name,
    available_quantity,physical_quantity,locked_quantity,in_transit_quantity,pending_shipment_quantity,
    sellable_quantity,sellable_quantity_status,source_predicted_daily_sales,predicted_daily_sales_semantic_status,
    days_of_supply,days_of_supply_status,snapshot_at,mapping_status,quality_status,created_at,
    normalized_warehouse_name,product_status,category_level_1,category_level_2,category_level_3,
    source_visible_sales_7d,source_visible_sales_28d,source_visible_sales_42d,source_scope_status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let index = 1; index <= 40; index += 1) {
    const sku = `SKU-${String(index).padStart(3, "0")}`;
    const sales28 = index === 1 ? 0 : index * 28;
    const sales7 = index === 1 ? 0 : index * 7;
    const sales42 = index === 1 ? 0 : index * 42;
    const available = index === 40 ? 0 : (index === 1 ? 1000 : index * 20);
    const sellableDays = index === 40
      ? 0
      : index === 39
        ? 5
        : index === 38
          ? 10
          : index === 1
            ? 200
            : 30;
    const status = index === 2 ? "停止销售" : "正常销售";
    insertRaw.run(
      `raw-${index}`,
      inventoryBatchId,
      "库存",
      index + 1,
      JSON.stringify({ 商品中文名称: `测试商品 ${index}` }),
      "{}",
      "[]",
      `raw-hash-${index}`,
      "parsed",
      createdAt,
    );
    insertInventory.run(
      `inventory-${index}`,
      inventoryBatchId,
      index + 1,
      sku,
      sku,
      null,
      "泰国仓",
      available,
      available,
      0,
      index === 40 ? 0 : index * 2,
      0,
      null,
      readyForTasks ? "confirmed" : "unconfirmed",
      index,
      readyForTasks ? "confirmed" : "unconfirmed",
      sellableDays,
      "confirmed",
      "2026-07-25T00:30:00.000Z",
      "country_unresolved",
      "confirmed",
      createdAt,
      "WH-A",
      status,
      "家居",
      "收纳",
      null,
      sales7,
      sales28,
      sales42,
      "confirmed",
    );
  }

  db.prepare(`INSERT INTO growth_shops (
    id,internal_shop_code,display_name,platform,country_code,country_name,owner_user_id,
    primary_category_scope_json,status,identity_status,revision,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "shop-v2-001",
    "SHOP-V2-001",
    "泰国测试店",
    "Shopee",
    countryMapping ? "TH" : "ZZ",
    countryMapping ? "泰国" : "未确认",
    "manager-a",
    "[]",
    "active",
    "confirmed",
    1,
    createdAt,
    createdAt,
  );
  db.prepare(`INSERT INTO growth_shop_source_mappings (
    id,source_system,source_shop_name,normalized_source_shop_name,internal_shop_id,platform,country_code,
    mapping_status,mapping_source,first_source_batch_id,last_source_batch_id,confirmed_by,confirmed_at,
    created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "shop-map-v2-001",
    "mabang",
    "泰国测试店",
    "泰国测试店",
    "shop-v2-001",
    "Shopee",
    countryMapping ? "TH" : null,
    "manually_confirmed",
    "manual",
    orderBatchId,
    orderBatchId,
    "test",
    createdAt,
    createdAt,
    createdAt,
  );
  if (countryMapping) {
    db.prepare(`INSERT INTO growth_warehouse_country_mappings (
      id,mapping_set_id,source_system,source_warehouse_name,normalized_warehouse_name,country_code,
      country_name,mapping_status,exclusion_reason,evidence_json,confirmed_by,confirmed_at,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "warehouse-map-v2-001",
      "gr-country-map-empty-v1",
      "mabang_inventory",
      "泰国仓",
      "WH-A",
      "TH",
      "泰国",
      "confirmed",
      null,
      "{}",
      "test",
      createdAt,
      createdAt,
    );
  }

  const insertHeader = db.prepare(`INSERT INTO growth_order_headers (
    id,business_key,business_key_version,platform,source_shop_name,normalized_source_shop_name,
    internal_shop_id,mapped_country,source_order_id,order_status,paid_at,cancelled_at,
    order_currency,order_amount,order_amount_source_field,effective_status,first_source_batch_id,
    source_batch_id,source_quality_status,first_seen_at,last_seen_at,revision,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertLine = db.prepare(`INSERT INTO growth_order_lines (
    id,order_header_id,first_source_batch_id,source_batch_id,source_row_number,source_line_key,
    source_line_key_version,line_occurrence,dedupe_confidence,source_sku,normalized_source_sku,
    platform_sku,mapped_product_id,mapped_country,quantity,line_amount,line_amount_status,product_name,
    mapping_status,effective_status,is_current,first_seen_at,last_seen_at,revision,created_at,updated_at,
    source_warehouse_name,normalized_source_warehouse_name
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const orderCount = readyForTasks ? 14 : 10;
  const validStatuses = ["已发货", "待处理", "配货中", "已完成"];
  for (let index = 1; index <= orderCount; index += 1) {
    const sku = `SKU-${String(index + 20).padStart(3, "0")}`;
    const orderId = `order-${index}`;
    const day = readyForTasks ? 10 + index : 14 + index;
    const paidAt = `2026-07-${String(day).padStart(2, "0")}T08:00:00.000Z`;
    insertHeader.run(
      orderId,
      `business-${index}`,
      "v1",
      "Shopee",
      "泰国测试店",
      "泰国测试店",
      "shop-v2-001",
      "TH",
      `SOURCE-${index}`,
      validStatuses[(index - 1) % validStatuses.length],
      paidAt,
      null,
      "THB",
      index * 10,
      "订单金额",
      "valid",
      orderBatchId,
      orderBatchId,
      "confirmed",
      paidAt,
      paidAt,
      1,
      createdAt,
      createdAt,
    );
    insertLine.run(
      `line-${index}`,
      orderId,
      orderBatchId,
      orderBatchId,
      index + 1,
      `line-key-${index}`,
      "v1",
      1,
      "source_identifier",
      sku,
      sku,
      sku,
      null,
      "TH",
      index,
      index * 10,
      "confirmed",
      `测试商品 ${index + 20}`,
      "country_unresolved",
      "valid",
      1,
      paidAt,
      paidAt,
      1,
      createdAt,
      createdAt,
      "泰国仓",
      "WH-A",
    );
  }
}

async function invoke(api, { method = "GET", pathname, body = null } = {}) {
  let status = null;
  let text = "";
  const req = {
    method,
    headers: {},
    auditContext: {
      actorType: "test",
      requestId: "request-v2",
      annotations: {},
      annotate(value) {
        this.annotations = { ...this.annotations, ...value };
      },
    },
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    writeHead(value) {
      status = value;
    },
    end(value) {
      text = String(value || "");
    },
  };
  const url = new URL(pathname, "http://127.0.0.1");
  const handled = await api(req, res, url);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

test("Growth Radar V2 migrations install the direction and task lifecycle contracts", async () => {
  const migrationNames = (await fs.readdir(path.resolve("migrations")))
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .sort();
  assert.equal(migrationNames.some((name) => name.startsWith("016_")), false);
  assert.deepEqual(migrationNames.filter((name) => {
    const version = Number(name.slice(0, 3));
    return version >= 17 && version <= 21;
  }), [
    "017_mabang_full_image_sync.sql",
    "018_mabang_image_collection_performance.sql",
    "019_growth_radar_v2_analysis.sql",
    "020_growth_radar_direction_contract.sql",
    "021_growth_radar_task_lifecycle.sql",
  ]);
  assert.equal(migrationNames.includes("032_growth_inventory_transfer_pending_shipment.sql"), true);
  const context = await createContext();
  try {
    const latest = context.db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();
    assert.equal(latest.version, migrationNames.at(-1));
    const rule = context.db.prepare(`SELECT version,status,metrics_contract_version,parameters_json,
      content_sha256
      FROM growth_rule_sets
      WHERE status='active'`).get();
    const parameters = JSON.parse(rule.parameters_json);
    assert.equal(rule.version, "GRV2-METRICS-1.2.0");
    assert.equal(rule.metrics_contract_version, "GRV2-METRICS-1.2.0");
    assert.equal(rule.status, "active");
    assert.equal(
      createHash("sha256").update(rule.parameters_json).digest("hex"),
      rule.content_sha256,
    );
    assert.deepEqual(parameters.validOrderStatuses, ["已发货", "待处理", "配货中", "已完成"]);
    assert.equal(parameters.thresholdProfileVersion, "GRV2-THRESHOLDS-1.2.0-DEFAULT");
    assert.equal(parameters.thresholds.capture.lowRatio, 0.1);
    assert.equal(parameters.thresholds.assortment.highPercentile, 0.8);
    assert.equal(parameters.thresholds.assortment.minimumSampleSize, 30);
    assert.equal(parameters.thresholds.storeGap.coverageRatio, 0.5);
    assert.equal(parameters.thresholds.storeGap.severeCoverageRatio, 0.25);
    assert.equal(parameters.thresholds.priority.p0.declineRate, 0.5);
    assert.equal(parameters.thresholds.task.managerHomeLimit, 10);
    assert.equal(configLeafCount({
      windows: parameters.windows,
      dataMinimums: parameters.dataMinimums,
      thresholds: parameters.thresholds,
    }), 32);
    const taskTables = context.db.prepare(`SELECT name,type
      FROM sqlite_master
      WHERE name IN (
        'growth_sku_warehouse_daily_metrics',
        'growth_latest_sku_warehouse_metrics_v',
        'growth_latest_country_supply_summary_v',
        'growth_focus_items',
        'growth_focus_item_events',
        'growth_open_focus_items_v'
      )
      ORDER BY name`).all();
    assert.deepEqual(taskTables.map((row) => ({ ...row })), [
      { name: "growth_focus_item_events", type: "table" },
      { name: "growth_focus_items", type: "table" },
      { name: "growth_latest_country_supply_summary_v", type: "view" },
      { name: "growth_latest_sku_warehouse_metrics_v", type: "view" },
      { name: "growth_open_focus_items_v", type: "view" },
      { name: "growth_sku_warehouse_daily_metrics", type: "table" },
    ]);
    const warehouseColumns = context.db.prepare(
      "PRAGMA table_info(growth_sku_warehouse_daily_metrics)",
    ).all().map((row) => row.name);
    assert.equal(warehouseColumns.includes("country_code"), true);
    assert.equal(warehouseColumns.includes("normalized_warehouse_name"), true);
    assert.equal(warehouseColumns.includes("normalized_source_sku"), true);
    assert.equal(warehouseColumns.includes("source_current_sellable_days"), true);
    assert.equal(warehouseColumns.includes("supply_status"), true);
    const signalColumns = context.db.prepare("PRAGMA table_info(growth_signals)")
      .all().map((row) => row.name);
    const taskColumns = context.db.prepare("PRAGMA table_info(growth_focus_items)")
      .all().map((row) => row.name);
    assert.equal(signalColumns.includes("normalized_warehouse_name"), true);
    assert.equal(taskColumns.includes("normalized_warehouse_name"), true);
    const skuMetricSql = context.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='growth_sku_daily_metrics'",
    ).get().sql;
    assert.match(skuMetricSql, /metrics_version <> 'GRV2-METRICS-1\.2\.0'/);
    assert.match(skuMetricSql, /computed_days_of_supply IS NULL/);
    assert.match(skuMetricSql, /days_of_supply_status = 'warehouse_aggregate_only'/);
    assert.match(skuMetricSql, /assortment_status IS NOT NULL/);
    const signalSql = context.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='growth_signals'",
    ).get().sql;
    const taskSql = context.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='growth_focus_items'",
    ).get().sql;
    assert.match(signalSql, /'warehouse_sku'/);
    assert.match(taskSql, /'warehouse_sku'/);
    const integrity = context.db.prepare("PRAGMA integrity_check").get();
    assert.equal(integrity.integrity_check, "ok");
    assert.deepEqual(context.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    await context.close();
  }
});

test("assistant readiness stays fail-closed when the database stops at migration 018", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "growth-radar-v2-readiness-"));
  const migrationsDir = path.join(root, "migrations");
  const databasePath = path.join(root, "readiness.sqlite");
  await fs.mkdir(migrationsDir, { recursive: true });
  const migrationFiles = (await fs.readdir(path.resolve("migrations")))
    .filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) <= 18)
    .sort();
  for (const filename of migrationFiles) {
    await fs.copyFile(
      path.resolve("migrations", filename),
      path.join(migrationsDir, filename),
    );
  }
  const access = openCommerceDataAccess({
    rootDir: path.resolve("."),
    databasePath,
    migrationsDir,
  });
  try {
    const service = new GrowthRadarV2Service({
      repository: access.repositories.growthRadarV2,
      now: () => new Date(FIXED_NOW),
    });
    const assistant = await service.assistantWorkspace();
    assert.equal(assistant.mode, "readiness");
    assert.equal(assistant.publishable, false);
    assert.equal(assistant.readiness.latestMigration, "018_mabang_image_collection_performance.sql");
    assert.equal(assistant.readiness.analysisSchemaReady, false);
    assert.equal(assistant.readiness.taskPersistenceReady, false);
    assert.equal(
      assistant.readiness.blockers.includes("ANALYSIS_SCHEMA_NOT_APPROVED"),
      true,
    );
    assert.equal(
      assistant.readiness.blockers.includes("TASK_PERSISTENCE_SCHEMA_NOT_APPROVED"),
      true,
    );
    assert.deepEqual(assistant.operationTasks, []);
    const configuration = await service.assistantConfiguration();
    assert.equal(configuration.writeGate.enabled, false);
    assert.equal(
      configuration.writeGate.reasons.includes("ANALYSIS_SCHEMA_NOT_APPROVED"),
      true,
    );
    assert.equal(configuration.dataSources.length, 2);
    assert.equal(configuration.dataSources[0].taskType, "order_export");
    assert.equal(configuration.dataSources[0].latestBatch, null);
    assert.equal(configuration.dataSources[1].taskType, "inventory_export");
    assert.equal(configuration.dataSources[1].latestBatch, null);
    assert.deepEqual(configuration.countryMappings, []);
    assert.deepEqual(configuration.shopMappings, []);
  } finally {
    access.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deterministic helpers preserve ties and warehouse-level supply semantics", () => {
  const values = [{ sku: "A", value: 1 }, { sku: "B", value: 2 }, { sku: "C", value: 2 }];
  const ranks = growthRadarV2Internals.percentileRanks(values, (item) => item.value);
  assert.equal(ranks.get(values[1]), ranks.get(values[2]));
  assert.equal(growthRadarV2Internals.warehouseSupplyStatus({
    availableQuantity: 20,
    inTransitQuantity: 0,
    sourceCurrentSellableDays: 5,
    outOfStockDays: 0,
    criticalDays: 7,
    warningDays: 14,
  }), "SUPPLY_CRITICAL");
  assert.equal(growthRadarV2Internals.warehouseSlowMovingStatus({
    availableQuantity: 20,
    sourceCurrentSellableDays: 181,
    watchDays: 60,
    riskDays: 90,
    severeDays: 180,
  }), "SLOW_MOVING_SEVERE");
  assert.equal(growthRadarV2Internals.operationalDirection({
    sourceHighPerformance: true,
    availableQuantity: 100,
    supplyRiskWarehouseCount: 0,
    ownSalesQuantity28d: 0,
    ownCaptureRatio28d: 0,
    lowCaptureThreshold: 0.1,
  }), "QUIET_ENTRY");
  assert.equal(growthRadarV2Internals.operationalDirection({
    sourceHighPerformance: true,
    availableQuantity: 100,
    supplyRiskWarehouseCount: 0,
    ownSalesQuantity28d: 28,
    ownCaptureRatio28d: 0.099,
    lowCaptureThreshold: 0.1,
  }), "PRIORITY_GROWTH");
  assert.equal(growthRadarV2Internals.operationalDirection({
    sourceHighPerformance: true,
    availableQuantity: 100,
    supplyRiskWarehouseCount: 0,
    ownSalesQuantity28d: 28,
    ownCaptureRatio28d: 0.1,
    lowCaptureThreshold: 0.1,
  }), "DEFEND_WINNER");
  assert.deepEqual(
    growthRadarV2Internals.consistentNumber([
      { source_predicted_daily_sales: 8 },
      { source_predicted_daily_sales: 8 },
    ], "source_predicted_daily_sales"),
    { value: 8, status: "available", values: [8] },
  );
  assert.equal(
    growthRadarV2Internals.consistentNumber([
      { source_predicted_daily_sales: 8 },
      { source_predicted_daily_sales: 9 },
    ], "source_predicted_daily_sales").status,
    "conflict",
  );
  const strictCategory = [
    { sku: "A", categoryL1: "X", categoryL2: "X1", value: 10, qualityStatus: "confirmed" },
    { sku: "B", categoryL1: "Y", categoryL2: "Y1", value: 100, qualityStatus: "confirmed" },
  ];
  growthRadarV2Internals.categoryComparison(
    strictCategory,
    "value",
    "rankPercentile",
    30,
    { rankField: "rank", scopeField: "scope", sampleField: "sample", strictCategory: true },
  );
  assert.equal(strictCategory[0].scope, undefined);
  assert.equal(strictCategory[0].sample, undefined);
  assert.equal(strictCategory[0].rank, undefined);
});

test("super manager projection caps tasks per manager and preserves evidence boundaries", () => {
  const stores = Array.from({ length: 12 }, (_, index) => ({
    shopId: `shop-${index + 1}`,
    displayName: `Store ${index + 1}`,
    platform: "Shopee",
    ownerUserId: "manager-a",
    countryCode: "TH",
    ownSalesQuantity7d: 0,
    ownSalesQuantityPrevious7d: 4,
    ownSalesQuantity28d: 0,
    highPerformanceCoverageRate28d: 0.1,
    saleableCoverageRate28d: 0.2,
    growthFocusCount: 1,
    quietEntryCount: 2,
    priorityGrowthCount: 1,
    defendWinnerCount: 0,
    supplyConstrainedCount: 1,
    anomalyCode: "ATTENTION_GAP",
    availabilityStatus: "available",
    qualityStatus: "confirmed",
    reasonCode: "METRIC_AVAILABLE",
    metricsVersion: "GRV2-METRICS-1.2.0",
  }));
  const workspace = buildAssistantWorkspace({
    run: { id: "run-1", status: "published" },
    overview: {},
    directions: {
      shopComparisons: stores,
      skuDirections: [],
      warehouseRisks: [],
      categoryCountry: [],
      managerComparisons: [],
      directionCounts: {
        quietEntry: 24,
        priorityGrowth: 12,
        defendWinner: 0,
        supplyConstrained: 12,
      },
    },
    readiness: {
      historyDays: 14,
      operationTasksPublishable: true,
      blockers: [],
    },
  });
  assert.equal(workspace.contractVersion, SUPER_MANAGER_CONTRACT_VERSION);
  assert.equal(workspace.operationTasks.length, 10);
  assert.equal(workspace.operationTasks.every((entry) => entry.managerId === "manager-a"), true);
  assert.equal(workspace.operationTasks.every((entry) => entry.status === "NEW"), true);
  assert.equal(workspace.stores[0].trend.status, "DECLINING");
  assert.equal(workspace.stores[0].trend.previous7d, 4);
  assert.equal(workspace.stores[0].trend.changeRate, -1);
  assert.equal(
    workspace.operationTasks.some((entry) => (
      entry.type === "BLUE_OCEAN"
      && entry.recommendedAction === "核查在线状态后低风险测试。"
    )),
    false,
  );
  assert.equal(workspace.taskPersistenceReady, false);
});

test("analysis publishes deterministic assortment, risk, store and evidence projections", async () => {
  const context = await createContext();
  try {
    const result = await context.service.analyze({ actorLabel: "tester" });
    assert.equal(result.reused, false);
    assert.equal(result.run.status, "published");
    assert.equal(result.run.globalSkuCount, 40);
    assert.equal(result.run.countrySkuCount, 40);
    assert.equal(result.run.shopCount, 1);
    assert.equal(result.run.qualitySummary.warehouseSkuCount, 40);

    const overview = await context.service.overview();
    assert.equal(overview.summary.skuCount, 40);
    assert.ok(overview.summary.highPerformanceCount >= 8);
    assert.ok(overview.summary.keyPerformerCount >= 1);
    assert.ok(overview.summary.growthFocusCount >= 1);
    assert.equal(overview.summary.supplyBands.reduce((sum, item) => sum + item.count, 0), 40);
    assert.equal(overview.summary.categoryPerformance[0].category, "收纳");
    assert.equal(overview.summary.categoryPerformance[0].skuCount, 40);

    const outOfStock = await context.service.listSignals({ ruleCode: "OUT_OF_STOCK" });
    assert.equal(outOfStock.signals.some((entry) => entry.sku === "SKU-040"), true);
    assert.equal(outOfStock.signals[0].normalizedWarehouseName, "WH-A");
    assert.equal(outOfStock.signals[0].evidence.formula,
      "source_current_sellable_days_used_directly_at_country_warehouse_sku_grain");

    const slow = await context.service.listSignals({ ruleCode: "SLOW_MOVING_SEVERE" });
    assert.equal(slow.signals.some((entry) => entry.sku === "SKU-001"), true);

    const stores = await context.service.listStores();
    assert.equal(stores.stores.length, 1);
    assert.equal(stores.stores[0].availabilityStatus, "available");
    assert.equal(stores.stores[0].ownSalesQuantity28d, 55);
    assert.notEqual(stores.stores[0].saleableCoverageRate28d, null);
    assert.equal(stores.stores[0].ownSalesQuantityPrevious7d, 10);

    const sku = await context.service.skuDetail("sku-040");
    assert.equal(sku.metric.productName, "测试商品 40");
    assert.equal(sku.metric.sourcePredictedDailySales, 40);
    assert.equal(sku.metric.forecastRank, null);
    assert.equal(sku.countries[0].countryCode, "TH");
    assert.equal(sku.countries[0].forecastRank, 1);
    assert.equal(sku.countries[0].forecastComparisonSampleSize, 40);
    assert.equal(sku.warehouses[0].normalizedWarehouseName, "WH-A");
    assert.equal(sku.signals.some((entry) => entry.ruleCode === "ASSORTMENT_VERIFIED_HIGH"), true);

    const directions = await context.service.directions();
    assert.ok(directions.directionCounts.quietEntry >= 1);
    assert.equal(directions.directionCounts.supplyConstrained, 3);
    assert.equal(directions.categoryCountry[0].countryCode, "TH");
    assert.equal(directions.categoryCountry[0].category, "收纳");
    assert.equal(directions.categoryCountry[0].verifiedSkuCount, 40);
    assert.equal(
      directions.skuDirections.find((item) => item.sku === "SKU-040").directionCode,
      "SUPPLY_CONSTRAINED",
    );
    assert.equal(
      directions.skuDirections.find((item) => item.sku === "SKU-039").directionCode,
      "SUPPLY_CONSTRAINED",
    );
    assert.equal(directions.warehouseRisks.some((item) => (
      item.sku === "SKU-040"
      && item.normalizedWarehouseName === "WH-A"
      && item.supplyStatus === "OUT_OF_STOCK"
    )), true);
    assert.equal(directions.shopComparisons[0].ownerUserId, "manager-a");

    const assistant = await context.service.assistantWorkspace();
    assert.equal(assistant.contractVersion, "GRV2-SUPER-MANAGER-2.2");
    assert.equal(assistant.mode, "readiness");
    assert.equal(assistant.readiness.historyDays, 10);
    assert.equal(assistant.readiness.blockers.includes("INSUFFICIENT_HISTORY"), true);
    assert.equal(assistant.operationTasks.length, 0);
    assert.ok(assistant.candidateTasks.length > 0);
    assert.ok(assistant.candidateTasks.length > 0);
    assert.equal(assistant.stores[0].state, "ACTION_REQUIRED");

    const reused = await context.service.analyze({ actorLabel: "tester" });
    assert.equal(reused.reused, true);
    assert.equal(reused.run.id, result.run.id);
    assert.equal(context.db.prepare("SELECT COUNT(*) AS count FROM growth_analysis_runs").get().count, 1);
  } finally {
    await context.close();
  }
});

test("published assistant tasks persist with an auditable and idempotent lifecycle", async () => {
  const context = await createContext({ readyForTasks: true });
  try {
    const api = createGrowthRadarV2Api({
      service: context.service,
      accessPolicy: createGrowthRadarAccessPolicy(),
    });
    const published = await invoke(api, {
      method: "POST",
      pathname: "/api/growth-radar/v2/analysis-runs",
    });
    assert.equal(published.status, 201);
    assert.equal(published.body.taskSync.synced, true);
    assert.ok(published.body.taskSync.candidateCount > 0);

    const workspace = await invoke(api, {
      pathname: "/api/growth-radar/v2/assistant/workspace?max_tasks=10",
    });
    assert.equal(workspace.status, 200);
    assert.equal(workspace.body.publishable, true);
    assert.equal(workspace.body.taskPersistenceReady, true);
    assert.ok(workspace.body.operationTasks.length > 0);
    assert.ok(workspace.body.operationTasks.length <= 10);
    assert.equal(workspace.body.operationTasks.every((item) => item.persisted), true);

    const tasks = await invoke(api, {
      pathname: "/api/growth-radar/v2/tasks?page_size=500",
    });
    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.total, published.body.taskSync.activeTaskCount);
    assert.ok(tasks.body.total >= workspace.body.operationTasks.length);
    const warehouseTask = tasks.body.items.find((item) => (
      item.type === "INVENTORY_RISK"
      && item.normalizedWarehouseName === "WH-A"
      && item.sku
    ));
    assert.ok(warehouseTask);
    assert.equal(warehouseTask.sourceWarehouseName, "泰国仓");
    const task = tasks.body.items.find((item) => item.status === "NEW");
    assert.ok(task);
    assert.equal(task.revision, 1);

    const acknowledged = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/status`,
      body: {
        status: "ACKNOWLEDGED",
        expectedRevision: task.revision,
        idempotencyKey: "task-lifecycle-ack-001",
      },
    });
    assert.equal(acknowledged.status, 200);
    assert.equal(acknowledged.body.item.status, "ACKNOWLEDGED");
    assert.equal(acknowledged.body.item.revision, 2);
    assert.equal(acknowledged.body.replayed, false);

    const replayed = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/status`,
      body: {
        status: "ACKNOWLEDGED",
        expectedRevision: task.revision,
        idempotencyKey: "task-lifecycle-ack-001",
      },
    });
    assert.equal(replayed.status, 200);
    assert.equal(replayed.body.item.revision, 2);
    assert.equal(replayed.body.replayed, true);

    const started = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/status`,
      body: {
        status: "IN_PROGRESS",
        expectedRevision: 2,
        idempotencyKey: "task-lifecycle-start-001",
      },
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.item.status, "IN_PROGRESS");
    assert.equal(started.body.item.revision, 3);

    const invalidMonitoring = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/status`,
      body: {
        status: "MONITORING",
        expectedRevision: 3,
        idempotencyKey: "task-lifecycle-monitor-invalid-001",
      },
    });
    assert.equal(invalidMonitoring.status, 400);
    assert.equal(invalidMonitoring.body.code, "GROWTH_RADAR_V2_TASK_SCHEDULE_INVALID");

    const monitoring = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/status`,
      body: {
        status: "MONITORING",
        expectedRevision: 3,
        snoozedUntil: "2026-08-01T00:00:00.000Z",
        idempotencyKey: "task-lifecycle-monitor-001",
      },
    });
    assert.equal(monitoring.status, 200);
    assert.equal(monitoring.body.item.status, "MONITORING");
    assert.equal(monitoring.body.item.revision, 4);

    const resolved = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/status`,
      body: {
        status: "RESOLVED",
        expectedRevision: 4,
        reasonCode: "ACTION_COMPLETED",
        note: "已完成低风险测试并记录结果。",
        idempotencyKey: "task-lifecycle-resolve-001",
      },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.item.status, "RESOLVED");
    assert.equal(resolved.body.item.revision, 5);

    const staleAssignment = await invoke(api, {
      method: "PATCH",
      pathname: `/api/growth-radar/v2/tasks/${task.id}/assignment`,
      body: {
        ownerUserId: "manager-b",
        expectedRevision: 3,
        idempotencyKey: "task-lifecycle-assign-stale-001",
      },
    });
    assert.equal(staleAssignment.status, 409);
    assert.equal(staleAssignment.body.code, "GROWTH_RADAR_V2_TASK_REVISION_CONFLICT");
    assert.equal(staleAssignment.body.currentItem.revision, 5);

    const detail = await invoke(api, {
      pathname: `/api/growth-radar/v2/tasks/${task.id}`,
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.item.status, "RESOLVED");
    assert.deepEqual(
      detail.body.events.map((event) => event.eventType),
      ["CREATED", "ACKNOWLEDGED", "STARTED", "MONITORING_STARTED", "RESOLVED"],
    );

    const beforeReplay = {
      revision: detail.body.item.revision,
      eventCount: detail.body.events.length,
    };
    const reusedRun = await invoke(api, {
      method: "POST",
      pathname: "/api/growth-radar/v2/analysis-runs",
    });
    assert.equal(reusedRun.status, 200);
    assert.equal(reusedRun.body.reused, true);
    assert.equal(reusedRun.body.taskSync.synced, true);
    const afterReplay = await invoke(api, {
      pathname: `/api/growth-radar/v2/tasks/${task.id}`,
    });
    assert.deepEqual(
      {
        revision: afterReplay.body.item.revision,
        eventCount: afterReplay.body.events.length,
      },
      beforeReplay,
    );
  } finally {
    await context.close();
  }
});

test("configuration is editable, versioned and changes the next analysis fingerprint", async () => {
  const context = await createContext();
  try {
    const before = await context.service.configuration();
    assert.equal(before.knownWarehouses.length, 1);
    assert.equal(before.knownWarehouses[0].normalizedWarehouseName, "WH-A");
    assert.equal(before.activeCountryMappingSet.status, "active");
    assert.equal(before.activeRuleSet.metricsContractVersion, "GRV2-METRICS-1.2.0");

    const firstRun = await context.service.analyze({ actorLabel: "tester" });
    const country = await context.service.saveCountryMappings({
      description: "测试国家映射",
      mappings: [{
        sourceWarehouseName: "泰国仓",
        normalizedWarehouseName: "WH-A",
        mappingStatus: "confirmed",
        countryCode: "TH",
        countryName: "泰国",
      }],
    }, { actorLabel: "config-user" });
    assert.equal(country.set.status, "active");
    assert.equal(country.mappings.length, 1);
    assert.equal(context.db.prepare(
      "SELECT COUNT(*) AS count FROM growth_country_mapping_sets WHERE status='active'",
    ).get().count, 1);
    assert.equal(context.db.prepare(
      "SELECT COUNT(*) AS count FROM growth_country_mapping_sets WHERE status='retired'",
    ).get().count, 1);

    const rules = await context.service.saveRuleSet({
      sourceHighPercentile: 0.85,
      storeLowRatioPercentile: 0.1,
      minimumComparisonSize: 30,
      newDays: 90,
      slowAttentionDays: 60,
      slowHighDays: 90,
      slowCriticalDays: 180,
      lowStockWarningDays: 14,
      lowStockHighDays: 7,
    }, { actorLabel: "config-user" });
    assert.equal(rules.ruleSet.parameters.thresholds.assortment.highPercentile, 0.85);
    assert.equal(rules.ruleSet.parameters.thresholds.capture.lowRatio, 0.1);
    assert.deepEqual(
      rules.ruleSet.parameters.validOrderStatuses,
      ["已发货", "待处理", "配货中", "已完成"],
    );
    assert.equal(configLeafCount({
      windows: rules.ruleSet.parameters.windows,
      dataMinimums: rules.ruleSet.parameters.dataMinimums,
      thresholds: rules.ruleSet.parameters.thresholds,
    }), 32);
    assert.equal(context.db.prepare(
      "SELECT COUNT(*) AS count FROM growth_rule_sets WHERE status='active'",
    ).get().count, 1);

    const after = await context.service.configuration();
    assert.equal(after.pendingAnalysisRefresh, true);
    assert.notEqual(after.activeCountryMappingSet.id, firstRun.run.countryMappingSetId);
    assert.notEqual(after.activeRuleSet.id, firstRun.run.ruleSetId);

    context.service.now = () => new Date("2026-07-28T09:00:00.000Z");
    const secondRun = await context.service.analyze({ actorLabel: "tester" });
    assert.equal(secondRun.reused, false);
    assert.notEqual(secondRun.run.inputFingerprint, firstRun.run.inputFingerprint);
    assert.equal((await context.service.configuration()).pendingAnalysisRefresh, false);
  } finally {
    await context.close();
  }
});

test("configuration validation rejects ambiguous countries and unsafe thresholds", async () => {
  const context = await createContext();
  try {
    await assert.rejects(
      context.service.saveCountryMappings({
        mappings: [{
          sourceWarehouseName: "未知仓",
          normalizedWarehouseName: "UNKNOWN",
          mappingStatus: "confirmed",
          countryCode: "ZZ",
          countryName: "未知",
        }],
      }),
      (error) => error.code === "GROWTH_RADAR_V2_CONFIG_INVALID",
    );
    await assert.rejects(
      context.service.saveRuleSet({
        sourceHighPercentile: 0.8,
        storeLowRatioPercentile: 0.1,
        minimumComparisonSize: 30,
        newDays: 90,
        slowAttentionDays: 180,
        slowHighDays: 90,
        slowCriticalDays: 60,
        lowStockWarningDays: 14,
        lowStockHighDays: 7,
      }),
      (error) => error.code === "GROWTH_RADAR_V2_CONFIG_INVALID",
    );
  } finally {
    await context.close();
  }
});

test("country mapping gaps degrade cross-source store analysis without inventing coverage", async () => {
  const context = await createContext({ countryMapping: false });
  try {
    const result = await context.service.analyze({ actorLabel: "tester" });
    assert.equal(result.run.status, "published");
    assert.equal(result.run.qualityStatus, "degraded");
    const stores = await context.service.listStores();
    assert.equal(stores.stores[0].availabilityStatus, "degraded");
    assert.equal(stores.stores[0].saleableCoverageRate28d, null);
    assert.equal(stores.stores[0].reasonCode, "COUNTRY_MAPPING_UNAVAILABLE");
  } finally {
    await context.close();
  }
});

test("a failed newer run leaves the previous published run available", async () => {
  const context = await createContext();
  try {
    const first = await context.service.analyze({ actorLabel: "tester" });
    const at = "2026-07-28T10:00:00.000Z";
    context.db.prepare(`INSERT INTO growth_source_batches (
      id,source_type,source_module,source_sha256,idempotency_key,collected_at,imported_at,
      source_scope_json,source_headers_json,redacted_headers_json,row_count,status,created_by,
      created_at,updated_at,source_scope_status,pii_filtered_field_count
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "inventory-v2-empty",
      "mabang_inventory",
      "mabang_inventory",
      "empty-sha",
      "empty-idempotency",
      at,
      at,
      "{}",
      "[]",
      "[]",
      0,
      "applied",
      "test",
      at,
      at,
      "confirmed",
      0,
    );
    context.service.now = () => new Date("2026-07-28T09:00:00.000Z");
    await assert.rejects(
      context.service.analyze({ actorLabel: "tester" }),
      (error) => error.code === "GROWTH_RADAR_V2_INVENTORY_EMPTY",
    );
    const status = await context.service.status();
    assert.equal(status.latestPublished.id, first.run.id);
    assert.equal(status.latestAttempt.status, "failed");
    assert.equal(status.servingPreviousPublishedRun, true);
    const overview = await context.service.overview();
    assert.equal(overview.run.id, first.run.id);
  } finally {
    await context.close();
  }
});

test("Growth Radar V2 API exposes published metrics and reuses idempotent runs", async () => {
  const context = await createContext();
  try {
    const api = createGrowthRadarV2Api({
      service: context.service,
      accessPolicy: createGrowthRadarAccessPolicy(),
    });
    const run = await invoke(api, { method: "POST", pathname: "/api/growth-radar/v2/analysis-runs" });
    assert.equal(run.handled, true);
    assert.equal(run.status, 201);
    assert.equal(run.body.run.status, "published");

    const overview = await invoke(api, { pathname: "/api/growth-radar/v2/overview" });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.summary.skuCount, 40);

    const directions = await invoke(api, { pathname: "/api/growth-radar/v2/directions" });
    assert.equal(directions.status, 200);
    assert.ok(directions.body.directionCounts.quietEntry >= 1);
    assert.equal(directions.body.skuDirections[0].directionCode, "QUIET_ENTRY");

    const assistant = await invoke(api, {
      pathname: "/api/growth-radar/v2/assistant/workspace?owner_user_id=manager-a&max_tasks=10",
    });
    assert.equal(assistant.status, 200);
    assert.equal(assistant.body.contractVersion, "GRV2-SUPER-MANAGER-2.2");
    assert.equal(assistant.body.publishable, false);
    assert.equal(assistant.body.operationTasks.length, 0);
    assert.ok(assistant.body.candidateTasks.length > 0);

    const assistantConfiguration = await invoke(api, {
      pathname: "/api/growth-radar/v2/assistant/configuration",
    });
    assert.equal(assistantConfiguration.status, 200);
    assert.equal(assistantConfiguration.body.writeGate.enabled, false);
    assert.equal(assistantConfiguration.body.dataSources.length, 2);
    assert.equal(assistantConfiguration.body.dataSources[0].label, "订单信息");
    assert.equal(assistantConfiguration.body.dataSources[0].latestBatch.id, "orders-v2-001");
    assert.equal(assistantConfiguration.body.dataSources[0].latestBatch.rowCount, 10);
    assert.equal(assistantConfiguration.body.dataSources[1].label, "库存信息");
    assert.equal(assistantConfiguration.body.dataSources[1].latestBatch.id, "inventory-v2-001");
    assert.equal(assistantConfiguration.body.dataSources[1].latestBatch.rowCount, 40);
    assert.equal(assistantConfiguration.body.countryMappings.length, 1);
    assert.equal(assistantConfiguration.body.countryMappings[0].countryCode, "TH");
    assert.equal(assistantConfiguration.body.shopMappings.length, 1);
    assert.equal(assistantConfiguration.body.shopMappings[0].managerUserId, "manager-a");
    assert.equal(assistantConfiguration.body.shopMappings[0].readinessStatus, "confirmed");

    const assortment = await invoke(api, {
      pathname: "/api/growth-radar/v2/assortment?country_code=TH&rule_code=ASSORTMENT_VERIFIED_HIGH&page_size=5",
    });
    assert.equal(assortment.status, 200);
    assert.equal(assortment.body.items.length, 5);
    assert.equal(assortment.body.items.every((item) => item.sourceHighPerformance), true);
    assert.equal(assortment.body.items.every((item) => item.countryCode === "TH"), true);
    assert.equal(assortment.body.items.every((item) => item.forecastRank !== null), true);

    const detail = await invoke(api, { pathname: "/api/growth-radar/v2/skus/SKU-040" });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.metric.sku, "SKU-040");

    const configuration = await invoke(api, { pathname: "/api/growth-radar/v2/configuration" });
    assert.equal(configuration.status, 200);
    assert.equal(configuration.body.configuration.knownWarehouses.length, 1);

    const country = await invoke(api, {
      method: "PUT",
      pathname: "/api/growth-radar/v2/configuration/country-mappings",
      body: {
        description: "API 国家映射",
        mappings: [{
          sourceWarehouseName: "泰国仓",
          normalizedWarehouseName: "WH-A",
          mappingStatus: "confirmed",
          countryCode: "TH",
          countryName: "泰国",
        }],
      },
    });
    assert.equal(country.status, 201);
    assert.equal(country.body.mappings[0].countryCode, "TH");

    const rules = await invoke(api, {
      method: "PUT",
      pathname: "/api/growth-radar/v2/configuration/rules",
      body: {
        sourceHighPercentile: 0.82,
        storeLowRatioPercentile: 0.1,
        minimumComparisonSize: 30,
        newDays: 90,
        slowAttentionDays: 60,
        slowHighDays: 90,
        slowCriticalDays: 180,
        lowStockWarningDays: 14,
        lowStockHighDays: 7,
      },
    });
    assert.equal(rules.status, 201);
    assert.equal(rules.body.ruleSet.parameters.thresholds.assortment.highPercentile, 0.82);
    assert.equal(rules.body.ruleSet.parameters.thresholds.capture.lowRatio, 0.1);

    const reused = await invoke(api, { method: "POST", pathname: "/api/growth-radar/v2/analysis-runs" });
    assert.equal(reused.status, 201);
    assert.equal(reused.body.reused, false);
  } finally {
    await context.close();
  }
});
