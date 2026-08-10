import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import {
  MabangListingRepricingAdapter,
  MabangRepricingClient,
} from "../lib/price-control/mabang-repricing-client.mjs";
import { createPriceControlApi } from "../lib/price-control/price-control-api.mjs";
import { PriceControlRepricingService } from "../lib/price-control/price-control-repricing-service.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

class FakeExecutor {
  constructor({
    drift = false,
    incompleteResult = false,
    matchedSku = "SKU-TH-1",
    skuMatchType = "exact",
    action = "promotion_update",
    targetField = "special_price",
    oldValue = "100.00",
    expiresInSeconds = 900,
    duplicateTarget = false,
    omitJobId = false,
  } = {}) {
    this.drift = drift;
    this.incompleteResult = incompleteResult;
    this.matchedSku = matchedSku;
    this.skuMatchType = skuMatchType;
    this.action = action;
    this.targetField = targetField;
    this.oldValue = oldValue;
    this.expiresInSeconds = expiresInSeconds;
    this.duplicateTarget = duplicateTarget;
    this.omitJobId = omitJobId;
    this.prepareCalls = [];
    this.executeCalls = [];
  }
  async prepare(accountId) { this.prepareCalls.push(accountId); }
  async parseInstruction() {
    return {
      provider: { configured: true, model: "fake-ai" },
      commands: [{
        action: this.action,
        target: { sku: "SKU-TH-1", parent_sku: "", category: "" },
        scope: {
          platforms: ["shopee"], countries: ["TH"], shop_ids: [],
          shop_names: ["Alpha TH"], categories: [],
        },
        operation: { field: this.targetField, mode: "set", value: this.drift ? 91 : 90, unit: "currency" },
        need_confirm: true, risks: [], clarifications: [], confidence: 0.99,
      }],
    };
  }
  async createPreview(_instruction, parsedCommands) {
    return {
      provider: { configured: true, model: "fake-ai" },
      parsed_commands: parsedCommands,
      resolved_scopes: [{
        platform: "shopee", countries: ["TH"],
        shops: [{ id: "provider-shop-1", name: "Alpha TH", site: "TH" }],
      }],
      batch_preview: {
        preview_token: "server-side-capability-token",
        created_at: "2026-08-06T12:00:00.000Z",
        expires_in_seconds: this.expiresInSeconds,
        warnings: [],
        changes: [{
          change_id: "provider-change-1", platform: "shopee", shop_id: "provider-shop-1",
          shop_name: "Alpha TH", requested_sku: "SKU-TH-1", matched_sku: this.matchedSku,
          sku_match_type: this.skuMatchType, field: this.targetField, old_value: this.oldValue, new_value: "90.00",
          internal_id: "listing-1", variation_key: "variation-1", sku: "SKU-TH-1",
        }, ...(this.duplicateTarget ? [{
          change_id: "provider-change-2", platform: "shopee", shop_id: "provider-shop-1",
          shop_name: "Alpha TH", requested_sku: "SKU-TH-1", matched_sku: this.matchedSku,
          sku_match_type: this.skuMatchType, field: this.targetField, old_value: this.oldValue, new_value: "90.00",
          internal_id: "listing-1", variation_key: "variation-1", sku: "SKU-TH-1",
        }] : [])],
      },
    };
  }
  async execute(previewToken, selectedChangeIds) {
    this.executeCalls.push({ previewToken, selectedChangeIds });
    return {
      ...(this.omitJobId ? {} : { job_id: "job-1" }),
      state: "queued", change_count: selectedChangeIds.length, results: [],
    };
  }
  async getJob() {
    return {
      job_id: "job-1", state: "completed", message: "done", successful_products: 1,
      failed_products: 0,
      results: this.incompleteResult ? [] : [{ platform: "shopee", internal_id: "listing-1", status: "success" }],
    };
  }
}

