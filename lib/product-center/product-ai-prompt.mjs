export const PRODUCT_AI_PROMPT_VERSION = "product-selling-points-v1";

export const PRODUCT_AI_PLATFORMS = Object.freeze(["Shopee", "Lazada", "TikTok Shop", "通用电商"]);
export const PRODUCT_AI_LANGUAGES = Object.freeze(["中文", "英文", "泰语", "马来语", "印尼语", "越南语", "菲律宾英语"]);

export function buildProductAiContext(product) {
  return Object.freeze({
    product_name: product.productName || null,
    sku: product.sku,
    country: product.country,
    category_l1: product.categoryL1 || null,
    category_l2: product.categoryL2 || null,
    style_name: product.styleName || null,
    sales_spec: product.salesSpec || null,
    dimensions: product.packaging?.itemDimensions || product.sourceFacts?.item_dimensions_raw || null,
    net_weight_g: product.packaging?.itemNetWeightG ?? product.sourceFacts?.item_net_weight_g ?? null,
    gross_weight_g: product.packaging?.itemGrossWeightG ?? product.sourceFacts?.item_gross_weight_g ?? null,
    material: product.sourceFacts?.material || product.sourceFacts?.材质 || null,
    lifecycle_status: product.lifecycleStatus || null,
    source_status: product.sourceStatus || null,
    image_count: Number(product.images?.length || 0),
    image_filenames: (product.images || []).slice(0, 20).map((image) => image.originalFilename),
    available_source_fields: product.sourceFacts || {},
    manual_overrides: product.manualOverrides || {},
  });
}

export function buildProductAiMessages({ context, options }) {
  const systemPrompt = [
    `提示词版本：${PRODUCT_AI_PROMPT_VERSION}`,
    "你是跨境电商产品内容分析助手。只能依据输入的产品字段和用户补充信息生成内容。",
    "严禁虚构产品功能、认证、材质、尺寸、承重、售后承诺、库存、销量、功率或平台保证。",
    "无法从输入验证的内容不得写成事实；资料不足时必须写入 risk_notes。",
    "必须只返回一个 JSON 对象，不要 Markdown、代码块或额外说明。",
    `输出语言：${options.outputLanguage}；目标平台：${options.targetPlatform}。`,
    `生成 ${options.sellingPointCount} 条卖点和 ${options.scenarioCount} 个使用场景。`,
    "JSON 必须包含 product_summary、target_users、user_pain_points、selling_points、usage_scenarios、feature_benefit_map、risk_notes。",
    "selling_points 每项必须包含 title、description、source_field；usage_scenarios 每项必须包含 scene、user、benefit。",
    "feature_benefit_map 每项必须包含 feature、benefit。",
    "资料不足时 risk_notes 必须包含：当前产品数据不足，以下内容需要人工确认。",
  ].join("\n");
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify({ product: context, requirements: options }) },
  ];
}
