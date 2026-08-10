import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { FulfillmentRepository } from "../fulfillment-service/repository.mjs";
import { FulfillmentService } from "../fulfillment-service/service.mjs";
import { createApiDocsHtml } from "../fulfillment-service/api-docs.mjs";
import { createMabangFulfillmentCatalogSource, createMabangFulfillmentExecutor, createMabangFulfillmentPreflight, createMabangFulfillmentScanSource, createMabangFulfillmentSource, createMabangMessageReviewRecovery, createMabangPolicySuggestionSource, inferFulfillmentPolicySuggestions, planFulfillmentPolicySuggestionConfirmations } from "../fulfillment-service/mabang-source.mjs";
import { FulfillmentPreviewScheduler } from "../fulfillment-service/scheduler.mjs";
import { createWindowsNotifier } from "../fulfillment-service/notifier.mjs";
import { isShopAutoFulfillAuthorized, resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";
import { createFulfillmentDashboardProxy } from "../lib/fulfillment-dashboard-proxy.mjs";
import { buildFulfillmentPolicyImportPreview, parseFulfillmentPolicyWorkbook } from "../fulfillment-service/policy-import.mjs";
import { authorizationSettingsForIdentity, authorizedShopIdsForIdentity,
  fulfillmentAccountIdentityKey } from "../fulfillment-service/account-authorization.mjs";

const config = Object.freeze({ shopName:"JOJO Mall",shopId:"2021485965",platform:"Shopee",platformId:"17",countryCode:"ID",
  pendingStatus:"待处理",pendingStatusId:"2",channelId:"1143663",channelProviderId:"1023359",channelName:"ID J&T",maxBatchSize:10,
  previewTtlSeconds:600,realSubmitEnabled:false });
const order = { 订单编号:"M-1",交易编号:"S-1",店铺名:"JOJO Mall",订单状态:"待处理",仓库:"印尼泗水环亚-AD仓-1308",SKU:"SKU-1",商品数量:1,商品库存:10 };

test("account authorization is isolated by profile id and normalized username fingerprint", () => {
  const first = { id:"PROFILE-1",username:"Manager-A",source:"account_profile" };
  const renamed = { id:"PROFILE-1",username:"Manager-B",source:"account_profile" };
  const settings = authorizationSettingsForIdentity({}, first, ["2021621760"]);
  assert.notEqual(fulfillmentAccountIdentityKey(first), fulfillmentAccountIdentityKey(renamed));
  assert.deepEqual([...authorizedShopIdsForIdentity(settings, first)], ["2021621760"]);
  assert.deepEqual([...authorizedShopIdsForIdentity(settings, renamed)], []);
});

test("environment account authorization survives restart under its username fingerprint", () => {
  const account = { id:"",username:"env-manager",source:"environment" };
  const initial = authorizedShopIdsForIdentity({}, account, ["STATIC-SHOP"]);
  assert.deepEqual([...initial], ["STATIC-SHOP"]);
  const settings = authorizationSettingsForIdentity({}, account, ["SYNCED-SHOP"]);
  assert.deepEqual([...authorizedShopIdsForIdentity(settings, account, ["STATIC-SHOP"])], ["SYNCED-SHOP"]);
});

test("Lazada uses the seller-center platform order number instead of Mabang's concatenated id", async () => {
  const repository = new FulfillmentRepository();
  const lazadaOrder = { ...order, 平台:"Lazada", 店铺名:"Lazada Shop",
    订单编号:"2021390750531159323305217", 交易编号:"531159323305217" };
  const lazadaConfig = { ...config, shopId:"2021390750", shopName:"Lazada Shop", platform:"Lazada", platformId:"7" };
  const service = new FulfillmentService({ config:lazadaConfig, repository,
    source:{ listPending:async()=>[lazadaOrder], getByIds:async()=>[lazadaOrder] }, executor:{ fulfill:async()=>{} } });

  const preview = await service.createPreview();
  const storedOrder = repository.getPreview(preview.previewId).orders[0];

  assert.equal(storedOrder.displayOrderId, "531159323305217");
  assert.equal(storedOrder.tradeNumber, "531159323305217");
  assert.equal(storedOrder.orderKey, "2021390750:531159323305217");
  assert.equal(storedOrder.snapshot.sourceOrderId, "2021390750531159323305217");
  assert.equal(storedOrder.snapshot.platformOrderId, "531159323305217");
  repository.close();
});

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

test("fulfillment dashboard and activity lists can be scoped to the selected account shops", async () => {
  const repository = new FulfillmentRepository();
  const now = "2026-08-08T08:00:00.000Z";
  for (const [shopId, shopName, suffix] of [["shop-current","Current Shop","CURRENT"],["shop-old","Old Shop","OLD"]]) {
    const service = new FulfillmentService({ config:{ ...config,shopId,shopName,realSubmitEnabled:true },repository,
      now:()=>new Date(now),
      source:{ listPending:async()=>[{ ...order,订单编号:`M-${suffix}`,交易编号:`S-${suffix}`,店铺名:shopName }] },
      executor:{ fulfill:async()=>({ trackingNumberMasked:"***1234",afterStatus:"配货中" }) } });
    const preview = await service.createPreview({ limit:1 });
    await service.confirmPreview(preview.previewId, preview.confirmationToken);
  }
  const windows = { todayStartIso:"2026-08-08T00:00:00.000Z",trendStartIso:"2026-08-08T00:00:00.000Z",
    endIso:"2026-08-09T00:00:00.000Z",dayWindows:[{ date:"2026-08-08",fromIso:"2026-08-08T00:00:00.000Z",toIso:"2026-08-09T00:00:00.000Z" }] };
  const scoped = repository.getDashboardSummary(windows,["shop-current"]);
  assert.deepEqual(scoped.shops.map((shop)=>shop.shopId),["shop-current"]);
  assert.equal(scoped.trend[0].total,1);
  assert.deepEqual(repository.listRecentBatches(20,["shop-current"]).map((batch)=>batch.shop.id),["shop-current"]);
  assert.deepEqual(repository.listRecentBatches(20,[]),[]);
  assert.deepEqual(repository.listTrackingRecoveries(20,null,[]),[]);
  repository.close();
});

test("fulfillment dashboard proxy bounds message review reads and requires exact recovery confirmation", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl:async(url,options)=>{
    calls.push({ url:String(url),options });
    return new Response(JSON.stringify({ success:true,data:[] }), { status:200 });
  } });

  const getReq = Readable.from([]);
  getReq.method = "GET";
  const getResponse = proxyResponse();
  assert.equal(await proxy(getReq,getResponse,new URL("http://localhost/api/fulfillment-dashboard/message-review-recoveries/candidates?limit=999")), true);
  assert.equal(calls[0].url, "http://127.0.0.1:3112/api/fulfillment/message-review-recoveries/candidates?limit=10");

  const postReq = Readable.from([JSON.stringify({
    orderId:"260804ABC_123",confirmation:"MESSAGE_REVIEW_RECOVERY_CONFIRMED",unexpected:"drop-me",
  })]);
  postReq.method = "POST";
  const postResponse = proxyResponse();
  assert.equal(await proxy(postReq,postResponse,new URL("http://localhost/api/fulfillment-dashboard/message-review-recoveries")), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    orderId:"260804ABC_123",confirmation:"MESSAGE_REVIEW_RECOVERY_CONFIRMED",
  });

  const invalidReq = Readable.from([JSON.stringify({ orderId:"260804ABC_123",confirmation:"yes" })]);
  invalidReq.method = "POST";
  const invalidResponse = proxyResponse();
  assert.equal(await proxy(invalidReq,invalidResponse,new URL("http://localhost/api/fulfillment-dashboard/message-review-recoveries")), true);
  assert.equal(invalidResponse.status, 400);
  assert.equal(calls.length, 2);

  const modeReq = Readable.from([JSON.stringify({ mode:"manual",unexpected:"drop-me" })]);
  modeReq.method = "PUT";
  assert.equal(await proxy(modeReq,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/message-review-recoveries/mode")), true);
  assert.equal(calls[2].url, "http://127.0.0.1:3112/api/fulfillment/message-review-recoveries/mode");
  assert.deepEqual(JSON.parse(calls[2].options.body), { mode:"manual" });

  const invalidModeReq = Readable.from([JSON.stringify({ mode:"always" })]);
  invalidModeReq.method = "PUT";
  const invalidModeResponse = proxyResponse();
  assert.equal(await proxy(invalidModeReq,invalidModeResponse,new URL("http://localhost/api/fulfillment-dashboard/message-review-recoveries/mode")), true);
  assert.equal(invalidModeResponse.status, 400);
  assert.equal(calls.length, 3);
});