class MultiCountryExecutor {
  async prepare() {}
  async parseInstruction() {
    return {
      provider: { configured: true, model: "fake-ai" },
      commands: [
        {
          action: "promotion_update",
          target: { sku: "SKU-TH-1", parent_sku: "", category: "" },
          scope: { platforms: ["shopee"], countries: ["TH"], shop_ids: [], shop_names: ["Alpha TH"], categories: [] },
          operation: { field: "special_price", mode: "set", value: 90, unit: "currency" },
          need_confirm: true, risks: [], clarifications: [], confidence: 0.99,
        },
        {
          action: "promotion_update",
          target: { sku: "SKU-TH-1", parent_sku: "", category: "" },
          scope: { platforms: ["shopee"], countries: ["MY"], shop_ids: [], shop_names: ["Beta MY"], categories: [] },
          operation: { field: "special_price", mode: "set", value: 80, unit: "currency" },
          need_confirm: true, risks: [], clarifications: [], confidence: 0.99,
        },
      ],
    };
  }
  async createPreview(_instruction, parsedCommands) {
    return {
      provider: { configured: true, model: "fake-ai" },
      parsed_commands: parsedCommands,
      resolved_scopes: [
        { platform: "shopee", countries: ["TH"], shops: [{ id: "provider-shop-1", name: "Alpha TH", site: "TH" }] },
        { platform: "shopee", countries: ["MY"], shops: [{ id: "provider-shop-2", name: "Beta MY", site: "MY" }] },
      ],
      batch_preview: {
        preview_token: "multi-country-preview-token",
        created_at: "2026-08-06T12:00:00.000Z",
        expires_in_seconds: 900,
        warnings: [],
        changes: [
          {
            source_command_index: 1,
            change_id: "provider-change-th", platform: "shopee", shop_id: "provider-shop-1",
            shop_name: "Alpha TH", requested_sku: "SKU-TH-1", matched_sku: "SKU-TH-1",
            sku_match_type: "exact", field: "special_price", old_value: "100.00", new_value: "90.00",
            internal_id: "listing-th", variation_key: "variation-th", sku: "SKU-TH-1",
          },
          {
            source_command_index: 2,
            change_id: "provider-change-my", platform: "shopee", shop_id: "provider-shop-2",
            shop_name: "Beta MY", requested_sku: "SKU-TH-1", matched_sku: "SKU-TH-1",
            sku_match_type: "exact", field: "special_price", old_value: "85.00", new_value: "80.00",
            internal_id: "listing-my", variation_key: "variation-my", sku: "SKU-TH-1",
          },
        ],
      },
    };
  }
}

