import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { openCommerceDataAccess } from "../lib/data/data-access.mjs";
import { SchedulerDatabase } from "../lib/mabang-scheduler/db.mjs";
import { createExportFileService } from "../lib/files/export-file-service.mjs";
import { resolvePythonRuntime } from "../lib/python-runtime.mjs";
import { ensureFileStorageRoots, resolveFileStorageConfig, XLSX_MIME } from "../lib/security/file-policy.mjs";
import { ALL_PRODUCT_PACKAGE_FIELDS, PRODUCT_PACKAGE_HEADERS, PRODUCT_PACKAGE_FIELD_COUNT } from "../lib/product-center/product-package-contract.mjs";
import { semanticCellEqual, validateParsedProductPackage } from "../lib/product-center/product-package-validation.mjs";
import { ProductImportService } from "../lib/product-center/product-import-service.mjs";
import { ProductCatalogService } from "../lib/product-center/product-catalog-service.mjs";
import { ProductImageService } from "../lib/product-center/product-image-service.mjs";
import { parseProductPackageXlsx } from "../lib/product-center/xlsx-parser.mjs";

const projectRoot = path.resolve(".");
const parserScript = path.join(projectRoot, "scripts", "product-package-parser.py");
const migrationsDir = path.join(projectRoot, "migrations");
const python = resolvePythonRuntime({ appRoot: projectRoot, env: process.env, requiredModules: ["openpyxl"] });

function completeRow(overrides = {}) {
  return {
    周期: "202606", SKU: "SKU-001", 商品名称: "测试商品", 主SKU: "MAIN-001", 国家: "马来",
    一级品类: "家纺", 二级品类: "床品", 创建日期: "2026-06-01", 新款年月: "202606", 新款月龄: 1,
    赠品: "否", SKU状态: "正常销售", 款号: "STYLE-01", 款名: "测试款", 销售规格: "白色 / 150x200cm",
    单品尺寸: "150x200cm", 单品净重g: 1000, 单品毛重g: 1100, 外箱长cm: 40, 外箱宽cm: 30,
    外箱高cm: 20, 每箱数量: 1, 出货方式: "整箱", 仓库: "MY-A", 仓存: 20, 规划仓: "MY-A",
    销售成本人民币: 10, 国家汇率: 5, 销售成本国家币: 50, "1档价(20%)": 62.5,
    "2档价(25%)": 66.67, "3档价(35%)": 76.92, "4档价(45%)": 90.91, 连带率: 1,
    ...overrides,
  };
}