test("fulfillment dashboard proxy validates and forwards batch SKU replacement jobs", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl: async (url, options) => {
    calls.push({ url:String(url),options });
    return new Response(JSON.stringify({ success:true,data:{} }), { status:202 });
  } });

  const planRequest = Readable.from([JSON.stringify({ selections:[
    { orderReference:"260810ABC123",itemId:"10001",replacementSku:"sku-red",unexpected:"drop" },
    { orderReference:"260810XYZ789",itemId:"10002",replacementSku:"SKU-SMALL" },
  ],unexpected:"drop" })]);
  planRequest.method = "POST";
  assert.equal(await proxy(planRequest,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/batch-plan")),true);
  assert.equal(calls[0].url,"http://127.0.0.1:3112/api/fulfillment/sku-replacements/batch-plan");
  assert.deepEqual(JSON.parse(calls[0].options.body), { selections:[
    { orderReference:"260810ABC123",itemId:"10001",replacementSku:"sku-red" },
    { orderReference:"260810XYZ789",itemId:"10002",replacementSku:"SKU-SMALL" },
  ] });

  const executeRequest = Readable.from([JSON.stringify({ batchHash:"a".repeat(64),approvalText:"确认批量更换SKU 2项",unexpected:"drop" })]);
  executeRequest.method = "POST";
  assert.equal(await proxy(executeRequest,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/batch-execute")),true);
  assert.equal(calls[1].url,"http://127.0.0.1:3112/api/fulfillment/sku-replacements/batch-execute");
  assert.deepEqual(JSON.parse(calls[1].options.body), { batchHash:"a".repeat(64),approvalText:"确认批量更换SKU 2项" });

  const statusRequest = Readable.from([]); statusRequest.method = "GET";
  assert.equal(await proxy(statusRequest,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/batch-executions/task-123")),true);
  assert.equal(calls[2].url,"http://127.0.0.1:3112/api/fulfillment/sku-replacements/batch-executions/task-123");

  const duplicateRequest = Readable.from([JSON.stringify({ selections:[
    { orderReference:"260810ABC123",itemId:"10001",replacementSku:"SKU-A" },
    { orderReference:"260810ABC123",itemId:"10001",replacementSku:"SKU-B" },
  ] })]); duplicateRequest.method = "POST";
  const duplicateResponse = proxyResponse();
  assert.equal(await proxy(duplicateRequest,duplicateResponse,new URL("http://localhost/api/fulfillment-dashboard/sku-replacements/batch-plan")),true);
  assert.equal(duplicateResponse.status,400);
  assert.equal(calls.length,3);
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
    FULFILLMENT_AUTO_FULFILL_SHOP_CONFIG_PATH:path.join(os.tmpdir(), "missing-auto-fulfill-authorization.json"),
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

test("legacy verify failure with a tracking number migrates to distribution recovery", () => {
  const repository = new FulfillmentRepository();
  repository.db.prepare(`INSERT INTO fulfillment_previews
    (id,status,shop_id,shop_name,channel_id,channel_name,confirmation_hash,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run("p-legacy","confirmed",config.shopId,config.shopName,config.channelId,
      config.channelName,"hash","2026-08-01T00:00:00.000Z","2026-07-31T00:00:00.000Z");
  repository.db.prepare("INSERT INTO fulfillment_batches (id,preview_id,status,created_at) VALUES (?,?,?,?)")
    .run("b-legacy","p-legacy","failed","2026-07-31T00:00:00.000Z");
  repository.db.prepare(`INSERT INTO fulfillment_batch_orders
    (batch_id,order_key,display_order_id,status,tracking_number_masked,error_code,error_message,
     before_status,after_status,timings_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run("b-legacy","legacy:o1","O-LEGACY","needs_attention","2016****8685","VERIFY_FAILED",
      "发货后回查不一致","待处理","待处理",'{"submitRequest":10,"distributionRequest":0}',
      "2026-07-31T00:01:00.000Z");
  repository.db.prepare("INSERT INTO fulfillment_idempotency (order_key,batch_id,status,completed_at) VALUES (?,?,?,?)")
    .run("legacy:o1","b-legacy","needs_attention","2026-07-31T00:01:00.000Z");

  assert.equal(repository.migratePendingTrackingRecoveries({
    nowIso:"2026-07-31T00:02:00.000Z",checkSeconds:300,deadlineHours:24,
  }), 1);
  const migrated = repository.getBatch("b-legacy").orders[0];
  assert.equal(migrated.errorCode, "DISTRIBUTION_PENDING");
  assert.equal(repository.listTrackingRecoveries(10, config.shopId)[0].status, "waiting_tracking");
  repository.close();
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

test("automatic preview prioritizes oldest eligible orders without letting shortages consume the limit", async () => {
  const repository = new FulfillmentRepository();
  const source = { listPending:async()=>[
    { ...order,订单编号:"M-OLD",交易编号:"S-OLD",付款时间:"2026-07-25 10:00:00" },
    { ...order,订单编号:"M-NEW-OOS",交易编号:"S-NEW-OOS",商品库存:0,付款时间:"2026-07-28 12:00:00" },
    { ...order,订单编号:"M-MIDDLE",交易编号:"S-MIDDLE",付款时间:"2026-07-27 10:00:00" },
    { ...order,订单编号:"M-NEW",交易编号:"S-NEW",付款时间:"2026-07-28 11:00:00" },
  ] };
  const service = new FulfillmentService({ config,repository,source,executor:{} });
  const preview = await service.createPreview({ limit:2 });
  assert.deepEqual(preview.eligibleOrders.map((item)=>item.displayOrderId), ["S-OLD", "S-MIDDLE"]);
  assert.equal(preview.excludedOrders[0].displayOrderId, "S-NEW-OOS");
  repository.close();
});

test("active dispatch orders are excluded while a later shop preview can still collect new orders", () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,autoFulfillEnabled:true },repository,
    source:{},executor:{} });
  const first = service.createPreviewFromRecords([order],{ limit:2 });
  const dispatch = service.queuePreviewDispatch(first.previewId);
  assert.equal(dispatch.status,"queued");
  const secondOrder = { ...order,订单编号:"M-2",交易编号:"S-2" };
  const next = service.createPreviewFromRecords([order,secondOrder],{ limit:2 });
  assert.deepEqual(next.eligibleOrders.map((item)=>item.displayOrderId),["S-2"]);
  assert.equal(next.excludedOrders.find((item)=>item.displayOrderId === "S-1")
    .exclusions.includes("QUEUED_FOR_FULFILLMENT"),true);
  assert.equal(service.queuePreviewDispatch(next.previewId).status,"queued");
  assert.deepEqual(repository.listActiveDispatchOrderKeys(config.shopId).sort(),
    [`${config.shopId}:M-1`,`${config.shopId}:M-2`]);
  repository.close();
});

test("account scope reset cancels queued dispatches and removes the previous channel catalog", () => {
  const repository = new FulfillmentRepository();
  repository.replaceChannelCatalog([{ channelId:"OLD",channelProviderId:"P",channelLogisticsId:"L",
    channelSource:"1",channelName:"Old channel",channelValue:"old" }]);
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,autoFulfillEnabled:true },repository,
    source:{},executor:{} });
  const preview = service.createPreviewFromRecords([order],{ limit:1 });
  assert.equal(service.queuePreviewDispatch(preview.previewId).status,"queued");
  assert.equal(repository.cancelQueuedDispatches("2026-08-08T00:00:00.000Z"),1);
  assert.equal(repository.getDispatchByPreview(preview.previewId).status,"failed");
  assert.equal(repository.clearChannelCatalog(),1);
  assert.deepEqual(repository.listChannelCatalog(),[]);
  repository.close();
});

test("backlog preview creation splits the oldest eligible orders into bounded batches", () => {
  const repository = new FulfillmentRepository();
  const records = [
    { ...order,订单编号:"M-BLOCKED",交易编号:"S-BLOCKED",商品库存:0,付款时间:"2026-07-20 08:00:00" },
    ...Array.from({ length:7 },(_,index)=>({ ...order,订单编号:`M-${index + 1}`,交易编号:`S-${index + 1}`,
      付款时间:`2026-07-${String(21 + index).padStart(2,"0")} 08:00:00` })),
  ];
  const service = new FulfillmentService({ config,repository,source:{},executor:{} });
  const previews = service.createBacklogPreviewsFromRecords(records,{ limit:2,maxPreviews:3 });
  assert.equal(previews.length,3);
  assert.deepEqual(previews.map((preview)=>preview.eligibleOrders.map((item)=>item.displayOrderId)),
    [["S-1","S-2"],["S-3","S-4"],["S-5","S-6"]]);
  assert.equal(previews[0].excludedOrders.some((item)=>item.displayOrderId === "S-BLOCKED"),true);
  assert.equal(previews.slice(1).every((preview)=>preview.excludedOrders.length === 0),true);
  repository.close();
});

test("Thai routed shops require product-name prefixes to use their assigned warehouses", async () => {
  const repository = new FulfillmentRepository();
  const routedConfig = { ...config, shopId:"69345928", shopName:"Impressive MALL", countryCode:"TH",
    allowedWarehouses:["泰国TZ-AG仓-1308", "泰国壹慧-A仓-1308", "泰国日达顺-A仓-1308", "泰国TLS-A仓-1308"] };
  const base = { ...order, 店铺名:routedConfig.shopName, 国家代码:"TH" };
  const rows = [
    { ...base, 订单编号:"M-5E", 交易编号:"S-5E", 商品中文名称:"5e 床架", 仓库:"泰国壹慧-A仓-1308" },
    { ...base, 订单编号:"M-5F", 交易编号:"S-5F", 商品中文名称:"5F 床垫", 仓库:"泰国日达顺-A仓-1308" },
    { ...base, 订单编号:"M-5J", 交易编号:"S-5J", 商品中文名称:"５ｊ 沙发", 仓库:"泰国TZ-AG仓-1308" },
    { ...base, 订单编号:"M-OTHER", 交易编号:"S-OTHER", 商品中文名称:"普通商品", 仓库:"泰国TZ-AG仓-1308" },
  ];
  const service = new FulfillmentService({ config:routedConfig, repository, source:{ listPending:async()=>rows }, executor:{} });
  const preview = await service.createPreview({ limit:10 });
  assert.deepEqual(preview.eligibleOrders.map((item) => item.displayOrderId).sort(), ["S-5E", "S-5F", "S-OTHER"]);
  const blocked = preview.excludedOrders.find((item) => item.displayOrderId === "S-5J");
  assert.equal(blocked.exclusions.includes("PRODUCT_PREFIX_WAREHOUSE_MISMATCH"), true);
  assert.deepEqual(blocked.warehouseRoutingIssues, [{ prefix:"5J", expectedWarehouses:["泰国TLS-A仓-1308"],
    warehouse:"泰国TZ-AG仓-1308", matched:false }]);
  repository.close();
});

test("product-prefix warehouse routing is limited to the three configured Thai shops", async () => {
  const repository = new FulfillmentRepository();
  const unrestricted = { ...order, 商品中文名称:"5F 床垫", 仓库:"印尼泗水环亚-AD仓-1308" };
  const service = new FulfillmentService({ config, repository, source:{ listPending:async()=>[unrestricted] }, executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 1);
  assert.equal(preview.eligibleOrders[0].warehouseRoutingIssues, undefined);
  repository.close();
});

test("gift SKU warehouse can accompany one in-stock fulfillment warehouse", async () => {
  const repository = new FulfillmentRepository();
  const normalWarehouse = "马来SN-A仓-1308";
  const rows = [
    { ...order,SKU:"SKU-NORMAL",仓库:normalWarehouse,商品库存:10 },
    { ...order,SKU:"SKU-GIFT",仓库:"赠品SKU仓",商品库存:5 },
  ];
  const service = new FulfillmentService({ config:{ ...config,allowedWarehouses:[normalWarehouse] },repository,
    source:{ listPending:async()=>rows },executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 1);
  assert.equal(preview.eligibleOrders[0].exclusions.length, 0);
  assert.deepEqual(preview.eligibleOrders[0].warehouses, ["赠品SKU仓",normalWarehouse]);
  repository.close();
});

test("gift-only order is blocked because gifts cannot be sold alone", async () => {
  const repository = new FulfillmentRepository();
  const giftOnly = { ...order,SKU:"SKU-GIFT",仓库:"赠品SKU仓",商品库存:5 };
  const service = new FulfillmentService({ config,repository,source:{ listPending:async()=>[giftOnly] },executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 0);
  assert.equal(preview.excludedOrders[0].exclusions.includes("GIFT_ONLY_ORDER_NOT_ALLOWED"), true);
  assert.equal(preview.excludedOrders[0].exclusions.includes("MULTI_WAREHOUSE_REQUIRES_REVIEW"), false);
  repository.close();
});

test("gift warehouse does not hide a real multi-warehouse order", async () => {
  const repository = new FulfillmentRepository();
  const rows = [
    { ...order,SKU:"SKU-A",仓库:"仓库A",商品库存:10 },
    { ...order,SKU:"SKU-B",仓库:"仓库B",商品库存:10 },
    { ...order,SKU:"SKU-GIFT",仓库:"赠品SKU仓",商品库存:5 },
  ];
  const service = new FulfillmentService({ config,repository,source:{ listPending:async()=>rows },executor:{} });
  const preview = await service.createPreview();
  assert.equal(preview.eligibleOrders.length, 0);
  assert.equal(preview.excludedOrders[0].exclusions.includes("MULTI_WAREHOUSE_REQUIRES_REVIEW"), true);
  repository.close();
});

test("web policies cannot authorize automatic fulfillment outside the static shop allowlist", () => {
  const resolved = resolveFulfillmentConfig({ rootDir:process.cwd(),env:{
    FULFILLMENT_AUTO_FULFILL_ENABLED:"true",
    FULFILLMENT_AUTO_FULFILL_SHOP_IDS:"2021485965",
    FULFILLMENT_AUTO_FULFILL_SHOP_CONFIG_PATH:path.join(os.tmpdir(), "missing-auto-fulfill-authorization.json"),
  } });
  assert.equal(isShopAutoFulfillAuthorized(resolved,"2021485965"), true);
  assert.equal(isShopAutoFulfillAuthorized(resolved,"2021578358"), false);
  assert.equal(isShopAutoFulfillAuthorized(resolved,"unconfigured-shop"), false);
});

test("static authorization file can authorize synchronized shops outside the legacy execution catalog", () => {
  const resolved = resolveFulfillmentConfig({ rootDir:process.cwd(),env:{ FULFILLMENT_AUTO_FULFILL_ENABLED:"true" } });
  assert.equal(isShopAutoFulfillAuthorized(resolved,"2021555509"), true);
  assert.equal(resolved.autoFulfillShopIds.includes("2021555509"), true);
  assert.match(resolved.autoFulfillAuthorizationPath, /fulfillment-auto-fulfill-shops\.json$/);
});

test("fulfillment dashboard proxy sanitizes account and shop policy writes", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl: async (url, options) => {
    calls.push({ url:String(url),options });
    return new Response(JSON.stringify({ success:true,data:{} }), { status:200 });
  }});
  const accountReq = Readable.from([JSON.stringify({ accountProfileId:"profile_1", password:"must-not-forward" })]);
  accountReq.method = "POST";
  assert.equal(await proxy(accountReq, proxyResponse(), new URL("http://localhost/api/fulfillment-dashboard/settings/account")), true);
  assert.deepEqual(JSON.parse(calls[0].options.body), { accountProfileId:"profile_1" });
  const policyReq = Readable.from([JSON.stringify({ mode:"manual",channelId:"c1",warehousePolicy:"allowlist",
    allowedWarehouses:["环亚","云雀"],minOrderAgeMinutes:10,maxBatchSize:2,unexpected:"drop-me" })]);
  policyReq.method = "PUT";
  assert.equal(await proxy(policyReq, proxyResponse(), new URL("http://localhost/api/fulfillment-dashboard/shops/2021485965/policy")), true);
  assert.equal(calls[1].url, "http://127.0.0.1:3112/api/fulfillment/shops/2021485965/policy");
  assert.deepEqual(JSON.parse(calls[1].options.body), { mode:"manual",channelId:"c1",warehousePolicy:"allowlist",
    allowedWarehouses:["环亚","云雀"],minOrderAgeMinutes:10,maxBatchSize:2 });
});

test("operational policies and synchronized channels persist in the fulfillment database", () => {
  const repository = new FulfillmentRepository();
  repository.initializeOperationalConfig([{ ...config, allowedWarehouses:["环亚"], minOrderAgeMinutes:10,
    configuredAutoFulfillEnabled:false }], "2026-08-03T01:00:00.000Z");
  const saved = repository.saveShopPolicy({ shopId:config.shopId,mode:"manual",channelId:config.channelId,
    warehousePolicy:"allowlist",allowedWarehouses:["环亚","云雀"],minOrderAgeMinutes:15,maxBatchSize:2 });
  assert.deepEqual(saved.allowedWarehouses, ["环亚","云雀"]);
  assert.equal(saved.version, 2);
  repository.replaceChannelCatalog([{ channelId:"new-channel",channelProviderId:"p2",channelLogisticsId:"l2",
    channelName:"J&T Indonesia",channelValue:"v2",platformId:"17",countryCode:"ID" }], "2026-08-03T02:00:00.000Z");
  assert.equal(repository.listChannelCatalog().find((channel) => channel.channelId === config.channelId).active, false);
  assert.equal(repository.listChannelCatalog({ activeOnly:true })[0].channelId, "new-channel");
  repository.initializeSyncedShops([{ shopId:"global-shop-1",shopName:"Thailand Shop",countryCode:"TH" }], "2026-08-03T03:00:00.000Z");
  const syncedPolicy = repository.getShopPolicy("global-shop-1");
  assert.equal(syncedPolicy.mode, "paused");
  assert.equal(syncedPolicy.maxBatchSize, 2);
  repository.initializeSyncedShops([{ shopId:"still-assigned",shopName:"Still Assigned" }], "2026-08-03T03:01:00.000Z");
  repository.saveShopPolicy({ shopId:"still-assigned",mode:"manual",channelId:"",warehousePolicy:"any_single_warehouse",
    allowedWarehouses:[],minOrderAgeMinutes:10,maxBatchSize:2 });
  assert.equal(repository.pauseShopPoliciesOutside(new Set(["still-assigned"]), { updatedAt:"2026-08-03T04:00:00.000Z" }), 1);
  assert.equal(repository.getShopPolicy(config.shopId).mode, "paused");
  assert.equal(repository.getShopPolicy("global-shop-1").mode, "paused");
  assert.equal(repository.getShopPolicy("still-assigned").mode, "manual");
  repository.close();
});

test("catalog discovery uses the live account shop scope instead of the old static whitelist", async () => {
  const workerPayloads = []; const fetchCalls = [];
  const source = createMabangFulfillmentCatalogSource({ rootDir:process.cwd(), config:{
    mabangUsername:"user",mabangPassword:"password",shops:[{ shopId:"old-shop" }],
  }, runWorker:async(payload)=>{ workerPayloads.push(payload); return payload.action === "inventory-warehouse-catalog"
    ? { catalog:{ options:[{ id:"warehouse-2",name:"ID Warehouse B" },{ id:"warehouse-1",name:"ID Warehouse A" }] } }
    : { shops:[{ shopId:"new-shop",shopName:"New from order page",platformId:"17",countryCode:"ID" }],channels:[] }; }, fetchImpl:async(url,options={})=>{
    fetchCalls.push({ url,options });
    if (url.endsWith("/session/login")) return new Response(JSON.stringify({ success:true }), { status:200 });
    if (url.includes("platform=shopee")) return new Response(JSON.stringify({ success:true,shops:[
      { id:"new-shop",name:"New",site:"ID" }, { id:"visible-but-unassigned",name:"Old Company Shop",site:"ID" },
    ] }), { status:200 });
    return new Response(JSON.stringify({ success:true,shops:[{ id:"lazada-unassigned",name:"Old Lazada Shop",site:"MY" }] }), { status:200 });
  } });
  const catalog = await source.sync();
  assert.equal(fetchCalls.length,3);
  const catalogPayload = workerPayloads.find((payload)=>payload.action === "fulfillment-catalog");
  assert.deepEqual(catalogPayload.shopIds,["new-shop","visible-but-unassigned","lazada-unassigned"]);
  assert.deepEqual(workerPayloads.map((payload)=>payload.action).sort(),["fulfillment-catalog","inventory-warehouse-catalog"]);
  assert.deepEqual(catalog.shops.map((shop)=>shop.shopId), ["new-shop"]);
  assert.equal(catalog.shops[0].shopName,"New");
  assert.deepEqual(catalog.warehouses,[{ id:"warehouse-1",name:"ID Warehouse A" },{ id:"warehouse-2",name:"ID Warehouse B" }]);
});

test("historical policy suggestions count orders once and keep shop platforms isolated", () => {
  const suggestions = inferFulfillmentPolicySuggestions([
    { 订单编号:"A-1",店铺名:"MY Shop",平台:"Shopee",物流渠道:"MY J&T",仓库:"MY-A",付款时间:"2026-08-01 10:00:00",SKU:"1" },
    { 订单编号:"A-1",店铺名:"MY Shop",平台:"Shopee",物流渠道:"MY J&T",仓库:"MY-A",付款时间:"2026-08-01 10:00:00",SKU:"2" },
    { 订单编号:"A-2",店铺名:"MY Shop",平台:"Shopee",物流渠道:"MY J&T",仓库:"MY-B",付款时间:"2026-08-02 10:00:00" },
    { 订单编号:"A-3",店铺名:"MY Shop",平台:"Lazada",物流渠道:"wrong",仓库:"wrong" },
    { 订单编号:"B-1",店铺名:"Lazada Shop",平台:"Lazada",物流渠道:"Lazada Express",仓库:"LAZ-A" },
  ], [
    { shopId:"shop-my",shopName:"MY Shop",platform:"Shopee" },
    { shopId:"shop-laz",shopName:"Lazada Shop",platform:"Lazada" },
  ], { scannedAt:"2026-08-06T00:00:00.000Z",lookbackDays:30 });
  const shopee = suggestions.find((item) => item.shopId === "shop-my");
  assert.equal(shopee.orderCount,2);
  assert.equal(shopee.channel.name,"MY J&T");
  assert.equal(shopee.channel.confidence,1);
  assert.deepEqual(shopee.warehouses.map((item) => item.name),["MY-B","MY-A"]);
  assert.equal(suggestions.find((item) => item.shopId === "shop-laz").channel.name,"Lazada Express");
});

test("policy suggestion scan reads order history and the complete inventory warehouse directory without saving policies", async () => {
  const actions = [];
  const source = createMabangPolicySuggestionSource({ rootDir:process.cwd(), config:{ mabangUsername:"user",mabangPassword:"password" },
    shops:[],runWorker:async(payload)=>{
      actions.push(payload.action);
      if (payload.action === "inventory") return { records:[{ 仓库:"Global Warehouse" }] };
      return { records:[{ 订单编号:"A-1",店铺名:"New Shop",平台:"Shopee",物流渠道:"MY J&T",仓库:"Order Warehouse" }] };
    } });
  const result = await source.scan({ lookbackDays:30,selectedShops:[
    { shopId:"new-shop",shopName:"New Shop",platform:"Shopee" },
  ] });
  assert.deepEqual(actions.sort(),["inventory","orders"]);
  assert.deepEqual(result.warehouses,["Global Warehouse","Order Warehouse"]);
  assert.equal(result.suggestions[0].status,"ready_for_review");
  assert.equal(result.warehouseCatalogComplete,true);
});

test("dashboard proxy exposes the bounded policy suggestion scan route", async () => {
  const calls = [];
  const proxy = createFulfillmentDashboardProxy({ fetchImpl:async(url,options)=>{
    calls.push({ url:String(url),options });
    return new Response(JSON.stringify({ success:true,data:{} }), { status:200 });
  } });
  const request = Readable.from([JSON.stringify({ lookbackDays:999,unexpected:"drop" })]); request.method = "POST";
  assert.equal(await proxy(request,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/policy-suggestions/scan")),true);
  assert.equal(calls[0].url,"http://127.0.0.1:3112/api/fulfillment/policy-suggestions/scan");
  assert.equal(calls[0].options.body,"{}");
  const confirmRequest = Readable.from([JSON.stringify({ shopIds:["2021555509","2021555509"],mode:"auto",unexpected:"drop" })]);
  confirmRequest.method = "POST";
  assert.equal(await proxy(confirmRequest,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/policy-suggestions/confirm")),true);
  assert.equal(calls[1].url,"http://127.0.0.1:3112/api/fulfillment/policy-suggestions/confirm");
  assert.deepEqual(JSON.parse(calls[1].options.body),{ shopIds:["2021555509"] });
  const importRequest = Readable.from([JSON.stringify({ filename:"config.xlsx",fileBase64:"YWJj",allowOverwrite:true,unexpected:"drop" })]);
  importRequest.method = "POST";
  assert.equal(await proxy(importRequest,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/policy-imports/preview")),true);
  assert.equal(calls[2].url,"http://127.0.0.1:3112/api/fulfillment/policy-imports/preview");
  assert.deepEqual(JSON.parse(calls[2].options.body),{ filename:"config.xlsx",fileBase64:"YWJj",allowOverwrite:true });
  const importConfirm = Readable.from([JSON.stringify({ previewId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",rowIds:["1","1","2"],unexpected:"drop" })]);
  importConfirm.method = "POST";
  assert.equal(await proxy(importConfirm,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/policy-imports/confirm")),true);
  assert.deepEqual(JSON.parse(calls[3].options.body),{ previewId:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",rowIds:["1","2"] });
  const batchPolicy = Readable.from([JSON.stringify({ shopIds:["2021555509","2021555509","2021557615"],
    patch:{ mode:"manual",minOrderAgeMinutes:2,maxBatchSize:5,channelId:"should-drop" },unexpected:"drop" })]);
  batchPolicy.method = "POST";
  assert.equal(await proxy(batchPolicy,proxyResponse(),new URL("http://localhost/api/fulfillment-dashboard/shop-policies/batch")),true);
  assert.equal(calls[4].url,"http://127.0.0.1:3112/api/fulfillment/shop-policies/batch");
  assert.deepEqual(JSON.parse(calls[4].options.body),{ shopIds:["2021555509","2021557615"],patch:{ mode:"manual",minOrderAgeMinutes:2,maxBatchSize:5 } });
  const invalidWait = Readable.from([JSON.stringify({ shopIds:["2021555509"],patch:{ minOrderAgeMinutes:1 } })]);
  invalidWait.method = "POST"; const invalidWaitResponse = proxyResponse();
  assert.equal(await proxy(invalidWait,invalidWaitResponse,new URL("http://localhost/api/fulfillment-dashboard/shop-policies/batch")),true);
  assert.equal(invalidWaitResponse.status,400);
  assert.equal(calls.length,5);
});

test("spreadsheet policy import parses required columns and only marks exact current catalog matches ready", () => {
  const csv = Buffer.from(`店编,马帮店名,平台,国家,对应物流渠道,对应仓库\nMS0561,Sunfay.MY,Shopee,马来,马来鲸速家具仓-1308[shopeeV2线上发货(新)],马来腾展-A仓-1308\nMS0000,Missing,Shopee,马来,,`);
  const parsed = parseFulfillmentPolicyWorkbook({ filename:"config.csv",buffer:csv });
  assert.equal(parsed.rows.length,2);
  assert.equal(parsed.rows[0].shopCode,"MS0561");
  const rows = buildFulfillmentPolicyImportPreview({ rows:parsed.rows,
    shops:new Map([["2021555509",{ shopId:"2021555509",shopName:"Sunfay.MY",platform:"Shopee",platformId:"17",countryCode:"MY" }]]),
    channels:[{ channelId:"1131396",channelName:"马来鲸速家具仓-1308",logisticsName:"shopeeV2线上发货(新)",platformId:"",countryCode:"MY",active:true }],
    warehouseOptions:["马来腾展-A仓-1308"], policies:new Map([["2021555509",{ shopId:"2021555509",mode:"paused",channelId:"",warehousePolicy:"allowlist",allowedWarehouses:[],minOrderAgeMinutes:10,maxBatchSize:2,version:1,updatedBy:"catalog_sync" }]]),
    hasAccess:()=>true });
  assert.equal(rows[0].ready,true);
  assert.equal(rows[0].shopId,"2021555509");
  assert.equal(rows[0].channelId,"1131396");
  assert.deepEqual(rows[0].warehouses,["马来腾展-A仓-1308"]);
  assert.equal(rows[1].ready,false);
  assert.match(rows[1].issues.join(" "),/未找到对应店铺/);
});

test("spreadsheet policy import keeps Best Express and BEST Express as different channels", () => {
  const imported = buildFulfillmentPolicyImportPreview({ rows:[
    { sourceRow:2,shopCode:"A",shopName:"Shop A",platform:"Shopee",country:"TH",
      channel:"Best Express[shopee线上发货]",warehouses:"泰国KJ-A仓-1308" },
    { sourceRow:3,shopCode:"B",shopName:"Shop B",platform:"Shopee",country:"TH",
      channel:"BEST Express [shopee线上发货]",warehouses:"泰国KJ-A仓-1308" },
    { sourceRow:4,shopCode:"C",shopName:"Shop C",platform:"Shopee",country:"TH",
      channel:"best express[shopee线上发货]",warehouses:"泰国KJ-A仓-1308" },
  ],shops:[
    { shopId:"A",shopName:"Shop A",platform:"Shopee",platformId:"17",countryCode:"TH" },
    { shopId:"B",shopName:"Shop B",platform:"Shopee",platformId:"17",countryCode:"TH" },
    { shopId:"C",shopName:"Shop C",platform:"Shopee",platformId:"17",countryCode:"TH" },
  ],channels:[
    { channelId:"1027036",channelName:"Best Express",logisticsName:"shopee线上发货",platformId:"",countryCode:"TH",active:true },
    { channelId:"1056705",channelName:"BEST Express",logisticsName:"shopee线上发货",platformId:"",countryCode:"TH",active:true },
  ],warehouseOptions:["泰国KJ-A仓-1308"],policies:[
    { shopId:"A",version:1,updatedBy:"catalog_sync" },
    { shopId:"B",version:1,updatedBy:"catalog_sync" },
    { shopId:"C",version:1,updatedBy:"catalog_sync" },
  ],hasAccess:()=>true });
  assert.equal(imported[0].channelId,"1027036");
  assert.equal(imported[1].channelId,"1056705");
  assert.equal(imported[2].ready,false);
  assert.match(imported[2].issues.join(" "),/未匹配到有效物流渠道/);
});

test("batch suggestion confirmation plans only unreviewed complete and accessible shop configs", () => {
  const basePolicy = { mode:"paused",channelId:"",warehousePolicy:"any_single_warehouse",allowedWarehouses:[],
    minOrderAgeMinutes:10,maxBatchSize:2 };
  const plan = planFulfillmentPolicySuggestionConfirmations({ shopIds:["1","2","3","4"],
    shops:[
      { shopId:"1",platformId:"17",countryCode:"MY" }, { shopId:"2",platformId:"17",countryCode:"MY" },
      { shopId:"3",platformId:"17",countryCode:"MY" }, { shopId:"4",platformId:"17",countryCode:"MY" },
    ],policies:[
      { ...basePolicy,shopId:"1",updatedBy:"catalog_sync" }, { ...basePolicy,shopId:"2",updatedBy:"operator" },
      { ...basePolicy,shopId:"3",updatedBy:"catalog_sync" }, { ...basePolicy,shopId:"4",updatedBy:"catalog_sync" },
    ],suggestions:[
      { shopId:"1",channel:{ name:"Best Express" },warehouses:[{ name:"MY-A" }] },
      { shopId:"2",channel:{ name:"Best Express" },warehouses:[{ name:"MY-A" }] },
      { shopId:"3",channel:{ name:"Unknown" },warehouses:[{ name:"MY-A" }] },
      { shopId:"4",channel:{ name:"Best Express" },warehouses:[{ name:"MY-A" }] },
    ],channels:[{ channelId:"1056705",channelName:"Best Express",logisticsName:"",platformId:"17",countryCode:"MY",active:true }],
    hasAccess:(shopId)=>shopId !== "4" });
  assert.deepEqual(plan.changes.map((item)=>item.shopId),["1"]);
  assert.equal(plan.changes[0].channelId,"1056705");
  assert.deepEqual(plan.changes[0].allowedWarehouses,["MY-A"]);
  assert.deepEqual(plan.skipped,[
    { shopId:"2",reason:"ALREADY_REVIEWED" }, { shopId:"3",reason:"SUGGESTION_INCOMPLETE" },
    { shopId:"4",reason:"SHOP_ACCESS_REVOKED" },
  ]);
});

test("historical policy suggestions preserve channel-name casing", () => {
  const basePolicy = { shopId:"1",mode:"paused",channelId:"",warehousePolicy:"any_single_warehouse",
    allowedWarehouses:[],minOrderAgeMinutes:10,maxBatchSize:2,updatedBy:"catalog_sync" };
  const plan = planFulfillmentPolicySuggestionConfirmations({ shopIds:["1"],
    shops:[{ shopId:"1",platformId:"17",countryCode:"TH" }],policies:[basePolicy],
    suggestions:[{ shopId:"1",channel:{ name:"BEST Express" },warehouses:[{ name:"TH-A" }] }],
    channels:[
      { channelId:"1027036",channelName:"Best Express",logisticsName:"shopee线上发货",platformId:"17",countryCode:"TH",active:true },
      { channelId:"1056705",channelName:"BEST Express",logisticsName:"shopee线上发货",platformId:"17",countryCode:"TH",active:true },
    ],hasAccess:()=>true });
  assert.equal(plan.changes[0].channelId,"1056705");
});

test("automatic preview defers immature orders and fails closed when payment time is missing", async () => {
  const repository = new FulfillmentRepository();
  const service = new FulfillmentService({ config:{ ...config,minOrderAgeMinutes:10 },repository,
    source:{ listPending:async()=>[
      { ...order,订单编号:"M-MATURE",交易编号:"S-MATURE",付款时间:"2026-07-29 09:30:00" },
      { ...order,订单编号:"M-NEW",交易编号:"S-NEW",付款时间:"2026-07-29 09:55:00" },
      { ...order,订单编号:"M-UNKNOWN",交易编号:"S-UNKNOWN" },
    ] },executor:{},now:()=>new Date("2026-07-29T02:00:00.000Z") });
  const preview = await service.createPreview({ limit:10 });
  assert.deepEqual(preview.eligibleOrders.map((item) => item.displayOrderId), ["S-MATURE"]);
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-NEW").exclusions.includes("ORDER_NOT_MATURE"), true);
  assert.equal(preview.excludedOrders.find((item) => item.displayOrderId === "S-UNKNOWN").exclusions.includes("ORDER_AGE_UNKNOWN"), true);
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
    channelValue:"1143663_1023359_fixed_1591", channelSource:"1", verificationTimeoutSeconds:90,
    trackingWaitTimeoutSeconds:30, distributionVerifyTimeoutSeconds:12 };
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
  assert.equal(workerPayload.trackingWaitTimeoutSeconds, 30);
  assert.equal(workerPayload.distributionVerifyTimeoutSeconds, 12);
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

test("real executor treats gift warehouse plus one fulfillment warehouse as safe single-warehouse", async () => {
  let workerPayload;
  const normalWarehouse = "马来SN-A仓-1308";
  const executor = createMabangFulfillmentExecutor({ config:{ ...config,channelValue:"fixed",channelSource:"1",
    allowedWarehouses:[normalWarehouse],verificationTimeoutSeconds:15 },rootDir:process.cwd(),runWorker:async(payload)=>{
      workerPayload = payload;
      return { verified:true,trackingNumber:"TRACK-GIFT",afterStatus:"配货中" };
    } });
  const result = await executor.fulfill({
    order:{ tradeNumber:"S-GIFT",warehouse:`${normalWarehouse} / 赠品SKU仓`,warehouses:[normalWarehouse,"赠品SKU仓"],
      stockStatus:"in_stock",eligible:true,snapshot:{ shopName:config.shopName,orderStatus:config.pendingStatus,
        sourceOrderId:"M-GIFT",warehouses:[normalWarehouse,"赠品SKU仓"] } },
    channel:{ id:config.channelId,providerId:config.channelProviderId },
  });
  assert.equal(workerPayload.singleWarehouseVerified, true);
  assert.equal(result.verified, true);
});

test("real executor blocks a gift-only order before worker submission", async () => {
  const executor = createMabangFulfillmentExecutor({ config:{ ...config,channelValue:"fixed",channelSource:"1",
    verificationTimeoutSeconds:15 },rootDir:process.cwd(),runWorker:async()=>assert.fail("gift-only order must not reach worker") });
  await assert.rejects(executor.fulfill({
    order:{ tradeNumber:"S-GIFT-ONLY",warehouse:"赠品SKU仓",warehouses:["赠品SKU仓"],stockStatus:"in_stock",eligible:true,
      snapshot:{ shopName:config.shopName,orderStatus:config.pendingStatus,sourceOrderId:"M-GIFT-ONLY",warehouses:["赠品SKU仓"] } },
    channel:{ id:config.channelId,providerId:config.channelProviderId },
  }), { code:"GIFT_ONLY_ORDER_NOT_ALLOWED" });
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

test("real executor preserves the existing-tracking safety code", async () => {
  const executorConfig = { ...config,channelValue:"fixed",channelSource:"1",verificationTimeoutSeconds:30 };
  const executor = createMabangFulfillmentExecutor({ config:executorConfig,rootDir:process.cwd(),runWorker:async()=>{
    throw new Error("ALREADY_HAS_TRACKING_NUMBER: 订单已经存在运单号");
  } });
  await assert.rejects(executor.fulfill({
    order:{ tradeNumber:"S-1",warehouse:"印尼泗水云雀-A仓-1308",warehouses:["印尼泗水云雀-A仓-1308"],
      stockStatus:"in_stock",eligible:true,
      snapshot:{ sourceOrderId:"M-1",shopName:"JOJO Mall",orderStatus:"待处理",warehouses:["印尼泗水云雀-A仓-1308"] } },
    channel:{ id:"1143663",providerId:"1023359" },
  }), { code:"ALREADY_HAS_TRACKING_NUMBER" });
});

test("confirmation isolates an out-of-stock order found during batch revalidation", async () => {
  const repository = new FulfillmentRepository();
  const initial = [order, { ...order, 订单编号:"M-2",交易编号:"S-2" }];
  let executorCalls = 0;
  const source = { listPending:async()=>initial, getByIds:async()=>[initial[0], { ...initial[1], 商品库存:0 }] };
  const service = new FulfillmentService({ config:{ ...config, realSubmitEnabled:true }, repository, source,
    executor:{ fulfill:async()=>{ executorCalls += 1; return { verified:true,trackingNumber:"TRACK-OK",afterStatus:"配货中" }; } } });
  const preview = await service.createPreview({ limit:2 });
  const batch = await service.confirmPreview(preview.previewId, preview.confirmationToken);
  assert.equal(batch.status, "partial_success");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-1").status, "success");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-2").errorCode, "OUT_OF_STOCK_BEFORE_SUBMIT");
  assert.equal(executorCalls, 1);
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

test("an existing tracking number is distributed without resubmission and does not stop later orders", async () => {
  const repository = new FulfillmentRepository();
  const initial = [order,{ ...order,订单编号:"M-2",交易编号:"S-2" }];
  const executorCalls = []; const inspections = []; const distributions = [];
  const executor = { fulfill:async({ order:current })=>{
    executorCalls.push(current.tradeNumber);
    if (current.tradeNumber === "S-1") {
      throw Object.assign(new Error("已有运单号"),{ code:"ALREADY_HAS_TRACKING_NUMBER" });
    }
    return { verified:true,trackingNumber:"TRACK-S-2",afterStatus:"配货中" };
  } };
  const trackingRecovery = {
    inspect:async(reference)=>{ inspections.push(reference); return {
      trackingNumber:"TRACK-EXISTING",orderStatus:"待处理",shippingRecordPending:false }; },
    distribute:async(reference,trackingNumber)=>{ distributions.push([reference,trackingNumber]); return {
      verified:true,trackingNumber,afterStatus:"配货中" }; },
  };
  const service = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,orderConcurrency:1,
    trackingRecoveryCheckSeconds:60,trackingRecoveryDeadlineHours:24 },repository,
    source:{ listPending:async()=>initial,getByIds:async()=>initial },executor,trackingRecovery });
  const preview = await service.createPreview({ limit:2 });
  const batch = await service.confirmPreview(preview.previewId,preview.confirmationToken);
  assert.equal(batch.status,"success");
  assert.deepEqual(executorCalls,["S-1","S-2"]);
  assert.deepEqual(inspections,["S-1"]);
  assert.deepEqual(distributions,[["S-1","TRACK-EXISTING"]]);
  assert.equal(batch.orders.every((item)=>item.status === "success"),true);
  assert.equal(batch.orders.find((item)=>item.displayOrderId === "S-1").timings.existingTrackingReused,true);
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

test("global automatic fulfillment switch blocks new and already queued dispatches", async () => {
  const finished = []; let enqueued = 0; let nextDispatch = { id:7,previewId:"P-7",shopId:"1" };
  const service = { config:{ shopId:"1",shopName:"Arca Woods",mode:"auto",autoFulfillEnabled:true },
    getActiveBatch:()=>null,getNextQueuedDispatch:()=>{ const value = nextDispatch; nextDispatch = null; return value; },
    finishDispatch:(...args)=>finished.push(args),listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    getDispatchQueueStatus:()=>({ queued:1,running:0 }),
    enqueueQueuedPreview:()=>{ enqueued += 1; } };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,autoFulfillEnabled:false,
    schedulerIntervalSeconds:300,maxBatchSize:10 },service,services:[service] });
  const queued = scheduler.queueAutoPreview({ ...service,queuePreviewDispatch:()=>{ enqueued += 1; } },
    { previewId:"P-NEW",eligibleOrders:[{}] },"Arca Woods");
  assert.equal(queued,null);
  await scheduler.drainDispatchQueue();
  assert.equal(enqueued,0);
  assert.equal(finished[0][0],7);
  assert.equal(finished[0][1],"failed");
  assert.equal(finished[0][2],"SHOP_AUTO_FULFILL_DISABLED");
  assert.deepEqual(scheduler.status().autoFulfillShops,[]);
});

test("scheduler skips paused shops and applies the per-shop batch limit", async () => {
  const calls = [];
  const shared = { getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],recordScanRun:()=>{},
    getLatestPendingPreview:()=>null,autoRecoverManualReviews:async()=>({ checked:0 }) };
  const services = [
    { ...shared,config:{ shopName:"Paused",shopId:"1",mode:"paused",maxBatchSize:10 },
      createPreview:async()=>{ calls.push(["paused"]); } },
    { ...shared,config:{ shopName:"Manual",shopId:"2",mode:"manual",maxBatchSize:2 },
      createPreview:async(options)=>{ calls.push(["manual",options.limit]); return { previewId:"P-2",shop:{ id:"2",name:"Manual" },
        eligibleOrders:[],excludedOrders:[] }; } },
  ];
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,schedulerIntervalSeconds:300,maxBatchSize:10 },
    service:services[0],services });
  await scheduler.scanNow();
  assert.deepEqual(calls, [["manual",2]]);
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
  assert.deepEqual(scanCalls, [{ shopIds:["1","2"],limit:50 }]);
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

test("scheduler scans every enabled shop instead of waiting five minutes after the first candidate", async () => {
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
  assert.deepEqual(calls, ["Arca Woods","Toko Penguin"]);
  assert.deepEqual(batches, [{ previewId:"AUTO-P",token:"AUTO-T" },{ previewId:"P-2",token:"T-2" }]);
  assert.equal(result.lastOutcome, "auto_fulfillment_started");
  assert.deepEqual(result.autoBatch, { id:"AUTO-B",shopName:"Arca Woods",orderCount:1,status:"queued" });
  assert.equal(result.queuedAutoBatches.length,2);
  assert.equal(result.lastMessage,"已扫描全部店铺，2 个店铺的 2 个批次共 2 单已按旧单优先追加到自动发货队列；首批为 Arca Woods。");
});

test("scheduler queues backlog batches round-robin with the shop holding the oldest order first", async () => {
  const queued = [];
  const shared = { getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    recordScanRun:()=>{},getLatestPendingPreview:()=>null };
  const makePreview = (shopId,shopName,id,paidAt)=>({ previewId:id,oldestEligiblePaidAt:paidAt,
    shop:{ id:shopId,name:shopName },eligibleOrders:[{ displayOrderId:id }],excludedOrders:[] });
  const services = [
    { ...shared,config:{ shopName:"Arca Woods",shopId:"1",autoFulfillEnabled:true,maxBatchSize:1 },
      createBacklogPreviewsFromRecords:()=>[
        makePreview("1","Arca Woods","A-1","2026-07-20 10:00:00"),
        makePreview("1","Arca Woods","A-2","2026-07-20 10:01:00")],
      queuePreviewDispatch:(id)=>{ queued.push(id); return { id:queued.length,status:"queued" }; } },
    { ...shared,config:{ shopName:"Toko Penguin",shopId:"2",autoFulfillEnabled:true,maxBatchSize:1 },
      createBacklogPreviewsFromRecords:()=>[
        makePreview("2","Toko Penguin","T-1","2026-07-20 09:00:00"),
        makePreview("2","Toko Penguin","T-2","2026-07-20 09:01:00")],
      queuePreviewDispatch:(id)=>{ queued.push(id); return { id:queued.length,status:"queued" }; } },
  ];
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10,backlogBatchesPerScan:5 },service:services[0],services,
    scanSource:{ listPendingByShop:async()=>new Map([["1",[]],["2",[]]]) } });
  const result = await scheduler.scanNow();
  assert.deepEqual(queued,["T-1","A-1","T-2","A-2"]);
  assert.equal(result.queuedAutoBatches.length,4);
  assert.equal(result.autoBatch.shopName,"Toko Penguin");
});

test("persistent dispatch queue runs shop batches serially and continues immediately", async () => {
  const repository = new FulfillmentRepository();
  let executing = 0; let maxExecuting = 0; const completed = [];
  const makeService = (shopId, shopName, tradeNumber) => {
    const row = { ...order, 店铺名:shopName, 交易编号:tradeNumber, 订单编号:`M-${tradeNumber}` };
    return new FulfillmentService({ config:{ ...config,shopId,shopName,realSubmitEnabled:true,
      autoFulfillEnabled:true,mode:"auto",minOrderAgeMinutes:0 },repository,
      source:{ listPending:async()=>[row],getByIds:async()=>[row] },executor:{ fulfill:async()=>{
        executing += 1; maxExecuting = Math.max(maxExecuting,executing);
        await new Promise((resolve)=>setTimeout(resolve,5));
        completed.push(shopId); executing -= 1;
        return { verified:true,trackingNumber:`TRACK-${shopId}`,afterStatus:"配货中" };
      } } });
  };
  const services = [makeService("shop-1","Shop One","S-1"),makeService("shop-2","Shop Two","S-2")];
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10 },service:services[0],services });
  const result = await scheduler.scanNow();
  assert.equal(result.createdPreviews.length,2);
  await scheduler.waitForIdle();
  const queue = services[0].getDispatchQueueStatus();
  assert.equal(queue.queued,0);
  assert.equal(queue.running,0);
  assert.equal(queue.completed,2);
  assert.deepEqual(completed,["shop-1","shop-2"]);
  assert.equal(maxExecuting,1);
  assert.equal(repository.listRecentBatches().filter((batch)=>batch.status === "success").length,2);
  repository.close();
});

test("restart reconciliation marks an already distributed order successful without resubmitting", async () => {
  const repository = new FulfillmentRepository();
  const base = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,
    source:{ listPending:async()=>[order] },executor:{} });
  const preview = await base.createPreview();
  const { batch } = base.createConfirmedBatch(preview.previewId, preview.confirmationToken);
  repository.recoverInterruptedBatches("2026-07-28T00:00:00.000Z");
  let inspections = 0;
  const recovered = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,
      trackingRecoveryCheckSeconds:300,trackingRecoveryDeadlineHours:24 },repository,
    source:{ getByIds:async()=>[] },executor:{ fulfill:async()=>{ throw new Error("must not submit"); } },
    trackingRecovery:{ inspectState:async()=>{ inspections += 1; return { shopId:config.shopId,
      platformId:config.platformId,orderStatus:"配货中",trackingNumber:"TRACK-RECOVERED" }; } } });
  const result = await recovered.reconcileInterruptedOrders();
  assert.equal(inspections,1);
  assert.deepEqual(result.completed,[{ orderId:"S-1",status:"配货中" }]);
  assert.equal(repository.getBatch(batch.id).orders[0].status,"success");
  assert.equal(repository.getBatch(batch.id).orders[0].trackingNumberMasked,"TRAC****ERED");
  repository.close();
});

test("restart reconciliation moves an order with submission evidence to tracking recovery", async () => {
  const repository = new FulfillmentRepository();
  const base = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true },repository,
    source:{ listPending:async()=>[order] },executor:{} });
  const preview = await base.createPreview();
  const { batch } = base.createConfirmedBatch(preview.previewId, preview.confirmationToken);
  repository.recoverInterruptedBatches("2026-07-28T00:00:00.000Z");
  const recovered = new FulfillmentService({ config:{ ...config,realSubmitEnabled:true,
      trackingRecoveryCheckSeconds:300,trackingRecoveryDeadlineHours:24 },repository,
    source:{ getByIds:async()=>[] },executor:{},trackingRecovery:{ inspectState:async()=>({ shopId:config.shopId,
      platformId:config.platformId,orderStatus:"待处理",trackingNumber:"",shippingRecordPending:true }) } });
  const result = await recovered.reconcileInterruptedOrders();
  assert.equal(result.trackingRecovery[0].status,"tracking_pending");
  assert.equal(repository.getBatch(batch.id).orders[0].errorCode,"TRACKING_NUMBER_PENDING");
  assert.equal(repository.listTrackingRecoveries(10,config.shopId)[0].status,"waiting_tracking");
  repository.close();
});

