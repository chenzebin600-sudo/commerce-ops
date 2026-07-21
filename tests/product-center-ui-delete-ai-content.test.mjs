import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { ProductCatalogService } from "../lib/product-center/product-catalog-service.mjs";
import { ProductAiContentService } from "../lib/product-center/product-ai-content-service.mjs";
import { createProductAccessPolicy } from "../lib/product-center/product-access-policy.mjs";
import { parseProductAiResponse } from "../lib/product-center/product-ai-response.mjs";
import { describeAuditRequest } from "../lib/security/audit-http.mjs";

const projectRoot = path.resolve(".");
const now = "2026-07-21T08:00:00.000Z";
const validAiContent = Object.freeze({
  product_summary: "适用于卧室收纳的测试产品。",
  target_users: ["租房用户", "家庭用户", "宿舍用户"],
  user_pain_points: ["空间有限", "物品凌乱", "取放不便"],
  selling_points: [{ title: "规格明确", description: "依据产品销售规格说明使用范围。", source_field: "sales_spec" }],
  usage_scenarios: [{ scene: "卧室收纳", user: "家庭用户", benefit: "集中整理日常用品" }],
  feature_benefit_map: [{ feature: "明确尺寸", benefit: "便于购买前确认摆放空间" }],
  risk_notes: ["当前产品数据不足，以下内容需要人工确认。"],
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "product-ui-ai-"));
  const access = openCommerceDataAccess({ rootDir: projectRoot, databasePath: path.join(root, "commerce.sqlite") });
  const db = access.provider.connection;
  db.prepare(`INSERT INTO product_import_batches (
    id,source_system,file_sha256,status,operator_label,created_at,updated_at,applied_at
  ) VALUES (?,?,?,?,?,?,?,?)`).run("batch-1", "company_product_center", "a".repeat(64), "applied", "fixture", now, now, now);
  db.prepare(`INSERT INTO product_categories (
    id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("cat-l1", null, "ROOT", 1, "company_product_center", "家纺", "家纺", "active", "batch-1", "batch-1", now, now);
  db.prepare(`INSERT INTO product_categories (
    id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run("cat-l2", "cat-l1", "cat-l1", 2, "company_product_center", "收纳", "收纳", "active", "batch-1", "batch-1", now, now);
  for (const [index, country] of ["马来", "菲律宾"].entries()) {
    const rowId = `row-${index + 1}`;
    const productId = `product-${index + 1}`;
    const normalized = `${country}|SKU-001`;
    const source = { product_name: `${country}测试商品`, category_l1: "家纺", category_l2: "收纳", sales_spec: "白色 40cm" };
    db.prepare(`INSERT INTO product_import_rows (
      id,batch_id,source_row_number,source_sku,row_sha256,raw_payload_json,normalized_payload_json,validation_codes_json,
      outcome,target_sku_id,applied_at,created_at,source_country_raw,product_key,product_sha256,source_warehouse_raw,source_row_key,row_occurrence,package_row_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      rowId, "batch-1", index + 2, "SKU-001", String(index + 1).repeat(64), JSON.stringify(source), JSON.stringify(source), "[]",
      "new", productId, now, now, country, normalized, String(index + 2).repeat(64), `${country}-A`, `${normalized}|A|1`, 1, null,
    );
    db.prepare(`INSERT INTO product_skus (
      id,source_system,source_sku,normalized_sku,category_id,source_product_name,source_main_sku,source_style_name,source_sales_spec,
      source_status_raw,current_source_row_id,first_seen_batch_id,last_seen_batch_id,revision,created_at,updated_at,country_raw,sku_code_normalized
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      productId, "company_product_center", "SKU-001", normalized, "cat-l2", `${country}测试商品`, "MAIN-001", "收纳款", "白色 40cm",
      "正常销售", rowId, "batch-1", "batch-1", 1, now, now, country, "SKU-001",
    );
    db.prepare(`INSERT INTO product_sku_lifecycle (
      sku_id,status_code,revision,decision_source,source_status_raw,source_batch_id,reason_code,operator_label,effective_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(productId, "ACTIVE", 1, "central", "正常销售", "batch-1", "CENTRAL_ACTIVE", "fixture", now, now);
  }
  return {
    root,
    access,
    catalog: new ProductCatalogService({ repository: access.repositories.productCatalog }),
    close: async () => { access.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

async function readUi() {
  return {
    html: await fs.readFile("public/index.html", "utf8"),
    source: await fs.readFile("public/product-center-page.mjs", "utf8"),
  };
}

test("1 import mapping is retained inside closed technical information", async () => {
  const { html } = await readUi();
  assert.match(html, /<details id="productTechnicalDetails"[^>]*>/);
  assert.doesNotMatch(html, /<details id="productTechnicalDetails"[^>]*\sopen(?:\s|>)/);
  assert.match(html, /id="productFieldMappingTable"/);
});

test("2 full parsed rows are hidden by default without removing evidence access", async () => {
  const { html } = await readUi();
  const technical = html.slice(html.indexOf('id="productTechnicalDetails"'), html.indexOf('id="productImportConfirmation"'));
  assert.match(technical, /id="productImportRowsTable"/);
  assert.match(technical, /逐行解析记录/);
});

test("3 blocker details remain available and open when blockers exist", async () => {
  const { html, source } = await readUi();
  assert.match(html, /id="productBlockerDetails"/);
  assert.match(source, /productBlockerDetails"\)\.open = Number\(batch\.blockerCount/);
});

test("4 field changes remain available in a collapsed disclosure", async () => {
  const { html } = await readUi();
  assert.match(html, /<details id="productChangesDetails"/);
  assert.match(html, /id="productImportChangesTable"/);
});

test("5 delete action is rendered only through product.delete capability", async () => {
  const { source } = await readUi();
  assert.match(source, /can\("product\.delete"\).*data-product-delete-id/s);
});

test("6 product deletion requires a dedicated confirmation dialog", async () => {
  const { html, source } = await readUi();
  assert.match(html, /id="productDeleteDialog"/);
  assert.match(html, /确认删除该产品吗/);
  assert.match(source, /productDeleteForm.*deleteProduct/s);
});

test("7 deleting one country SKU does not affect the same SKU in another country", async () => {
  const context = await fixture();
  try {
    await context.catalog.softDelete("product-1", "测试删除", { operatorLabel: "admin" });
    const malaysia = await context.catalog.detail("product-1");
    const philippines = await context.catalog.detail("product-2");
    assert.ok(malaysia.deletedAt);
    assert.equal(philippines.deletedAt, null);
  } finally { await context.close(); }
});

test("8 delete is soft and preserves the product row", async () => {
  const context = await fixture();
  try {
    await context.catalog.softDelete("product-1", "测试删除", { operatorLabel: "admin" });
    const row = context.access.provider.connection.prepare("SELECT deleted_at,deleted_by,delete_reason FROM product_skus WHERE id=?").get("product-1");
    assert.ok(row.deleted_at);
    assert.equal(row.deleted_by, "admin");
    assert.equal(row.delete_reason, "测试删除");
  } finally { await context.close(); }
});

test("9 soft-deleted products are absent from default catalog queries", async () => {
  const context = await fixture();
  try {
    await context.catalog.softDelete("product-1", null, { operatorLabel: "admin" });
    const result = await context.catalog.list({ pageSize: 10 });
    assert.deepEqual(result.products.map((item) => item.id), ["product-2"]);
  } finally { await context.close(); }
});

test("10 authorized deleted queries can restore a product", async () => {
  const context = await fixture();
  try {
    await context.catalog.softDelete("product-1", null, { operatorLabel: "admin" });
    const deleted = await context.catalog.list({ deleted: "deleted", pageSize: 10 });
    assert.deepEqual(deleted.products.map((item) => item.id), ["product-1"]);
    await context.catalog.restore("product-1", { operatorLabel: "admin" });
    assert.equal((await context.catalog.detail("product-1")).deletedAt, null);
  } finally { await context.close(); }
});

test("11 delete and restore use stable audit operations", () => {
  assert.equal(describeAuditRequest("DELETE", "/api/product-center/products/abc").action, "product.deleted");
  assert.equal(describeAuditRequest("POST", "/api/product-center/products/abc/restore").action, "product.restored");
});

test("12 the product detail drawer remains read-only", async () => {
  const { html } = await readUi();
  const drawer = html.slice(html.indexOf('id="productCatalogDrawer"'), html.indexOf('id="productDetailFieldsDialog"'));
  assert.doesNotMatch(drawer, /<(?:input|textarea|select)\b/i);
});

test("13 manual overrides update details and can be cleared back to source facts", async () => {
  const context = await fixture();
  try {
    await context.catalog.update("product-1", { product_name: "人工商品名" }, { operatorLabel: "operator" });
    let product = await context.catalog.detail("product-1");
    assert.equal(product.productName, "人工商品名");
    assert.equal(product.sourceFieldValues.product_name, "马来测试商品");
    await context.catalog.update("product-1", {}, { operatorLabel: "operator" }, ["product_name"]);
    product = await context.catalog.detail("product-1");
    assert.equal(product.productName, "马来测试商品");
    assert.equal(product.manualOverrides.product_name, undefined);
  } finally { await context.close(); }
});

test("14 soft delete and source refresh do not remove manual override records", async () => {
  const context = await fixture();
  try {
    await context.catalog.update("product-1", { style_name: "人工款名" }, { operatorLabel: "operator" });
    await context.catalog.softDelete("product-1", null, { operatorLabel: "admin" });
    await context.catalog.restore("product-1", { operatorLabel: "admin" });
    assert.equal((await context.catalog.detail("product-1")).styleName, "人工款名");
  } finally { await context.close(); }
});

test("15 missing DeepSeek configuration is explicit and secret-free", async () => {
  const service = new ProductAiContentService({ repository: {}, gateway: {}, configured: false });
  await assert.rejects(service.generate({ id: "p1" }), (error) => error.code === "AI_NOT_CONFIGURED" && !/key-[a-z0-9]/i.test(error.message));
});

test("16 DeepSeek calls exist only in backend adapters and the browser has no API key", async () => {
  const { source } = await readUi();
  const provider = await fs.readFile("lib/ai/providers/deepseek-provider.mjs", "utf8");
  assert.doesNotMatch(source, /DEEPSEEK_API_KEY|api\.deepseek\.com|authorization\s*:/i);
  assert.match(provider, /authorization: `Bearer \$\{this\.apiKey\}`/);
});

test("17 a non-JSON AI response is rejected with a stable code", () => {
  assert.throws(() => parseProductAiResponse("not json"), (error) => error.code === "PRODUCT_AI_RESPONSE_NOT_JSON");
});

test("18 a structurally incomplete AI response is rejected", () => {
  assert.throws(() => parseProductAiResponse(JSON.stringify({ product_summary: "only" })), (error) => error.code === "PRODUCT_AI_RESPONSE_SCHEMA_INVALID");
});

test("19 generating AI content does not save automatically", async () => {
  let saveCount = 0;
  const service = new ProductAiContentService({
    configured: true,
    repository: { create: async () => { saveCount += 1; } },
    gateway: { complete: async () => ({ success: true, content: JSON.stringify(validAiContent), provider: "deepseek", model: "deepseek-v4", durationMs: 1 }) },
  });
  const result = await service.generate({ id: "p1", sku: "SKU-1", country: "马来", sourceFacts: {}, images: [] });
  assert.equal(result.outputContent.product_summary, validAiContent.product_summary);
  assert.equal(saveCount, 0);
});

test("20 confirmed AI content is written to product_ai_contents", async () => {
  const context = await fixture();
  try {
    const service = new ProductAiContentService({ repository: context.access.repositories.productAiContents, gateway: {}, configured: false });
    const product = await context.catalog.detail("product-1");
    const content = await service.save(product, { status: "confirmed", outputContent: validAiContent }, { operatorLabel: "reviewer" });
    assert.equal(content.status, "confirmed");
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_ai_contents").get().n, 1);
  } finally { await context.close(); }
});

test("21 AI content versions preserve history and only one confirmed version", async () => {
  const context = await fixture();
  try {
    const service = new ProductAiContentService({ repository: context.access.repositories.productAiContents, gateway: {}, configured: false });
    const product = await context.catalog.detail("product-1");
    await service.save(product, { status: "confirmed", outputContent: validAiContent }, { operatorLabel: "reviewer" });
    await service.save(product, { status: "confirmed", outputContent: { ...validAiContent, product_summary: "第二版" } }, { operatorLabel: "reviewer" });
    const history = await service.history(product.id, { pageSize: 10 });
    assert.deepEqual(history.contents.map((item) => item.version), [2, 1]);
    assert.equal(history.contents.filter((item) => item.status === "confirmed").length, 1);
    assert.equal(history.contents.find((item) => item.version === 1).status, "archived");
  } finally { await context.close(); }
});

test("22 saving AI content never writes product package source rows", async () => {
  const context = await fixture();
  try {
    const before = context.access.provider.connection.prepare("SELECT count(*) n FROM product_package_rows").get().n;
    const service = new ProductAiContentService({ repository: context.access.repositories.productAiContents, gateway: {}, configured: false });
    await service.save(await context.catalog.detail("product-1"), { status: "draft", outputContent: validAiContent }, { operatorLabel: "operator" });
    const after = context.access.provider.connection.prepare("SELECT count(*) n FROM product_package_rows").get().n;
    assert.equal(after, before);
  } finally { await context.close(); }
});

test("23 saving AI content never overwrites product field overrides", async () => {
  const context = await fixture();
  try {
    await context.catalog.update("product-1", { product_name: "人工商品名" }, { operatorLabel: "operator" });
    const before = context.access.provider.connection.prepare("SELECT value_json FROM product_field_overrides WHERE sku_id=? AND field_code='product_name'").get("product-1").value_json;
    const service = new ProductAiContentService({ repository: context.access.repositories.productAiContents, gateway: {}, configured: false });
    await service.save(await context.catalog.detail("product-1"), { status: "confirmed", outputContent: validAiContent }, { operatorLabel: "reviewer" });
    const after = context.access.provider.connection.prepare("SELECT value_json FROM product_field_overrides WHERE sku_id=? AND field_code='product_name'").get("product-1").value_json;
    assert.equal(after, before);
  } finally { await context.close(); }
});

test("24 product permissions and country/category scopes are independent", () => {
  const policy = createProductAccessPolicy({
    PRODUCT_PERMISSIONS: "product.view,product.ai.generate",
    PRODUCT_ALLOWED_COUNTRIES: "马来",
    PRODUCT_ALLOWED_CATEGORY_L1: "家纺",
  });
  assert.equal(policy.has("product.view"), true);
  assert.equal(policy.has("product.edit"), false);
  assert.equal(policy.productInScope({ country: "马来", categoryL1: "家纺" }), true);
  assert.equal(policy.productInScope({ country: "菲律宾", categoryL1: "家纺" }), false);
  assert.throws(() => policy.assert("product.ai.confirm", { country: "马来", categoryL1: "家纺" }), /没有执行此产品操作的权限/);
});

test("25 migration 010 is additive and preserves existing product data", async () => {
  const context = await fixture();
  try {
    const columns = context.access.provider.connection.prepare("PRAGMA table_info('product_skus')").all().map((item) => item.name);
    for (const column of ["deleted_at", "deleted_by", "delete_reason", "restored_at", "restored_by"]) assert.ok(columns.includes(column));
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_skus").get().n, 2);
    assert.equal(context.access.provider.connection.prepare("SELECT count(*) n FROM product_ai_contents").get().n, 0);
    assert.equal(context.access.provider.connection.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { await context.close(); }
});