async function createWorkbook(root, rows, headers = PRODUCT_PACKAGE_HEADERS) {
  const jsonPath = path.join(root, "fixture.json");
  const xlsxPath = path.join(root, "fixture.xlsx");
  await fs.writeFile(jsonPath, JSON.stringify({ headers, rows }), "utf8");
  const code = [
    "import json,sys",
    "from openpyxl import Workbook",
    "data=json.load(open(sys.argv[1],encoding='utf-8'))",
    "wb=Workbook()",
    "ws=wb.active",
    "ws.title='\\u4ea7\\u54c1\\u5305'",
    "ws.append(data['headers'])",
    "[ws.append([row.get(header) for header in data['headers']]) for row in data['rows']]",
    "wb.save(sys.argv[2])",
  ].join(";");
  const result = spawnSync(python.executable, ["-c", code, jsonPath, xlsxPath], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return xlsxPath;
}

async function fixture() {
  assert.equal(python.ok, true, "openpyxl runtime is required for product import tests");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-import-"));
  const dataAccess = openCommerceDataAccess({ rootDir: projectRoot, databasePath: path.join(root, "commerce.sqlite") });
  const fileStorageConfig = await ensureFileStorageRoots(resolveFileStorageConfig(root, {
    STORAGE_ROOT: path.join(root, "storage"),
    EXPORT_ROOT: path.join(root, "storage", "exports"),
    TEMP_ROOT: path.join(root, "storage", "temp"),
    UPLOAD_ROOT: path.join(root, "storage", "uploads"),
    MAX_UPLOAD_BYTES: String(20 * 1024 * 1024),
  }));
  const fileService = createExportFileService({
    repository: dataAccess.repositories.exportFiles,
    exportRoot: fileStorageConfig.exportRoot,
    tempRoot: fileStorageConfig.tempRoot,
  });
  const service = new ProductImportService({
    repository: dataAccess.repositories.productImports,
    fileService,
    fileStorageConfig,
    pythonExecutable: python.executable,
    parserScript,
    maxRows: 10000,
  });
  return {
    root,
    dataAccess,
    fileStorageConfig,
    service,
    async close() {
      dataAccess.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("the frozen product package contract recognizes exactly 34 central fields", () => {
  assert.equal(PRODUCT_PACKAGE_FIELD_COUNT, 34);
  assert.equal(new Set(PRODUCT_PACKAGE_HEADERS).size, 34);
});

test("a normal Excel product package validates and applies through the standard flow", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [completeRow()]);
    const result = await context.service.uploadAndValidate({
      filename: "产品包测试.xlsx",
      mimeType: XLSX_MIME,
      buffer: await fs.readFile(filename),
      operatorLabel: "test_session",
      requestId: "request-product-normal",
    });
    assert.equal(result.batch.status, "preview_ready");
    assert.equal(result.batch.rowCount, 1);
    assert.equal(result.batch.blockerCount, 0);
    assert.equal(result.batch.sourceFilename, "产品包测试.xlsx");
    assert.equal(result.detail.file.fileRole, "source");
    assert.equal(result.detail.file.sourceFilename, "产品包测试.xlsx");
    const applied = await context.service.apply(result.batch.id, { operatorLabel: "test_session", requestId: "request-apply", acknowledgeWarnings: true });
    assert.equal(applied.status, "applied");
    const db = context.dataAccess.provider.connection;
    assert.equal(db.prepare("SELECT count(*) n FROM product_skus").get().n, 1);
    assert.equal(db.prepare("SELECT status_code FROM product_sku_lifecycle").get().status_code, "ACTIVE");
    assert.equal(db.prepare("SELECT exchange_direction FROM product_cost_snapshots").get().exchange_direction, "local_per_cny");
    const file = context.dataAccess.repositories.exportFiles.list({ sourceType: "product_package_import" }).files[0];
    assert.equal(file.sourceType, "product_package_import");
    assert.equal(file.fileHash.length, 64);
  } finally {
    await context.close();
  }
});

test("country plus SKU is the product identity and later imports update only that country", async () => {
  const context = await fixture();
  try {
    const firstFile = await createWorkbook(context.root, [
      completeRow({ SKU: "SHARED-001", 国家: "马来", 商品名称: "马来版本", 仓库: "MY-A", 销售成本人民币: 10, 国家汇率: 5, 销售成本国家币: 50 }),
      completeRow({ SKU: "SHARED-001", 国家: "泰国", 商品名称: "泰国版本", 仓库: "TH-A", 销售成本人民币: 12, 国家汇率: 5, 销售成本国家币: 60 }),
    ]);
    const first = await context.service.uploadAndValidate({ filename: "countries.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    assert.equal(first.batch.rowCount, 2);
    await context.service.apply(first.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    const db = context.dataAccess.provider.connection;
    assert.equal(db.prepare("SELECT count(*) n FROM product_skus WHERE source_sku='SHARED-001'").get().n, 2);

    const secondFile = await createWorkbook(context.root, [
      completeRow({ SKU: "SHARED-001", 国家: "马来", 商品名称: "马来版本更新", 仓库: "MY-A", 销售成本人民币: 11, 国家汇率: 5, 销售成本国家币: 55 }),
    ]);
    const second = await context.service.uploadAndValidate({ filename: "country-update.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    assert.equal(second.batch.updatedCount, 1);
    await context.service.apply(second.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    const names = db.prepare("SELECT country_raw,source_product_name FROM product_skus WHERE source_sku='SHARED-001' ORDER BY country_raw").all();
    assert.deepEqual(names.map((row) => ({ ...row })), [
      { country_raw: "泰国", source_product_name: "泰国版本" },
      { country_raw: "马来", source_product_name: "马来版本更新" },
    ]);
  } finally {
    await context.close();
  }
});

test("a central template without cost fields imports without invented cost data", async () => {
  const context = await fixture();
  try {
    const headers = PRODUCT_PACKAGE_HEADERS.filter((header) => !["出货方式", "规划仓", "销售成本人民币", "国家汇率", "销售成本国家币", "1档价(20%)", "2档价(25%)", "3档价(35%)", "4档价(45%)", "连带率"].includes(header));
    const filename = await createWorkbook(context.root, [completeRow({ SKU: "NO-COST-001" })], headers);
    const result = await context.service.uploadAndValidate({ filename: "no-cost.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    assert.equal(result.batch.blockerCount, 0);
    await context.service.apply(result.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    assert.equal(context.dataAccess.provider.connection.prepare("SELECT count(*) n FROM product_cost_snapshots").get().n, 0);
  } finally {
    await context.close();
  }
});

test("manual product fields and global detail preferences are stored separately from central facts", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [completeRow({ SKU: "EDIT-001", 商品名称: "中台名称" })]);
    const imported = await context.service.uploadAndValidate({ filename: "edit.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    await context.service.apply(imported.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    const service = new ProductCatalogService({ repository: context.dataAccess.repositories.productCatalog });
    const product = (await service.list({ keyword: "EDIT-001" })).products[0];
    await service.update(product.id, { product_name: "人工名称" }, { operatorLabel: "test", requestId: "edit-request" });
    await service.saveFieldPreference(["sku_code", "product_name", "country_raw"], { operatorLabel: "test" });
    const defaultTableFields = await service.tableFields();
    assert.equal(defaultTableFields.fields.filter((field) => field.group === "source_database").length, 62);
    assert.deepEqual(defaultTableFields.visibleFields, [
      "summary:country_main_sku",
      "summary:category_sales_spec",
      "summary:lifecycle_status",
      "summary:data_status",
      "summary:updated_at",
    ]);
    await service.saveTableFieldPreference(["summary:lifecycle_status", "source:picture"], { operatorLabel: "test" });
    assert.deepEqual((await service.tableFields()).visibleFields, ["summary:lifecycle_status", "source:picture"]);
    const detail = await service.detail(product.id);
    assert.equal(detail.sourceFacts.product_name, "中台名称");
    assert.equal(detail.fieldValues.product_name, "人工名称");
    assert.deepEqual(detail.visibleFields, ["sku_code", "product_name", "country_raw"]);
  } finally {
    await context.close();
  }
});

test("product images are safely persisted and returned as catalog metadata", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [completeRow({ SKU: "IMAGE-001" })]);
    const imported = await context.service.uploadAndValidate({ filename: "image.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    await context.service.apply(imported.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    const product = (await context.dataAccess.repositories.productCatalog.list({ keyword: "IMAGE-001" })).products[0];
    const imageService = new ProductImageService({
      repository: context.dataAccess.repositories.productCatalog,
      tempRoot: context.fileStorageConfig.tempRoot,
      imageRoot: path.join(context.fileStorageConfig.storageRoot, "product-images"),
    });
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const image = await imageService.upload(product.id, { filename: "商品图.png", mimeType: "image/png", buffer: png, operatorLabel: "test" });
    assert.equal(image.productId, product.id);
    assert.deepEqual((await imageService.read(product.id, image.id)).buffer, png);
    const listed = (await context.dataAccess.repositories.productCatalog.list({ keyword: "IMAGE-001" })).products[0];
    assert.equal(listed.image.status, "available");
    assert.equal(listed.image.count, 1);
  } finally {
    await context.close();
  }
});

test("company central lifecycle labels map without false blockers", () => {
  const rows = [
    completeRow({ SKU: "STATUS-ACTIVE", SKU状态: "正常销售" }),
    completeRow({ SKU: "STATUS-CLEARANCE", SKU状态: "清仓商品" }),
    completeRow({ SKU: "STATUS-NEW", SKU状态: "待开发" }),
  ].map((rawPayload, index) => ({ sourceRowNumber: index + 2, rawPayload, formulaFields: [] }));
  const result = validateParsedProductPackage({ headers: PRODUCT_PACKAGE_HEADERS, rows });
  assert.equal(result.counts.blockerCount, 0);
  assert.equal(result.counts.exceptionCount, 0);
  assert.deepEqual(result.rows.map((row) => row.normalizedPayload.lifecycle_status), ["ACTIVE", "CLEARANCE", "NEW"]);
});

test("a preview batch can be revalidated from its persisted source file", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [completeRow({ SKU: "REVALIDATE-001" })]);
    const input = {
      filename: "revalidate.xlsx",
      mimeType: XLSX_MIME,
      buffer: await fs.readFile(filename),
      operatorLabel: "test_session",
      requestId: "request-revalidate",
    };
    const initial = await context.service.uploadAndValidate(input);
    const sourceFileId = initial.detail.file.exportFileId;
    const repeated = await context.service.uploadAndValidate(input);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.revalidated, true);
    assert.equal(repeated.batch.id, initial.batch.id);
    assert.equal(repeated.detail.file.exportFileId, sourceFileId);
    assert.equal(repeated.batch.blockerCount, 0);
    assert.equal(repeated.detail.rows.rows[0].normalizedPayload.lifecycle_status, "ACTIVE");
  } finally {
    await context.close();
  }
});

test("applied products are searchable and expose only real catalog facts", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [
      completeRow({ SKU: "CAT-001", 商品名称: "竹制收纳架", 主SKU: "CAT-MAIN", 款号: "BAMBOO-1", SKU状态: "清仓商品" }),
      completeRow({ SKU: "CAT-002", 商品名称: "家纺测试款", 主SKU: "TEXTILE-MAIN", 仓库: "TH-B", 仓存: 9 }),
    ]);
    const result = await context.service.uploadAndValidate({ filename: "catalog.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    await context.service.apply(result.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    const catalog = await context.dataAccess.repositories.productCatalog.list({ keyword: "竹制", page: 1, pageSize: 30 });
    assert.equal(catalog.total, 1);
    assert.equal(catalog.products[0].sku, "CAT-001");
    assert.equal(catalog.products[0].lifecycleStatus, "CLEARANCE");
    assert.equal(catalog.products[0].image.status, "missing");
    assert.equal(catalog.products[0].aiContentStatus, "not_generated");
    const detail = await context.dataAccess.repositories.productCatalog.get(catalog.products[0].id);
    assert.equal(detail.sourceFacts.product_name, "竹制收纳架");
    assert.equal(detail.packaging.itemNetWeightG, 1000);
    assert.equal(detail.costHistory[0].costCny, 10);
    assert.equal(detail.inventories[0].warehouse, "MY-A");
  } finally {
    await context.close();
  }
});

test("a missing product identity field creates a blocker and prevents apply", async () => {
  const context = await fixture();
  try {
    const headers = PRODUCT_PACKAGE_HEADERS.filter((header) => header !== "国家");
    const filename = await createWorkbook(context.root, [completeRow()], headers);
    const result = await context.service.uploadAndValidate({ filename: "missing-field.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    assert.ok(result.batch.blockerCount > 0);
    assert.ok(result.detail.issues.issues.some((item) => item.code === "MISSING_REQUIRED_FIELD"));
    await assert.rejects(() => context.service.apply(result.batch.id, { operatorLabel: "test", acknowledgeWarnings: true }), (error) => error.code === "PRODUCT_IMPORT_BLOCKED");
  } finally {
    await context.close();
  }
});

test("duplicate country SKU warehouse rows are preserved one-to-one", async () => {
  const parsed = {
    headers: PRODUCT_PACKAGE_HEADERS,
    rows: [
      { sourceRowNumber: 2, rawPayload: completeRow({ SKU: "DUP-1" }), formulaFields: [] },
      { sourceRowNumber: 3, rawPayload: completeRow({ SKU: "DUP-1" }), formulaFields: [] },
    ],
  };
  const validation = validateParsedProductPackage(parsed);
  assert.equal(validation.rows.length, 2);
  assert.deepEqual(validation.rows.map((row) => row.rowOccurrence), [1, 2]);
  assert.deepEqual(validation.rows.map((row) => row.outcome), ["new", "new"]);
  assert.equal(validation.counts.blockerCount, 0);
  assert.equal(validation.issues.filter((item) => item.code === "REPEATED_COUNTRY_SKU_WAREHOUSE").length, 1);
});

test("the same country and SKU can contain multiple warehouse inventory rows", () => {
  const parsed = {
    headers: PRODUCT_PACKAGE_HEADERS,
    rows: [
      { sourceRowNumber: 2, rawPayload: completeRow({ SKU: "MULTI-WH", 仓库: "MY-A", 仓存: 10 }), formulaFields: [] },
      { sourceRowNumber: 3, rawPayload: completeRow({ SKU: "MULTI-WH", 仓库: "MY-B", 仓存: 20 }), formulaFields: [] },
    ],
  };
  const validation = validateParsedProductPackage(parsed);
  assert.equal(validation.rows.length, 2);
  assert.deepEqual(validation.rows.map((row) => row.outcome), ["new", "new"]);
  assert.deepEqual(validation.rows.map((row) => row.normalizedPayload.inventories.length), [1, 1]);
  assert.equal(validation.counts.blockerCount, 0);
});

test("unknown fields remain in source evidence without becoming an import blocker", async () => {
  const context = await fixture();
  try {
    const unknownHeader = "公司新增字段";
    const filename = await createWorkbook(context.root, [completeRow({ [unknownHeader]: "保留原值" })], [...PRODUCT_PACKAGE_HEADERS, unknownHeader]);
    const result = await context.service.uploadAndValidate({ filename: "unknown-field.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    assert.deepEqual(result.batch.unknownFields, [unknownHeader]);
    assert.equal(result.detail.rows.rows[0].rawPayload[unknownHeader], "保留原值");
    const applied = await context.service.apply(result.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    assert.equal(applied.status, "applied");
  } finally {
    await context.close();
  }
});

test("a confirmed discontinued SKU without a main SKU is not blocked or assigned a false model", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [completeRow({ SKU: "OLD-001", 主SKU: null, SKU状态: "灭款" })]);
    const result = await context.service.uploadAndValidate({ filename: "discontinued.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    assert.equal(result.batch.blockerCount, 0);
    assert.ok(result.detail.issues.issues.some((item) => item.code === "DISCONTINUED_WITHOUT_MAIN_SKU" && item.severity === "reminder"));
    await context.service.apply(result.batch.id, { operatorLabel: "test", acknowledgeWarnings: true });
    const db = context.dataAccess.provider.connection;
    assert.equal(db.prepare("SELECT status_code FROM product_sku_lifecycle").get().status_code, "DISCONTINUED");
    assert.equal(db.prepare("SELECT model_id FROM product_skus").get().model_id, null);
    assert.equal(db.prepare("SELECT count(*) n FROM product_models").get().n, 0);
  } finally {
    await context.close();
  }
});

test("exchange-rate validation supports both documented directions", () => {
  const rows = [
    completeRow({ SKU: "FX-MULTIPLY", 销售成本人民币: 10, 国家汇率: 5, 销售成本国家币: 50 }),
    completeRow({ SKU: "FX-DIVIDE", 销售成本人民币: 50, 国家汇率: 5, 销售成本国家币: 10 }),
  ].map((rawPayload, index) => ({ sourceRowNumber: index + 2, rawPayload, formulaFields: [] }));
  const result = validateParsedProductPackage({ headers: PRODUCT_PACKAGE_HEADERS, rows });
  assert.equal(result.counts.blockerCount, 0);
  assert.deepEqual(result.rows.map((row) => row.normalizedPayload.exchange_direction), ["local_per_cny", "cny_per_local"]);
});

test("a bounded large Excel product package is parsed and validated without dropping rows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-large-"));
  const rows = Array.from({ length: 2500 }, (_, index) => ({
    ...completeRow({ SKU: `LOAD-${String(index).padStart(5, "0")}` }),
  }));
  try {
    const filename = await createWorkbook(root, rows);
    const parsed = await parseProductPackageXlsx({ pythonExecutable: python.executable, parserScript, filename, maxRows: 3000 });
    const result = validateParsedProductPackage(parsed);
    assert.equal(result.rows.length, 2500);
    assert.equal(result.counts.newCount, 2500);
    assert.equal(result.counts.blockerCount, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("same country SKU warehouse rows may disagree on product facts without a conflict", () => {
  const result = validateParsedProductPackage({
    headers: PRODUCT_PACKAGE_HEADERS,
    rows: [
      { sourceRowNumber: 2, rawPayload: completeRow({ SKU: "FACT-1", 商品名称: "名称 A", 仓库: "MY-A" }) },
      { sourceRowNumber: 3, rawPayload: completeRow({ SKU: "FACT-1", 商品名称: "名称 B", 仓库: "MY-A", 一级品类: "家具", 销售规格: "完全不同规格" }) },
    ],
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.counts.blockerCount, 0);
  assert.equal(result.issues.some((item) => item.code === "COUNTRY_SKU_FACT_CONFLICT"), false);
});

test("one repeated import distinguishes new updated and unchanged source rows", async () => {
  const context = await fixture();
  try {
    const firstFile = await createWorkbook(context.root, [
      completeRow({ SKU: "MIX-A", 商品名称: "A" }),
      completeRow({ SKU: "MIX-B", 商品名称: "B", 仓库: "MY-B" }),
    ]);
    const first = await context.service.uploadAndValidate({ filename: "mix-one.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    await context.service.apply(first.batch.id, { operatorLabel: "test" });
    const secondFile = await createWorkbook(context.root, [
      completeRow({ SKU: "MIX-A", 商品名称: "A changed" }),
      completeRow({ SKU: "MIX-B", 商品名称: "B", 仓库: "MY-B" }),
      completeRow({ SKU: "MIX-C", 商品名称: "C", 仓库: "MY-C" }),
    ]);
    const second = await context.service.uploadAndValidate({ filename: "mix-two.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    assert.deepEqual({ new: second.batch.newCount, updated: second.batch.updatedCount, unchanged: second.batch.unchangedCount }, { new: 1, updated: 1, unchanged: 1 });
  } finally {
    await context.close();
  }
});

test("import validation and persistence do not filter rows by operator permissions", async () => {
  const validationSource = await fs.readFile("lib/product-center/product-package-validation.mjs", "utf8");
  const serviceSource = await fs.readFile("lib/product-center/product-import-service.mjs", "utf8");
  for (const source of [validationSource, serviceSource]) {
    assert.doesNotMatch(source, /allowedCountries|allowedCategories|visibleSku|permissionScope|operatorProducts/);
  }
});

test("semantic comparison treats null and empty as equal while preserving zero", () => {
  assert.equal(semanticCellEqual(null, ""), true);
  assert.equal(semanticCellEqual(undefined, "  "), true);
  assert.equal(semanticCellEqual(0, ""), false);
  assert.equal(semanticCellEqual(0, "0", { oldType: "integer", newType: "text" }), true);
});

test("semantic comparison normalizes numeric formats, dates, trim, full-width and case", () => {
  assert.equal(semanticCellEqual(1, 1.0, { oldType: "integer", newType: "number" }), true);
  assert.equal(semanticCellEqual("2026-07-20", "2026-07-20T00:00:00.000Z", { contract: { type: "date" } }), true);
  assert.equal(semanticCellEqual(" ＡＢＣ ", "abc"), true);
  assert.equal(semanticCellEqual("a   b", "A B"), true);
});

test("parser preserves raw scalar types and zero values", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-types-"));
  try {
    const filename = await createWorkbook(root, [completeRow({ SKU: "TYPE-001", 仓存: 0, 连带率: 0 })]);
    const parsed = await parseProductPackageXlsx({ pythonExecutable: python.executable, parserScript, filename, maxRows: 10 });
    assert.equal(parsed.rows[0].rawPayload.仓存, 0);
    assert.equal(parsed.rows[0].rawTypes.仓存, "integer");
    assert.equal(parsed.rows[0].rawTypes.商品名称, "text");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("lossless source table exposes one typed raw column for all 35 supported fields", async () => {
  const context = await fixture();
  try {
    const columns = context.dataAccess.provider.connection.prepare("PRAGMA table_info(product_package_rows)").all().map((row) => row.name);
    for (const item of ALL_PRODUCT_PACKAGE_FIELDS) assert.ok(columns.includes(`raw_${item.systemField}_json`), item.systemField);
    assert.equal(ALL_PRODUCT_PACKAGE_FIELDS.length, 35);
  } finally {
    await context.close();
  }
});

test("duplicate warehouse rows apply atomically to two source rows and one inventory projection", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [
      completeRow({ SKU: "RAW-DUP-1", 仓库: "MY-A", 仓存: 10, 商品名称: "第一行" }),
      completeRow({ SKU: "RAW-DUP-1", 仓库: "MY-A", 仓存: 20, 商品名称: "第二行" }),
    ]);
    const preview = await context.service.uploadAndValidate({ filename: "duplicate-source.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    assert.equal(preview.batch.rowCount, 2);
    assert.equal(preview.batch.blockerCount, 0);
    await context.service.apply(preview.batch.id, { operatorLabel: "test" });
    const db = context.dataAccess.provider.connection;
    assert.equal(db.prepare("SELECT count(*) n FROM product_package_rows").get().n, 2);
    assert.equal(db.prepare("SELECT count(*) n FROM product_skus").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM product_inventory_snapshots").get().n, 1);
    assert.equal(db.prepare("SELECT warehouse_stock FROM product_inventory_snapshots").get().warehouse_stock, 20);
  } finally {
    await context.close();
  }
});

test("a second source version produces field-level changes without collapsing rows", async () => {
  const context = await fixture();
  try {
    const firstFile = await createWorkbook(context.root, [completeRow({ SKU: "DIFF-001", 商品名称: "旧名称", 仓库: "MY-A" })]);
    const first = await context.service.uploadAndValidate({ filename: "diff-one.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    await context.service.apply(first.batch.id, { operatorLabel: "test" });
    const secondFile = await createWorkbook(context.root, [completeRow({ SKU: "DIFF-001", 商品名称: "新名称", 仓库: "MY-A" })]);
    const second = await context.service.uploadAndValidate({ filename: "diff-two.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    assert.equal(second.batch.updatedCount, 1);
    assert.equal(second.detail.changes.total, 1);
    assert.equal(second.detail.changes.changes[0].fieldCode, "product_name");
    assert.equal(second.detail.changes.changes[0].oldValue, "旧名称");
    assert.equal(second.detail.changes.changes[0].newValue, "新名称");
  } finally {
    await context.close();
  }
});

test("manual overrides are marked in source diffs and survive source updates", async () => {
  const context = await fixture();
  try {
    const firstFile = await createWorkbook(context.root, [completeRow({ SKU: "OVERRIDE-001", 商品名称: "中台旧值" })]);
    const first = await context.service.uploadAndValidate({ filename: "override-one.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    await context.service.apply(first.batch.id, { operatorLabel: "test" });
    const catalog = new ProductCatalogService({ repository: context.dataAccess.repositories.productCatalog });
    const product = (await catalog.list({ keyword: "OVERRIDE-001" })).products[0];
    await catalog.update(product.id, { product_name: "人工值" }, { operatorLabel: "test" });
    const secondFile = await createWorkbook(context.root, [completeRow({ SKU: "OVERRIDE-001", 商品名称: "中台新值" })]);
    const second = await context.service.uploadAndValidate({ filename: "override-two.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    const change = second.detail.changes.changes.find((item) => item.fieldCode === "product_name");
    assert.equal(change.hasManualOverride, true);
    await context.service.apply(second.batch.id, { operatorLabel: "test" });
    const detail = await catalog.detail(product.id);
    assert.equal(detail.sourceFacts.product_name, "中台新值");
    assert.equal(detail.fieldValues.product_name, "人工值");
  } finally {
    await context.close();
  }
});

test("semantically unchanged source rows are reported unchanged but refresh exact raw evidence", async () => {
  const context = await fixture();
  try {
    const firstHeaders = PRODUCT_PACKAGE_HEADERS;
    const firstFile = await createWorkbook(context.root, [completeRow({ SKU: "SAME-001", 商品名称: "ABC" })], firstHeaders);
    const first = await context.service.uploadAndValidate({ filename: "same-one.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    await context.service.apply(first.batch.id, { operatorLabel: "test" });
    const secondHeaders = [...PRODUCT_PACKAGE_HEADERS, "可选空字段"];
    const secondFile = await createWorkbook(context.root, [completeRow({ SKU: "SAME-001", 商品名称: "ＡＢＣ", 可选空字段: null })], secondHeaders);
    const second = await context.service.uploadAndValidate({ filename: "same-two.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    assert.equal(second.batch.unchangedCount, 1);
    assert.equal(second.detail.changes.total, 0);
    await context.service.apply(second.batch.id, { operatorLabel: "test" });
    const raw = JSON.parse(context.dataAccess.provider.connection.prepare("SELECT raw_payload_json FROM product_package_rows").get().raw_payload_json);
    assert.equal(raw.商品名称, "ＡＢＣ");
    assert.equal(Object.hasOwn(raw, "可选空字段"), true);
  } finally {
    await context.close();
  }
});

test("rows absent from a later source file remain in the current source table", async () => {
  const context = await fixture();
  try {
    const firstFile = await createWorkbook(context.root, [completeRow({ SKU: "KEEP-001" }), completeRow({ SKU: "KEEP-002" })]);
    const first = await context.service.uploadAndValidate({ filename: "keep-one.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    await context.service.apply(first.batch.id, { operatorLabel: "test" });
    const secondFile = await createWorkbook(context.root, [completeRow({ SKU: "KEEP-001", 商品名称: "更新" })]);
    const second = await context.service.uploadAndValidate({ filename: "keep-two.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    await context.service.apply(second.batch.id, { operatorLabel: "test" });
    assert.equal(context.dataAccess.provider.connection.prepare("SELECT count(*) n FROM product_package_rows").get().n, 2);
  } finally {
    await context.close();
  }
});

test("an apply failure rolls back every lossless source row in the batch", async () => {
  const context = await fixture();
  try {
    const filename = await createWorkbook(context.root, [completeRow({ SKU: "ROLLBACK-001" })]);
    const preview = await context.service.uploadAndValidate({ filename: "rollback.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(filename), operatorLabel: "test" });
    const db = context.dataAccess.provider.connection;
    db.exec("CREATE TRIGGER fail_product_projection BEFORE INSERT ON product_skus BEGIN SELECT RAISE(ABORT, 'forced test failure'); END");
    await assert.rejects(() => context.service.apply(preview.batch.id, { operatorLabel: "test" }));
    assert.equal(db.prepare("SELECT count(*) n FROM product_package_rows").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM product_skus").get().n, 0);
  } finally {
    await context.close();
  }
});

test("field-change queries filter by country SKU and field", async () => {
  const context = await fixture();
  try {
    const firstFile = await createWorkbook(context.root, [completeRow({ SKU: "FILTER-001", 商品名称: "旧", 销售规格: "旧规格" })]);
    const first = await context.service.uploadAndValidate({ filename: "filter-one.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(firstFile), operatorLabel: "test" });
    await context.service.apply(first.batch.id, { operatorLabel: "test" });
    const secondFile = await createWorkbook(context.root, [completeRow({ SKU: "FILTER-001", 商品名称: "新", 销售规格: "新规格" })]);
    const second = await context.service.uploadAndValidate({ filename: "filter-two.xlsx", mimeType: XLSX_MIME, buffer: await fs.readFile(secondFile), operatorLabel: "test" });
    const result = await context.service.changes(second.batch.id, { country: "马来", sku: "FILTER-001", field: "product_name" });
    assert.equal(result.total, 1);
    assert.equal(result.changes[0].newValue, "新");
  } finally {
    await context.close();
  }
});

test("an invalid upload is rejected before a batch or formal file record is created", async () => {
  const context = await fixture();
  try {
    await assert.rejects(() => context.service.uploadAndValidate({
      filename: "fake.xlsx",
      mimeType: XLSX_MIME,
      buffer: Buffer.from("not an xlsx"),
      operatorLabel: "test",
    }), (error) => error.code === "FILE_SIGNATURE_INVALID");
    const db = context.dataAccess.provider.connection;
    assert.equal(db.prepare("SELECT count(*) n FROM product_import_batches").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM export_files").get().n, 0);
  } finally {
    await context.close();
  }
});

test("007 migration is additive and preserves existing business rows", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-migration-preserve-"));
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged);
  try {
    for (const name of (await fs.readdir(migrationsDir)).filter((name) => /^00[1-6]_/.test(name)).sort()) {
      await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
    }
    const database = new SchedulerDatabase({ databasePath: path.join(root, "commerce.sqlite"), migrationsDir: staged });
    try {
      database.migrate();
      const now = new Date().toISOString();
      database.db.prepare(`INSERT INTO operation_audit_events (
        id,request_id,occurred_at,module,action,status,metadata_json,created_at
      ) VALUES (?,?,?,?,?,?,?,?)`).run("audit-existing", "request-existing", now, "system", "system.baseline", "success", "{}", now);
      const before = database.db.prepare("SELECT count(*) total FROM operation_audit_events").get().total;
      await fs.copyFile(path.join(migrationsDir, "007_product_center_g1a2.sql"), path.join(staged, "007_product_center_g1a2.sql"));
      assert.deepEqual(database.migrate(), ["007_product_center_g1a2.sql"]);
      assert.equal(database.db.prepare("SELECT count(*) total FROM operation_audit_events").get().total, before);
      assert.equal(database.db.prepare("SELECT count(*) total FROM product_import_batches").get().total, 0);
      assert.equal(database.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed 007 migration rolls back all product-center schema changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-migration-rollback-"));
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged);
  try {
    for (const name of (await fs.readdir(migrationsDir)).filter((name) => /^00[1-6]_/.test(name)).sort()) {
      await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
    }
    const sql = await fs.readFile(path.join(migrationsDir, "007_product_center_g1a2.sql"), "utf8");
    await fs.writeFile(path.join(staged, "007_product_center_g1a2.sql"), `${sql}\nINVALID SQL;\n`, "utf8");
    const database = new SchedulerDatabase({ databasePath: path.join(root, "commerce.sqlite"), migrationsDir: staged });
    try {
      assert.throws(() => database.migrate());
      assert.equal(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_import_batches'").get(), undefined);
      assert.equal(database.db.prepare("SELECT count(*) total FROM schema_migrations WHERE version='007_product_center_g1a2.sql'").get().total, 0);
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("009 migration adds lossless source and field-change tables without changing existing products", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-lossless-migration-"));
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged);
  try {
    for (const name of (await fs.readdir(migrationsDir)).filter((name) => /^00[1-8]_/.test(name)).sort()) {
      await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
    }
    const database = new SchedulerDatabase({ databasePath: path.join(root, "commerce.sqlite"), migrationsDir: staged });
    try {
      database.migrate();
      const before = database.db.prepare("SELECT count(*) n FROM product_skus").get().n;
      await fs.copyFile(path.join(migrationsDir, "009_product_package_lossless_rows.sql"), path.join(staged, "009_product_package_lossless_rows.sql"));
      assert.deepEqual(database.migrate(), ["009_product_package_lossless_rows.sql"]);
      assert.equal(database.db.prepare("SELECT count(*) n FROM product_skus").get().n, before);
      assert.ok(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_package_rows'").get());
      assert.ok(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_import_field_changes'").get());
      assert.equal(database.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a failed 009 migration rolls back every lossless schema change", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "commerce-product-lossless-rollback-"));
  const staged = path.join(root, "migrations");
  await fs.mkdir(staged);
  try {
    for (const name of (await fs.readdir(migrationsDir)).filter((name) => /^00[1-8]_/.test(name)).sort()) {
      await fs.copyFile(path.join(migrationsDir, name), path.join(staged, name));
    }
    const database = new SchedulerDatabase({ databasePath: path.join(root, "commerce.sqlite"), migrationsDir: staged });
    try {
      database.migrate();
      const sql = await fs.readFile(path.join(migrationsDir, "009_product_package_lossless_rows.sql"), "utf8");
      await fs.writeFile(path.join(staged, "009_product_package_lossless_rows.sql"), `${sql}\nINVALID SQL;\n`, "utf8");
      assert.throws(() => database.migrate());
      assert.equal(database.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_package_rows'").get(), undefined);
      assert.equal(database.db.prepare("SELECT count(*) n FROM schema_migrations WHERE version='009_product_package_lossless_rows.sql'").get().n, 0);
    } finally {
      database.close();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
