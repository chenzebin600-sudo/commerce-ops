import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  buildListingAiContext,
  LISTING_AI_CONTENT_TYPES,
  normalizeListingTarget,
} from "../lib/product-center/listing-ai-context.mjs";
import { buildListingAiMessages, LISTING_AI_PROMPT_VERSION } from "../lib/product-center/listing-ai-prompt.mjs";
import { parseListingAiResponse } from "../lib/product-center/listing-ai-response.mjs";
import {
  DEFAULT_IMAGE_TEMPLATE,
  IMAGE_AI_UNCONFIGURED_MESSAGE,
  resolveImageGenerationConfig,
} from "../lib/product-center/image-generation-config.mjs";
import { createImageGenerationProvider } from "../lib/product-center/image-generation-provider.mjs";
import { ProductAiContentService } from "../lib/product-center/product-ai-content-service.mjs";
import { ProductImageGenerationService } from "../lib/product-center/product-image-generation-service.mjs";

const product = Object.freeze({
  id: "product-1",
  country: "马来",
  sku: "SKU-001",
  mainSku: "MAIN-001",
  productName: "实木餐桌",
  categoryL1: "大家具",
  categoryL2: "餐厅家具",
  styleName: "胡桃色圆角款",
  salesSpec: "实木餐桌120×60×75cm，胡桃色，圆角桌面，带抽屉，适合餐厅、书房和小户型使用",
  lifecycleStatus: "ACTIVE",
  packaging: { itemNetWeightG: 22000, itemGrossWeightG: 25000, cartonQuantity: 1 },
  sourceFacts: { material: "实木", color: "胡桃色", carton_dimensions_raw: "130×70×20cm" },
  manualOverrides: {},
  images: [{ id: "base-image-1", originalFilename: "table.webp", isPrimary: true }],
});

function listingContext(overrides = {}) {
  return {
    productFacts: { productName: product.productName, salesSpec: product.salesSpec, material: "实木", color: "胡桃色" },
    platform: "shopee",
    target: { countryCode: "MY", countryName: "马来西亚" },
    shopId: "shop-1",
    shopName: "MY Home",
    platformCategoryName: "Dining Tables",
    outputLanguage: "马来语",
    targetAudience: "小户型家庭",
    productPositioning: "实用型中端餐桌",
    contentStyle: "清晰、克制",
    pricePositioning: "中端",
    primaryScenarios: "餐厅、书房",
    specialRequirements: "突出圆角和抽屉",
    forbiddenContent: "不得写虚假承重",
    currentContent: { title: "当前标题", subtitle: "当前副标题", description: "当前描述", sellingPoints: [], usageScenarios: [] },
    adoptedAi: {},
    ...overrides,
  };
}

function outputFor(types, template = DEFAULT_IMAGE_TEMPLATE) {
  const root = {};
  if (types.includes("target_audience")) root.target_audience = { target_users: ["小户型家庭", "租房用户", "居家办公人群"], reasoning_summary: "来自尺寸和场景", risk_notes: [] };
  if (types.includes("product_positioning")) root.product_positioning = { text: "小户型实用餐桌", reasoning_summary: "来自规格", risk_notes: [] };
  if (types.includes("content_style")) root.content_style = { text: "清晰克制", reasoning_summary: "适配平台", risk_notes: [] };
  if (types.includes("listing_title")) root.listing_title = { titles: [1, 2, 3].map((n) => ({ text: `候选标题 ${n}`, character_count: 6, reason: `理由 ${n}` })), risk_notes: [] };
  if (types.includes("listing_subtitle")) root.listing_subtitle = { subtitles: [1, 2, 3].map((n) => ({ text: `候选副标题 ${n}`, character_count: 7, reason: `理由 ${n}` })), risk_notes: [] };
  if (types.includes("listing_description")) root.listing_description = { text: "产品简介\n核心特点\n规格信息", outline: ["产品简介", "核心特点", "规格信息"], risk_notes: [] };
  if (types.includes("selling_points")) root.selling_points = { items: [{ title: "圆角桌面", description: "减少日常磕碰风险", source_fields: ["销售规格"] }], feature_benefit_map: [{ feature: "带抽屉", benefit: "便于收纳" }], risk_notes: [] };
  if (types.includes("usage_scenarios")) root.usage_scenarios = { items: [{ scene: "小户型餐厅", target_user: "小户型家庭", description: "满足日常用餐" }], risk_notes: [] };
  if (types.includes("image_prompt")) root.image_prompt = {
    summary: "七张商品图方案",
    global_constraints: ["不得改变产品结构"],
    slots: template.slots.map((slot) => ({ slot_key: slot.key, prompt: `${slot.label}提示词`, negative_prompt: "错误结构", aspect_ratio: slot.aspectRatio, risk_notes: [] })),
  };
  return JSON.stringify(root);
}

