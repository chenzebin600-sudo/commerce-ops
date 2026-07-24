import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import {
  analyzeInventoryHtmlPayload,
  analyzeInventoryPayload,
  deduplicateDiscoveryRows,
  filenameSkuFromUrl,
  inventoryPageHash,
  normalizeDiscoveryRow,
  sanitizeInterfaceProfile,
  sanitizeStoredSourceUrl,
} from "../lib/mabang-images/extraction.mjs";
import { MabangInventoryBrowserSession, requestForPage, selectInventoryCapture } from "../lib/mabang-images/browser-session.mjs";
import { inspectImageBuffer, MabangImageAssetService } from "../lib/mabang-images/image-assets.mjs";
import { MabangSkuImageCollectorService } from "../lib/mabang-images/service.mjs";
import { redactAuditText, sanitizeAuditMetadata } from "../lib/security/audit-service.mjs";

const projectRoot = path.resolve(".");

function png(width = 2, height = 3) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

function rawRow(sku = "AB-1", image = "https://stock-cos.mabangerp.com/p/AB-1_123.png") {
  return { skuCode: sku, goodsName: "测试商品", warehouseName: "华南仓", imageUrl: image };
}

function row(sku = "AB-1", image = null, page = 1, rowNumber = 1) {
  return normalizeDiscoveryRow({ sourceSku: sku, sourceImageUrl: image, productName: "测试商品", warehouseName: "华南仓" },
    { pageNumber: page, rowNumber, sourceKind: "interface" });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mabang-image-tests-"));
  const access = openCommerceDataAccess({ rootDir: projectRoot, databasePath: path.join(root, "test.sqlite") });
  const now = new Date().toISOString();
  const accountId = randomUUID();
  await access.provider.execute(`INSERT INTO mabang_account_profiles
    (id,name,username,encrypted_password,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
  [accountId, "测试账号", "masked@example.test", "encrypted-only", 1, now, now]);
  return { root, access, repository: access.repositories.mabangImages, accountId, now };
}

async function seedProducts(context, countries = ["TH", "PH"], sku = "AB-1") {
  const { access, now } = context;
  const batchId = randomUUID();
  await access.provider.execute(`INSERT INTO product_import_batches
    (id,source_system,file_sha256,status,mapping_json,unknown_fields_json,validation_summary_json,operator_label,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [batchId, "company_product_center", randomUUID().replaceAll("-", ""), "applied", "[]", "[]", "{}", "test", now, now]);
  const categoryId = randomUUID();
  await access.provider.execute(`INSERT INTO product_categories
    (id,parent_id,parent_key,level,source_system,source_name,normalized_name,status,first_seen_batch_id,last_seen_batch_id,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [categoryId, null, "root", 1, "company_product_center", "测试类目", "测试类目", "active", batchId, batchId, now, now]);
  const products = [];
  for (let index = 0; index < countries.length; index += 1) {
    const country = countries[index];
    const importRowId = randomUUID();
    await access.provider.execute(`INSERT INTO product_import_rows
      (id,batch_id,source_row_number,source_sku,row_sha256,raw_payload_json,normalized_payload_json,validation_codes_json,outcome,created_at,
       source_country_raw,product_key,product_sha256,source_warehouse_raw,source_row_key,row_occurrence,raw_types_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [importRowId, batchId, index + 2, sku, `${index}`.padStart(64, "0"), "{}", "{}", "[]", "new", now,
        country, `${country}|${sku}`, `${index + 1}`.padStart(64, "0"), "仓", `${country}|${sku}|仓`, 1, "{}"]);
    const id = randomUUID();
    await access.provider.execute(`INSERT INTO product_skus
      (id,source_system,source_sku,normalized_sku,category_id,source_product_name,source_status_raw,current_source_row_id,
       first_seen_batch_id,last_seen_batch_id,created_at,updated_at,country_raw,sku_code_normalized)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id, "company_product_center", sku, `${country}|${sku}`, categoryId, `商品 ${country}`, "ACTIVE",
        importRowId, batchId, batchId, now, now, country, sku]);
    products.push({ id, country });
  }
  return { batchId, products };
}

test("1. 从接口响应提取 SKU、图片、仓库、名称及分页结构", () => {
  const result = analyzeInventoryPayload({ data: { list: [rawRow()], total: 101, pageNo: 1, pageSize: 50 } }, {
    request: { url: "https://tenant.mabangerp.com/inventory?pageNo=1&pageSize=50", method: "GET" }, transport: "xhr",
  });
  assert.equal(result.rows[0].sourceSku, "AB-1");
  assert.match(result.rows[0].sourceImageUrl, /stock-cos/);
  assert.equal(result.profile.pageParameter.path, "pageNo");
  assert.equal(result.profile.total, 101);
});

test("2. 接口没有图片字段时选择页面采集兜底", () => {
  const capture = selectInventoryCapture([{ payload: { rows: [{ skuCode: "A" }] }, request: { url: "https://a.mabangerp.com/api" }, transport: "xhr" }]);
  assert.equal(capture.analyzed.profile.hasImages, false);
});

test("3. 懒加载 data-src 和 srcset 可提取", () => {
  const lazy = normalizeDiscoveryRow({ sourceSku: "A", imageDataSrc: "https://stock-cos.mabangerp.com/A_1.webp" });
  const srcset = normalizeDiscoveryRow({ sourceSku: "B", imageSrcset: "https://stock-cos.mabangerp.com/B_1.jpg 1x, https://stock-cos.mabangerp.com/B_2.jpg 2x" });
  assert.match(lazy.sourceImageUrl, /A_1\.webp/);
  assert.match(srcset.sourceImageUrl, /B_1\.jpg/);
});

test("4. 多页发现按 SKU、图片、仓库去重", () => {
  const first = row("A", "https://stock-cos.mabangerp.com/A_1.png");
  assert.equal(deduplicateDiscoveryRows([first, { ...first }, row("B")]).length, 2);
});

test("5. 最后一页 hasNext=false 时正确停止", async () => {
  const harness = runHarness([{ rows: [row("A")], hasNext: false, totalPages: 1 }]);
  await harness.service.run("batch");
  assert.deepEqual(harness.pageCalls, [1]);
  assert.equal(harness.batch.status, "completed");
});

test("6. 连续页面内容哈希相同触发保护", async () => {
  const same = row("A", "https://stock-cos.mabangerp.com/A_1.png");
  const harness = runHarness([{ rows: [same], hasNext: true }, { rows: [{ ...same, sourcePage: 2 }], hasNext: true }]);
  await harness.service.run("batch");
  assert.deepEqual(harness.pageCalls, [1, 2]);
  assert.equal(harness.checkpoints.at(-1).status, "repeated");
  assert.equal(harness.checkpoints.at(-1).errorCode, "REPEATED_PAGE_HASH");
});

test("7. 已完成检查点后从下一页继续", async () => {
  const harness = runHarness([{ rows: [row("C", null, 3)], hasNext: false }], { pageNumber: 2, pageHash: inventoryPageHash([row("B")]), status: "completed" });
  await harness.service.run("batch");
  assert.deepEqual(harness.pageCalls, [3]);
});

test("8. 行 SKU 始终作为主要身份", () => {
  const value = normalizeDiscoveryRow({ sourceSku: "ROW-SKU", sourceImageUrl: "https://stock-cos.mabangerp.com/FILE-SKU_123.jpg" });
  assert.equal(value.sourceSku, "ROW-SKU");
  assert.equal(value.sourceSkuNormalized, "ROW-SKU");
});

test("9. 文件名 SKU 只用于正则校验", () => {
  assert.equal(filenameSkuFromUrl("https://stock-cos.mabangerp.com/a/ABC-9_171234.jpg"), "ABC-9");
  assert.equal(filenameSkuFromUrl("https://stock-cos.mabangerp.com/a/ABC-9.jpg"), null);
});

test("10. SKU 不一致生成质量问题", () => {
  const value = normalizeDiscoveryRow({ sourceSku: "ROW", sourceImageUrl: "https://stock-cos.mabangerp.com/FILE_1.png" });
  assert.equal(value.qualityIssueCode, "IMAGE_FILENAME_SKU_MISMATCH");
  assert.equal(value.validationStatus, "warning");
});

test("11. 相同 SHA-256 图片不重复保存", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  const service = new MabangImageAssetService({ repository: context.repository, tempRoot: path.join(context.root, "temp"), imageRoot: path.join(context.root, "media") });
  const first = await service.store({ buffer: png(), contentType: "image/png", sourceUrl: "https://stock-cos.mabangerp.com/A_1.png" });
  const second = await service.store({ buffer: png(), contentType: "image/png", sourceUrl: "https://stock-cos.mabangerp.com/B_2.png" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.asset.id, second.asset.id);
});

test("12. 403 按指数退避规则重试", async () => {
  const result = await retryHarness([403, 403, 200]);
  assert.equal(result.calls, 3);
  assert.deepEqual(result.waits, [500, 1000]);
  assert.equal(result.update.downloadStatus, "downloaded");
});

test("13. 429 按规则重试", async () => {
  const result = await retryHarness([429, 200]);
  assert.equal(result.calls, 2);
  assert.deepEqual(result.waits, [500]);
});

test("14. 非图片响应不保存", () => {
  assert.throws(() => inspectImageBuffer(Buffer.from("<html>login</html>"), { contentType: "text/html" }), { code: "IMAGE_CONTENT_TYPE_INVALID" });
});

test("15. 损坏图片不通过校验", () => {
  assert.throws(() => inspectImageBuffer(Buffer.from("not-a-png"), { contentType: "image/png" }), { code: "IMAGE_CORRUPTED" });
});

test("16. 一张图片关联多个国家下的相同 SKU", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  const seeded = await seedProducts(context, ["TH", "PH", "MY"]);
  const asset = await createAsset(context);
  const links = await context.repository.linkAssetToMatchingProducts({ assetId: asset.id, sourceSku: "AB-1", linkedBy: "tester" });
  assert.equal(links.length, 3);
  assert.deepEqual(new Set(links.map((link) => link.countryCode)), new Set(["TH", "PH", "MY"]));
  const product = await context.access.repositories.productCatalog.get(seeded.products[0].id);
  assert.equal(product.mabangImages[0].sourceSystem, "mabang");
});

test("17. 人工主图存在时不允许覆盖", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  const seeded = await seedProducts(context, ["TH"]);
  const asset = await createAsset(context);
  const [link] = await context.repository.linkAssetToMatchingProducts({ assetId: asset.id, sourceSku: "AB-1", linkedBy: "tester" });
  await context.access.provider.execute(`INSERT INTO product_images
    (id,sku_id,original_filename,storage_filename,relative_path,mime_type,file_size,file_hash,is_primary,sort_order,status,operator_label,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), seeded.products[0].id, "manual.png", "manual.png", "manual/manual.png", "image/png", 24, "hash", 1, 0, "available", "human", context.now, context.now]);
  await assert.rejects(() => context.repository.confirmPrimary(link.id, "tester"), { code: "MANUAL_PRIMARY_EXISTS" });
});

