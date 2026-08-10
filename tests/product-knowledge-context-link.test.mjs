import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SqliteProvider } from "../lib/data/sqlite/sqlite-provider.mjs";
import { ProductKnowledgeRepository } from "../lib/product-knowledge/product-knowledge-repository.mjs";
import { ProductKnowledgeService } from "../lib/product-knowledge/product-knowledge-service.mjs";
import { ProductCoreReadFacade } from "../lib/product-center/product-core-read-facade.mjs";
import { CustomerServiceRepository } from "../lib/customer-service/customer-service-repository.mjs";
import { CustomerServiceService } from "../lib/customer-service/customer-service-service.mjs";
import { CustomerServiceContextService } from "../lib/customer-service/customer-service-context-service.mjs";
import { CustomerServiceBusinessContextFacade } from "../lib/customer-service/customer-service-business-context-facade.mjs";

const NOW = "2026-08-08T12:00:00.000Z";

function createSchema(db, { customerService = false } = {}) {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`
    CREATE TABLE product_categories (
      id TEXT PRIMARY KEY,parent_id TEXT,source_name TEXT NOT NULL
    );
    CREATE TABLE product_models (
      id TEXT PRIMARY KEY,category_id TEXT,source_main_sku TEXT,canonical_name TEXT
    );
    CREATE TABLE product_skus (
      id TEXT PRIMARY KEY,model_id TEXT,category_id TEXT,country_raw TEXT,sku_code_normalized TEXT,
      source_main_sku TEXT,source_product_name TEXT,source_style_name TEXT,source_sales_spec TEXT,
      revision INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,archived_at TEXT,deleted_at TEXT,current_source_row_id TEXT
    );
  `);
  db.exec(fs.readFileSync(new URL("../migrations/035_shared_product_knowledge.sql", import.meta.url), "utf8"));
  if (customerService) {
    db.exec(fs.readFileSync(new URL("../migrations/033_customer_service_control_plane.sql", import.meta.url), "utf8"));
  }
}