test("a safely failed shop batch does not block the next dispatch", async () => {
  const repository = new FulfillmentRepository();
  const completed = [];
  const makeService = (shopId, shouldFail) => {
    const row = { ...order, 店铺名:`Shop ${shopId}`,交易编号:`S-${shopId}`,订单编号:`M-${shopId}` };
    return new FulfillmentService({ config:{ ...config,shopId,shopName:`Shop ${shopId}`,realSubmitEnabled:true,
      autoFulfillEnabled:true,mode:"auto",minOrderAgeMinutes:0 },repository,
      source:{ listPending:async()=>[row],getByIds:async()=>[row] },executor:{ fulfill:async()=>{
        completed.push(shopId);
        if (shouldFail) throw Object.assign(new Error("temporary shop failure"),{ code:"SHOP_TEMPORARY_FAILURE" });
        return { verified:true,trackingNumber:`TRACK-${shopId}`,afterStatus:"配货中" };
      } } });
  };
  const services = [makeService("1",true),makeService("2",false)];
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:false,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10 },service:services[0],services });
  await scheduler.scanNow();
  await scheduler.waitForIdle();
  const queue = services[0].getDispatchQueueStatus();
  assert.deepEqual(completed,["1","2"]);
  assert.equal(queue.failed,1);
  assert.equal(queue.completed,1);
  assert.equal(scheduler.status().dispatchQueue.paused,false);
  repository.close();
});

