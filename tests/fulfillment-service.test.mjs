import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { FulfillmentRepository } from "../fulfillment-service/repository.mjs";
import { FulfillmentService } from "../fulfillment-service/service.mjs";
import { createApiDocsHtml } from "../fulfillment-service/api-docs.mjs";
import { createMabangFulfillmentExecutor, createMabangFulfillmentPreflight, createMabangFulfillmentScanSource, createMabangFulfillmentSource } from "../fulfillment-service/mabang-source.mjs";
import { FulfillmentPreviewScheduler } from "../fulfillment-service/scheduler.mjs";
import { createWindowsNotifier } from "../fulfillment-service/notifier.mjs";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";
import { createFulfillmentDashboardProxy } from "../lib/fulfillment-dashboard-proxy.mjs";

const config = Object.freeze({ shopName:"JOJO Mall",shopId:"2021485965",platform:"Shopee",platformId:"17",countryCode:"ID",
  pendingStatus:"待处理",pendingStatusId:"2",channelId:"1143663",channelProviderId:"1023359",channelName:"ID J&T",maxBatchSize:10,
  previewTtlSeconds:600,realSubmitEnabled:false });
const order = { 订单编号:"M-1",交易编号:"S-1",店铺名:"JOJO Mall",订单状态:"待处理",仓库:"印尼泗水环亚-AD仓-1308",SKU:"SKU-1",商品数量:1,商品库存:10 };

function proxyResponse() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body || ""; },
  };
}

test("fulfillment dashboard proxy permits only fixed local read routes", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ success:true,data:[] }), { status:200 });
  }});
  const response = proxyResponse();
  const dashboardResponse = proxyResponse();
  assert.equal(await proxy({ method:"GET" }, dashboardResponse, new URL("http://localhost/api/fulfillment-dashboard/dashboard?days=999")), true);
  assert.equal(calls[0].url, "http://127.0.0.1:3112/api/fulfillment/dashboard?days=30");
  assert.equal(await proxy({ method:"GET" }, response, new URL("http://localhost/api/fulfillment-dashboard/batches?limit=999")), true);
  assert.equal(calls[1].url, "http://127.0.0.1:3112/api/fulfillment/batches?limit=50");
  assert.equal(calls[1].options.method, "GET");
  const recoveryResponse = proxyResponse();
  assert.equal(await proxy({ method:"GET" }, recoveryResponse, new URL("http://localhost/api/fulfillment-dashboard/tracking-recoveries?limit=999")), true);
  assert.equal(calls[2].url, "http://127.0.0.1:3112/api/fulfillment/tracking-recoveries?limit=100");
  const rejected = proxyResponse();
  assert.equal(await proxy({ method:"POST" }, rejected, new URL("http://localhost/api/fulfillment-dashboard/previews/abc")), true);
  assert.equal(rejected.status, 404);
  assert.equal(calls.length, 3);
});