test("18. 未确认素材不写入当前上架素材", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  await seedProducts(context, ["TH"]);
  const asset = await createAsset(context);
  const before = await context.access.provider.query("SELECT count(*) total FROM product_listing_drafts");
  const [link] = await context.repository.linkAssetToMatchingProducts({ assetId: asset.id, sourceSku: "AB-1", linkedBy: "tester" });
  const after = await context.access.provider.query("SELECT count(*) total FROM product_listing_drafts");
  assert.equal(link.mappingStatus, "suggested");
  assert.equal(after.rows[0].total, before.rows[0].total);
});

test("19. 关联过程不修改 product_package_rows", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  await seedProducts(context, ["TH", "PH"]);
  const before = Number((await context.access.provider.query("SELECT count(*) total FROM product_package_rows")).rows[0].total);
  const asset = await createAsset(context);
  await context.repository.linkAssetToMatchingProducts({ assetId: asset.id, sourceSku: "AB-1", linkedBy: "tester" });
  const after = Number((await context.access.provider.query("SELECT count(*) total FROM product_package_rows")).rows[0].total);
  assert.equal(after, before);
});

test("20. 账号、Cookie、Token 和完整授权头不进入日志或接口档案", () => {
  const secret = "Bearer top-secret-token";
  assert.doesNotMatch(redactAuditText(`Authorization: ${secret}; Cookie: sid=abc`, { secretValues: [secret] }), /top-secret-token|sid=abc/);
  const metadata = sanitizeAuditMetadata({ batchId: "batch", cookie: "sid=abc", authorization: secret, token: "hidden" });
  assert.deepEqual(metadata, { batchId: "batch" });
  const profile = sanitizeInterfaceProfile({ url: "https://tenant.company.mabangerp.com/api?token=x&page=1", method: "POST", parameterKeys: ["page", "token"] });
  assert.doesNotMatch(JSON.stringify(profile), /tenant\.company|token=x|page=1/);
});