test("catch-up mode starts for a large backlog and exits only after the queue is drained", () => {
  const notifications = [];
  const scheduler = new FulfillmentPreviewScheduler({ config:{ catchUpEnabled:true,catchUpThresholdOrders:20,
      catchUpLowWaterOrders:10,catchUpMaxWaitMinutes:30,dispatchFailureCircuitThreshold:3 },
    service:{ getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],getDispatchQueueStatus:()=>({}) },
    notifier:{ notify:(message)=>notifications.push(message) },now:()=>new Date("2026-08-08T10:00:00.000Z") });
  scheduler.updateCatchUp({ detectedOrders:20,oldestOrderAt:"2026-08-08T09:50:00.000Z",queueOrders:20 });
  assert.equal(scheduler.catchUp.active,true);
  assert.equal(scheduler.finishCatchUpIfDrained({ detectedOrders:0,queueOrders:1 }),false);
  assert.equal(scheduler.finishCatchUpIfDrained({ detectedOrders:0,queueOrders:0 }),true);
  assert.equal(scheduler.catchUp.active,false);
  assert.deepEqual(notifications.map((item)=>item.title),["自动发货进入积压恢复","自动发货积压已清空"]);
});

test("three consecutive dispatch failures trip the circuit breaker and resume clears it", () => {
  const scheduler = new FulfillmentPreviewScheduler({ config:{ dispatchFailureCircuitThreshold:3 },
    service:{ getActiveBatch:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],getDispatchQueueStatus:()=>({}) } });
  assert.equal(scheduler.recordDispatchFailure("TEMPORARY_FAILURE","one"),false);
  assert.equal(scheduler.recordDispatchFailure("TEMPORARY_FAILURE","two"),false);
  assert.equal(scheduler.recordDispatchFailure("TEMPORARY_FAILURE","three"),true);
  assert.equal(scheduler.dispatchPaused,true);
  scheduler.resumeDispatch();
  assert.equal(scheduler.dispatchPaused,false);
  assert.equal(scheduler.consecutiveDispatchFailures,0);
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

test("confirmation isolates a deterministic stock failure and continues later orders", async () => {
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
  assert.equal(executorCalls, 3);
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-1").status, "success");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-2").status, "needs_attention");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-2").errorCode, "OUT_OF_STOCK_BEFORE_SUBMIT");
  assert.equal(batch.orders.find((item) => item.displayOrderId === "S-3").status, "success");
  const repeatedPreview = await service.createPreview({ limit:3 });
  assert.equal(repeatedPreview.eligibleOrders.length, 0);
  assert.equal(repeatedPreview.excludedOrders.every((item) => item.exclusions.includes("ALREADY_FULFILLED")), true);
  repository.close();
});