async function fixture(t, { executor = new FakeExecutor() } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "price-control-repricing-"));
  const access = openCommerceDataAccess({ rootDir, databasePath: path.join(directory, "isolated.sqlite") });
  t.after(async () => {
    access.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const nowState = { value: new Date("2026-08-06T12:00:00.000Z") };
  const timestamp = nowState.value.toISOString();
  const execute = (sql, values) => access.provider.execute(sql, values);
  await execute(
    `INSERT OR IGNORE INTO foundation_source_systems
      (code,source_type,display_name,status,metadata_json,created_at,updated_at)
     VALUES ('mabang','erp','Mabang','active','{}',?,?)`,
    [timestamp, timestamp],
  );
  await execute(
    `INSERT INTO foundation_integration_accounts
      (id,source_system_code,display_name,credential_ref_type,credential_ref_id,status,
       metadata_json,created_at,updated_at)
     VALUES ('account-1','mabang','Test account','mabang_account_profile','profile-1','active','{}',?,?)`,
    [timestamp, timestamp],
  );
  await execute(
    `INSERT INTO price_control_sync_runs
      (id,trigger_type,sync_mode,status,input_fingerprint,created_at,updated_at)
     VALUES ('round-1','manual','incremental','SUCCEEDED','fingerprint',?,?)`,
    [timestamp, timestamp],
  );
  await execute(
    `INSERT INTO price_control_source_batches
      (apply_no,country_code,approval_status,source_row_count,batch_fingerprint,effective_at,
       first_seen_at,last_seen_at,last_sync_run_id)
     VALUES ('apply-1','TH','CA',1,'batch-fingerprint',?,?,?,'round-1')`,
    [timestamp, timestamp, timestamp],
  );
  await execute(
    `INSERT INTO product_price_change_events
      (id,sync_run_id,source_apply_no,price_key,country_code,sku,platform,shop_type,price_type,
       old_price,new_price,delta_value,delta_percent,direction,change_text,change_fingerprint,
       detected_at,created_at)
     VALUES ('change-1','round-1','apply-1','key-1','TH','SKU-TH-1','SHOPEE','STANDARD',
       'CAMPAIGN','100.00','90.00','-10.00',-10,'DOWN','test change','change-fingerprint',?,?)`,
    [timestamp, timestamp],
  );
  await execute(
    `INSERT INTO commerce_shop_registry
      (id,platform,provider_shop_id,shop_name,normalized_shop_name,source_country_code,site_code,
       control_shop_type,execution_provider,identity_status,status,source_metadata_json,
       first_seen_at,last_seen_at,created_at,updated_at)
     VALUES ('shop-1','SHOPEE','provider-shop-1','Alpha TH','alpha th','TH','TH','UNKNOWN',
       'MABANG_LISTING','CONFIRMED','ACTIVE','{}',?,?,?,?)`,
    [timestamp, timestamp, timestamp, timestamp],
  );
  await execute(
    `INSERT INTO commerce_shop_account_bindings
      (shop_id,account_id,source_system,status,capabilities_json,first_seen_at,last_seen_at,created_at,updated_at)
     VALUES ('shop-1','account-1','mabang','ACTIVE','["price","special_price"]',?,?,?,?)`,
    [timestamp, timestamp, timestamp, timestamp],
  );
  const service = new PriceControlRepricingService({
    repository: access.repositories.priceControlRepricing,
    priceControlRepository: access.repositories.priceControl,
    shopRepository: access.repositories.commerceShops,
    executors: new Map([["MABANG_LISTING", executor]]),
    now: () => new Date(nowState.value),
  });
  return { access, executor, nowState, service };
}

async function seedSecondCountrySameSku(access) {
  const timestamp = "2026-08-06T12:00:00.000Z";
  await access.provider.execute(
    `INSERT INTO price_control_source_batches
      (apply_no,country_code,approval_status,source_row_count,batch_fingerprint,effective_at,
       first_seen_at,last_seen_at,last_sync_run_id)
     VALUES ('apply-my','MY','CA',1,'batch-fingerprint-my',?,?,?,'round-1')`,
    [timestamp, timestamp, timestamp],
  );
  await access.provider.execute(
    `INSERT INTO product_price_change_events
      (id,sync_run_id,source_apply_no,price_key,country_code,sku,platform,shop_type,price_type,
       old_price,new_price,delta_value,delta_percent,direction,change_text,change_fingerprint,
       detected_at,created_at)
     VALUES ('change-my','round-1','apply-my','key-my','MY','SKU-TH-1','SHOPEE','STANDARD',
       'CAMPAIGN','85.00','80.00','-5.00',-5.88,'DOWN','MY change','change-fingerprint-my',?,?)`,
    [timestamp, timestamp],
  );
  await access.provider.execute(
    `INSERT INTO commerce_shop_registry
      (id,platform,provider_shop_id,shop_name,normalized_shop_name,source_country_code,site_code,
       control_shop_type,execution_provider,identity_status,status,source_metadata_json,
       first_seen_at,last_seen_at,created_at,updated_at)
     VALUES ('shop-2','SHOPEE','provider-shop-2','Beta MY','beta my','MY','MY','UNKNOWN',
       'MABANG_LISTING','CONFIRMED','ACTIVE','{}',?,?,?,?)`,
    [timestamp, timestamp, timestamp, timestamp],
  );
  await access.provider.execute(
    `INSERT INTO commerce_shop_account_bindings
      (shop_id,account_id,source_system,status,capabilities_json,first_seen_at,last_seen_at,created_at,updated_at)
     VALUES ('shop-2','account-1','mabang','ACTIVE','["price","special_price"]',?,?,?,?)`,
    [timestamp, timestamp, timestamp, timestamp],
  );
}

const previewInput = {
  roundId: "round-1",
  assignments: [{ changeId: "change-1", shopIds: ["shop-1"] }],
};

async function seedNewerRound(access) {
  const later = "2026-08-06T12:01:00.000Z";
  await access.provider.execute(
    `INSERT INTO price_control_sync_runs
      (id,trigger_type,sync_mode,status,input_fingerprint,created_at,updated_at)
     VALUES ('round-2','scheduled','incremental','SUCCEEDED','fingerprint-2',?,?)`,
    [later, later],
  );
  await access.provider.execute(
    `INSERT INTO product_price_change_events
      (id,sync_run_id,source_apply_no,price_key,country_code,sku,platform,shop_type,price_type,
       old_price,new_price,delta_value,delta_percent,direction,change_text,change_fingerprint,
       detected_at,created_at)
     VALUES ('change-2','round-2','apply-1','key-2','TH','SKU-TH-2','SHOPEE','STANDARD',
       'CAMPAIGN','100.00','95.00','-5.00',-5,'DOWN','newer change','change-fingerprint-2',?,?)`,
    [later, later],
  );
}

async function invokeApi(handler, { method = "GET", pathname, body = undefined, actorIdentifier = "api-operator" }) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  const annotations = [];
  request.auditContext = {
    actorIdentifier,
    annotate(value) { annotations.push(value); },
  };
  const response = {
    status: 0,
    headers: {},
    payload: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk = "") { this.payload += String(chunk); },
  };
  const handled = await handler(request, response, new URL(pathname, "http://127.0.0.1"));
  return { handled, status: response.status, body: JSON.parse(response.payload), annotations };
}