test("21. 分页请求只替换运行时识别的参数", () => {
  const request = requestForPage({ url: "https://x.mabangerp.com/api?pageNo=1&tenant=dynamic", method: "GET" },
    { pageParameter: { source: "query", path: "pageNo" }, pageSizeParameter: null }, 9);
  assert.equal(new URL(request.url).searchParams.get("pageNo"), "9");
  assert.equal(new URL(request.url).searchParams.get("tenant"), "dynamic");
});

test("22. 图片来源 URL 只脱敏，不根据 SKU 构造", () => {
  const source = "https://stock-cos.mabangerp.com/path/A_1.jpg?token=secret&v=2";
  const sanitized = sanitizeStoredSourceUrl(source);
  assert.equal(new URL(sanitized).searchParams.has("token"), false);
  assert.equal(new URL(sanitized).searchParams.get("v"), "2");
});

test("23. 图片二进制不写入 SQLite 迁移", async () => {
  const sql = await fs.readFile(path.join(projectRoot, "migrations", "015_mabang_sku_image_collector.sql"), "utf8");
  assert.doesNotMatch(sql, /\bBLOB\b|BYTEA/i);
  assert.match(sql, /relative_path TEXT NOT NULL/);
});

test("24. 下载并发被限制为 3 到 5", () => {
  const low = new MabangSkuImageCollectorService({ repository: {}, assetService: {}, browserFactory: async () => ({}), concurrency: 1 });
  const high = new MabangSkuImageCollectorService({ repository: {}, assetService: {}, browserFactory: async () => ({}), concurrency: 99 });
  assert.equal(low.concurrency, 3);
  assert.equal(high.concurrency, 5);
});

