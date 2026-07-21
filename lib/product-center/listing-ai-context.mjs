import { createHash } from "node:crypto";

export const LISTING_AI_CONTENT_TYPES = Object.freeze([
  "target_audience",
  "product_positioning",
  "content_style",
  "listing_title",
  "listing_subtitle",
  "listing_description",
  "selling_points",
  "usage_scenarios",
  "image_prompt",
  "product_images",
]);

export const LISTING_TARGETS = Object.freeze([
  Object.freeze({ countryCode: "TH", countryName: "泰国", aliases: ["泰国", "TH", "Thailand"] }),
  Object.freeze({ countryCode: "PH", countryName: "菲律宾", aliases: ["菲律宾", "PH", "Philippines"] }),
  Object.freeze({ countryCode: "MY", countryName: "马来西亚", aliases: ["马来", "马来西亚", "MY", "Malaysia"] }),
  Object.freeze({ countryCode: "ID", countryName: "印度尼西亚", aliases: ["印尼", "印度尼西亚", "ID", "Indonesia"] }),
  Object.freeze({ countryCode: "VN", countryName: "越南", aliases: ["越南", "VN", "Vietnam"] }),
]);

const TARGET_BY_ALIAS = new Map(LISTING_TARGETS.flatMap((target) => target.aliases.map((alias) => [alias.toLocaleLowerCase("en-US"), target])));
const PLATFORMS = Object.freeze({ shopee: "Shopee", lazada: "Lazada", tiktok_shop: "TikTok Shop" });

function text(value, max = 20000) {
  return String(value ?? "").trim().slice(0, max);
}
function cleanObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanList(value, max = 100) {
  return (Array.isArray(value) ? value : []).slice(0, max);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function normalizeListingTarget(value, fallback = null) {
  const input = cleanObject(value);
  const raw = text(input.countryCode || input.countryName || value, 100).toLocaleLowerCase("en-US");
  const target = TARGET_BY_ALIAS.get(raw)
    || LISTING_TARGETS.find((item) => item.countryCode.toLocaleLowerCase("en-US") === raw)
    || normalizeListingTargetFallback(fallback);
  if (!target) throw Object.assign(new Error("请选择泰国、菲律宾、马来西亚、印度尼西亚或越南。"), {
    code: "PRODUCT_LISTING_COUNTRY_INVALID",
    status: 400,
  });
  return Object.freeze({
    countryCode: target.countryCode,
    countryName: target.countryName,
    marketplaceCode: target.countryCode,
  });
}

function normalizeListingTargetFallback(value) {
  if (!value) return null;
  const raw = text(value, 100).toLocaleLowerCase("en-US");
  return TARGET_BY_ALIAS.get(raw) || null;
}

export function normalizeListingContentTypes(value, fallback = ["selling_points", "usage_scenarios"]) {
  const allowed = new Set(LISTING_AI_CONTENT_TYPES);
  const normalized = cleanList(value, LISTING_AI_CONTENT_TYPES.length).map((item) => text(item, 80)).filter((item) => allowed.has(item));
  return [...new Set(normalized.length ? normalized : fallback)];
}

export function buildListingAiContext(product, input = {}) {
  const page = cleanObject(input.listingContext || input);
  const facts = cleanObject(page.productFacts);
  const target = normalizeListingTarget(page.target || page.targetCountry || product.country, product.country);
  const platform = text(page.platform, 30).toLowerCase();
  const current = cleanObject(page.currentContent);
  const adopted = cleanObject(page.adoptedAi);
  const context = {
    product: {
      product_name: text(facts.productName || product.productName, 2000) || null,
      sku: product.sku,
      main_sku: text(facts.mainSku || product.mainSku, 500) || null,
      source_country: product.country,
      category_l1: text(facts.categoryL1 || product.categoryL1, 500) || null,
      category_l2: text(facts.categoryL2 || product.categoryL2, 500) || null,
      style_code: text(facts.styleCode || product.styleCode, 500) || null,
      style_name: text(facts.styleName || product.styleName, 500) || null,
      sales_spec: text(facts.salesSpec || product.salesSpec, 10000) || null,
      dimensions: text(facts.dimensions || product.packaging?.itemDimensions || product.sourceFacts?.item_dimensions_raw, 2000) || null,
      net_weight_g: facts.netWeightG ?? product.packaging?.itemNetWeightG ?? product.sourceFacts?.item_net_weight_g ?? null,
      gross_weight_g: facts.grossWeightG ?? product.packaging?.itemGrossWeightG ?? product.sourceFacts?.item_gross_weight_g ?? null,
      package_dimensions: text(facts.packageDimensions || product.sourceFacts?.carton_dimensions_raw, 2000) || null,
      carton_quantity: facts.cartonQuantity ?? product.packaging?.cartonQuantity ?? product.sourceFacts?.carton_quantity ?? null,
      material: text(facts.material || product.sourceFacts?.material || product.sourceFacts?.材质, 2000) || null,
      color: text(facts.color || product.sourceFacts?.color || product.sourceFacts?.颜色, 1000) || null,
      lifecycle_status: product.lifecycleStatus || null,
      source_status: product.sourceStatus || null,
      available_source_fields: cleanObject(product.sourceFacts),
      manual_overrides: cleanObject(product.manualOverrides),
      image_count: Number(product.images?.length || 0),
      image_filenames: (product.images || []).slice(0, 20).map((image) => image.originalFilename),
    },
    target: {
      platform,
      platform_name: PLATFORMS[platform] || text(page.platformName, 100) || null,
      country_code: target.countryCode,
      country_name: target.countryName,
      marketplace_code: target.marketplaceCode,
      shop_id: text(page.shopId, 200) || null,
      shop_name: text(page.shopName, 300) || null,
      platform_category_id: text(page.platformCategoryId, 200) || null,
      platform_category_name: text(page.platformCategoryName, 500) || null,
      output_language: text(page.outputLanguage || page.contentLanguage, 100) || "中文",
    },
    positioning: {
      target_audience: text(page.targetAudience || page.targetUsers, 4000) || null,
      product_positioning: text(page.productPositioning, 4000) || null,
      content_style: text(page.contentStyle, 2000) || null,
      price_positioning: text(page.pricePositioning, 2000) || null,
      primary_scenarios: text(page.primaryScenarios, 4000) || null,
      special_requirements: text(page.specialRequirements, 8000) || null,
      forbidden_content: text(page.forbiddenContent, 8000) || null,
    },
    current_content: {
      title: text(current.title, 2000) || null,
      subtitle: text(current.subtitle, 2000) || null,
      description: text(current.description, 30000) || null,
      selling_points: cleanList(current.sellingPoints, 20),
      usage_scenarios: cleanList(current.usageScenarios, 20),
      manually_modified: cleanObject(current.manuallyModified),
      adopted_ai: adopted,
    },
  };
  const serialized = JSON.stringify(stable(context));
  return Object.freeze({ context: Object.freeze(context), contextHash: createHash("sha256").update(serialized).digest("hex") });
}