test("scheduler performs an independent read-only scan while a batch is active", async () => {
  const activeBatch = { id:"BATCH-ACTIVE",status:"running",createdAt:"2026-07-28T00:00:00.000Z" };
  const scans = []; const queued = []; let recoveryCalls = 0;
  const service = { config:{ shopId:"1",shopName:"Active Shop",autoFulfillEnabled:true },
    getActiveBatch:()=>activeBatch,getLatestPendingPreview:()=>null,getDispatchByPreview:()=>null,
    listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],recordScanRun:(run)=>scans.push(run),
    recoverPendingTrackingNumbers:async()=>{ recoveryCalls += 1; },
    createPreviewFromRecords:()=>({ previewId:"P-NEW",shop:{ id:"1",name:"Active Shop" },
      eligibleOrders:[{ displayOrderId:"S-NEW" }],excludedOrders:[] }),
    queuePreviewDispatch:(previewId)=>{ queued.push(previewId); return { id:1,status:"queued" }; },
  };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:true,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10 },service,services:[service],
    scanSource:{ listPendingByShop:async()=>new Map([["1",[{ ...order,店铺名:"Active Shop" }]]]) } });
  const result = await scheduler.scanNow();
  assert.equal(result.lastOutcome,"auto_fulfillment_started");
  assert.deepEqual(queued,["P-NEW"]);
  assert.equal(recoveryCalls,0);
  assert.equal(scans[0].message.includes("独立只读扫描"),true);
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