test("25. 管理页包含二次确认、暂停、继续、失败原因与主图确认", async () => {
  const [html, page] = await Promise.all([
    fs.readFile(path.join(projectRoot, "public", "index.html"), "utf8"),
    fs.readFile(path.join(projectRoot, "public", "mabang-images-page.mjs"), "utf8"),
  ]);
  const source = `${html}\n${page}`;
  for (const text of ["开始首次全量采集", "补采缺失图片", "重试失败图片", "暂停", "继续", "失败原因", "确认设为产品主图"]) assert.match(source, new RegExp(text));
  assert.match(page, /window\.confirm\("确认开始首次全量采集/);
});

test("26. CDP 标准返回包和库存 iframe 执行上下文可读取", async () => {
  const calls = [];
  const listeners = new Map();
  const cdp = {
    on: (name, handler) => listeners.set(name, handler),
    close: () => {},
    send: async (method, params = {}) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") return { result: { frameTree: { frame: { id: "top" }, childFrames: [{ frame: { id: "inventory" } }] } } };
      if (method === "Page.createIsolatedWorld") return { result: { executionContextId: params.frameId === "top" ? 10 : 20 } };
      if (method !== "Runtime.evaluate") return { result: {} };
      const source = params.expression;
      let value = null;
      if (source.includes("const labels = ['商品'")) value = { clicked: true, bodyText: "库存查询" };
      else if (source.includes("script[type=\"application/json\"]")) value = [];
      else if (source.includes("const roots =")) value = null;
      else if (source.includes("const allRows =")) value = params.contextId === 20
        ? { rows: [{ sourceSku: "FRAME-SKU", imageDataSrc: "https://stock-cos.mabangerp.com/FRAME-SKU_1.png", rowNumber: 1 }], currentPage: 1, nextDisabled: true, rowCount: 1 }
        : { rows: [], currentPage: 1, nextDisabled: true, rowCount: 0 };
      return { result: { result: { type: "object", value } } };
    },
  };
  const session = new MabangInventoryBrowserSession({
    targetProvider: async () => [{ type: "page", url: "https://tenant.mabangerp.com/", webSocketDebuggerUrl: "ws://test" }],
    connectCdp: async () => cdp,
    wait: async () => {},
  });
  const opened = await session.open();
  const page = await session.page(1);
  assert.equal(opened.strategy, "dom");
  assert.equal(page.rows[0].sourceSku, "FRAME-SKU");
  assert.equal(calls.some((call) => call.method === "Runtime.evaluate" && call.params.contextId === 20), true);
  await session.close();
});

test("27. 启动采集同时要求采集或重试权限以及产品关联权限", async () => {
  const source = await fs.readFile(path.join(projectRoot, "lib", "mabang-images", "api.mjs"), "utf8");
  assert.match(source, /body\.mode === "retry_failed" \? "mabang_images\.retry" : "mabang_images\.collect"/);
  assert.match(source, /accessPolicy\.assert\("mabang_images\.link"\)/);
});

test("28. 真实库存 XHR 返回 HTML 行时识别接口分页与图片来源", () => {
  const result = analyzeInventoryHtmlPayload({
    success: true,
    message: '<li><ul><li><img src="https://stock-cos.mabangerp.com/dynamic/A_1.jpg"></li><li><a class="shopStock">A</a></li></ul></li>',
  }, {
    request: {
      url: "https://tenant.mabangerp.com/index.php?mod=warehouse.inventorydetail",
      method: "POST",
      postData: "page=1&rowsPerPage=50&warehouseId=dynamic",
    },
    transport: "xhr",
  });
  assert.equal(result.htmlField, "message");
  assert.equal(result.profile.pageParameter.path, "page");
  assert.equal(result.profile.pageSizeParameter.path, "rowsPerPage");
  assert.equal(result.profile.hasImages, true);
  assert.equal(result.profile.rowsPath, "message");
});

test("29. 图片通过当前 CDP Browser Context 的 Network 资源通道下载", async () => {
  const image = png(7, 9);
  let read = false;
  const session = new MabangInventoryBrowserSession({ targetProvider: async () => [], connectCdp: async () => null });
  session.topFrameId = "inventory";
  session.cdp = {
    send: async (method) => {
      if (method === "Network.loadNetworkResource") return { result: { resource: {
        success: true, httpStatusCode: 200, stream: "stream-1", url: "https://stock-cos.mabangerp.com/dynamic/A_1.png",
        headers: { "content-type": "image/png" },
      } } };
      if (method === "IO.read") {
        if (read) return { result: { data: "", eof: true, base64Encoded: false } };
        read = true;
        return { result: { data: image.toString("base64"), eof: true, base64Encoded: true } };
      }
      return { result: {} };
    },
  };
  const result = await session.fetchImage("https://stock-cos.mabangerp.com/dynamic/A_1.png");
  assert.equal(result.status, 200);
  assert.equal(result.contentType, "image/png");
  assert.deepEqual(result.buffer, image);
});

test("30. CDP 网络错误按指数退避规则重试", async () => {
  let calls = 0;
  const waits = [];
  let update;
  const service = new MabangSkuImageCollectorService({
    repository: {
      updateDiscovery: async (_id, value) => { update = value; },
      linkAssetToMatchingProducts: async () => [],
    },
    assetService: { store: async () => ({ duplicate: false, asset: { id: "asset" } }) },
    browserFactory: async () => ({}),
    wait: async (ms) => waits.push(ms),
    retryAttempts: 4,
  });
  const browser = { fetchImage: async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("network"), { code: "IMAGE_NETWORK_ERROR" });
    return { status: 200, contentType: "image/png", buffer: png() };
  } };
  await service.downloadOne({ id: "batch", createdBy: "tester" }, {
    id: "row", sourceSku: "A", sourceImageUrl: "https://stock-cos.mabangerp.com/dynamic/A_1.png",
  }, browser);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(update.downloadStatus, "downloaded");
});

