import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { GrowthRadarService } from "../lib/growth-radar/growth-radar-service.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { SalesAssortmentService } from "../lib/sales-assortment/sales-assortment-service.mjs";

const root = path.resolve(".");
const python = resolvePythonRuntime({ appRoot: root, requiredModules: ["openpyxl"] });

function repositoryFixture() {
  return {
    sourceStatus: async () => ({
      order: { row_count: 2, collected_at: "2026-07-30T00:00:00Z" },
      inventory: { row_count: 1, collected_at: "2026-07-30T00:00:00Z" },
      productPackage: { row_count: 1, source_period: "202607" },
    }),
    warehouseMappings: async () => [],
    productPackageRows: async () => [{
      country_normalized: "泰国",
      sku_normalized: "SKU-1",
      warehouse_normalized: "泰国A仓",
      normalized_payload_json: JSON.stringify({
        product_name: "测试产品",
        category_l1: "家居",
        category_l2: "收纳",
        style_name: "测试款",
        main_sku_code: "MAIN-1",
        cost_cny: 10,
        cost_local: 50,
        exchange_rate: 5,
        price_tier_45: 100,
      }),
    }],
    latestInventoryRows: async () => ({
      batch: { id: "inventory-1" },
      rows: [{
        normalized_source_sku: "SKU-1",
        normalized_warehouse_name: "泰国A仓",
        source_visible_sales_7d: 10,
        source_visible_sales_28d: 40,
        source_visible_sales_42d: 60,
        source_predicted_daily_sales: 2,
        available_quantity: 100,
        in_transit_quantity: 20,
        product_status: "正常销售",
        category_level_1: "家居",
        category_level_2: "收纳",
        raw_values_json: JSON.stringify({
          中文名称: "测试产品",
          活跃度: "旺款",
          是否新款: "是",
          当前可售天数: 50,
        }),
      }],
    }),
    currentOrderRows: async () => [{
      normalized_source_sku: "SKU-1",
      normalized_source_warehouse_name: "泰国A仓",
      quantity: 2,
      product_name: "测试产品",
      paid_at: "2026-07-30 10:00:00",
      platform: "shopee",
      source_shop_name: "测试店",
      raw_values_json: JSON.stringify({ 店长: "张三" }),
    }],
  };
}

test("sales assortment dashboard compares assortment and own sales with one standard CNY price", async () => {
  const dashboard = await new SalesAssortmentService({
    repository: repositoryFixture(),
  }).dashboard({ periodDays: 7 });

  assert.equal(dashboard.summary.assortmentQuantity, 10);
  assert.equal(dashboard.summary.assortmentAmount, 200);
  assert.equal(dashboard.summary.ownQuantity, 2);
  assert.equal(dashboard.summary.ownAmount, 40);
  assert.equal(dashboard.summary.ownShare, 20);
  assert.equal(dashboard.topProducts[0].productName, "测试产品");
  assert.equal(dashboard.stores[0].manager, "张三");
  assert.equal(dashboard.contract.aggregationKey, "国家 + 商品中文名称");
  assert.equal(
    dashboard.contract.amountBasis,
    "产品包4档价(45%)按同行人民币/国家币成本关系折算",
  );
});

test("growth radar import accepts large legitimate worksheets without relaxing other workbook gates", () => {
  const service = new GrowthRadarService({
    repository: {},
    pythonExecutable: "python",
    parserScript: "unused-parser.py",
    fileStorageConfig: {
      tempRoot: os.tmpdir(),
      workbookLimits: {
        maxEntryBytes: 64 * 1024 * 1024,
        maxUncompressedBytes: 200 * 1024 * 1024,
        maxCompressionRatio: 200,
      },
    },
  });

  assert.equal(service.fileStorageConfig.workbookLimits.maxEntryBytes, 128 * 1024 * 1024);
  assert.equal(service.fileStorageConfig.workbookLimits.maxUncompressedBytes, 200 * 1024 * 1024);
  assert.equal(service.fileStorageConfig.workbookLimits.maxCompressionRatio, 200);
});

test("order parser inherits only common fields for multiline order rows and keeps manager", async (t) => {
  if (!python.ok) return t.skip("openpyxl runtime unavailable");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sales-assortment-parser-"));
  const workbookPath = path.join(directory, "orders.xlsx");
  try {
    const create = [
      "from openpyxl import Workbook",
      "import sys",
      "wb=Workbook(); ws=wb.active; ws.title='订单明细'",
      "ws.append(['订单编号','交易编号','店铺名','平台','店长','订单状态','仓库','SKU','商品数量','商品中文名称','付款时间','订单核算金额（人民币）'])",
      "ws.append(['O-1','T-1','店铺A','Shopee','张三','已发货','泰国A仓','SKU-1',1,'产品A','2026-07-30 10:00:00',100])",
      "ws.append([None,None,None,None,None,None,'泰国A仓','SKU-2',2,'产品B',None,None])",
      "wb.save(sys.argv[1])",
    ].join(";");
    const created = spawnSync(python.executable, ["-c", create, workbookPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(created.status, 0, created.stderr);

    const parsed = spawnSync(python.executable, [
      path.join(root, "scripts", "growth-radar-parser.py"),
      workbookPath,
      "--domain",
      "order",
    ], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    const result = JSON.parse(parsed.stdout);
    assert.equal(result.rows[1].parseStatus, "parsed");
    assert.equal(result.rows[1].rawPayload["订单编号"], "O-1");
    assert.equal(result.rows[1].rawPayload["店长"], "张三");
    assert.equal(result.rows[1].rawTypes["订单编号"], "inherited");
    assert.equal(result.rows[1].rawPayload["订单核算金额（人民币）"], null);
    assert.equal(result.redactedHeaders.includes("店长"), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("sales assortment frontend stays an isolated React island in the unified shell", async () => {
  const [html, app, loader, packageJson] = await Promise.all([
    fs.readFile(path.join(root, "public", "index.html"), "utf8"),
    fs.readFile(path.join(root, "public", "app.js"), "utf8"),
    fs.readFile(path.join(root, "public", "sales-assortment-dashboard-loader.mjs"), "utf8"),
    fs.readFile(path.join(root, "frontend", "sales-assortment-dashboard", "package.json"), "utf8"),
  ]);
  assert.match(html, /data-page="sales-assortment"/);
  assert.match(html, /id="salesAssortmentDashboardRoot"/);
  assert.match(app, /createSalesAssortmentDashboard/);
  assert.match(loader, /mountSalesAssortmentDashboard/);
  assert.match(packageJson, /"echarts"/);
  assert.doesNotMatch(loader, /iframe/i);
});
