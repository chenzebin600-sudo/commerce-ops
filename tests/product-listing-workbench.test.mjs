import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { ProductListingService, validateListingDraft } from "../lib/product-center/product-listing-service.mjs";

const now = "2026-07-21T08:00:00.000Z";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-listing-workbench-"));
  const access = openCommerceDataAccess({ rootDir: path.resolve("."), databasePath: path.join(root, "commerce.sqlite") });
  const db = access.provider.connection;
  db.prepare(`INSERT INTO product_import_batches (
    id,source_system,file_sha256,status,operator_label,created_at,updated_at,applied_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run("batch-listing", "company_product_center", "b".repeat(64), "applied", "fixture", now, now, now);
  db.prepare(`INSERT INTO product_categories (
    id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("listing-l1", null, "ROOT", 1, "company_product_center", "家纺", "家纺", "active", "batch-listing", "batch-listing", now, now);
  db.prepare(`INSERT INTO product_categories (
    id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("listing-l2", "listing-l1", "listing-l1", 2, "company_product_center", "床品", "床品", "active", "batch-listing", "batch-listing", now, now);
  for (const [index, country] of ["马来", "菲律宾"].entries()) {
    const id = `listing-product-${index + 1}`;
    const rowId = `listing-row-${index + 1}`;
    const source = { product_name: `${country}床品`, category_l1: "家纺", category_l2: "床品", sales_spec: "150x200cm" };
    db.prepare(`INSERT INTO product_import_rows (
      id,batch_id,source_row_number,source_sku,row_sha256,raw_payload_json,normalized_payload_json,validation_codes_json,
      outcome,target_sku_id,applied_at,created_at,source_country_raw,product_key,product_sha256,source_warehouse_raw,source_row_key,row_occurrence,package_row_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rowId, "batch-listing", index + 2, "SHARED-SKU", String(index + 1).repeat(64), JSON.stringify(source), JSON.stringify(source), "[]",
      "new", id, now, now, country, `${country}|SHARED-SKU`, String(index + 2).repeat(64), `${country}-A`, `${country}|SHARED-SKU|A|1`, 1, null,
    );
    db.prepare(`INSERT INTO product_skus (
      id,source_system,source_sku,normalized_sku,category_id,source_product_name,source_main_sku,source_style_name,source_sales_spec,
      source_status_raw,current_source_row_id,first_seen_batch_id,last_seen_batch_id,revision,created_at,updated_at,country_raw,sku_code_normalized
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, "company_product_center", "SHARED-SKU", `${country}|SHARED-SKU`, "listing-l2", `${country}床品`, "MAIN-001", "基础款", "150x200cm",
      "正常销售", rowId, "batch-listing", "batch-listing", 1, now, now, country, "SHARED-SKU",
    );
  }
  return {
    root,
    access,
    service: new ProductListingService({ repository: access.repositories.productListings }),
    product(country = "马来") {
      return { id: country === "马来" ? "listing-product-1" : "listing-product-2", country, sku: "SHARED-SKU" };
    },
    async close() { access.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

function draft(overrides = {}) {
  return {
    platform: "shopee",
    shopId: "shop-1",
    shopName: "测试店铺",
    platformCategoryName: "Bedding",
    title: "测试床品标题",
    description: "基于产品事实的商品描述",
    platformAttributes: [{ key: "material", value: "待人工确认", required: true }],
    variants: [{ sku: "SHARED-SKU", name: "150x200cm", availableStock: 10, status: "active" }],
    pricing: { salePrice: 59.9 },
    media: { imageIds: ["image-1", "image-2"], primaryImageId: "image-1" },
    logistics: { weightG: 1000, lengthCm: 40, widthCm: 30, heightCm: 20 },
    compliance: { aiRiskNotes: [] },
    ...overrides,
  };
}

test("migration 011 adds listing drafts and publish records without changing product rows", async () => {
  const context = await fixture();
  try {
    const db = context.access.provider.connection;
    assert.equal(db.prepare("SELECT count(*) n FROM product_skus").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM product_listing_drafts").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM product_listing_publish_records").get().n, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { await context.close(); }
});

test("saving a listing draft does not write product package facts or manual overrides", async () => {
  const context = await fixture();
  try {
    const before = context.access.provider.connection.prepare("SELECT source_product_name,revision FROM product_skus WHERE id=?").get("listing-product-1");
    const saved = await context.service.save(context.product(), draft(), { operatorLabel: "operator" });
    const after = context.access.provider.connection.prepare("SELECT source_product_name,revision FROM product_skus WHERE id=?").get("listing-product-1");
    assert.equal(saved.title, "测试床品标题");
    assert.deepEqual(after, before);
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_field_overrides").get().n, 0);
  } finally { await context.close(); }
});

test("platform, country and shop identities keep listing drafts isolated", async () => {
  const context = await fixture();
  try {
    await context.service.save(context.product(), draft(), { operatorLabel: "operator" });
    await context.service.save(context.product(), draft({ platform: "lazada" }), { operatorLabel: "operator" });
    await context.service.save(context.product(), draft({ shopId: "shop-2", shopName: "第二店铺" }), { operatorLabel: "operator" });
    await context.service.save(context.product("菲律宾"), draft(), { operatorLabel: "operator" });
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_listing_drafts").get().n, 4);
    assert.equal((await context.service.list("listing-product-1")).length, 3);
    assert.equal((await context.service.list("listing-product-2")).length, 1);
  } finally { await context.close(); }
});

test("saving the same product target updates one draft and increments its revision", async () => {
  const context = await fixture();
  try {
    const first = await context.service.save(context.product(), draft(), { operatorLabel: "operator" });
    const second = await context.service.save(context.product(), draft({ title: "更新标题" }), { operatorLabel: "operator" });
    assert.equal(second.id, first.id);
    assert.equal(second.revision, 2);
    assert.equal(second.title, "更新标题");
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_listing_drafts").get().n, 1);
  } finally { await context.close(); }
});

test("listing media order stays in the draft and never changes base product images", async () => {
  const context = await fixture();
  try {
    const saved = await context.service.save(context.product(), draft({ media: { imageIds: ["image-2", "image-1"], primaryImageId: "image-2" } }), { operatorLabel: "operator" });
    assert.deepEqual(saved.media.imageIds, ["image-2", "image-1"]);
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_images").get().n, 0);
  } finally { await context.close(); }
});

test("a later product source refresh does not overwrite an existing listing draft", async () => {
  const context = await fixture();
  try {
    const saved = await context.service.save(context.product(), draft(), { operatorLabel: "operator" });
    context.access.provider.connection.prepare("UPDATE product_skus SET source_product_name=?,revision=revision+1 WHERE id=?").run("中台更新名称", "listing-product-1");
    const [after] = await context.service.list("listing-product-1");
    assert.equal(after.id, saved.id);
    assert.equal(after.title, "测试床品标题");
  } finally { await context.close(); }
});

test("soft deleting a listing draft preserves its product and allows a fresh target draft", async () => {
  const context = await fixture();
  try {
    const saved = await context.service.save(context.product(), draft(), { operatorLabel: "operator" });
    await context.service.remove("listing-product-1", saved.id, { operatorLabel: "operator" });
    assert.equal((await context.service.list("listing-product-1")).length, 0);
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_skus WHERE id=?").get("listing-product-1").n, 1);
    const fresh = await context.service.save(context.product(), draft({ title: "重新建立" }), { operatorLabel: "operator" });
    assert.notEqual(fresh.id, saved.id);
  } finally { await context.close(); }
});

test("product deletion policy can archive every active listing draft", async () => {
  const context = await fixture();
  try {
    await context.service.save(context.product(), draft(), { operatorLabel: "operator" });
    await context.service.save(context.product(), draft({ platform: "lazada" }), { operatorLabel: "operator" });
    assert.equal(await context.service.archiveForProduct("listing-product-1", { operatorLabel: "admin" }), 2);
    assert.equal((await context.service.list("listing-product-1")).length, 0);
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_listing_drafts WHERE status='archived'").get().n, 2);
  } finally { await context.close(); }
});

test("save and check marks a complete draft ready without publishing", async () => {
  const context = await fixture();
  try {
    const saved = await context.service.save(context.product(), draft(), { operatorLabel: "operator" }, true);
    assert.equal(saved.status, "ready");
    assert.equal(saved.validationResult.ready, true);
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_listing_publish_records").get().n, 0);
  } finally { await context.close(); }
});

test("publication checks distinguish blockers from logistics warnings", () => {
  const result = validateListingDraft({ sku: "SKU-1" }, draft({ shopId: "", shopName: "", pricing: {}, media: {}, logistics: {}, platformAttributes: [] }));
  assert.equal(result.ready, false);
  assert.ok(result.blockerCount >= 3);
  assert.ok(result.warningCount >= 2);
  assert.equal(result.checks.find((item) => item.code === "SHOP_REQUIRED").severity, "blocker");
});

test("the workbench uses one scrollable page and no legacy edit tabs", async () => {
  const html = await fs.readFile("public/index.html", "utf8");
  for (const id of ["workbenchProductInfo", "workbenchListingTarget", "workbenchContent", "workbenchAi", "workbenchVariants", "workbenchMedia", "workbenchLogistics", "workbenchAttributes", "workbenchValidation"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.doesNotMatch(html, /data-product-edit-tab|productEditInfoPanel|productEditImagesPanel|productEditAiPanel/);
});

test("cancel and close controls are explicit non-submit buttons", async () => {
  const html = await fs.readFile("public/index.html", "utf8");
  assert.match(html, /id="productEditForm" class="product-listing-workbench"/);
  assert.doesNotMatch(html, /<form[^>]+id="productEditForm"/);
  for (const id of ["cancelProductEditBtn", "closeProductEditBtn", "productWorkbenchBackBtn"]) {
    assert.match(html, new RegExp(`<button[^>]+id=["']${id}["'][^>]+type=["']button["']`));
  }
});

test("all five close sources use the unified guarded close flow", async () => {
  const source = await fs.readFile("public/product-center-page.mjs", "utf8");
  assert.match(source, /async function handleRequestClose\(source = "unknown"\)/);
  for (const name of ["cancel-button", "close-icon", "escape-key", "backdrop", "route-change"]) assert.match(source, new RegExp(name));
  assert.match(source, /state\.closeRequestPending/);
  assert.match(source, /state\.dirtyScopes\.clear\(\)/);
});

test("dirty workbench confirmation uses the required copy and never saves on close", async () => {
  const html = await fs.readFile("public/index.html", "utf8");
  const source = await fs.readFile("public/product-center-page.mjs", "utf8");
  assert.match(html, /放弃本次修改？/);
  assert.match(html, /当前修改尚未保存，关闭后本次修改将丢失。/);
  assert.match(html, /继续编辑/);
  assert.match(html, /放弃修改并关闭/);
  const closeFlow = source.slice(source.indexOf("async function handleRequestClose"), source.indexOf("async function uploadProductImages"));
  assert.doesNotMatch(closeFlow, /saveListingWorkbench|saveProductOverrides|authorizedFetch/);
});

test("AI key remains backend-only and the workbench supports adopting title and description suggestions", async () => {
  const html = await fs.readFile("public/index.html", "utf8");
  const source = await fs.readFile("public/product-center-page.mjs", "utf8");
  assert.doesNotMatch(`${html}\n${source}`, /DEEPSEEK_API_KEY|api\.deepseek\.com|sk-[a-z0-9]{20,}/i);
  assert.match(source, /data-adopt-ai-title/);
  assert.match(source, /data-adopt-ai-description/);
});