test("Mabang adapter reuses the prepared account so a live preview token survives confirmation", async () => {
  const connectCalls = [];
  const adapter = new MabangListingRepricingAdapter({
    client: {},
    accountBridge: {
      async connect(accountId) {
        connectCalls.push(accountId);
        return { accountId, reused: false };
      },
    },
  });
  await adapter.prepare("account-1");
  const reused = await adapter.prepare("account-1");
  assert.deepEqual(connectCalls, ["account-1"]);
  assert.deepEqual(reused, { accountId: "account-1", reused: true });
});

test("Mabang adapter serializes account-bound operations so sessions cannot cross", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const adapter = new MabangListingRepricingAdapter({
    client: {},
    accountBridge: {
      async connect(accountId) {
        events.push(`connect:${accountId}`);
        return { accountId };
      },
    },
  });
  const first = adapter.withAccount("account-a", async () => {
    events.push("action:a:start");
    await firstGate;
    events.push("action:a:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = adapter.withAccount("account-b", async () => { events.push("action:b"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["connect:account-a", "action:a:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "connect:account-a", "action:a:start", "action:a:end", "connect:account-b", "action:b",
  ]);
});

test("Mabang client distinguishes an unknown network outcome from a known execution rejection", async () => {
  const unknownClient = new MabangRepricingClient({
    baseUrl: "http://127.0.0.1:5999",
    internalToken: "test-only-token",
    fetchImpl: async () => { throw new Error("simulated connection reset"); },
  });
  await assert.rejects(
    unknownClient.execute({ previewToken: "preview-1", selectedChangeIds: ["change-1"] }),
    (error) => error.code === "MABANG_REPRICING_EXECUTION_OUTCOME_UNKNOWN" && error.outcomeUnknown === true,
  );

  const rejectedClient = new MabangRepricingClient({
    baseUrl: "http://127.0.0.1:5999",
    internalToken: "test-only-token",
    fetchImpl: async () => new Response(JSON.stringify({ success: false, message: "preview expired" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    rejectedClient.execute({ previewToken: "preview-1", selectedChangeIds: ["change-1"] }),
    (error) => error.code === "MABANG_REPRICING_EXECUTION_REJECTED" && error.outcomeUnknown === false,
  );
});

test("price-control API carries one guarded preview through confirmation and provider readback", async (t) => {
  const { executor, service } = await fixture(t);
  const permissions = [];
  const api = createPriceControlApi({
    service: { status: async () => ({ schemaReady: true }) },
    repricingService: service,
    accessPolicy: { assert(permission) { permissions.push(permission); } },
  });

  const shops = await invokeApi(api, {
    pathname: "/api/price-control/shops?platform=SHOPEE&country=TH",
  });
  assert.equal(shops.status, 200);
  assert.deepEqual(shops.body.shops.map((shop) => shop.id), ["shop-1"]);

  const preview = await invokeApi(api, {
    method: "POST",
    pathname: "/api/price-control/repricing/previews",
    body: previewInput,
  });
  assert.equal(preview.status, 201);
  assert.equal(preview.body.plan.status, "PREVIEW_READY");
  assert.equal(preview.body.plan.previewToken, undefined);
  assert.equal(preview.annotations[0].runId, "round-1");

  const confirmed = await invokeApi(api, {
    method: "POST",
    pathname: `/api/price-control/repricing/plans/${preview.body.plan.id}/confirm`,
    body: {
      confirmed: true,
      confirmationText: "确认同步到店铺",
      previewFingerprint: preview.body.plan.previewFingerprint,
      selectedItemIds: [preview.body.plan.items[0].id],
      acknowledgeUnknownShopTypes: true,
    },
  });
  assert.equal(confirmed.status, 202);
  assert.equal(confirmed.body.plan.status, "EXECUTING");
  assert.equal(executor.executeCalls.length, 1);

  const refreshed = await invokeApi(api, {
    method: "POST",
    pathname: `/api/price-control/repricing/plans/${preview.body.plan.id}/refresh`,
  });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.plan.status, "SUCCEEDED");
  assert.equal(refreshed.body.plan.items[0].status, "SUCCEEDED");
  assert.deepEqual(permissions, ["product.view", "product.edit", "product.edit", "product.edit"]);
});

test("the same SKU in two countries stays isolated through AI scope and actual Mabang diffs", async (t) => {
  const { access, service } = await fixture(t, { executor: new MultiCountryExecutor() });
  await seedSecondCountrySameSku(access);
  const plan = await service.createPreview({
    roundId: "round-1",
    assignments: [
      { changeId: "change-1", shopIds: ["shop-1"] },
      { changeId: "change-my", shopIds: ["shop-2"] },
    ],
  }, { requestedBy: "operator" });

  assert.equal(plan.status, "PREVIEW_READY");
  assert.equal(plan.items.length, 2);
  assert.match(plan.instructionText, /国家代码 TH 的 “Alpha TH” 店铺中/);
  assert.match(plan.instructionText, /国家代码 MY 的 “Beta MY” 店铺中/);
  assert.deepEqual(
    plan.items.map((item) => [item.sourceChangeId, item.countryCode, item.shopName, item.sku, item.newValue]),
    [
      ["change-1", "TH", "Alpha TH", "SKU-TH-1", "90.00"],
      ["change-my", "MY", "Beta MY", "SKU-TH-1", "80.00"],
    ],
  );
});

test("multi-country repricing requires an explicit valid source command index", async (t) => {
  const executor = new MultiCountryExecutor();
  const createPreview = executor.createPreview.bind(executor);
  executor.createPreview = async (...args) => {
    const result = await createPreview(...args);
    result.batch_preview.changes[1].source_command_index = 0;
    return result;
  };
  const { access, service } = await fixture(t, { executor });
  await seedSecondCountrySameSku(access);
  await assert.rejects(
    service.createPreview({
      roundId: "round-1",
      assignments: [
        { changeId: "change-1", shopIds: ["shop-1"] },
        { changeId: "change-my", shopIds: ["shop-2"] },
      ],
    }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_COMMAND_INVALID",
  );
});

test("repricing persists a server-side Mabang preview and returns only safe confirmation material", async (t) => {
  const { access, executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  assert.equal(plan.status, "PREVIEW_READY");
  assert.equal(plan.listingChangeCount, 1);
  assert.equal(plan.items[0].oldValue, "100.00");
  assert.equal(plan.items[0].newValue, "90.00");
  assert.equal(plan.items[0].matchedSku, "SKU-TH-1");
  assert.equal(plan.items[0].skuMatchType, "exact");
  assert.equal(plan.items[0].selected, false);
  assert.equal(plan.items[0].registryShopId, "shop-1");
  assert.equal(plan.previewToken, undefined);
  assert.equal(plan.accountId, undefined);
  assert.equal(plan.parsedCommands, undefined);
  assert.equal(plan.items[0].providerChangeId, undefined);
  assert.equal(plan.items[0].rawPreview, undefined);
  assert.match(plan.instructionText, /SHOPEE|Shopee/i);
  assert.match(plan.instructionText, /^1\. /);
  assert.match(plan.instructionText, /TH/);
  assert.match(plan.instructionText, /SKU-TH-1/);
  assert.equal(executor.prepareCalls.length, 1);
  const stored = await access.repositories.priceControlRepricing.getPlan(plan.id, { includeCapability: true });
  assert.equal(stored.previewToken, "server-side-capability-token");
  assert.ok(plan.warnings.some((warning) => warning.includes("Standard/Mall")));
});

test("repricing excludes unconfirmed shop identities from selection and blocks a crafted preview", async (t) => {
  const { access, executor, service } = await fixture(t);
  await access.provider.execute(
    "UPDATE commerce_shop_registry SET identity_status='REVIEW_REQUIRED' WHERE id='shop-1'",
  );

  assert.deepEqual(await service.listShops({ platform: "SHOPEE", countryCode: "TH" }), []);
  await assert.rejects(
    service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => {
      assert.equal(error.code, "PRICE_CONTROL_REPRICING_SHOP_IDENTITY_UNCONFIRMED");
      assert.equal(error.status, 409);
      assert.match(error.message, /Alpha TH/);
      assert.match(error.message, /REVIEW_REQUIRED/);
      assert.match(error.message, /阻断调价预览/);
      return true;
    },
  );
  assert.equal(executor.prepareCalls.length, 0);
});

test("repricing rechecks shop identity at confirmation and never executes after review is required", async (t) => {
  const { access, executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  await access.provider.execute(
    "UPDATE commerce_shop_registry SET identity_status='REVIEW_REQUIRED' WHERE id='shop-1'",
  );

  await assert.rejects(
    service.confirm(plan.id, {
      confirmed: true,
      confirmationText: "确认同步到店铺",
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds: [plan.items[0].id],
      acknowledgeUnknownShopTypes: true,
    }, { requestedBy: "operator" }),
    (error) => {
      assert.equal(error.code, "PRICE_CONTROL_REPRICING_SHOP_IDENTITY_UNCONFIRMED");
      assert.match(error.message, /阻断调价确认与执行/);
      return true;
    },
  );
  assert.equal(executor.executeCalls.length, 0);
});

test("regular control prices map only to the provider price field and price action", async (t) => {
  const { access, service } = await fixture(t, {
    executor: new FakeExecutor({ action: "price_update", targetField: "price" }),
  });
  await access.provider.execute(
    "UPDATE product_price_change_events SET price_type='REGULAR' WHERE id='change-1'",
  );
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  assert.equal(plan.items[0].targetField, "price");
  assert.match(plan.instructionText, /原价（price）/);
});

test("repricing requires the common shop account to allow the selected price field", async (t) => {
  const { access, service } = await fixture(t);
  await access.provider.execute(
    `UPDATE commerce_shop_account_bindings SET capabilities_json='["price"]'
     WHERE shop_id='shop-1' AND account_id='account-1'`,
  );
  await assert.rejects(
    service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_ACCOUNT_CAPABILITY_MISSING",
  );
});

test("repricing blocks a non-positive control target before contacting the provider", async (t) => {
  const { access, service } = await fixture(t);
  await access.provider.execute(
    "UPDATE product_price_change_events SET new_price='0' WHERE id='change-1'",
  );
  await assert.rejects(
    service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_TARGET_PRICE_INVALID",
  );
});

test("repricing requires explicit human confirmation, matching fingerprint and unknown-shop acknowledgement", async (t) => {
  const { executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  const confirmation = {
    confirmed: true,
    confirmationText: "确认同步到店铺",
    previewFingerprint: plan.previewFingerprint,
    selectedItemIds: [plan.items[0].id],
    acknowledgeUnknownShopTypes: true,
  };
  await assert.rejects(
    service.confirm(plan.id, { ...confirmation, confirmationText: "确认" }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_EXPLICIT_CONFIRMATION_REQUIRED",
  );
  await assert.rejects(
    service.confirm(plan.id, { ...confirmation, acknowledgeUnknownShopTypes: false }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_SHOP_TYPE_ACK_REQUIRED",
  );
  const executing = await service.confirm(plan.id, confirmation, { requestedBy: "operator" });
  assert.equal(executing.status, "EXECUTING");
  assert.deepEqual(executor.executeCalls, [{
    previewToken: "server-side-capability-token",
    selectedChangeIds: ["provider-change-1"],
  }]);
  await assert.rejects(
    service.confirm(plan.id, confirmation, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_STATE_INVALID",
  );
  const completed = await service.refresh(plan.id, { requestedBy: "operator" });
  assert.equal(completed.status, "SUCCEEDED");
  assert.equal(completed.items[0].status, "SUCCEEDED");
});

test("an accepted provider job becomes recoverable execution-unknown when local state persistence fails", async (t) => {
  const { executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  service.repository.markExecutionStarted = async () => {
    throw new Error("simulated local persistence failure after provider acceptance");
  };

  const unknown = await service.confirm(plan.id, {
    confirmed: true,
    confirmationText: "确认同步到店铺",
    previewFingerprint: plan.previewFingerprint,
    selectedItemIds: [plan.items[0].id],
    acknowledgeUnknownShopTypes: true,
  }, { requestedBy: "operator" });

  assert.equal(unknown.status, "EXECUTION_UNKNOWN");
  assert.equal(unknown.executionJobId, "job-1");
  assert.equal(unknown.executionState, "queued");
  assert.equal(unknown.errorCode, "PRICE_CONTROL_REPRICING_STATE_PERSISTENCE_UNKNOWN");
  assert.equal(executor.executeCalls.length, 1);

  const recovered = await service.refresh(plan.id, { requestedBy: "operator" });
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.items[0].status, "SUCCEEDED");
  assert.equal(executor.executeCalls.length, 1);
});

test("an accepted provider response without a job id remains execution-unknown", async (t) => {
  const { service } = await fixture(t, { executor: new FakeExecutor({ omitJobId: true }) });
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  const unknown = await service.confirm(plan.id, {
    confirmed: true,
    confirmationText: "确认同步到店铺",
    previewFingerprint: plan.previewFingerprint,
    selectedItemIds: [plan.items[0].id],
    acknowledgeUnknownShopTypes: true,
  }, { requestedBy: "operator" });
  assert.equal(unknown.status, "EXECUTION_UNKNOWN");
  assert.equal(unknown.executionJobId, null);
  assert.equal(unknown.errorCode, "MABANG_REPRICING_EXECUTION_JOB_ID_MISSING");
});

test("a terminal provider job without item-level evidence never marks a price change adjusted", async (t) => {
  const { access, service } = await fixture(t, { executor: new FakeExecutor({ incompleteResult: true }) });
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  await service.confirm(plan.id, {
    confirmed: true,
    confirmationText: "确认同步到店铺",
    previewFingerprint: plan.previewFingerprint,
    selectedItemIds: [plan.items[0].id],
    acknowledgeUnknownShopTypes: true,
  }, { requestedBy: "operator" });

  const unknown = await service.refresh(plan.id, { requestedBy: "operator" });
  assert.equal(unknown.status, "EXECUTION_UNKNOWN");
  assert.equal(unknown.errorCode, "MABANG_REPRICING_RESULT_INCOMPLETE");
  assert.equal(unknown.items[0].status, "EXECUTION_UNKNOWN");
  const change = (await access.provider.query(
    "SELECT adjustment_status FROM product_price_change_events WHERE id='change-1'",
  )).rows[0];
  assert.equal(change.adjustment_status, "UNADJUSTED");
});

test("a source change is marked adjusted only when every planned shop diff succeeds", async () => {
  const updates = [];
  const service = new PriceControlRepricingService({
    repository: {},
    priceControlRepository: {},
    shopRepository: {},
    executors: new Map(),
    priceControlService: {
      async updateAdjustment(changeId, input) { updates.push({ changeId, input }); },
    },
  });
  const basePlan = {
    id: "plan-1",
    executionProvider: "MABANG_LISTING",
    sourceAssignments: [{ changeId: "change-1", shopIds: ["shop-1", "shop-2"] }],
    items: [
      { sourceChangeId: "change-1", registryShopId: "shop-1", selected: true, status: "SUCCEEDED" },
      { sourceChangeId: "change-1", registryShopId: "shop-2", selected: false, status: "SKIPPED" },
    ],
  };

  await service.recordCompletedAdjustments(basePlan, "operator");
  assert.deepEqual(updates, []);

  await service.recordCompletedAdjustments({
    ...basePlan,
    items: basePlan.items.map((item) => ({ ...item, selected: true, status: "SUCCEEDED" })),
  }, "operator");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].changeId, "change-1");
  assert.equal(updates[0].input.status, "ADJUSTED");
});

test("a source change stays unadjusted when any assigned shop has no actual diff evidence", async () => {
  const updates = [];
  const service = new PriceControlRepricingService({
    repository: {}, priceControlRepository: {}, shopRepository: {}, executors: new Map(),
    priceControlService: {
      async updateAdjustment(changeId, input) { updates.push({ changeId, input }); },
    },
  });
  await service.recordCompletedAdjustments({
    id: "plan-missing-shop",
    executionProvider: "MABANG_LISTING",
    sourceAssignments: [{ changeId: "change-1", shopIds: ["shop-1", "shop-2"] }],
    items: [{
      sourceChangeId: "change-1", registryShopId: "shop-1", selected: true, status: "SUCCEEDED",
    }],
  }, "operator");
  assert.deepEqual(updates, []);
});

test("confirmation is rejected when a newer valid control-price round supersedes the preview", async (t) => {
  const { access, executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  await seedNewerRound(access);

  await assert.rejects(
    service.confirm(plan.id, {
      confirmed: true,
      confirmationText: "确认同步到店铺",
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds: [plan.items[0].id],
      acknowledgeUnknownShopTypes: true,
    }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_SUPERSEDED",
  );
  assert.equal(executor.executeCalls.length, 0);
});

test("the atomic confirmation claim closes a concurrent newer-round race", async (t) => {
  const { access, executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  const originalClaim = service.repository.claimConfirmation.bind(service.repository);
  service.repository.claimConfirmation = async (input) => {
    await seedNewerRound(access);
    return originalClaim(input);
  };

  await assert.rejects(
    service.confirm(plan.id, {
      confirmed: true,
      confirmationText: "确认同步到店铺",
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds: [plan.items[0].id],
      acknowledgeUnknownShopTypes: true,
    }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_CONFIRMATION_CONFLICT",
  );
  assert.equal(executor.executeCalls.length, 0);
});

test("confirmation is rejected when a previewed source change was already handled", async (t) => {
  const { access, executor, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  await access.provider.execute(
    "UPDATE product_price_change_events SET adjustment_status='ADJUSTED' WHERE id='change-1'",
  );

  await assert.rejects(
    service.confirm(plan.id, {
      confirmed: true,
      confirmationText: "确认同步到店铺",
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds: [plan.items[0].id],
      acknowledgeUnknownShopTypes: true,
    }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_CHANGE_NO_LONGER_ACTIONABLE",
  );
  assert.equal(executor.executeCalls.length, 0);
});

test("repricing blocks AI interpretation drift before asking Mabang for an actual preview", async (t) => {
  const { access, service } = await fixture(t, { executor: new FakeExecutor({ drift: true }) });
  await assert.rejects(
    service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_AI_COMMAND_DRIFT",
  );
  const count = (await access.provider.query("SELECT COUNT(*) AS total FROM price_control_repricing_plans")).rows[0].total;
  assert.equal(count, 0);
});

test("repricing exposes bounded virtual SKU matches and blocks arbitrary provider matches", async (t) => {
  const virtualFixture = await fixture(t, {
    executor: new FakeExecutor({ matchedSku: "SKU-TH-1S2", skuMatchType: "virtual" }),
  });
  const virtualPlan = await virtualFixture.service.createPreview(previewInput, { requestedBy: "operator" });
  assert.equal(virtualPlan.items[0].matchedSku, "SKU-TH-1S2");
  assert.equal(virtualPlan.items[0].skuMatchType, "virtual");
  assert.ok(virtualPlan.warnings.some((warning) => warning.includes("实际虚拟 SKU")));
});

test("repricing rejects an unbounded provider SKU match", async (t) => {
  const { service } = await fixture(t, {
    executor: new FakeExecutor({ matchedSku: "OTHER-SKU", skuMatchType: "all" }),
  });
  await assert.rejects(
    service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_DRIFT",
  );
});

test("repricing rejects duplicate provider targets and unusable live values", async (t) => {
  const duplicated = await fixture(t, { executor: new FakeExecutor({ duplicateTarget: true }) });
  await assert.rejects(
    duplicated.service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_TARGET_DUPLICATED",
  );
  const invalidOldValue = await fixture(t, { executor: new FakeExecutor({ oldValue: "not-a-price" }) });
  await assert.rejects(
    invalidOldValue.service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_DRIFT",
  );
});

test("repricing rejects a provider preview that has no remaining lifetime", async (t) => {
  const { service } = await fixture(t, { executor: new FakeExecutor({ expiresInSeconds: 0 }) });
  await assert.rejects(
    service.createPreview(previewInput, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_EXPIRED",
  );
});

test("repricing rejects confirmation after the live preview capability expires", async (t) => {
  const { nowState, service } = await fixture(t);
  const plan = await service.createPreview(previewInput, { requestedBy: "operator" });
  nowState.value = new Date("2026-08-06T12:16:00.000Z");
  await assert.rejects(
    service.confirm(plan.id, {
      confirmed: true,
      confirmationText: "确认同步到店铺",
      previewFingerprint: plan.previewFingerprint,
      selectedItemIds: [plan.items[0].id],
      acknowledgeUnknownShopTypes: true,
    }, { requestedBy: "operator" }),
    (error) => error.code === "PRICE_CONTROL_REPRICING_PREVIEW_EXPIRED",
  );
  assert.equal((await service.getPlan(plan.id)).status, "EXPIRED");
});