class MemoryImageRepository {
  constructor() { this.task = null; }
  async createTask(input) {
    this.task = {
      ...input,
      id: "task-1",
      updatedAt: new Date().toISOString(),
      items: input.items.map((item, index) => ({ ...item, id: `item-${index + 1}`, taskId: "task-1", slotIndex: index, generatedFileId: null })),
    };
    return structuredClone(this.task);
  }
  async getTask(id) { return id === this.task?.id ? structuredClone(this.task) : null; }
  async list(productId) { return this.task?.productId === productId ? [structuredClone(this.task)] : []; }
  async updateTask(id, changes) { Object.assign(this.task, changes, { updatedAt: new Date().toISOString() }); return structuredClone(this.task); }
  async updateItem(id, changes) { Object.assign(this.task.items.find((item) => item.id === id), changes); return structuredClone(this.task.items.find((item) => item.id === id)); }
}

const html = () => fs.readFile("public/index.html", "utf8");
const css = () => fs.readFile("public/styles.css", "utf8");
const ui = () => fs.readFile("public/product-center-page.mjs", "utf8");

test("01 sales specification uses an auto-growing multiline editor", async () => assert.match(await ui(), /sales-spec-textarea/));
test("02 sales specification wraps whitespace and unbroken text", async () => {
  const source = await css();
  assert.match(source, /\.sales-spec-textarea[\s\S]*overflow-wrap:\s*anywhere/);
  assert.match(source, /word-break:\s*break-word/);
});
test("03 sales specification does not use horizontal scrolling", async () => assert.match(await css(), /\.sales-spec-textarea[\s\S]*overflow-x:\s*hidden/));
test("04 field and content colors have separate visual hierarchy", async () => {
  const source = await css();
  assert.match(source, /field-block > span \{ color: #475569/);
  assert.match(source, /textarea \{ border-color: #cbd5e1; color: #0f172a/);
});
test("05 listing target shows one country/site control and no duplicate control", async () => {
  const source = await html();
  assert.match(source, /id="listingCountrySite"/);
  assert.doesNotMatch(source, /id="listingCountry"|id="listingMarketplace"/);
});
test("06 country/site control contains the five supported sites", async () => {
  const source = await html();
  for (const code of ["TH", "PH", "MY", "ID", "VN"]) assert.match(source, new RegExp(`<option value="${code}">`));
});
test("07 country aliases normalize to stable codes", () => {
  assert.equal(normalizeListingTarget("马来").countryCode, "MY");
  assert.equal(normalizeListingTarget("Indonesia").countryCode, "ID");
});
test("08 country/site normalization saves name code and marketplace code", () => {
  const target = normalizeListingTarget({ countryCode: "VN" });
  assert.deepEqual(target, { countryCode: "VN", countryName: "越南", marketplaceCode: "VN" });
});
test("09 listing context includes the current platform and site", () => {
  const { context } = buildListingAiContext(product, { listingContext: listingContext() });
  assert.equal(context.target.platform, "shopee");
  assert.equal(context.target.country_code, "MY");
});
test("10 listing context uses current page values instead of stale product values", () => {
  const { context } = buildListingAiContext(product, { listingContext: listingContext({ productFacts: { productName: "页面最新名称", salesSpec: "页面最新规格" } }) });
  assert.equal(context.product.product_name, "页面最新名称");
  assert.equal(context.product.sales_spec, "页面最新规格");
});
test("11 listing context includes positioning and current adopted content", () => {
  const { context } = buildListingAiContext(product, { listingContext: listingContext() });
  assert.equal(context.positioning.target_audience, "小户型家庭");
  assert.equal(context.current_content.title, "当前标题");
});
test("12 unified content registry contains every required content type", () => {
  for (const type of ["target_audience", "product_positioning", "content_style", "listing_title", "listing_subtitle", "listing_description", "selling_points", "usage_scenarios", "image_prompt", "product_images"]) assert.ok(LISTING_AI_CONTENT_TYPES.includes(type));
});
test("13 prompt uses one Listing AI Context and forbids invented facts", () => {
  const messages = buildListingAiMessages({ context: { product: {} }, contentTypes: ["listing_title"] });
  assert.match(messages[0].content, /Listing AI Context/);
  assert.match(messages[0].content, /严禁虚构/);
});
test("14 prompt carries configurable title and generation limits", () => {
  const messages = buildListingAiMessages({ context: {}, contentTypes: ["selling_points"], titleLimits: { shopee: 120 }, generationOptions: { selling_point_count: 5 } });
  assert.match(messages[1].content, /selling_point_count/);
  assert.match(messages[1].content, /120/);
});
test("15 title parser returns three candidates with computed character counts", () => {
  const result = parseListingAiResponse(outputFor(["listing_title"]), ["listing_title"]);
  assert.equal(result.listing_title.titles.length, 3);
  assert.equal(result.listing_title.titles[0].character_count, [..."候选标题 1"].length);
});
test("16 subtitle and description use structured candidate schemas", () => {
  const result = parseListingAiResponse(outputFor(["listing_subtitle", "listing_description"]), ["listing_subtitle", "listing_description"]);
  assert.equal(result.listing_subtitle.subtitles.length, 3);
  assert.match(result.listing_description.text, /核心特点/);
});
test("17 selling points retain source fields and benefit mapping", () => {
  const result = parseListingAiResponse(outputFor(["selling_points"]), ["selling_points"]);
  assert.deepEqual(result.selling_points.items[0].source_fields, ["销售规格"]);
  assert.equal(result.selling_points.feature_benefit_map[0].benefit, "便于收纳");
});
test("18 listing AI service persists one candidate record per requested type", async () => {
  const created = [];
  const service = new ProductAiContentService({
    configured: true,
    repository: { latestConfirmed: async () => null, create: async (value) => (created.push(value), { ...value, id: `content-${created.length}`, version: 1 }) },
    gateway: { complete: async () => ({ success: true, provider: "deepseek", model: "deepseek-chat", content: outputFor(["listing_title", "listing_subtitle"]), requestId: "request-1", durationMs: 1 }) },
  });
  const result = await service.generateListingContent(product, { contentTypes: ["listing_title", "listing_subtitle"], listingContext: listingContext() });
  assert.equal(result.records.length, 2);
  assert.deepEqual(created.map((item) => item.contentType), ["listing_title", "listing_subtitle"]);
});
test("19 listing AI service forwards the current page context to the gateway", async () => {
  let request;
  const service = new ProductAiContentService({
    configured: true,
    repository: { latestConfirmed: async () => null, create: async (value) => ({ ...value, id: "content-1", version: 1 }) },
    gateway: { complete: async (value) => (request = value, { success: true, provider: "deepseek", model: "deepseek-chat", content: outputFor(["listing_title"]), requestId: "request-1", durationMs: 1 }) },
  });
  await service.generateListingContent(product, { contentTypes: ["listing_title"], listingContext: listingContext({ productFacts: { productName: "实时页面名称" } }) });
  assert.match(request.messages[1].content, /实时页面名称/);
});
test("20 generated candidates are not silently written into listing fields", async () => {
  const source = await ui();
  assert.match(source, /AI 候选已生成并记录，当前草稿内容尚未被覆盖/);
  assert.match(source, /adoptAiCandidate/);
});
test("21 AI history stores adopted selection and manual edits", async () => {
  const source = `${await ui()}\n${await fs.readFile("migrations/012_product_listing_ai_content_images.sql", "utf8")}`;
  assert.match(source, /adopted_content_json/);
  assert.match(source, /manual_content_json/);
});
test("22 restoring a history version requires explicit confirmation", async () => assert.match(await ui(), /confirm\?\.\(`确认恢复/));
test("23 context changes retain old content and show a stale notice", async () => {
  const source = `${await html()}\n${await ui()}`;
  assert.match(source, /上下文已变化，建议重新生成。旧内容仍会保留。/);
  assert.match(source, /listingStaleSignature/);
});
test("24 unconfigured image API has the required exact notice", () => assert.equal(IMAGE_AI_UNCONFIGURED_MESSAGE, "尚未配置图片生成模型API，目前仅支持生成图片方案和提示词。"));
test("25 unconfigured image provider never makes a real request", async () => {
  const provider = createImageGenerationProvider(resolveImageGenerationConfig({}));
  await assert.rejects(provider.generate({ prompt: "test" }), /尚未配置图片生成模型API/);
});
test("26 default image template contains one primary and six secondary slots", () => {
  assert.equal(DEFAULT_IMAGE_TEMPLATE.slots.filter((slot) => slot.type === "primary").length, 1);
  assert.equal(DEFAULT_IMAGE_TEMPLATE.slots.filter((slot) => slot.type === "secondary").length, 6);
});
test("27 image quantity is configurable instead of fixed in service logic", () => {
  const config = resolveImageGenerationConfig({ IMAGE_AI_TEMPLATE_JSON: JSON.stringify({ key: "two", slots: [{ key: "a" }, { key: "b" }] }) });
  assert.equal(config.template.slots.length, 2);
});
test("28 image prompt plan creates all configured slots without fake files", async () => {
  const repository = new MemoryImageRepository();
  const config = resolveImageGenerationConfig({});
  const service = new ProductImageGenerationService({
    repository, config, provider: createImageGenerationProvider(config),
    aiContentService: { generateListingContent: async () => ({ contextHash: "h", inputContext: {}, outputContent: { image_prompt: JSON.parse(outputFor(["image_prompt"])).image_prompt } }) },
  });
  const task = await service.createPlan(product, {});
  assert.equal(task.items.length, 7);
  assert.ok(task.items.every((item) => item.generatedFileId === null));
});
test("29 one image failure preserves another successful image", async () => {
  const repository = new MemoryImageRepository();
  await repository.createTask({ productId: product.id, templateKey: "two", contextHash: "h", context: {}, promptPlan: {}, status: "waiting_generation", createdBy: "test", items: [
    { slotKey: "a", slotType: "primary", label: "A", aspectRatio: "1:1", prompt: "A", status: "waiting" },
    { slotKey: "b", slotType: "secondary", label: "B", aspectRatio: "1:1", prompt: "B", status: "waiting" },
  ] });
  let call = 0;
  const service = new ProductImageGenerationService({ repository, config: { configured: true }, provider: { configured: true, generate: async () => (++call === 1 ? { fileId: "file-a" } : Promise.reject(new Error("failed"))) }, aiContentService: {} });
  const task = await service.generate(product.id, "task-1");
  assert.equal(task.status, "partially_completed");
  assert.equal(task.items[0].generatedFileId, "file-a");
  assert.equal(task.items[1].status, "failed");
});
test("30 a failed image can be retried independently", async () => {
  const repository = new MemoryImageRepository();
  await repository.createTask({ productId: product.id, templateKey: "one", contextHash: "h", context: {}, promptPlan: {}, status: "failed", createdBy: "test", items: [{ slotKey: "a", slotType: "primary", label: "A", aspectRatio: "1:1", prompt: "A", status: "failed" }] });
  const service = new ProductImageGenerationService({ repository, config: { configured: true }, provider: { configured: true, generate: async () => ({ fileId: "file-a" }) }, aiContentService: {} });
  const task = await service.generate(product.id, "task-1", { itemIds: ["item-1"] });
  assert.equal(task.items[0].status, "completed");
});
test("31 generated image enters listing media only after explicit adoption", async () => {
  const repository = new MemoryImageRepository();
  await repository.createTask({ productId: product.id, listingDraftId: "draft-1", templateKey: "one", contextHash: "h", context: {}, promptPlan: {}, status: "completed", createdBy: "test", items: [{ slotKey: "a", slotType: "primary", label: "A", aspectRatio: "1:1", prompt: "A", status: "completed" }] });
  repository.task.items[0].generatedFileId = "ai-file-1";
  let saved;
  const listingService = { get: async () => ({ id: "draft-1", productId: product.id, media: { imageIds: ["base-image-1"] } }), save: async (_product, draft) => { saved = draft; } };
  const service = new ProductImageGenerationService({ repository, config: { configured: true }, provider: { configured: true }, aiContentService: {}, listingService });
  assert.equal(saved, undefined);
  await service.adopt(product, "task-1", "item-1", { operatorLabel: "tester" });
  assert.deepEqual(saved.media.imageIds, ["base-image-1", "ai-file-1"]);
});
test("32 frontend and templates contain no image or DeepSeek API key", async () => {
  const source = `${await html()}\n${await ui()}\n${await fs.readFile(".env.example", "utf8")}`;
  assert.doesNotMatch(source, /sk-[a-z0-9]{20,}/i);
  assert.match(source, /IMAGE_AI_API_KEY=\r?\n/);
});
test("33 image provider configuration is backend-only", async () => {
  const source = await ui();
  assert.doesNotMatch(source, /IMAGE_AI_API_KEY|DEEPSEEK_API_KEY|api\.deepseek\.com/);
});
test("34 AI content and listing data never write product package source rows", async () => {
  const sources = await Promise.all(["lib/product-center/product-ai-content-service.mjs", "lib/product-center/product-listing-service.mjs", "lib/data/repositories/product-ai-content-repository.mjs", "lib/data/repositories/product-listing-repository.mjs"].map((file) => fs.readFile(file, "utf8")));
  assert.doesNotMatch(sources.join("\n"), /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:app\.)?product_package_rows/i);
});
test("35 listing drafts persist the merged target codes", async () => {
  const source = await fs.readFile("lib/data/repositories/product-listing-repository.mjs", "utf8");
  for (const column of ["country_code", "country_name", "marketplace_code"]) assert.match(source, new RegExp(column));
});
test("36 image task schema contains task and per-image states", async () => {
  const source = await fs.readFile("migrations/012_product_listing_ai_content_images.sql", "utf8");
  for (const status of ["pending", "generating_prompt", "waiting_generation", "generating", "partially_completed", "completed", "failed", "cancelled"]) assert.match(source, new RegExp(`'${status}'`));
});
test("37 the workbench exposes all thirteen requested modules", async () => {
  const source = await html();
  assert.equal([...source.matchAll(/data-workbench-anchor=/g)].length, 13);
});
test("38 title limits and image model settings are centralized environment variables", async () => {
  const source = await fs.readFile(".env.example", "utf8");
  for (const name of ["LISTING_TITLE_LIMIT_SHOPEE", "LISTING_TITLE_LIMIT_LAZADA", "LISTING_TITLE_LIMIT_TIKTOK_SHOP", "IMAGE_AI_PROVIDER", "IMAGE_AI_API_KEY", "IMAGE_AI_BASE_URL", "IMAGE_AI_MODEL"]) assert.match(source, new RegExp(`^${name}=`, "m"));
});
test("39 prompt version is stable and recorded", () => assert.equal(LISTING_AI_PROMPT_VERSION, "product-listing-content-v1"));
test("40 image result actions require explicit user controls", async () => {
  const source = `${await html()}\n${await ui()}`;
  assert.match(source, /采用到上架素材/);
  assert.match(source, /data-regenerate-image-item/);
});
