import { normalizeListingTarget } from "./listing-ai-context.mjs";

const PLATFORMS = new Set(["shopee", "lazada", "tiktok_shop"]);
const STATUSES = new Set(["draft", "ready"]);

function text(value, max = 2000) {
  return String(value ?? "").trim().slice(0, max);
}

function list(value, max = 100) {
  return (Array.isArray(value) ? value : []).slice(0, max);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function shopKey(input) {
  const stable = text(input.shopId || input.shopName, 200).toLocaleLowerCase("en-US");
  return stable || "__unassigned__";
}

function normalizeDraft(product, input, audit) {
  const platform = text(input.platform, 30).toLowerCase();
  if (!PLATFORMS.has(platform)) throw Object.assign(new Error("请选择 Shopee、Lazada 或 TikTok Shop。"), { code: "PRODUCT_LISTING_PLATFORM_INVALID", status: 400 });
  const status = STATUSES.has(input.status) ? input.status : "draft";
  const target = normalizeListingTarget({ countryCode: input.countryCode, countryName: input.countryName || input.country }, product.country);
  return {
    productId: product.id,
    country: target.countryName,
    countryCode: target.countryCode,
    countryName: target.countryName,
    marketplaceCode: target.marketplaceCode,
    sku: product.sku,
    platform,
    shopId: text(input.shopId, 200) || null,
    shopKey: shopKey(input),
    shopName: text(input.shopName, 300) || null,
    platformCategoryId: text(input.platformCategoryId, 200) || null,
    platformCategoryName: text(input.platformCategoryName, 500) || null,
    listingMode: text(input.listingMode, 50) || "standard",
    title: text(input.title, 1000),
    subtitle: text(input.subtitle, 1000),
    description: text(input.description, 20000),
    searchKeywords: list(input.searchKeywords, 100).map((item) => text(item, 200)).filter(Boolean),
    brand: text(input.brand, 500),
    model: text(input.model, 500),
    targetUsers: text(input.targetUsers, 2000),
    productPositioning: text(input.productPositioning, 4000),
    contentStyle: text(input.contentStyle, 2000),
    pricePositioning: text(input.pricePositioning, 2000),
    primaryScenarios: text(input.primaryScenarios, 4000),
    specialRequirements: text(input.specialRequirements, 8000),
    forbiddenContent: text(input.forbiddenContent, 8000),
    contentLanguage: text(input.contentLanguage, 100) || "中文",
    sellingPoints: list(input.sellingPoints, 20),
    usageScenarios: list(input.usageScenarios, 20),
    platformAttributes: list(input.platformAttributes, 300),
    variants: list(input.variants, 500),
    pricing: object(input.pricing),
    media: object(input.media),
    logistics: object(input.logistics),
    compliance: object(input.compliance),
    aiContextHash: text(input.aiContextHash, 64) || null,
    aiAdoptions: object(input.aiAdoptions),
    status,
    validationResult: object(input.validationResult),
    updatedBy: audit.operatorLabel || "local_session",
  };
}

function item(code, label, severity, complete, message) {
  return { code, label, severity, complete: Boolean(complete), message };
}

export function validateListingDraft(product, draft) {
  const selectedImages = Array.isArray(draft.media?.imageIds) ? draft.media.imageIds : [];
  const variants = Array.isArray(draft.variants) ? draft.variants : [];
  const attributes = Array.isArray(draft.platformAttributes) ? draft.platformAttributes : [];
  const riskNotes = Array.isArray(draft.compliance?.aiRiskNotes) ? draft.compliance.aiRiskNotes.filter(Boolean) : [];
  const checks = [
    item("TITLE_REQUIRED", "商品标题", "blocker", draft.title, "填写平台商品标题。"),
    item("PLATFORM_REQUIRED", "目标平台", "blocker", draft.platform, "选择目标平台。"),
    item("SHOP_REQUIRED", "目标店铺", "blocker", draft.shopId || draft.shopName, "填写店铺 ID 或店铺名称。"),
    item("CATEGORY_REQUIRED", "平台类目", "blocker", draft.platformCategoryId || draft.platformCategoryName, "选择或填写平台类目。"),
    item("PRIMARY_IMAGE_REQUIRED", "商品主图", "blocker", draft.media?.primaryImageId || selectedImages.length, "从产品素材中选择主图。"),
    item("SKU_REQUIRED", "SKU", "blocker", product.sku, "产品 SKU 不完整。"),
    item("PRICE_REQUIRED", "销售价格", "blocker", Number(draft.pricing?.salePrice) > 0, "填写大于 0 的销售价格。"),
    item("WEIGHT_REQUIRED", "物流重量", "warning", Number(draft.logistics?.weightG) > 0, "补充物流重量。"),
    item("DIMENSIONS_REQUIRED", "物流尺寸", "warning", [draft.logistics?.lengthCm, draft.logistics?.widthCm, draft.logistics?.heightCm].every((value) => Number(value) > 0), "补充完整长宽高。"),
    item("REQUIRED_ATTRIBUTES", "平台必填属性", "blocker", attributes.filter((entry) => entry.required).every((entry) => text(entry.value)), "填写全部必填平台属性。"),
    item("AI_RISK_REVIEW", "AI 风险确认", "warning", riskNotes.length === 0, "确认 AI 内容中的风险提示。"),
  ];
  const blockers = checks.filter((entry) => entry.severity === "blocker" && !entry.complete);
  const warnings = checks.filter((entry) => entry.severity === "warning" && !entry.complete);
  return {
    checkedAt: new Date().toISOString(),
    checks,
    completedCount: checks.filter((entry) => entry.complete).length,
    blockerCount: blockers.length,
    warningCount: warnings.length,
    ready: blockers.length === 0,
  };
}

export class ProductListingService {
  constructor({ repository }) {
    this.repository = repository;
  }

  list(productId) {
    return this.repository.list(productId);
  }

  get(draftId) {
    return this.repository.get(draftId);
  }

  async save(product, input, audit = {}, check = false) {
    const draft = normalizeDraft(product, input, audit);
    if (check) {
      draft.validationResult = validateListingDraft(product, draft);
      draft.status = draft.validationResult.ready ? "ready" : "draft";
    }
    return this.repository.upsert(draft);
  }

  async remove(productId, draftId, audit = {}) {
    const deleted = await this.repository.softDelete(productId, draftId, audit.operatorLabel || "local_session");
    if (!deleted) throw Object.assign(new Error("上架草稿不存在。"), { code: "PRODUCT_LISTING_NOT_FOUND", status: 404 });
    return true;
  }

  archiveForProduct(productId, audit = {}) {
    return this.repository.softDeleteAll(productId, audit.operatorLabel || "local_session");
  }
}