test("unlocked Mabang reads retain complete SKU groups for the oldest candidate orders", async () => {
  const records = Array.from({ length:22 }, (_, index) => ({ ...order,订单编号:`M-${index}`,交易编号:`S-${index}`,
    付款时间:`2026-07-${String(index + 1).padStart(2,"0")} 10:00:00` }));
  records.push({ ...records[0],SKU:"SKU-SECOND" });
  const sourceConfig = { ...config,mabangUsername:"local-user",mabangPassword:"local-password",lookbackDays:3 };
  const source = createMabangFulfillmentSource({ config:sourceConfig,rootDir:process.cwd(),runWorker:async()=>({ records }) });
  const result = await source.listPending({ limit:1 });
  assert.equal(new Set(result.map((row)=>row["订单编号"])).size, 20);
  assert.equal(result.filter((row)=>row["订单编号"] === "M-0").length, 2);
  assert.equal(result.some((row)=>row["订单编号"] === "M-21"), false);
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

test("message-review adapter separates read-only candidates from confirmed recovery", async () => {
  const calls = [];
  const recovery = createMabangMessageReviewRecovery({
    config:{ ...config,mabangUsername:"local-user",mabangPassword:"local-password",messageReviewRecoveryLimit:3 },
    shops:[{ shopId:"2021485965",shopName:"JOJO Mall",platformId:"17",mode:"auto" }],rootDir:process.cwd(),
    runWorker:async(payload)=>{
      calls.push(payload);
      if (payload.action === "fulfillment-message-review-candidates") return { records:[{
        platformOrderId:"S-REVIEW",shopId:"2021485965",eligible:true,exclusions:[],
      }] };
      return { platformOrderId:"S-REVIEW",shopId:"2021485965",movedToPending:true,afterStatus:"待处理" };
    },
  });

  const candidates = await recovery.listCandidates({ limit:99 });
  const recovered = await recovery.recover("S-REVIEW");

  assert.equal(candidates.length,1);
  assert.equal(calls[0].action,"fulfillment-message-review-candidates");
  assert.equal(calls[0].limit,10);
  assert.equal(Object.hasOwn(calls[0],"commit"),false);
  assert.equal(calls[1].action,"fulfillment-message-review-recover");
  assert.equal(calls[1].commit,"MESSAGE_REVIEW_RECOVERY_CONFIRMED");
  assert.equal(recovered.movedToPending,true);
});

test("message-review automatic recovery is disabled by default", async () => {
  let recoveryCalls = 0;
  const service = { config:{ shopId:"1",shopName:"JOJO Mall",mode:"manual",autoFulfillEnabled:false },
    getActiveBatch:()=>null,getLatestPendingPreview:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    recordScanRun:()=>{},recoverPendingTrackingNumbers:async()=>({ checked:0 }),
    autoRecoverManualReviews:async()=>({ checked:0 }),
    createPreview:async()=>({ previewId:"P",shop:{ id:"1",name:"JOJO Mall" },eligibleOrders:[],excludedOrders:[] }) };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:true,schedulerIntervalSeconds:300,
    maxBatchSize:10,messageReviewRecoveryEnabled:false,messageReviewRecoveryIntervalMinutes:30 },service,services:[service],
    messageReviewRecovery:{ run:async()=>{ recoveryCalls += 1; return { checked:0,moved:[],results:[] }; } } });

  await scheduler.scanNow();
  assert.equal(recoveryCalls,0);
  assert.equal(scheduler.status().messageReviewRecoveryEnabled,false);
});