test("31. 并发相同 SHA-256 只落一个物理文件和一个素材记录", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  const service = new MabangImageAssetService({
    repository: context.repository,
    tempRoot: path.join(context.root, "temp"),
    imageRoot: path.join(context.root, "media"),
  });
  const [first, second] = await Promise.all([
    service.store({ buffer: png(8, 9), contentType: "image/png", sourceUrl: "https://stock-cos.mabangerp.com/dynamic/A_1.png" }),
    service.store({ buffer: png(8, 9), contentType: "image/png", sourceUrl: "https://stock-cos.mabangerp.com/dynamic/B_2.png" }),
  ]);
  assert.equal(first.asset.id, second.asset.id);
  assert.deepEqual([first.duplicate, second.duplicate].sort(), [false, true]);
  assert.equal((await context.access.provider.query("SELECT count(*) total FROM product_media_assets")).rows[0].total, 1);
});

test("32. 素材记录存在但物理文件缺失时由相同 SHA 内容安全修复", async (t) => {
  const context = await fixture();
  t.after(() => context.access.close());
  const imageRoot = path.join(context.root, "media");
  const service = new MabangImageAssetService({
    repository: context.repository,
    tempRoot: path.join(context.root, "temp"),
    imageRoot,
  });
  const source = { buffer: png(10, 11), contentType: "image/png", sourceUrl: "https://stock-cos.mabangerp.com/dynamic/A_1.png" };
  const first = await service.store(source);
  const storedPath = path.join(imageRoot, ...first.asset.relativePath.split("/"));
  await fs.unlink(storedPath);
  const repaired = await service.store(source);
  assert.equal(repaired.asset.id, first.asset.id);
  assert.equal(repaired.duplicate, true);
  assert.equal((await fs.stat(storedPath)).size, source.buffer.length);
});