test("fulfillment dashboard summary uses full database history and groups shops, trends and queues", () => {
  const repository = new FulfillmentRepository();
  const addPreview = repository.db.prepare(`INSERT INTO fulfillment_previews
    (id,status,shop_id,shop_name,channel_id,channel_name,confirmation_hash,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  addPreview.run("p1","confirmed","s1","JOJO Mall","c1","J&T","h","2026-07-30T00:00:00.000Z","2026-07-29T01:00:00.000Z");
  addPreview.run("p2","confirmed","s2","Arca Woods","c1","J&T","h","2026-07-30T00:00:00.000Z","2026-07-28T01:00:00.000Z");
  repository.db.prepare(`INSERT INTO fulfillment_preview_orders
    (preview_id,order_key,display_order_id,warehouse,sku_count,eligible,exclusion_json,snapshot_json,priority)
    VALUES ('p1','s1:excluded','EX-1','W1',1,0,'["OUT_OF_STOCK"]','{}',0)`).run();
  repository.db.prepare("INSERT INTO fulfillment_batches (id,preview_id,status,created_at,finished_at) VALUES (?,?,?,?,?)")
    .run("b1","p1","partial_success","2026-07-29T02:00:00.000Z","2026-07-29T02:10:00.000Z");
  repository.db.prepare("INSERT INTO fulfillment_batches (id,preview_id,status,created_at,finished_at) VALUES (?,?,?,?,?)")
    .run("b2","p2","success","2026-07-28T02:00:00.000Z","2026-07-28T02:10:00.000Z");
  const addOrder = repository.db.prepare(`INSERT INTO fulfillment_batch_orders
    (batch_id,order_key,display_order_id,status,error_code,timings_json,updated_at) VALUES (?,?,?,?,?,?,?)`);
  addOrder.run("b1","s1:o1","O1","success",null,'{"total":1000,"trackingWait":600}',"2026-07-29T02:05:00.000Z");
  addOrder.run("b1","s1:o2","O2","needs_attention","MULTI_WAREHOUSE_REQUIRES_REVIEW",null,"2026-07-29T02:06:00.000Z");
  addOrder.run("b2","s2:o3","O3","success",null,'{"total":800,"trackingWait":500}',"2026-07-28T02:05:00.000Z");
  repository.db.prepare("INSERT INTO fulfillment_idempotency (order_key,batch_id,status,completed_at) VALUES ('s1:o2','b1','needs_attention','2026-07-29T02:06:00.000Z')").run();
  repository.db.prepare(`INSERT INTO fulfillment_tracking_recoveries
    (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at)
    VALUES ('s1:o4','b1','O4','s1','waiting_tracking','2026-07-29T02:00:00.000Z','2026-07-29T02:05:00.000Z','2026-07-30T02:00:00.000Z')`).run();
  const summary = repository.getDashboardSummary({
    todayStartIso:"2026-07-28T16:00:00.000Z", trendStartIso:"2026-07-27T16:00:00.000Z", endIso:"2026-07-29T08:00:00.000Z",
    dayWindows:[
      { date:"2026-07-28",fromIso:"2026-07-27T16:00:00.000Z",toIso:"2026-07-28T16:00:00.000Z" },
      { date:"2026-07-29",fromIso:"2026-07-28T16:00:00.000Z",toIso:"2026-07-29T16:00:00.000Z" },
    ],
  });
  assert.deepEqual(summary.shops.map((shop) => [shop.shopId,shop.total,shop.success,shop.exceptions]), [["s1",2,1,1]]);
  assert.deepEqual(summary.trend.map((day) => [day.date,day.total,day.success,day.exceptions]),
    [["2026-07-28",1,1,0],["2026-07-29",2,1,1]]);
  assert.equal(summary.exceptions.find((item) => item.code === "OUT_OF_STOCK").count, 1);
  assert.equal(summary.exceptions.find((item) => item.code === "MULTI_WAREHOUSE_REQUIRES_REVIEW").count, 1);
  assert.deepEqual(summary.queues.tracking, [{ shopId:"s1",status:"waiting_tracking",count:1 }]);
  assert.deepEqual(summary.queues.manual, [{ shopId:"s1",count:1 }]);
  repository.close();
});

test("fulfillment dashboard proxy forwards only validated manual review fields", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl:async(url,options)=>{
    calls.push({ url:String(url),options });
    return new Response(JSON.stringify({ success:true,data:{ released:true } }), { status:200 });
  } });
  const req = Readable.from([JSON.stringify({ shopId:"2021485965",orderId:"260728TQYWBBTD",unexpected:"drop-me" })]);
  req.method = "POST";
  const response = proxyResponse();
  assert.equal(await proxy(req,response,new URL("http://localhost/api/fulfillment-dashboard/manual-reviews/recheck")), true);
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "http://127.0.0.1:3112/api/fulfillment/manual-reviews/recheck");
  assert.deepEqual(JSON.parse(calls[0].options.body), { shopId:"2021485965",orderId:"260728TQYWBBTD" });

  const invalidReq = Readable.from([JSON.stringify({ shopId:"../../bad",orderId:"x" })]);
  invalidReq.method = "POST";
  const invalidResponse = proxyResponse();
  assert.equal(await proxy(invalidReq,invalidResponse,new URL("http://localhost/api/fulfillment-dashboard/manual-reviews/recheck")), true);
  assert.equal(invalidResponse.status, 400);
  assert.equal(calls.length, 1);
});

test("production fulfillment configuration contains all five Indonesian Shopee shops", () => {
  const resolved = resolveFulfillmentConfig({ rootDir:process.cwd(),env:{} });
  assert.deepEqual(resolved.shops.map((shop) => shop.shopId), ["2021578358","2021640336","2021485965","2021621760","2021557966"]);
  assert.equal(resolved.shops.every((shop) => shop.platformId === "17" && shop.countryCode === "ID"), true);
  assert.equal(new Set(resolved.shops.map((shop) => shop.channelId)).size, 1);
  assert.equal(resolved.autoFulfillEnabled, false);
  assert.equal(resolved.orderConcurrency, 1);
  assert.equal(resolved.trackingRecoveryResetEnabled, false);
  assert.equal(resolved.shops.every((shop) => shop.autoFulfillEnabled === false), true);
});

test("automatic fulfillment is opt-in and limited to explicitly configured shops", () => {
  const resolved = resolveFulfillmentConfig({ rootDir:process.cwd(),env:{
    FULFILLMENT_AUTO_FULFILL_ENABLED:"true",
    FULFILLMENT_AUTO_FULFILL_SHOP_IDS:"2021578358,2021485965,2021557966",
    FULFILLMENT_ORDER_CONCURRENCY:"2",
  }});
  assert.deepEqual(resolved.shops.filter((shop) => shop.autoFulfillEnabled).map((shop) => shop.shopId),
    ["2021578358","2021485965","2021557966"]);
  assert.equal(resolved.shops.find((shop) => shop.shopId === "2021640336").autoFulfillEnabled, false);
  assert.equal(resolved.shops.find((shop) => shop.shopId === "2021621760").autoFulfillEnabled, false);
  assert.equal(resolved.orderConcurrency, 2);
});

test("fulfillment order concurrency cannot be configured above two", () => {
  assert.throws(() => resolveFulfillmentConfig({ rootDir:process.cwd(),env:{
    FULFILLMENT_ORDER_CONCURRENCY:"3",
  }}), /1-2/);
});

test("fulfillment shop catalog fails closed on duplicate stable shop ids", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fulfillment-shop-config-"));
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "fulfillment-shops.json"), "utf8"));
    catalog.shops[1].shopId = catalog.shops[0].shopId;
    const catalogPath = path.join(tempDir, "shops.json");
    fs.writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
    assert.throws(() => resolveFulfillmentConfig({ rootDir:process.cwd(),env:{
      FULFILLMENT_SHOP_CONFIG_PATH:catalogPath,
    } }), /店铺 ID 重复/);
  } finally {
    fs.rmSync(tempDir, { recursive:true, force:true });
  }
});

test("tracking recovery waits, resets only once, then distributes an existing tracking number", async () => {
  let currentMs = Date.parse("2026-07-29T00:00:00.000Z");
  const now = () => new Date(currentMs);
  const recoveryConfig = { ...config, realSubmitEnabled:true, trackingRecoveryCheckSeconds:60,
    trackingRecoveryResetMinutes:30, trackingRecoveryDeadlineHours:24, trackingRecoveryResetEnabled:false, orderConcurrency:1 };
  const repository = new FulfillmentRepository();
  let trackingNumber = "";
  let resetCalls = 0;
  let resubmitCalls = 0;
  let shippingRecordPending = true;
  let distributeCalls = 0;
  const source = { listPending:async()=>[order], getByIds:async()=>[order] };
  const executor = { fulfill:async()=>({ verified:false, trackingNumber:"", afterStatus:"待处理",
    errorCode:"TRACKING_NUMBER_PENDING", errorMessage:"审批中", timings:{ submitRequest:10, distributionRequest:0 } }) };
  const trackingRecovery = {
    inspect:async()=>({ trackingNumber, orderStatus:"待处理", shippingRecordPending }),
    resetPending:async()=>{ resetCalls += 1; shippingRecordPending = false; },
    resubmitPending:async()=>{ resubmitCalls += 1; shippingRecordPending = true;
      return { submitted:true, verified:false, trackingNumber:"", afterStatus:"待处理" }; },
    distribute:async(_orderId, value)=>{ distributeCalls += 1; return { verified:true, trackingNumber:value, afterStatus:"配货中" }; },
  };
  const service = new FulfillmentService({ config:recoveryConfig, repository, source, executor, trackingRecovery, now });
  const preview = await service.createPreview();
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.orders[0].errorCode, "TRACKING_NUMBER_PENDING");
  assert.equal(repository.listTrackingRecoveries(10, config.shopId)[0].resetCount, 0);

  currentMs += 2 * 60000;
  assert.equal((await service.recoverPendingTrackingNumbers()).results[0].status, "waiting_tracking");
  currentMs += 29 * 60000;
  assert.equal((await service.recoverPendingTrackingNumbers({ allowReset:true })).results[0].status, "channel_cleared_once");
  assert.equal(resetCalls, 1);
  currentMs += 2 * 60000;
  assert.equal((await service.recoverPendingTrackingNumbers({ allowReset:true })).results[0].status, "resubmitted_once");
  assert.equal(resubmitCalls, 1);
  currentMs += 2 * 60000;
  assert.equal((await service.recoverPendingTrackingNumbers()).results[0].status, "waiting_tracking");
  assert.equal(resetCalls, 1);
  assert.equal(resubmitCalls, 1);

  trackingNumber = "201672570083";
  currentMs += 2 * 60000;
  const completed = await service.recoverPendingTrackingNumbers();
  assert.equal(completed.results[0].status, "completed");
  assert.equal(completed.results[0].trackingNumberMasked, "2016****0083");
  assert.equal(distributeCalls, 1);
  assert.equal(service.getBatch(batch.id).orders[0].status, "success");
  assert.equal(repository.listTrackingRecoveries(10, config.shopId)[0].status, "completed");
  repository.close();
});

test("tracking recovery stops automatically after its 24-hour deadline", async () => {
  const repository = new FulfillmentRepository();
  const submittedAt = "2026-07-28T00:00:00.000Z";
  repository.registerTrackingRecovery({ orderKey:"2021485965:late", batchId:"missing-batch", displayOrderId:"LATE-1",
    shopId:config.shopId, submittedAt, nextCheckAt:submittedAt, deadlineAt:"2026-07-29T00:00:00.000Z" });
  const service = new FulfillmentService({ config:{ ...config,trackingRecoveryCheckSeconds:60,trackingRecoveryResetMinutes:30,
    trackingRecoveryDeadlineHours:24 }, repository, source:{}, executor:{}, trackingRecovery:{ inspect:async()=>{ throw new Error("must not inspect"); } },
    now:()=>new Date("2026-07-29T00:00:01.000Z") });
  const result = await service.recoverPendingTrackingNumbers();
  assert.deepEqual(result.results, [{ orderId:"LATE-1", status:"manual_attention", errorCode:"TRACKING_APPROVAL_TIMEOUT" }]);
  assert.equal(repository.listTrackingRecoveries(10, config.shopId)[0].status, "manual_attention");
  repository.close();
});

test("tracking recovery can be restricted to one explicit order", () => {
  const repository = new FulfillmentRepository();
  const dueAt = "2026-07-29T00:00:00.000Z";
  for (const orderId of ["ONLY-1", "OTHER-2"]) repository.registerTrackingRecovery({
    orderKey:`${config.shopId}:${orderId}`, batchId:`batch-${orderId}`, displayOrderId:orderId,
    shopId:config.shopId, submittedAt:dueAt, nextCheckAt:dueAt, deadlineAt:"2026-07-30T00:00:00.000Z",
  });
  const due = repository.listDueTrackingRecoveries(dueAt, 5, config.shopId, "ONLY-1");
  assert.deepEqual(due.map((item) => item.displayOrderId), ["ONLY-1"]);
  const beforeScheduledTime = repository.listDueTrackingRecoveries("2026-07-28T00:00:00.000Z", 5, config.shopId, "ONLY-1");
  assert.deepEqual(beforeScheduledTime.map((item) => item.displayOrderId), ["ONLY-1"]);
  repository.close();
});

test("fulfillment preview is limited, sanitized and requires confirmation", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending: async () => [order, { ...order, 订单编号:"M-2",交易编号:"S-2",仓库:"" }] };
  const service = new FulfillmentService({ config, repository, source, executor:{} });
  const preview = await service.createPreview({ limit:10 });
  assert.equal(preview.eligibleOrders.length, 1);
  assert.equal(preview.excludedOrders[0].exclusions.includes("MISSING_WAREHOUSE"), true);
  assert.equal(preview.requiresConfirmation, true);
  assert.ok(preview.confirmationToken);
  assert.equal(JSON.stringify(preview).includes("SKU-1"), false);
  repository.close();
});

test("real submission is disabled by default", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending: async () => [order] };
  const service = new FulfillmentService({ config, repository, source, executor:{} });
  const preview = await service.createPreview();
  await assert.rejects(service.confirmPreview(preview.previewId, preview.confirmationToken), { code:"REAL_SUBMIT_DISABLED" });
  repository.close();
});

test("preview enforces ten-order maximum", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config, repository, source:{ listPending:async()=>[] }, executor:{} });
  await assert.rejects(service.createPreview({ limit:11 }), { code:"INVALID_LIMIT" });
  repository.close();
});

test("preview exposes inventory and rejects out-of-stock orders", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending: async () => [
    { ...order, 订单编号:"M-STOCK",交易编号:"S-STOCK",商品数量:2,商品库存:3 },
    { ...order, 订单编号:"M-OOS",交易编号:"S-OOS",商品数量:2,商品库存:1 },
    { ...order, 订单编号:"M-UNKNOWN",交易编号:"S-UNKNOWN",商品库存:"" },
  ] };
  const service = new FulfillmentService({ config, repository, source, executor:{} });
  const preview = await service.createPreview();
  assert.deepEqual(preview.eligibleOrders[0], {
    displayOrderId:"S-STOCK", tradeNumber:"S-STOCK", warehouse:"印尼泗水环亚-AD仓-1308",
    warehouses:["印尼泗水环亚-AD仓-1308"], skuCount:1,
    stockStatus:"in_stock", isOutOfStock:false, requiredQuantity:2, totalItemQuantity:2, availableQuantity:3,
    outOfStockItemCount:0, unknownStockItemCount:0, eligible:true, exclusions:[],
  });
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-OOS").isOutOfStock, true);
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-OOS").exclusions.includes("OUT_OF_STOCK"), true);
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-UNKNOWN").stockStatus, "unknown");
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-UNKNOWN").exclusions.includes("INVENTORY_UNKNOWN"), true);
  repository.close();
});

test("shared scan records use the same shop and inventory safety rules as a normal preview", () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config,repository,source:{ listPending:async()=>{ throw new Error("not used"); } },executor:{} });
  const preview = service.createPreviewFromRecords([
    order,
    { ...order,订单编号:"M-2",交易编号:"S-2",商品库存:0 },
    { ...order,订单编号:"M-3",交易编号:"S-3",店铺名:"Toko Penguin" },
  ], { limit:10 });
  assert.deepEqual(preview.eligibleOrders.map((item) => item.displayOrderId), ["S-1"]);
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-2").exclusions.includes("OUT_OF_STOCK"), true);
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-3").exclusions.includes("SHOP_MISMATCH"), true);
  repository.close();
});

test("preview aggregates multiple SKU rows and blocks the whole order when one SKU is short", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending: async () => [
    { ...order, 订单编号:"M-MULTI",交易编号:"S-MULTI",SKU:"SKU-A",商品数量:2,商品库存:5 },
    { ...order, 订单编号:"M-MULTI",交易编号:"S-MULTI",SKU:"SKU-B",商品数量:3,商品库存:2 },
  ] };
  const service = new FulfillmentService({ config, repository, source, executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 0);
  assert.equal(preview.excludedOrders.length, 1);
  assert.equal(preview.excludedOrders[0].skuCount, 2);
  assert.equal(preview.excludedOrders[0].totalItemQuantity, 5);
  assert.equal(preview.excludedOrders[0].outOfStockItemCount, 1);
  assert.equal(preview.excludedOrders[0].stockStatus, "out_of_stock");
  assert.equal(preview.excludedOrders[0].exclusions.includes("OUT_OF_STOCK"), true);
  assert.equal(JSON.stringify(preview).includes("SKU-A"), false);
  repository.close();
});

test("preview detects one order split across multiple warehouses before submission", async () => {
  const repository = new FulfillmentRepository();
  const rows = [
    { ...order,SKU:"SKU-A",仓库:"印尼泗水云雀-A仓-1308",商品库存:10 },
    { ...order,SKU:"SKU-B",仓库:"印尼泗水环亚-AD仓-1308",商品库存:8 },
  ];
  const service = new FulfillmentService({ config,repository,source:{ listPending:async()=>rows },executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 0);
  assert.equal(preview.excludedOrders[0].exclusions.includes("MULTI_WAREHOUSE_REQUIRES_REVIEW"), true);
  assert.deepEqual(preview.excludedOrders[0].warehouses, ["印尼泗水云雀-A仓-1308","印尼泗水环亚-AD仓-1308"]);
  assert.equal(preview.excludedOrders[0].skuCount, 2);
  repository.close();
});

test("shop warehouse allowlist excludes an otherwise eligible order", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config:{ ...config,allowedWarehouses:["仅允许仓库"] }, repository,
    source:{ listPending:async()=>[order] }, executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 0);
  assert.equal(preview.excludedOrders[0].exclusions.includes("WAREHOUSE_NOT_ALLOWED"), true);
  repository.close();
});

test("preview can be locked to explicit order ids without substituting other orders", async () => {
  const repository = new FulfillmentRepository();
  let receivedOrderIds;
  const source = { listPending: async ({ orderIds }) => {
    receivedOrderIds = orderIds;
    return [order, { ...order, 订单编号:"M-OTHER",交易编号:"S-OTHER" }];
  } };
  const service = new FulfillmentService({ config, repository, source, executor:{} });
  const preview = await service.createPreview({ orderIds:["S-1", "S-MISSING"] });
  assert.deepEqual(receivedOrderIds, ["S-1", "S-MISSING"]);
  assert.deepEqual(preview.eligibleOrders.map((item) => item.displayOrderId), ["S-1"]);
  assert.equal(preview.excludedOrders[0].displayOrderId, "S-MISSING");
  assert.deepEqual(preview.excludedOrders[0].exclusions, ["ORDER_NOT_FOUND_OR_NOT_PENDING"]);
  assert.equal(preview.excludedOrders.some((item) => item.displayOrderId === "S-OTHER"), false);
  repository.close();
});

test("automatic preview prioritizes newest eligible orders without letting shortages consume the limit", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending:async()=>[
    { ...order,订单编号:"M-OLD",交易编号:"S-OLD",付款时间:"2026-07-25 10:00:00" },
    { ...order,订单编号:"M-NEW-OOS",交易编号:"S-NEW-OOS",商品库存:0,付款时间:"2026-07-28 12:00:00" },
    { ...order,订单编号:"M-MIDDLE",交易编号:"S-MIDDLE",付款时间:"2026-07-27 10:00:00" },
    { ...order,订单编号:"M-NEW",交易编号:"S-NEW",付款时间:"2026-07-28 11:00:00" },
  ] };
  const service = new FulfillmentService({ config,repository,source,executor:{} });
  const preview = await service.createPreview({ limit:2 });
  assert.deepEqual(preview.eligibleOrders.map((item)=>item.displayOrderId), ["S-NEW", "S-MIDDLE"]);
  assert.equal(preview.excludedOrders[0].displayOrderId, "S-NEW-OOS");
  repository.close();
});

test("explicit order preview validates the id list", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config, repository, source:{ listPending:async()=>[] }, executor:{} });
  await assert.rejects(service.createPreview({ orderIds:[] }), { code:"INVALID_ORDER_IDS" });
  await assert.rejects(service.createPreview({ orderIds:Array.from({ length:11 }, (_, index) => `S-${index}`) }), { code:"INVALID_ORDER_IDS" });
  repository.close();
});

test("interactive API documentation always contains valid browser JavaScript", () => {
  const html = createApiDocsHtml();
  assert.equal(html.includes("获取运单号 → 核对固定渠道 → 转入配货中"), true);
  assert.equal(html.includes("成功订单应显示“配货中”"), true);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test("real executor pins shop, channel and final confirmation in its worker request", async () => {
  let workerPayload;
  const executorConfig = { ...config, mabangUsername:"local-user", mabangPassword:"local-password",
    channelValue:"1143663_1023359_fixed_1591", channelSource:"1", verificationTimeoutSeconds:30 };
  const executor = createMabangFulfillmentExecutor({ config:executorConfig, rootDir:process.cwd(), runWorker:async (payload) => {
    workerPayload = payload;
    return { verified:true, trackingNumber:"TRACK-123", afterStatus:"配货中", channelVerified:true,
      timingsMs:{ prepare:120,submitRequest:80,trackingWait:3000,distributionRequest:70,distributionWait:3000,total:6270 } };
  } });
  const result = await executor.fulfill({
    order:{ tradeNumber:"S-1", warehouse:"印尼泗水云雀-A仓-1308", warehouses:["印尼泗水云雀-A仓-1308"],
      stockStatus:"in_stock",eligible:true,
      snapshot:{ sourceOrderId:"M-1", shopName:"JOJO Mall", orderStatus:"待处理", warehouses:["印尼泗水云雀-A仓-1308"] } },
    channel:{ id:"1143663", providerId:"1023359" },
  });
  assert.equal(workerPayload.action, "fulfillment-submit");
  assert.equal(workerPayload.commit, "FULFILLMENT_CONFIRMED");
  assert.equal(workerPayload.orderReference, "S-1");
  assert.equal(workerPayload.shopId, "2021485965");
  assert.equal(workerPayload.channelValue, "1143663_1023359_fixed_1591");
  assert.equal(workerPayload.singleWarehouseVerified, true);
  assert.equal(result.verified, true);
  assert.equal(result.trackingNumber, "TRACK-123");
  assert.equal(result.timings.trackingWait, 3000);
});

test("real executor rechecks the configured warehouse allowlist before worker submission", async () => {
  const executor = createMabangFulfillmentExecutor({ config:{ ...config,channelValue:"fixed",channelSource:"1",
    allowedWarehouses:["仅允许仓库"],verificationTimeoutSeconds:15 },rootDir:process.cwd(),
    runWorker:async()=>assert.fail("warehouse mismatch must stop before worker") });
  await assert.rejects(executor.fulfill({
    order:{ tradeNumber:"S-1",warehouse:"其他仓库",warehouses:["其他仓库"],stockStatus:"in_stock",eligible:true,
      snapshot:{ shopName:config.shopName,orderStatus:config.pendingStatus,sourceOrderId:"M-1",warehouses:["其他仓库"] } },
    channel:{ id:config.channelId,providerId:config.channelProviderId },
  }), { code:"WAREHOUSE_NOT_ALLOWED_BEFORE_SUBMIT" });
});

test("deep preflight uses a non-submit worker action and never sends a commit marker", async () => {
  let workerPayload;
  const preflightConfig = { ...config, mabangUsername:"local-user", mabangPassword:"local-password",
    channelValue:"1143663_1023359_fixed_1591" };
  const preflight = createMabangFulfillmentPreflight({ config:preflightConfig, rootDir:process.cwd(), runWorker:async (payload) => {
    workerPayload = payload;
    return { ready:true, wouldSubmit:false, platformOrderId:"S-1", orderStatus:"2", stockStatus:"in_stock",
      channelMatched:true, reportingSuccess:true, checks:["inventory","available_channel"] };
  } });
  const result = await preflight.run("S-1", { singleWarehouseVerified:true });
  assert.equal(workerPayload.action, "fulfillment-preflight");
  assert.equal(Object.hasOwn(workerPayload, "commit"), false);
  assert.equal(workerPayload.singleWarehouseVerified, true);
  assert.equal(result.ready, true);
  assert.equal(result.wouldSubmit, false);
});

test("real executor stops before the worker when order state or channel changes", async () => {
  let calls = 0;
  const executorConfig = { ...config, channelValue:"fixed", channelSource:"1", verificationTimeoutSeconds:30 };
  const executor = createMabangFulfillmentExecutor({ config:executorConfig, rootDir:process.cwd(), runWorker:async () => { calls += 1; } });
  await assert.rejects(executor.fulfill({ order:{ tradeNumber:"S-1", snapshot:{ shopName:"JOJO Mall", orderStatus:"已发货" } },
    channel:{ id:"1143663", providerId:"1023359" } }), { code:"PRE_SUBMIT_CHECK_FAILED" });
  await assert.rejects(executor.fulfill({ order:{ tradeNumber:"S-1", snapshot:{ shopName:"JOJO Mall", orderStatus:"待处理" } },
    channel:{ id:"wrong", providerId:"1023359" } }), { code:"CHANNEL_MISMATCH" });
  assert.equal(calls, 0);
});

test("real executor exposes unavailable Mabang channel as a safety error", async () => {
  const executorConfig = { ...config, channelValue:"fixed", channelSource:"1", verificationTimeoutSeconds:30 };
  const executor = createMabangFulfillmentExecutor({ config:executorConfig, rootDir:process.cwd(), runWorker:async () => {
    throw new Error("CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT: 固定物流渠道不可用");
  } });
  await assert.rejects(executor.fulfill({
    order:{ tradeNumber:"S-1", warehouse:"印尼泗水云雀-A仓-1308", warehouses:["印尼泗水云雀-A仓-1308"],
      stockStatus:"in_stock",eligible:true,
      snapshot:{ sourceOrderId:"M-1", shopName:"JOJO Mall", orderStatus:"待处理", warehouses:["印尼泗水云雀-A仓-1308"] } },
    channel:{ id:"1143663", providerId:"1023359" },
  }), { code:"CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT" });
});

test("confirmation stops the entire batch before submission when any order is out of stock", async () => {
  const repository = new FulfillmentRepository();
  const initial = [order, { ...order, 订单编号:"M-2",交易编号:"S-2" }];
  let executorCalls = 0;
  const source = { listPending:async()=>initial, getByIds:async()=>[initial[0], { ...initial[1], 商品库存:0 }] };
  const service = new FulfillmentService({ config:{ ...config, realSubmitEnabled:true }, repository, source,
    executor:{ fulfill:async()=>{ executorCalls += 1; } } });
  const preview = await service.createPreview({ limit:2 });
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.status, "failed");
  assert.equal(batch.orders.every((item) => item.errorCode === "OUT_OF_STOCK_BEFORE_SUBMIT"), true);
  assert.equal(executorCalls, 0);
  repository.close();
});

test("confirmation requires a new preview when inventory changed but remains sufficient", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending:async()=>[order], getByIds:async()=>[{ ...order, 商品库存:9 }] };
  const service = new FulfillmentService({ config:{ ...config, realSubmitEnabled:true }, repository, source, executor:{ fulfill:async()=>{} } });
  const preview = await service.createPreview();
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.status, "failed");
  assert.equal(batch.orders[0].errorCode, "INVENTORY_CHANGED_AFTER_PREVIEW");
  repository.close();
});

test("asynchronous confirmation returns a queued batch before Mabang reading finishes", async () => {
  const repository = new FulfillmentRepository();
  let releaseRead;
  const source = { listPending:async()=>[order], getByIds:()=>new Promise((resolve)=>{ releaseRead=()=>resolve([order]); }) };
  const executor = { fulfill:async()=>({ verified:true,trackingNumber:"TRACK-ASYNC",afterStatus:"配货中",
    timings:{ prepare:10,submitRequest:20,trackingWait:30,distributionRequest:40,distributionWait:50,total:150 } }) };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,executor });
  const preview = await service.createPreview();
  const queued = service.enqueuePreview(preview.previewId, preview.confirmationToken);
  assert.equal(queued.status, "queued");
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(service.getBatch(queued.id).status, "running");
  releaseRead();
  await service.waitForIdle();
  const finished = service.getBatch(queued.id);
  assert.equal(finished.status, "success");
  assert.equal(finished.orders[0].timings.trackingWait, 30);
  assert.equal(Number.isInteger(finished.orders[0].timings.executorTotal), true);
  assert.equal(Number.isInteger(finished.timings.preSubmitRevalidation), true);
  assert.equal(Number.isInteger(finished.timings.total), true);
  repository.close();
});

test("order concurrency two runs a successful batch in bounded two-order waves", async () => {
  const repository = new FulfillmentRepository();
  const initial = Array.from({ length:4 }, (_, index) => ({ ...order,
    订单编号:`M-C${index + 1}`,交易编号:`S-C${index + 1}` }));
  let inFlight = 0; let maximumInFlight = 0; const events = [];
  const executor = { fulfill:async({ order:current })=>{
    events.push(`start:${current.tradeNumber}`);
    inFlight += 1; maximumInFlight = Math.max(maximumInFlight, inFlight);
    await new Promise((resolve)=>setTimeout(resolve, 10));
    inFlight -= 1;
    events.push(`finish:${current.tradeNumber}`);
    return { verified:true,trackingNumber:`TRACK-${current.tradeNumber}`,afterStatus:"配货中",
      timings:{ trackingWait:5,total:10 } };
  } };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,orderConcurrency:2 },repository,
    source:{ listPending:async()=>initial,getByIds:async()=>initial },executor });
  const preview = await service.createPreview({ limit:4 });
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.status, "success");
  assert.equal(maximumInFlight, 2);
  assert.equal(batch.timings.orderConcurrency, 2);
  assert.equal(batch.orders.every((item) => item.status === "success" && item.timings.trackingWait === 5), true);
  assert.ok(events.indexOf("start:S-C3") > events.indexOf("finish:S-C1"));
  assert.ok(events.indexOf("start:S-C3") > events.indexOf("finish:S-C2"));
  repository.close();
});

test("order concurrency two stops later waves when either in-flight order fails", async () => {
  const repository = new FulfillmentRepository();
  const initial = Array.from({ length:4 }, (_, index) => ({ ...order,
    订单编号:`M-W${index + 1}`,交易编号:`S-W${index + 1}` }));
  const calls = [];
  const executor = { fulfill:async({ order:current })=>{
    calls.push(current.tradeNumber);
    await new Promise((resolve)=>setTimeout(resolve, 5));
    if (current.tradeNumber === "S-W2") throw Object.assign(new Error("波次失败"), { code:"WAVE_FAILED" });
    return { verified:true,trackingNumber:`TRACK-${current.tradeNumber}`,afterStatus:"配货中" };
  } };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,orderConcurrency:2 },repository,
    source:{ listPending:async()=>initial,getByIds:async()=>initial },executor });
  const preview = await service.createPreview({ limit:4 });
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.deepEqual(calls, ["S-W1","S-W2"]);
  assert.equal(batch.status, "partial_success");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-W1").status, "success");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-W2").errorCode, "WAVE_FAILED");
  assert.equal(batch.orders.filter((item) => item.errorCode === "SKIPPED_AFTER_BATCH_FAILURE").length, 2);
  repository.close();
});

test("inventory unknown before submit enters manual review and cannot be queued repeatedly", async () => {
  const repository = new FulfillmentRepository();
  let executorCalls = 0;
  const executor = { fulfill:async()=>{
    executorCalls += 1;
    throw Object.assign(new Error("库存标志无法识别"), { code:"INVENTORY_UNKNOWN_BEFORE_SUBMIT" });
  } };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,
    source:{ listPending:async()=>[order],getByIds:async()=>[order] },executor });
  const preview = await service.createPreview();
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.status, "failed");
  assert.equal(batch.orders[0].status, "needs_attention");
  assert.equal(batch.orders[0].errorCode, "INVENTORY_UNKNOWN_BEFORE_SUBMIT");
  const repeatedPreview = await service.createPreview();
  assert.equal(repeatedPreview.eligibleOrders.length, 0);
  assert.equal(repeatedPreview.excludedOrders[0].exclusions.includes("ALREADY_FULFILLED"), true);
  assert.equal(executorCalls, 1);
  repository.close();
});

test("manual review recheck releases only a corrected order and never submits it", async () => {
  const repository = new FulfillmentRepository();
  let executorCalls = 0;
  const source = { listPending:async()=>[order],getByIds:async()=>[order] };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,executor:{ fulfill:async()=>{
    executorCalls += 1;
    throw Object.assign(new Error("多仓订单"), { code:"MULTI_WAREHOUSE_REQUIRES_REVIEW" });
  } } });
  const preview = await service.createPreview();
  const failed = await service.confirmPreview(preview.previewId,preview.confirmationToken);
  assert.equal(failed.orders[0].status,"needs_attention");
  let preflightCalls = 0;
  const released = await service.recheckManualReview("S-1", { run:async()=>{
    preflightCalls += 1;
    return { ready:true,wouldSubmit:false,stockStatus:"in_stock",hasTrackingNumber:false,channelMatched:true,
      reportingSuccess:true,hasDeclarationRows:false,missingRequiredPropertyCount:0 };
  } });
  assert.equal(released.released,true);
  assert.equal(released.nextStep.includes("没有提交发货"),true);
  assert.equal(preflightCalls,1);
  assert.equal(executorCalls,1);
  const nextPreview = await service.createPreview();
  assert.equal(nextPreview.eligibleOrders.length,1);
  repository.close();
});

test("manual review recheck keeps the lock while SKU warehouses still differ", async () => {
  const repository = new FulfillmentRepository();
  let targetedReads = 0;
  const corrected = [
    { ...order,SKU:"SKU-A",仓库:"印尼泗水云雀-A仓-1308" },
    { ...order,SKU:"SKU-B",仓库:"印尼泗水环亚-AD仓-1308" },
  ];
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,
    source:{ listPending:async()=>[order],getByIds:async()=>++targetedReads === 1 ? [order] : corrected },executor:{ fulfill:async()=>{
      throw Object.assign(new Error("多仓订单"), { code:"MULTI_WAREHOUSE_REQUIRES_REVIEW" });
    } } });
  const preview = await service.createPreview();
  await service.confirmPreview(preview.previewId,preview.confirmationToken);
  let preflightCalls = 0;
  await assert.rejects(service.recheckManualReview("S-1", { run:async()=>{ preflightCalls += 1; } }),
    { code:"MULTI_WAREHOUSE_REQUIRES_REVIEW" });
  assert.equal(preflightCalls,0);
  assert.equal(repository.getManualReview(config.shopId,"S-1")?.errorCode,"MULTI_WAREHOUSE_REQUIRES_REVIEW");
  repository.close();
});

test("automatic manual-review recovery requires two passes and never submits while releasing", async () => {
  const repository = new FulfillmentRepository();
  let executorCalls = 0; let preflightCalls = 0;
  const source = { listPending:async()=>[order],getByIds:async()=>[order] };
  const preflight = { run:async(_orderId,options)=>{
    preflightCalls += 1;
    assert.equal(options.singleWarehouseVerified,true);
    return { ready:true,wouldSubmit:false,stockStatus:"in_stock",hasTrackingNumber:false,channelMatched:true,
      reportingSuccess:true,hasDeclarationRows:false,missingRequiredPropertyCount:0 };
  } };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,preflight,
    executor:{ fulfill:async()=>{ executorCalls += 1;
      throw Object.assign(new Error("多仓订单"), { code:"MULTI_WAREHOUSE_REQUIRES_REVIEW" }); } } });
  const preview = await service.createPreview();
  const failed = await service.confirmPreview(preview.previewId,preview.confirmationToken);
  assert.equal(failed.orders[0].status,"needs_attention");

  const first = await service.autoRecoverManualReviews({ records:[order] });
  assert.deepEqual(first.firstPass,[{ orderId:"S-1",passCount:1 }]);
  assert.equal(first.released.length,0);
  assert.equal(repository.getManualReview(config.shopId,"S-1")?.errorCode,"MULTI_WAREHOUSE_REQUIRES_REVIEW");

  const second = await service.autoRecoverManualReviews({ records:[order] });
  assert.deepEqual(second.released,[{ orderId:"S-1",previousErrorCode:"MULTI_WAREHOUSE_REQUIRES_REVIEW" }]);
  assert.equal(repository.getManualReview(config.shopId,"S-1"),null);
  assert.equal(repository.getBatch(failed.id).orders[0].status,"released");
  assert.equal(executorCalls,1);
  assert.equal(preflightCalls,2);
  const nextPreview = await service.createPreview();
  assert.equal(nextPreview.eligibleOrders.length,1);
  repository.close();
});

test("automatic manual-review recovery resets its pass after a failed safety check", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending:async()=>[order],getByIds:async()=>[order] };
  const preflight = { run:async()=>({ ready:true,wouldSubmit:false,stockStatus:"in_stock",hasTrackingNumber:false,
    channelMatched:true,reportingSuccess:true,hasDeclarationRows:false,missingRequiredPropertyCount:0 }) };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,preflight,
    executor:{ fulfill:async()=>{ throw Object.assign(new Error("库存未知"), { code:"INVENTORY_UNKNOWN_BEFORE_SUBMIT" }); } } });
  const preview = await service.createPreview();
  await service.confirmPreview(preview.previewId,preview.confirmationToken);
  assert.equal((await service.autoRecoverManualReviews({ records:[order] })).firstPass.length,1);
  const failedCheck = await service.autoRecoverManualReviews({ records:[{ ...order,商品库存:0 }] });
  assert.equal(failedCheck.retained[0].code,"OUT_OF_STOCK");
  const restarted = await service.autoRecoverManualReviews({ records:[order] });
  assert.deepEqual(restarted.firstPass,[{ orderId:"S-1",passCount:1 }]);
  assert.equal(restarted.released.length,0);
  repository.close();
});

test("startup quarantine converts the latest inventory-unknown failure into manual review", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,
    source:{ listPending:async()=>[order],getByIds:async()=>[order] },executor:{ fulfill:async()=>{
      throw Object.assign(new Error("temporary failure"), { code:"TEMPORARY_FAILURE" });
    } } });
  const preview = await service.createPreview();
  const failed = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  repository.db.prepare(`UPDATE fulfillment_batch_orders SET error_code='INVENTORY_UNKNOWN_BEFORE_SUBMIT' WHERE batch_id=?`).run(failed.id);
  assert.equal(repository.quarantineFailedOrders("INVENTORY_UNKNOWN_BEFORE_SUBMIT", "2026-07-29T06:00:00.000Z"), 1);
  const quarantined = repository.getBatch(failed.id);
  assert.equal(quarantined.orders[0].status, "needs_attention");
  assert.equal(repository.isCompleted(quarantined.orders[0].orderKey), true);
  assert.equal(repository.quarantineFailedOrders("INVENTORY_UNKNOWN_BEFORE_SUBMIT", "2026-07-29T06:01:00.000Z"), 0);
  repository.close();
});

test("only one fulfillment batch can run at a time", async () => {
  const repository = new FulfillmentRepository();
  let releaseRead;
  const source = { listPending:async()=>[order], getByIds:()=>new Promise((resolve)=>{ releaseRead=()=>resolve([order]); }) };
  const executor = { fulfill:async()=>({ verified:true,trackingNumber:"TRACK-LOCK",afterStatus:"配货中" }) };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,executor });
  const firstPreview = await service.createPreview();
  const secondPreview = await service.createPreview();
  service.enqueuePreview(firstPreview.previewId, firstPreview.confirmationToken);
  assert.throws(() => service.enqueuePreview(secondPreview.previewId, secondPreview.confirmationToken), { code:"BATCH_ALREADY_RUNNING" });
  await new Promise((resolve)=>setImmediate(resolve));
  releaseRead();
  await service.waitForIdle();
  repository.close();
});

test("restart recovery locks uncertain queued orders for manual attention", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,
    source:{ listPending:async()=>[order] },executor:{} });
  const preview = await service.createPreview();
  const { batch } = service.createConfirmedBatch(preview.previewId, preview.confirmationToken);
  const recovered = repository.recoverInterruptedBatches("2026-07-28T00:00:00.000Z");
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "failed");
  assert.equal(recovered[0].orders[0].status, "needs_attention");
  assert.equal(recovered[0].orders[0].errorCode, "SERVICE_RESTARTED_DURING_BATCH");
  assert.equal(repository.getActiveBatch(), null);
  repository.close();
});

test("scheduler creates a preview without confirming fulfillment", async () => {
  let previewCalls = 0;
  const scheduledPreview = { previewId:"PREVIEW-SCHEDULED",expiresAt:"2026-07-28T01:00:00.000Z",
    eligibleOrders:[{ displayOrderId:"S-1" }],excludedOrders:[] };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,schedulerIntervalSeconds:300,maxBatchSize:10 },
    service:{ getActiveBatch:()=>null,getLatestPendingPreview:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
      recordScanRun:()=>{},createPreview:async()=>{ previewCalls += 1; return scheduledPreview; } },
    now:()=>new Date("2026-07-28T00:00:00.000Z") });
  const result = await scheduler.scanNow();
  assert.equal(previewCalls, 1);
  assert.equal(result.scanning, false);
  assert.equal(result.lastOutcome, "preview_created");
  assert.equal(result.createdPreview.previewId, "PREVIEW-SCHEDULED");
});

test("scheduler releases recovered manual locks only after the current scan has finished selecting orders", async () => {
  let scans = 0; let recoveries = 0; const batches = [];
  const service = { config:{ shopId:"1",shopName:"Arca Woods",autoFulfillEnabled:true },getActiveBatch:()=>null,
    getLatestPendingPreview:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],recordScanRun:()=>{},
    createPreview:async()=>{ scans += 1; return { previewId:`P-${scans}`,confirmationToken:`T-${scans}`,
      shop:{ id:"1",name:"Arca Woods" },eligibleOrders:scans === 1 ? [] : [{ displayOrderId:"S-1" }],excludedOrders:[] }; },
    autoRecoverManualReviews:async()=>{ recoveries += 1; return { checked:1,firstPass:[],
      released:[{ orderId:"S-1" }],retained:[] }; },
    enqueuePreview:(previewId,token)=>{ batches.push({ previewId,token }); return { id:"B-1",status:"queued" }; } };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10 },service,services:[service] });
  const first = await scheduler.scanNow();
  assert.equal(first.autoBatch,null);
  assert.equal(recoveries,1);
  assert.equal(first.lastManualRecoveries[0].released[0].orderId,"S-1");
  assert.deepEqual(batches,[]);
  const second = await scheduler.scanNow();
  assert.equal(second.autoBatch.id,"B-1");
  assert.equal(recoveries,1);
  assert.deepEqual(batches,[{ previewId:"P-2",token:"T-2" }]);
});

test("multi-shop scheduler creates isolated previews for every shop", async () => {
  const scans = []; const calls = [];
  const shared = { getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    recordScanRun:(run)=>scans.push(run) };
  const services = ["Arca Woods","Toko Penguin"].map((shopName, index) => ({ ...shared,
    config:{ shopName,shopId:String(index + 1) },getLatestPendingPreview:()=>null,
    createPreview:async()=>{ calls.push(shopName); return { previewId:`P-${index}`,shop:{ id:String(index + 1),name:shopName },
      eligibleOrders:[{ displayOrderId:`S-${index}` }],excludedOrders:[] }; } }));
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,schedulerIntervalSeconds:300,maxBatchSize:10 },
    service:services[0],services,now:()=>new Date("2026-07-28T00:00:00.000Z") });
  const result = await scheduler.scanNow();
  assert.deepEqual(calls, ["Arca Woods","Toko Penguin"]);
  assert.equal(result.createdPreviews.length, 2);
  assert.equal(result.lastOutcome, "preview_created");
  assert.equal(scans[0].eligibleCount, 2);
});

test("multi-shop scheduler uses one shared account scan and keeps shop records isolated", async () => {
  const scanCalls = []; const previewCalls = []; const fallbackCalls = [];
  const shared = { getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],recordScanRun:()=>{},
    getLatestPendingPreview:()=>null };
  const services = [
    { ...shared,config:{ shopName:"Arca Woods",shopId:"1" },createPreview:async()=>{ fallbackCalls.push("1"); },
      createPreviewFromRecords:(records)=>{ previewCalls.push(["1",...records.map((item)=>item["交易编号"])]); return {
        previewId:"P-1",shop:{ id:"1",name:"Arca Woods" },eligibleOrders:[],excludedOrders:[] }; } },
    { ...shared,config:{ shopName:"Toko Penguin",shopId:"2" },createPreview:async()=>{ fallbackCalls.push("2"); },
      createPreviewFromRecords:(records)=>{ previewCalls.push(["2",...records.map((item)=>item["交易编号"])]); return {
        previewId:"P-2",shop:{ id:"2",name:"Toko Penguin" },eligibleOrders:[],excludedOrders:[] }; } },
  ];
  const scanSource = { listPendingByShop:async(options)=>{ scanCalls.push(options); return new Map([
    ["1",[{ 店铺名:"Arca Woods",交易编号:"A-1" }]], ["2",[{ 店铺名:"Toko Penguin",交易编号:"T-1" }]],
  ]); } };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,schedulerIntervalSeconds:300,maxBatchSize:10 },
    service:services[0],services,scanSource });
  const result = await scheduler.scanNow();
  assert.deepEqual(scanCalls, [{ shopIds:["1","2"],limit:10 }]);
  assert.deepEqual(previewCalls, [["1","A-1"],["2","T-1"]]);
  assert.deepEqual(fallbackCalls, []);
  assert.equal(result.lastScanStrategy, "shared_account_scan");
  assert.equal(Number.isInteger(result.lastSharedCollectionMs), true);
});

test("shared scan failure safely falls back to the existing per-shop readers", async () => {
  const calls = []; const warnings = [];
  const shared = { getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],recordScanRun:()=>{},
    getLatestPendingPreview:()=>null };
  const services = ["Arca Woods","Toko Penguin"].map((shopName,index)=>({ ...shared,
    config:{ shopName,shopId:String(index + 1) },createPreview:async()=>{ calls.push(shopName); return {
      previewId:`P-${index}`,shop:{ id:String(index + 1),name:shopName },eligibleOrders:[],excludedOrders:[] }; } }));
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,schedulerIntervalSeconds:300,maxBatchSize:10 },
    service:services[0],services,scanSource:{ listPendingByShop:async()=>{ throw Object.assign(new Error("shared failed"),{ code:"SHARED_FAILED" }); } },
    logger:{ warn:(message)=>warnings.push(message) } });
  const result = await scheduler.scanNow();
  assert.deepEqual(calls, ["Arca Woods","Toko Penguin"]);
  assert.equal(result.lastScanStrategy, "per_shop_fallback");
  assert.equal(warnings[0].includes("SHARED_FAILED"), true);
  assert.equal(result.lastOutcome, "no_eligible_orders");
});

test("scheduler automatically enqueues only an explicitly enabled shop after preview checks", async () => {
  const calls = []; const batches = [];
  const shared = { getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    recordScanRun:()=>{},getLatestPendingPreview:()=>null };
  const services = [
    { ...shared,config:{ shopName:"Arca Woods",shopId:"1",autoFulfillEnabled:true },
      createPreview:async()=>{ calls.push("Arca Woods"); return { previewId:"AUTO-P",confirmationToken:"AUTO-T",
        shop:{ id:"1",name:"Arca Woods" },eligibleOrders:[{ displayOrderId:"S-1" }],excludedOrders:[] }; },
      enqueuePreview:(previewId,token)=>{ batches.push({ previewId,token }); return { id:"AUTO-B",status:"queued" }; } },
    { ...shared,config:{ shopName:"Toko Penguin",shopId:"2",autoFulfillEnabled:true },
      createPreview:async()=>{ calls.push("Toko Penguin"); return { previewId:"P-2",confirmationToken:"T-2",
        shop:{ id:"2",name:"Toko Penguin" },eligibleOrders:[{ displayOrderId:"S-2" }],excludedOrders:[] }; },
      enqueuePreview:(previewId,token)=>{ batches.push({ previewId,token }); return { id:"B-2",status:"queued" }; } },
  ];
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:true,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10 },service:services[0],services,
    now:()=>new Date("2026-07-28T00:00:00.000Z") });
  const result = await scheduler.scanNow();
  assert.deepEqual(calls, ["Arca Woods"]);
  assert.deepEqual(batches, [{ previewId:"AUTO-P",token:"AUTO-T" }]);
  assert.equal(result.lastOutcome, "auto_fulfillment_started");
  assert.deepEqual(result.autoBatch, { id:"AUTO-B",shopName:"Arca Woods",orderCount:1,status:"queued" });
  const second = await scheduler.scanNow();
  assert.deepEqual(calls, ["Arca Woods","Toko Penguin"]);
  assert.deepEqual(batches[1], { previewId:"P-2",token:"T-2" });
  assert.equal(second.autoBatch.shopName, "Toko Penguin");
});

test("scheduler skips scanning while a batch is active", async () => {
  let previewCalls = 0;
  const activeBatch = { id:"BATCH-ACTIVE",status:"running",createdAt:"2026-07-28T00:00:00.000Z" };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:true,schedulerIntervalSeconds:300,maxBatchSize:10 },
    service:{ getActiveBatch:()=>activeBatch,getLatestPendingPreview:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
      recordScanRun:()=>{},createPreview:async()=>{ previewCalls += 1; } } });
  const result = await scheduler.scanNow();
  assert.equal(previewCalls, 0);
  assert.equal(result.lastOutcome, "skipped_active_batch");
});

test("pending preview summaries and scan history survive scheduler status reads", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config,repository,source:{ listPending:async()=>[order] },executor:{} });
  const preview = await service.createPreview();
  service.recordScanRun({ startedAt:"2026-07-28T01:00:00.000Z",finishedAt:"2026-07-28T01:00:02.000Z",
    outcome:"preview_created",message:"已生成预览",eligibleCount:1,excludedCount:0,previewId:preview.previewId });
  const summaries = service.listPendingPreviewSummaries();
  const history = service.listRecentScanRuns();
  assert.equal(summaries[0].previewId, preview.previewId);
  assert.deepEqual(summaries[0].shop, { id:"2021485965",name:"JOJO Mall" });
  assert.equal(summaries[0].eligibleOrderCount, 1);
  assert.equal(history[0].outcome, "preview_created");
  assert.equal(history[0].eligibleOrderCount, 1);
  repository.close();
});

test("Windows notifier is opt-in and forwards only bounded notification data", () => {
  const calls = [];
  const spawnProcess = (command,args,options) => { calls.push({ command,args,options }); return { unref() {} }; };
  assert.equal(createWindowsNotifier({ enabled:false,platform:"win32",spawnProcess }).notify({ title:"x",message:"y" }), false);
  assert.equal(calls.length, 0);
  assert.equal(createWindowsNotifier({ enabled:true,platform:"win32",spawnProcess }).notify({
    title:"待确认",message:"订单预览已生成",
  }), true);
  assert.equal(calls[0].command, "powershell.exe");
  assert.equal(calls[0].options.env.ZNWX_TOAST_TITLE, "待确认");
  assert.equal(Object.hasOwn(calls[0].options.env, "FULFILLMENT_MABANG_PASSWORD"), false);
});

test("confirmation performs one batch inventory read and stops after an executor pre-submit stock failure", async () => {
  const repository = new FulfillmentRepository();
  const initial = [order, { ...order,订单编号:"M-2",交易编号:"S-2" }, { ...order,订单编号:"M-3",交易编号:"S-3" }];
  let reads = 0; let executorCalls = 0;
  const source = { listPending:async()=>initial, getByIds:async()=>{ reads += 1; return initial; } };
  const executor = { fulfill:async()=>{
    executorCalls += 1;
    if (executorCalls === 2) throw Object.assign(new Error("提交前库存不足"), { code:"OUT_OF_STOCK_BEFORE_SUBMIT" });
    return { verified:true,trackingNumber:"TRACK-123456",afterStatus:"配货中" };
  } };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,executor });
  const preview = await service.createPreview({ limit:3 });
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.status, "partial_success");
  assert.equal(reads, 1);
  assert.equal(executorCalls, 2);
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-1").status, "success");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-2").errorCode, "OUT_OF_STOCK_BEFORE_SUBMIT");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-3").errorCode, "SKIPPED_AFTER_BATCH_FAILURE");
  repository.close();
});

test("explicit Mabang order reads use the targeted worker instead of scanning the date range", async () => {
  const calls = [];
  const sourceConfig = { ...config, mabangUsername:"local-user", mabangPassword:"local-password", lookbackDays:30 };
  const source = createMabangFulfillmentSource({ config:sourceConfig, rootDir:process.cwd(), runWorker:async (payload) => {
    calls.push(payload);
    return { records:[order] };
  } });
  await source.listPending({ limit:1, orderIds:["S-1"] });
  await source.getByIds(["S-1"]);
  assert.deepEqual(calls.map((payload) => payload.action), ["fulfillment-orders", "fulfillment-orders"]);
  assert.deepEqual(calls[0].orderReferences, ["S-1"]);
  assert.equal(Object.hasOwn(calls[0], "startDate"), false);
});

test("shared Mabang scan logs in once, filters configured shops, and groups complete SKU rows", async () => {
  const calls = [];
  const shops = [{ shopId:"1",shopName:"Arca Woods" },{ shopId:"2",shopName:"Toko Penguin" }];
  const source = createMabangFulfillmentScanSource({ config:{ ...config,mabangUsername:"local-user",mabangPassword:"local-password",
    lookbackDays:3,maxBatchSize:10,shops },shops,rootDir:process.cwd(),runWorker:async(payload)=>{
      calls.push(payload);
      return { records:[
        { ...order,店铺名:"Arca Woods",订单编号:"A-1",交易编号:"AS-1",SKU:"A-SKU-1" },
        { ...order,店铺名:"Arca Woods",订单编号:"A-1",交易编号:"AS-1",SKU:"A-SKU-2" },
        { ...order,店铺名:"Toko Penguin",订单编号:"T-1",交易编号:"TS-1" },
        { ...order,店铺名:"Unknown Shop",订单编号:"X-1",交易编号:"XS-1" },
      ] };
    } });
  const grouped = await source.listPendingByShop({ shopIds:["1","2"],limit:10 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].orderFilters.conditions[0], { field:"店铺名",operator:"equals",values:["Arca Woods","Toko Penguin"] });
  assert.deepEqual(calls[0].orderFilters.conditions[1], { field:"订单状态",operator:"equals",values:["待处理"] });
  assert.equal(grouped.get("1").length, 2);
  assert.equal(grouped.get("2").length, 1);
  assert.equal([...grouped.values()].flat().some((item)=>item["店铺名"] === "Unknown Shop"), false);
});

test("unlocked Mabang reads retain complete SKU groups for the newest candidate orders", async () => {
  const records = Array.from({ length:22 }, (_, index) => ({ ...order,订单编号:`M-${index}`,交易编号:`S-${index}`,
    付款时间:`2026-07-${String(index + 1).padStart(2,"0")} 10:00:00` }));
  records.push({ ...records[21],SKU:"SKU-SECOND" });
  const sourceConfig = { ...config,mabangUsername:"local-user",mabangPassword:"local-password",lookbackDays:3 };
  const source = createMabangFulfillmentSource({ config:sourceConfig,rootDir:process.cwd(),runWorker:async()=>({ records }) });
  const result = await source.listPending({ limit:1 });
  assert.equal(new Set(result.map((row)=>row["订单编号"])).size, 20);
  assert.equal(result.filter((row)=>row["订单编号"] === "M-21").length, 2);
  assert.equal(result.some((row)=>row["订单编号"] === "M-0"), false);
});

test("a failed idempotency reservation can be retried but a success cannot", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending:async()=>[order], getByIds:async()=>[order] };
  let attempts = 0;
  const executor = { fulfill:async()=>{
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("safe pre-submit failure"), { code:"SAFE_FAILURE" });
    return { verified:true,trackingNumber:"TRACK-RETRY",afterStatus:"配货中" };
  } };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,executor });

  const firstPreview = await service.createPreview();
  const firstBatch = await service.confirmPreview(firstPreview.previewId, firstPreview.confirmationToken);
  assert.equal(firstBatch.status, "failed");

  const retryPreview = await service.createPreview();
  const retryBatch = await service.confirmPreview(retryPreview.previewId, retryPreview.confirmationToken);
  assert.equal(retryBatch.status, "success");

  const duplicatePreview = await service.createPreview();
  assert.equal(duplicatePreview.eligibleOrders.length, 0);
  assert.equal(duplicatePreview.excludedOrders[0].exclusions.includes("ALREADY_FULFILLED"), true);
  repository.close();
});

test("a needs-attention order remains locked against duplicate fulfillment", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending:async()=>[order], getByIds:async()=>[order] };
  const executor = { fulfill:async()=>({ verified:false,trackingNumber:"TRACK-UNCERTAIN",afterStatus:"待处理" }) };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,source,executor });

  const preview = await service.createPreview();
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.orders[0].status, "needs_attention");

  const duplicatePreview = await service.createPreview();
  assert.equal(duplicatePreview.eligibleOrders.length, 0);
  assert.equal(duplicatePreview.excludedOrders[0].exclusions.includes("ALREADY_FULFILLED"), true);
  repository.close();
});