test("message-review automatic recovery honors its independent interval", async () => {
  let recoveryCalls = 0;
  let now = new Date("2026-08-04T01:00:00.000Z");
  const service = { config:{ shopId:"1",shopName:"JOJO Mall",mode:"manual",autoFulfillEnabled:false },
    getActiveBatch:()=>null,getLatestPendingPreview:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    recordScanRun:()=>{},recoverPendingTrackingNumbers:async()=>({ checked:0 }),autoRecoverManualReviews:async()=>({ checked:0 }),
    createPreview:async()=>({ previewId:"P",shop:{ id:"1",name:"JOJO Mall" },eligibleOrders:[],excludedOrders:[] }) };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:true,schedulerIntervalSeconds:300,
    maxBatchSize:10,messageReviewRecoveryEnabled:true,messageReviewRecoveryLimit:3,messageReviewRecoveryIntervalMinutes:30 },
    service,services:[service],now:()=>now,
    messageReviewRecovery:{ run:async()=>{ recoveryCalls += 1; return { checked:0,moved:[],results:[] }; } } });

  await scheduler.scanNow();
  now = new Date("2026-08-04T01:05:00.000Z");
  await scheduler.scanNow();
  assert.equal(recoveryCalls,1);
  assert.equal(scheduler.status().lastMessageReviewCheckAt,"2026-08-04T01:00:00.000Z");
  now = new Date("2026-08-04T01:30:00.000Z");
  await scheduler.scanNow();
  assert.equal(recoveryCalls,2);
});