function seedProduct(db) {
  db.prepare("INSERT INTO product_categories (id,parent_id,source_name) VALUES (?,?,?)").run("cat-l1", null, "家具");
  db.prepare("INSERT INTO product_categories (id,parent_id,source_name) VALUES (?,?,?)").run("cat-l2", "cat-l1", "卧室家具");
  db.prepare("INSERT INTO product_models (id,category_id,source_main_sku,canonical_name) VALUES (?,?,?,?)")
    .run("model-bed-1", "cat-l2", "AA1001", "Steel Bed");
  db.prepare(`INSERT INTO product_skus (
    id,model_id,category_id,country_raw,sku_code_normalized,source_main_sku,source_product_name,
    source_style_name,source_sales_spec,revision,updated_at,archived_at,deleted_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "sku-bed-th", "model-bed-1", "cat-l2", "TH", "T3AA1001001", "AA1001", "Steel Bed 100cm",
    "Steel Bed", "100cm / black", 3, NOW, null, null,
  );
}

function candidate({
  id = "candidate-1",
  assetId = "asset-1",
  status = "REVIEW_REQUIRED",
  targetDomain = "PRODUCT_KNOWLEDGE",
  assetType = "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE",
  riskLevel = "NORMAL",
  productModelId = "model-bed-1",
  productSkuId = null,
  canonicalCategoryName = "卧室家具",
  content = { claim_type: "INSTALLATION", title: "安装", text: "需要自行安装，包装内附安装说明。" },
  scope = { scope_type: "COMMON", country_codes: [], language: "zh-CN", consumer_scopes: ["CUSTOMER_SERVICE"] },
  countries = [],
  consumers = ["CUSTOMER_SERVICE", "LISTING"],
} = {}) {
  return {
    id,
    importBatchId: "batch-1",
    assetId,
    assetType,
    targetDomain,
    candidateStatus: status,
    mappingStatus: "EXACT_STOCK_SKU_TO_MODEL",
    riskLevel,
    conflictStatus: "UNCHECKED",
    canonicalCategoryName,
    productModelId,
    productSkuId,
    sourceSku: "T3AA1001001",
    languageCode: "zh-CN",
    scopeType: "COMMON",
    countries,
    consumers,
    subject: { model_ids: ["model-bed-1"], source_sku: "T3AA1001001" },
    content,
    scope,
    governance: { status },
    evidence: { primary: { source_id: "source-1", source_sha256: "abc", sheet: "产品信息", cell_range: "A2:G2" } },
    sourceId: "source-1",
    sourceSha256: "abc",
    sourceSheet: "产品信息",
    sourceLocation: "A2:G2",
    contentDigest: `digest-${assetId}`,
    createdAt: NOW,
  };
}

async function* candidates(values) {
  for (const value of values) yield value;
}

function insertCandidate(db, input) {
  db.prepare(`INSERT INTO product_knowledge_candidates (
    id,import_batch_id,asset_id,asset_type,target_domain,candidate_status,mapping_status,risk_level,
    conflict_status,canonical_category_name,product_model_id,product_sku_id,source_sku,language_code,
    scope_type,country_scope_json,consumer_scopes_json,subject_json,content_json,scope_json,governance_json,
    evidence_json,source_id,source_sha256,source_sheet,source_location,content_digest,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.id, input.importBatchId, input.assetId, input.assetType, input.targetDomain, input.candidateStatus,
    input.mappingStatus, input.riskLevel, input.conflictStatus, input.canonicalCategoryName,
    input.productModelId, input.productSkuId, input.sourceSku, input.languageCode, input.scopeType,
    JSON.stringify(input.countries), JSON.stringify(input.consumers), JSON.stringify(input.subject),
    JSON.stringify(input.content), JSON.stringify(input.scope), JSON.stringify(input.governance),
    JSON.stringify(input.evidence), input.sourceId, input.sourceSha256, input.sourceSheet,
    input.sourceLocation, input.contentDigest, input.createdAt,
  );
}

function seedPublishedClaim(db, {
  suffix, text, scopeType = "COMMON", countryCode = null, releaseStatus = "PUBLISHED", visibility = "CUSTOMER_VISIBLE",
} = {}) {
  const item = candidate({ id: `candidate-${suffix}`, assetId: `asset-${suffix}`, status: "APPROVED" });
  insertCandidate(db, item);
  db.prepare(`INSERT INTO product_knowledge_claims (
    id,claim_key,version_no,claim_type,title,text_content,structured_json,product_model_id,product_sku_id,
    category_id,source_candidate_id,source_content_digest,approval_status,risk_level,approved_by,approved_at,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `claim-${suffix}`, `install-${suffix}`, 1, "INSTALLATION", "安装", text, "{}", "model-bed-1",
    null, "cat-l2", item.id, item.contentDigest, "APPROVED", "NORMAL", "reviewer-1", NOW, NOW,
  );
  db.prepare(`INSERT INTO product_knowledge_claim_scopes (
    id,claim_id,scope_type,country_code,language_code,consumer_scope,visibility,effective_from,effective_until,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    `scope-${suffix}`, `claim-${suffix}`, scopeType, countryCode, "zh-CN", "CUSTOMER_SERVICE", visibility,
    NOW, null, NOW,
  );
  db.prepare(`INSERT INTO product_knowledge_releases (
    id,release_key,version_no,consumer_scope,status,content_digest,notes,created_by,created_at,
    published_by,published_at,effective_from,effective_until,retired_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    `release-${suffix}`, `support-${suffix}`, 1, "CUSTOMER_SERVICE", releaseStatus, `release-digest-${suffix}`,
    null, "publisher-1", NOW, releaseStatus === "PUBLISHED" ? "publisher-1" : null,
    releaseStatus === "PUBLISHED" ? NOW : null, NOW, null, null,
  );
  db.prepare(`INSERT INTO product_knowledge_release_items (
    id,release_id,claim_id,claim_content_digest,rank_no,created_at
  ) VALUES (?,?,?,?,?,?)`).run(
    `release-item-${suffix}`, `release-${suffix}`, `claim-${suffix}`, item.contentDigest, 1, NOW,
  );
}

test("shared knowledge import is digest-idempotent and offline candidates remain unavailable to runtime", async (t) => {
  const db = new DatabaseSync(":memory:");
  createSchema(db);
  seedProduct(db);
  const provider = new SqliteProvider({ connection: db });
  t.after(() => provider.close());
  const repository = new ProductKnowledgeRepository({ provider });
  const batch = {
    id: "batch-1", contractVersion: "1.0.0", packageDigest: "package-digest-1", packageName: "batch-one",
    declaredCounts: { claims: 1 }, manifest: { schema_version: "1.0.0" }, createdBy: "tester",
    createdAt: NOW, completedAt: NOW,
  };
  const first = await repository.importPackage({ batch, candidates: candidates([candidate()]) });
  const second = await repository.importPackage({ batch, candidates: candidates([candidate()]) });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.prepare("SELECT count(*) total FROM product_knowledge_candidates").get().total, 1);
  assert.equal(db.prepare("SELECT candidate_status FROM product_knowledge_candidates").get().candidate_status, "REVIEW_REQUIRED");
  assert.deepEqual(await repository.searchPublished({
    productModelId: "model-bed-1", countryCode: "TH", consumerScope: "CUSTOMER_SERVICE", now: NOW,
  }), []);
});

test("governance reviews mapped candidates and publishes a separate-duty support release", async (t) => {
  const db = new DatabaseSync(":memory:");
  createSchema(db);
  seedProduct(db);
  db.prepare(`INSERT INTO product_knowledge_import_batches (
    id,contract_version,package_digest,package_name,status,declared_counts_json,imported_counts_json,
    source_manifest_json,error_json,created_by,created_at,completed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "batch-1", "1.0.0", "digest-governance", "fixture", "IMPORTED", "{}", "{}", "{}", "{}", "tester", NOW, NOW,
  );
  const records = [
    candidate({ id: "candidate-claim", assetId: "asset-claim" }),
    candidate({
      id: "candidate-accessory", assetId: "asset-accessory",
      assetType: "PRODUCT_ACCESSORY_RELATION_CANDIDATE",
      content: { accessory_sku: "T3AZ1001", accessory_name: "螺丝包", applicable_style_name: "Steel Bed" },
    }),
    candidate({
      id: "candidate-policy", assetId: "asset-policy", targetDomain: "CUSTOMER_SERVICE_POLICY",
      assetType: "SUPPORT_POLICY_CANDIDATE", riskLevel: "SENSITIVE", productModelId: null,
      canonicalCategoryName: "家具",
      content: { issue_category: "缺件", issue: "螺丝包缺失", resolution: "核对订单和缺件照片后升级人工" },
      scope: { scope_type: "COUNTRY_OVERRIDE", country_codes: ["TH"], language: "zh-CN" },
      countries: ["TH"], consumers: [],
    }),
    candidate({
      id: "candidate-playbook", assetId: "asset-playbook", targetDomain: "CUSTOMER_SERVICE_PLAYBOOK",
      assetType: "SUPPORT_PLAYBOOK_CANDIDATE",
      content: { intent: "MISSING_PART", question: "少了螺丝怎么办？", reply_template: "请提供缺少配件照片，我们会为您核实。" },
      scope: { scope_type: "COUNTRY_OVERRIDE", country_codes: ["TH"], language: "zh-CN", visibility: "CUSTOMER_VISIBLE" },
      countries: ["TH"], consumers: ["CUSTOMER_SERVICE"],
    }),
  ];
  records.forEach((record) => insertCandidate(db, record));
  const provider = new SqliteProvider({ connection: db });
  t.after(() => provider.close());
  const repository = new ProductKnowledgeRepository({ provider });
  let sequence = 0;
  const service = new ProductKnowledgeService({
    repository,
    now: () => new Date(NOW),
    createId: () => `id-${++sequence}`,
    governance: {
      enabled: true,
      reviewerIds: ["reviewer-a"],
      publisherIds: ["reviewer-a", "publisher-b"],
    },
  });
  const commonScope = {
    scopeType: "COMMON", countries: [], languageCode: "zh-CN",
    consumerScopes: ["CUSTOMER_SERVICE"], visibility: "CUSTOMER_VISIBLE",
  };
  await service.reviewCandidate("candidate-claim", {
    action: "APPROVE", expectedContentDigest: "digest-asset-claim", scope: commonScope,
  }, { actorId: "reviewer-a" });
  await service.reviewCandidate("candidate-accessory", {
    action: "APPROVE", expectedContentDigest: "digest-asset-accessory", scope: commonScope,
  }, { actorId: "reviewer-a" });
  await service.reviewCandidate("candidate-policy", {
    action: "APPROVE", expectedContentDigest: "digest-asset-policy", acknowledgeRisk: true,
    reviewerRoles: ["COMPLIANCE_REVIEWER"],
    scope: {
      scopeType: "COUNTRY_OVERRIDE", countries: ["TH"], languageCode: "zh-CN",
      consumerScopes: ["CUSTOMER_SERVICE"], visibility: "CUSTOMER_VISIBLE_AFTER_POLICY_VALIDATION",
      categoryName: "家具",
    },
  }, { actorId: "reviewer-a" });
  await service.reviewCandidate("candidate-playbook", {
    action: "APPROVE", expectedContentDigest: "digest-asset-playbook",
    scope: {
      scopeType: "COUNTRY_OVERRIDE", countries: ["TH"], languageCode: "zh-CN",
      consumerScopes: ["CUSTOMER_SERVICE"], visibility: "CUSTOMER_VISIBLE",
    },
  }, { actorId: "reviewer-a" });

  const beforeRelease = await service.resolveSupportBundle({
    productModelId: "model-bed-1", categoryName: "家具", countryCode: "TH",
  });
  assert.deepEqual(Object.values(beforeRelease).map((items) => items.length), [0, 0, 0, 0]);

  const created = await service.createRelease({
    consumerScope: "CUSTOMER_SERVICE",
    releaseKey: "support-main",
    candidateIds: records.map((record) => record.id),
    notes: "Reviewed fixture",
  }, { actorId: "reviewer-a" });
  assert.equal(created.release.status, "DRAFT");
  await assert.rejects(
    service.publishRelease(created.release.id, {
      expectedContentDigest: created.release.contentDigest, acknowledgeHumanReview: true,
    }, { actorId: "reviewer-a" }),
    (error) => error.code === "PK_RELEASE_SEPARATION_REQUIRED",
  );
  const published = await service.publishRelease(created.release.id, {
    expectedContentDigest: created.release.contentDigest,
    acknowledgeHumanReview: true,
  }, { actorId: "publisher-b" });
  assert.equal(published.status, "PUBLISHED");

  const bundle = await service.resolveSupportBundle({
    productModelId: "model-bed-1", categoryName: "家具", countryCode: "TH",
  });
  assert.deepEqual(Object.fromEntries(Object.entries(bundle).map(([key, items]) => [key, items.length])), {
    claims: 1, accessories: 1, policies: 1, playbooks: 1,
  });
  assert.equal(bundle.policies[0].policy.resolution, "核对订单和缺件照片后升级人工");
  assert.equal(db.prepare("SELECT COUNT(*) total FROM product_knowledge_reviews").get().total, 4);
});

test("resolver reads published approved claims only and gives country overrides priority", async (t) => {
  const db = new DatabaseSync(":memory:");
  createSchema(db);
  seedProduct(db);
  db.prepare(`INSERT INTO product_knowledge_import_batches (
    id,contract_version,package_digest,package_name,status,declared_counts_json,imported_counts_json,
    source_manifest_json,error_json,created_by,created_at,completed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "batch-1", "1.0.0", "digest", "fixture", "IMPORTED", "{}", "{}", "{}", "{}", "tester", NOW, NOW,
  );
  seedPublishedClaim(db, { suffix: "common", text: "通用安装说明。" });
  seedPublishedClaim(db, { suffix: "th", text: "泰国版本安装说明。", scopeType: "COUNTRY_OVERRIDE", countryCode: "TH" });
  seedPublishedClaim(db, { suffix: "draft", text: "草稿不得出现。", releaseStatus: "DRAFT" });
  seedPublishedClaim(db, { suffix: "internal", text: "内部内容不得出现。", visibility: "INTERNAL_ONLY" });
  const provider = new SqliteProvider({ connection: db });
  t.after(() => provider.close());
  const repository = new ProductKnowledgeRepository({ provider });

  const thailand = await repository.searchPublished({
    productModelId: "model-bed-1", countryCode: "TH", consumerScope: "CUSTOMER_SERVICE", now: NOW,
  });
  const malaysia = await repository.searchPublished({
    productModelId: "model-bed-1", countryCode: "MY", consumerScope: "CUSTOMER_SERVICE", now: NOW,
  });

  assert.deepEqual(thailand.map((item) => item.text), ["泰国版本安装说明。", "通用安装说明。"]);
  assert.deepEqual(malaysia.map((item) => item.text), ["通用安装说明。"]);
  assert.ok(thailand.every((item) => item.evidence.sourceId === "source-1"));
  assert.ok(thailand.every((item) => item.release.digest.startsWith("release-digest-")));
});

test("customer-service Context links an encrypted LiaoLiao panel to exact Product Core and published evidence", async (t) => {
  const db = new DatabaseSync(":memory:");
  createSchema(db, { customerService: true });
  seedProduct(db);
  db.prepare(`INSERT INTO product_knowledge_import_batches (
    id,contract_version,package_digest,package_name,status,declared_counts_json,imported_counts_json,
    source_manifest_json,error_json,created_by,created_at,completed_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "batch-1", "1.0.0", "digest", "fixture", "IMPORTED", "{}", "{}", "{}", "{}", "tester", NOW, NOW,
  );
  seedPublishedClaim(db, { suffix: "context", text: "包装内附安装说明，按编号依次连接床架。" });
  const provider = new SqliteProvider({ connection: db });
  t.after(() => provider.close());
  const csRepository = new CustomerServiceRepository({ provider });
  const pkRepository = new ProductKnowledgeRepository({ provider });
  let sequence = 0;
  const encryptText = (value) => `encrypted:${Buffer.from(String(value), "utf8").toString("base64url")}`;
  const decryptText = (value) => Buffer.from(String(value).slice("encrypted:".length), "base64url").toString("utf8");
  const csService = new CustomerServiceService({
    repository: csRepository,
    encryptText,
    decryptText,
    identityPepper: "test-pepper",
    now: () => new Date(NOW),
    createId: () => `cs-id-${++sequence}`,
  });
  const account = await csService.createAccount({
    displayName: "LiaoLiao Thailand",
    countryCodes: ["TH"],
    automationMode: "SUGGEST_ONLY",
  });
  // This fixture needs an already-enabled account so ingestion creates the
  // suggestion that receives the Context snapshot. Production upgrades go
  // through CustomerServiceService rollout readiness checks.
  await csRepository.updateAccountAutomation({
    id: account.id,
    mode: "SUGGEST_ONLY",
    actorId: "test-fixture",
    now: NOW,
  });
  await csService.registerWorker("worker-1", { displayName: "Worker 1", capabilities: ["capture_panel"] });
  const ingested = await csService.ingestBatch("worker-1", { events: [{
    eventId: "message-event-1",
    sequenceNo: 1,
    accountId: account.id,
    observedAt: NOW,
    eventType: "MESSAGE_OBSERVED",
    shop: { externalId: "shop-1", name: "Thailand Home", countryCode: "TH" },
    conversation: { externalId: "conversation-1", customerExternalId: "buyer-1", customerDisplayName: "Buyer" },
    message: { externalId: "message-1", direction: "INBOUND", contentType: "TEXT", content: "How do I install it?", sentAt: NOW },
    observation: { unread: true },
    panelSnapshot: {
      source: "LIAOLIAO_RIGHT_PANEL",
      structured: { skus: ["T3AA1001001"], order_refs: ["ORDER-1"] },
      order: { references: ["ORDER-1"] },
      product: { skus: ["T3AA1001001"] },
    },
  }] });
  const contextService = new CustomerServiceContextService({
    customerServiceRepository: csRepository,
    productCoreFacade: new ProductCoreReadFacade({ provider }),
    productKnowledgeService: new ProductKnowledgeService({ repository: pkRepository, now: () => new Date(NOW) }),
    encryptText,
    decryptText,
    digestText: (value) => `digest:${Buffer.from(value).toString("base64url").slice(0, 40)}`,
    createId: () => `context-${++sequence}`,
    now: () => new Date(NOW),
  });
  const conversationId = ingested.results[0].conversationId;
  const result = await contextService.build(conversationId);

  assert.equal(result.context.product.productSkuId, "sku-bed-th");
  assert.equal(result.context.product.productModelId, "model-bed-1");
  assert.equal(result.context.knowledge.claims[0].text, "包装内附安装说明，按编号依次连接床架。");
  assert.equal(result.evidence[0].sourceVersion, "support-context@1");
  assert.ok(result.context.unavailable.includes("authoritative_order_context"));
  const stored = db.prepare("SELECT context_ciphertext FROM cs_context_snapshots WHERE id=?").get(result.snapshot.id);
  assert.equal(stored.context_ciphertext.includes("How do I install it?"), false);
  assert.equal(db.prepare("SELECT context_snapshot_id FROM cs_suggestions WHERE conversation_id=?").get(conversationId).context_snapshot_id, result.snapshot.id);
});

test("business Context facade resolves confirmed shop, exact order, country inventory and product package without guessing", async (t) => {
  const db = new DatabaseSync(":memory:");
  createSchema(db);
  seedProduct(db);
  db.exec(`
    CREATE TABLE commerce_shop_registry (
      id TEXT PRIMARY KEY,platform TEXT,provider_shop_id TEXT,shop_code TEXT,shop_name TEXT,
      normalized_shop_name TEXT,source_country_code TEXT,currency TEXT,category_name TEXT,
      growth_shop_id TEXT,identity_status TEXT,status TEXT,updated_at TEXT
    );
    CREATE TABLE growth_order_headers (
      id TEXT PRIMARY KEY,business_key TEXT,internal_shop_id TEXT,source_order_id TEXT,platform TEXT,
      order_status TEXT,effective_status TEXT,source_quality_status TEXT,paid_at TEXT,cancelled_at TEXT,
      order_currency TEXT,order_amount NUMERIC,revision INTEGER,source_batch_id TEXT,last_seen_at TEXT,updated_at TEXT
    );
    CREATE TABLE growth_order_lines (
      id TEXT PRIMARY KEY,order_header_id TEXT,is_current INTEGER,source_row_number INTEGER,line_occurrence INTEGER,
      source_sku TEXT,normalized_source_sku TEXT,platform_sku TEXT,mapped_product_id TEXT,mapped_country TEXT,
      quantity NUMERIC,line_amount NUMERIC,line_amount_status TEXT,product_name TEXT,mapping_status TEXT,
      effective_status TEXT,revision INTEGER,updated_at TEXT
    );
    CREATE TABLE growth_source_batches (
      id TEXT PRIMARY KEY,source_type TEXT,status TEXT,collected_at TEXT,imported_at TEXT,created_at TEXT,
      source_sha256 TEXT,row_count INTEGER
    );
    CREATE TABLE growth_country_mapping_sets (id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE growth_warehouse_country_mappings (
      id TEXT PRIMARY KEY,mapping_set_id TEXT,normalized_warehouse_name TEXT,country_code TEXT,country_name TEXT,mapping_status TEXT
    );
    CREATE TABLE growth_inventory_snapshots (
      id TEXT PRIMARY KEY,batch_id TEXT,mapped_product_id TEXT,source_sku TEXT,normalized_source_sku TEXT,
      warehouse_name TEXT,available_quantity NUMERIC,physical_quantity NUMERIC,locked_quantity NUMERIC,
      in_transit_quantity NUMERIC,pending_shipment_quantity NUMERIC,transfer_pending_shipment_quantity NUMERIC,
      sellable_quantity NUMERIC,sellable_quantity_status TEXT,source_predicted_daily_sales NUMERIC,
      predicted_daily_sales_semantic_status TEXT,days_of_supply NUMERIC,days_of_supply_status TEXT,
      snapshot_at TEXT,mapping_status TEXT,quality_status TEXT,created_at TEXT
    );
    CREATE TABLE product_package_rows (
      id TEXT PRIMARY KEY,latest_import_row_id TEXT,semantic_row_sha256 TEXT,raw_payload_json TEXT,
      import_batch_id TEXT,updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO commerce_shop_registry VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "shop-reg-1", "LAZADA", "seller-1", "BS0001", "S-NAIDE", "s naide", "TH", "THB", "卧室家具",
    "growth-shop-1", "CONFIRMED", "ACTIVE", NOW,
  );
  db.prepare(`INSERT INTO growth_order_headers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "order-1", "order-business-1", "growth-shop-1", "ORDER-1001", "LAZADA", "SHIPPED", "valid",
    "confirmed", NOW, null, "THB", 999, 2, "order-batch-1", NOW, NOW,
  );
  db.prepare(`INSERT INTO growth_order_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "line-1", "order-1", 1, 2, 1, "T3AA1001001", "T3AA1001001", "PLATFORM-SKU", "sku-bed-th",
    "TH", 1, 999, "confirmed", "Steel Bed", "matched", "valid", 2, NOW,
  );
  db.prepare("INSERT INTO growth_source_batches VALUES (?,?,?,?,?,?,?,?)").run(
    "inventory-batch-1", "mabang_inventory", "applied", NOW, NOW, NOW, "inventory-sha", 100,
  );
  db.prepare("INSERT INTO growth_country_mapping_sets VALUES (?,?)").run("country-map-1", "active");
  db.prepare("INSERT INTO growth_warehouse_country_mappings VALUES (?,?,?,?,?,?)").run(
    "warehouse-map-1", "country-map-1", "THAILAND TZ-A", "TH", "Thailand", "confirmed",
  );
  db.prepare(`INSERT INTO growth_inventory_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    "inventory-1", "inventory-batch-1", "sku-bed-th", "T3AA1001001", "T3AA1001001", "Thailand TZ-A",
    8, 10, 2, 3, 4, 1, 6, "confirmed", 1, "confirmed", 6, "confirmed", NOW, "matched", "confirmed", NOW,
  );
  db.prepare("INSERT INTO product_package_rows VALUES (?,?,?,?,?,?)").run(
    "package-row-1", "import-row-1", "package-semantic-sha", JSON.stringify({ material: "steel", color: "black" }),
    "package-batch-1", NOW,
  );
  db.prepare("UPDATE product_skus SET current_source_row_id=? WHERE id=?").run("import-row-1", "sku-bed-th");
  const provider = new SqliteProvider({ connection: db });
  t.after(() => provider.close());
  const facade = new CustomerServiceBusinessContextFacade({ provider });

  const shop = await facade.resolveShopCandidates({ observedName: "S.NAIDE", countryCode: "TH" });
  const order = await facade.findExactOrder({ commerceShopId: "shop-reg-1", orderRef: "ORDER-1001" });
  const inventory = await facade.currentInventory({ productSkuId: "sku-bed-th", countryCode: "TH" });
  const productPackage = await facade.productPackageSnapshot("sku-bed-th");

  assert.equal(shop.status, "EXACT_UNIQUE_CANDIDATE");
  assert.equal(order.status, "RESOLVED");
  assert.equal(order.order.lines[0].productSkuId, "sku-bed-th");
  assert.equal(inventory.status, "RESOLVED");
  assert.equal(inventory.snapshots[0].pendingShipmentQuantity, 4);
  assert.equal(inventory.snapshots[0].transferPendingShipmentQuantity, 1);
  assert.deepEqual(productPackage.facts, { material: "steel", color: "black" });
});