test("33. 当前分支完整迁移链可从 001 执行至 015 且新增表初始为空", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mabang-image-migration-chain-"));
  const databasePath = path.join(root, "migration-chain.sqlite");
  let access;
  try {
    const migrationNames = (await fs.readdir(path.join(projectRoot, "migrations")))
      .filter((name) => /^\d{3}_.+\.sql$/.test(name))
      .sort();
    assert.deepEqual(
      migrationNames.map((name) => Number.parseInt(name.slice(0, 3), 10)),
      Array.from({ length: 15 }, (_, index) => index + 1),
    );
    assert.equal(migrationNames.at(-1), "015_mabang_sku_image_collector.sql");

    access = openCommerceDataAccess({ rootDir: projectRoot, databasePath });
    const applied = await access.provider.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(applied.rows.map((row) => row.version), migrationNames);
    assert.equal((await access.provider.query("PRAGMA integrity_check")).rows[0].integrity_check, "ok");
    assert.equal((await access.provider.query("PRAGMA foreign_key_check")).rows.length, 0);

    for (const table of [
      "mabang_sku_image_batches",
      "mabang_sku_image_checkpoints",
      "mabang_sku_image_discoveries",
      "product_media_assets",
      "product_media_links",
    ]) {
      const count = await access.provider.query(`SELECT COUNT(*) AS total FROM ${table}`);
      assert.equal(Number(count.rows[0].total), 0, table);
    }

    access.close();
    access = openCommerceDataAccess({ rootDir: projectRoot, databasePath });
    const reapplied = await access.provider.query("SELECT version FROM schema_migrations ORDER BY version");
    assert.deepEqual(reapplied.rows.map((row) => row.version), migrationNames);
  } finally {
    access?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function createAsset(context) {
  const service = new MabangImageAssetService({ repository: context.repository, tempRoot: path.join(context.root, "temp"), imageRoot: path.join(context.root, "media") });
  return (await service.store({ buffer: png(), contentType: "image/png", sourceUrl: "https://stock-cos.mabangerp.com/AB-1_1.png" })).asset;
}

async function retryHarness(statuses) {
  let calls = 0;
  let update;
  const waits = [];
  const repository = {
    updateDiscovery: async (_id, value) => { update = value; },
    linkAssetToMatchingProducts: async () => [],
  };
  const service = new MabangSkuImageCollectorService({
    repository,
    assetService: { store: async () => ({ duplicate: false, asset: { id: "asset" } }) },
    browserFactory: async () => ({}),
    wait: async (ms) => waits.push(ms),
    retryAttempts: 4,
  });
  const browser = { fetchImage: async () => {
    const status = statuses[calls++];
    return { status, contentType: status === 200 ? "image/png" : "text/plain", buffer: status === 200 ? png() : Buffer.from("denied") };
  } };
  await service.downloadOne({ id: "batch", createdBy: "tester" }, { id: "row", sourceSku: "A", sourceImageUrl: "https://stock-cos.mabangerp.com/A_1.png" }, browser);
  return { calls, waits, update };
}

function runHarness(pages, checkpoint = null) {
  const batch = { id: "batch", accountId: "account", mode: "full_initial", status: "pending", currentPage: checkpoint?.pageNumber || 0,
    totalPages: null, startedAt: null, createdBy: "tester", failedImages: 0 };
  const checkpoints = [];
  const discoveries = new Map();
  const pageCalls = [];
  const repository = {
    getBatch: async () => ({ ...batch }),
    updateBatch: async (_id, changes) => { Object.assign(batch, changes); return { ...batch }; },
    latestCheckpoint: async () => checkpoint,
    upsertCheckpoint: async (value) => checkpoints.push(value),
    saveDiscoveries: async (_id, values) => { discoveries.set(values[0]?.sourcePage || 1, values.map((item, index) => ({ ...item, id: `${item.sourcePage}-${index}` }))); },
    discoveriesForPage: async (_id, pageNumber) => discoveries.get(pageNumber) || [],
    updateDiscovery: async () => {},
    recomputeBatchCounters: async () => ({ ...batch, failedImages: 0 }),
  };
  const browser = {
    open: async () => ({ interfaceProfile: {}, totalPages: null }),
    page: async (number) => { pageCalls.push(number); const value = pages[pageCalls.length - 1] || { rows: [], hasNext: false }; return value; },
    close: async () => {},
  };
  const service = new MabangSkuImageCollectorService({ repository, assetService: {}, browserFactory: async () => browser });
  return { service, batch, checkpoints, pageCalls };
}
