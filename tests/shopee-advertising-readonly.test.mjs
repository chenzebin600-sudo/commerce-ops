import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { ShopeeAdvertisingService, parseShopeeAdvertisingCsv } from "../lib/advertising/shopee-advertising-service.mjs";
import { createShopeeAdvertisingApi } from "../lib/advertising/shopee-advertising-api.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const headers = [
  "Sequence", "Ad Name", "Status", "Ads Type", "Product ID", "Creative", "Bidding Method", "Placement",
  "Start Date", "End Date", "Impression", "Clicks", "CTR", "Add to Cart", "Add to Cart Rate", "Conversions",
  "Direct Conversions", "Conversion Rate", "Direct Conversion Rate", "Cost per Conversion", "Cost per Direct Conversion",
  "Items Sold", "Direct Items Sold", "GMV", "Direct GMV", "Expense", "ROAS", "Direct ROAS", "ACOS", "Direct ACOS",
  "Product Impressions", "Product Clicks", "Product CTR", "Voucher Amount", "Vouchered Sales",
];

function csvCell(value) {
  const result = String(value ?? "");
  return /[",\r\n]/.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
}

function adRow({
  sequence, adName, productId, biddingMethod = "GMV Max Custom ROAS", startDate = "01/07/2026",
  impression, clicks, conversions, gmv, expense,
}) {
  const values = {
    Sequence: sequence, "Ad Name": adName, Status: "Ongoing", "Ads Type": "Product Ad", "Product ID": productId,
    "Bidding Method": biddingMethod, Placement: "All", "Start Date": startDate, Impression: impression, Clicks: clicks,
    CTR: impression ? `${((clicks / impression) * 100).toFixed(2)}%` : "0%", Conversions: conversions,
    "Conversion Rate": clicks ? `${((conversions / clicks) * 100).toFixed(2)}%` : "0%", "Items Sold": conversions,
    GMV: gmv, Expense: expense, ROAS: expense ? gmv / expense : 0,
  };
  return headers.map((header) => csvCell(values[header])).join(",");
}

function csv({ from, to, rows }) {
  return [
    "All CPC Ads Report - Shopee Indonesia",
    "User Name,readonly-user",
    "Shop Name,jojo mall",
    "Shop ID,1379379507",
    "Report Creation Time,04/08/2026 15:20",
    `Date Period,${from} - ${to}`,
    "",
    headers.join(","),
    ...rows.map(adRow),
  ].join("\n");
}

function openService() {
  const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), "shopee-ad-readonly-"));
  const access = openCommerceDataAccess({ rootDir, databasePath: path.join(runtimeRoot, "ads.sqlite") });
  return { access, service: new ShopeeAdvertisingService({ repository: access.repositories.shopeeAdvertising }) };
}

const matureLowEfficiency = {
  sequence: 1, adName: "Meja TV Kayu", productId: "26416704840", startDate: "01/07/2026",
  impression: 5000, clicks: 150, conversions: 3, gmv: 900000, expense: 100000,
};

test("Shopee CSV parser preserves period, start date, metrics, and stable ad identity", () => {
  const parsed = parseShopeeAdvertisingCsv(csv({
    from: "03/08/2026", to: "03/08/2026",
    rows: [
      { sequence: 1, adName: "会议桌", productId: "-", impression: 100, clicks: 4, conversions: 0, gmv: 0, expense: 14931 },
      { ...matureLowEfficiency, sequence: 2, clicks: 18, conversions: 2, gmv: 760000, expense: 113490 },
    ],
  }), { filename: "daily.csv" });
  assert.equal(parsed.batch.shopId, "1379379507");
  assert.equal(parsed.batch.periodDays, 1);
  assert.equal(parsed.facts[0].adKey.startsWith("name:"), true);
  assert.equal(parsed.facts[1].adKey, "product:26416704840");
  assert.equal(parsed.facts[1].startDate, "2026-07-01");
  assert.equal(parsed.facts[1].clicks, 18);
});

test("day and 7-day reports remain directional evidence when exact 14-day evidence is missing", () => {
  const { access, service } = openService();
  try {
    service.importCsv({ filename: "seven.csv", csvText: csv({ from: "29/07/2026", to: "04/08/2026", rows: [matureLowEfficiency] }) });
    service.importCsv({ filename: "day.csv", csvText: csv({ from: "03/08/2026", to: "03/08/2026", rows: [{ ...matureLowEfficiency, clicks: 12 }] }) });
    service.saveTargets({
      shopId: "1379379507", effectiveFrom: "2026-08-04", sourceType: "screenshot",
      targets: [{ adName: matureLowEfficiency.adName, productId: matureLowEfficiency.productId, targetRoas: 17.1 }],
    });
    const dashboard = service.dashboard({ shopId: "1379379507" });
    assert.equal(dashboard.evidenceReady, false);
    assert.equal(dashboard.coverage.seven, true);
    assert.equal(dashboard.coverage.fourteen, false);
    assert.equal(dashboard.summary.p0Count, 0);
    assert.equal(dashboard.summary.p1Count, 0);
    assert.equal(dashboard.summary.waitingCount, 1);
    assert.equal(dashboard.rows[0].ruleCode, "needs_14d_evidence");
  } finally {
    access.close();
  }
});