test("message-review recovery waits before a targeted full safety scan", async () => {
  const timers = [];
  let previewCalls = 0;
  let batchCalls = 0;
  const service = { config:{ shopId:"1",shopName:"JOJO Mall",mode:"auto",autoFulfillEnabled:true },
    getActiveBatch:()=>null,getLatestPendingPreview:()=>null,listPendingPreviewSummaries:()=>[],listRecentScanRuns:()=>[],
    recordScanRun:()=>{},recoverPendingTrackingNumbers:async()=>({ checked:0 }),
    createPreview:async({ orderIds })=>{
      previewCalls += 1;
      assert.deepEqual(orderIds,["S-REVIEW"]);
      return { previewId:"P-REVIEW",confirmationToken:"T-REVIEW",shop:{ id:"1",name:"JOJO Mall" },
        eligibleOrders:[{ displayOrderId:"S-REVIEW" }],excludedOrders:[] };
    },
    enqueuePreview:()=>{ batchCalls += 1; return { id:"B-REVIEW",status:"queued" }; },
  };
  const scheduler = new FulfillmentPreviewScheduler({ config:{ schedulerEnabled:true,autoFulfillEnabled:true,
    schedulerIntervalSeconds:300,maxBatchSize:10,messageReviewRecoveryEnabled:true,messageReviewRecoveryLimit:3,
    messageReviewRecoveryIntervalMinutes:30,messageReviewFollowUpDelaySeconds:30 },service,services:[service],
    messageReviewRecovery:{ run:async()=>({ checked:1,moved:[{ shopId:"1",platformOrderId:"S-REVIEW" }],results:[] }) },
    setTimeoutFn:(callback)=>{ timers.push(callback); return { unref() {} }; },clearTimeoutFn:()=>{} });

  const recovered = await scheduler.scanNow();
  assert.equal(recovered.lastOutcome,"message_review_recovered");
  assert.equal(previewCalls,0);
  assert.equal(batchCalls,0);
  assert.equal(timers.length,1);

  await timers[0]();
  assert.equal(previewCalls,1);
  assert.equal(batchCalls,1);
  assert.equal(scheduler.status().lastOutcome,"auto_fulfillment_started");
});