test("mature 14-day evidence diagnoses efficiency below target and compares the previous window", () => {
  const { access, service } = openService();
  try {
    service.importCsv({ filename: "previous-14.csv", csvText: csv({
      from: "07/07/2026", to: "20/07/2026", rows: [{ ...matureLowEfficiency, gmv: 1200000, expense: 100000 }],
    }) });
    service.importCsv({ filename: "current-14.csv", csvText: csv({
      from: "21/07/2026", to: "03/08/2026", rows: [matureLowEfficiency],
    }) });
    service.saveTargets({
      shopId: "1379379507", effectiveFrom: "2026-08-03",
      targets: [{ adName: matureLowEfficiency.adName, productId: matureLowEfficiency.productId, targetRoas: 17.1 }],
    });
    const dashboard = service.dashboard({ shopId: "1379379507" });
    assert.equal(dashboard.evidenceReady, true);
    assert.equal(dashboard.summary.matureCount, 1);
    assert.equal(dashboard.summary.p1Count, 1);
    assert.equal(dashboard.rows[0].ruleCode, "efficiency_below_target");
    assert.equal(dashboard.rows[0].targetAttainment, 52.6);
    assert.equal(dashboard.rows[0].fourteenTrend, -25);
    assert.equal(dashboard.rows[0].detail.campaignType, "individual");
    assert.equal(dashboard.rows[0].detail.stage, "mature");
    assert.equal(dashboard.rows[0].detail.bottleneck, "成熟样本下效率低于目标");
    assert.ok(dashboard.rows[0].detail.evidence.some((item) => item.includes("150 次点击")));
    assert.ok(dashboard.rows[0].detail.actionSteps.length >= 4);
    assert.ok(dashboard.rows[0].detail.missingData.includes("商品毛利与盈亏ROAS"));
  } finally {
    access.close();
  }
});

test("fewer than 100 clicks stays in observation instead of becoming a performance verdict", () => {
  const { access, service } = openService();
  try {
    service.importCsv({ filename: "current-14.csv", csvText: csv({
      from: "21/07/2026", to: "03/08/2026", rows: [{ ...matureLowEfficiency, clicks: 70, conversions: 1, gmv: 300000 }],
    }) });
    service.saveTargets({
      shopId: "1379379507", effectiveFrom: "2026-08-03",
      targets: [{ adName: matureLowEfficiency.adName, productId: matureLowEfficiency.productId, targetRoas: 17.1 }],
    });
    const dashboard = service.dashboard({ shopId: "1379379507" });
    assert.equal(dashboard.summary.insufficientCount, 1);
    assert.equal(dashboard.rows[0].priority, "WAITING");
    assert.equal(dashboard.rows[0].ruleCode, "sample_insufficient");
  } finally {
    access.close();
  }
});

test("an imported batch can be deleted precisely and re-imported without removing target ROAS", () => {
  const { access, service } = openService();
  try {
    const source = csv({ from: "21/07/2026", to: "03/08/2026", rows: [matureLowEfficiency] });
    const imported = service.importCsv({ filename: "wrong-14.csv", csvText: source });
    service.saveTargets({
      shopId: "1379379507", effectiveFrom: "2026-08-03",
      targets: [{ adName: matureLowEfficiency.adName, productId: matureLowEfficiency.productId, targetRoas: 17.1 }],
    });

    const deleted = service.deleteBatch(imported.batch.id);
    assert.equal(deleted.batch.originalFilename, "wrong-14.csv");
    assert.equal(deleted.deletedFacts, 1);
    assert.equal(service.dashboard({ shopId: "1379379507" }).empty, true);
    assert.throws(() => service.deleteBatch(imported.batch.id), (error) => error.code === "ADS_BATCH_NOT_FOUND" && error.status === 404);
    assert.throws(() => service.deleteBatch("not-a-batch"), (error) => error.code === "ADS_BATCH_ID_INVALID" && error.status === 400);

    const reimported = service.importCsv({ filename: "corrected-14.csv", csvText: source });
    assert.equal(reimported.duplicate, false);
    const dashboard = service.dashboard({ shopId: "1379379507" });
    assert.equal(dashboard.targets.length, 1);
    assert.equal(dashboard.summary.targetCoverage, 100);
  } finally {
    access.close();
  }
});

test("batch deletion API returns the deleted scope and records bounded audit metadata", async () => {
  const deleted = { batch: { id: "8f87553e-2bc1-4c8d-8537-73868cf08359", shopId: "1379379507" }, deletedFacts: 19 };
  let requestedId = "";
  let auditMetadata = null;
  const handler = createShopeeAdvertisingApi({ service: { deleteBatch(id) { requestedId = id; return deleted; } } });
  const request = Readable.from([]);
  request.method = "DELETE";
  request.headers = {};
  request.auditContext = { annotate(value) { auditMetadata = value.metadata; } };
  const response = {
    status: 0, headers: {}, body: "",
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = Buffer.from(body).toString("utf8"); },
  };

  const handled = await handler(request, response, new URL(`http://localhost/api/shopee-advertising/batches/${deleted.batch.id}`));
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(requestedId, deleted.batch.id);
  assert.equal(JSON.parse(response.body).deletedFacts, 19);
  assert.deepEqual(auditMetadata, { platform: "shopee", batchId: deleted.batch.id, shopId: "1379379507", deletedFacts: 19 });
});

test("advertising page batches up to 30 CSV files with progress and partial-failure reporting", () => {
  const page = readFileSync(path.join(rootDir, "frontend", "commerce-ops-vue", "src", "pages", "AdvertisingPage.vue"), "utf8");
  assert.match(page, /type="file"[^>]+multiple/);
  assert.match(page, /selectedFiles\.length > 30/);
  assert.match(page, /for \(let index = 0; index < selectedFiles\.length/);
  assert.match(page, /duplicateCount \+= 1/);
  assert.match(page, /failures\.push/);
  assert.match(page, /批量导入完成/);
  assert.match(page, /@dragenter\.prevent="onDragEnter"/);
  assert.match(page, /@drop\.prevent="onFilesDropped"/);
  assert.match(page, /dataTransfer\?\.files/);
  assert.match(page, /@keydown\.space\.prevent="openFilePicker"/);
});
