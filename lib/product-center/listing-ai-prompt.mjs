export const LISTING_AI_PROMPT_VERSION = "product-listing-content-v1";

const TYPE_RULES = Object.freeze({
  target_audience: "返回 target_audience：target_users 数组（3类）、reasoning_summary 和 risk_notes。",
  product_positioning: "返回 product_positioning：text、reasoning_summary 和 risk_notes。",
  content_style: "返回 content_style：text、reasoning_summary 和 risk_notes。",
  listing_title: "返回 listing_title：titles 数组，必须正好 3 项；每项含 text、character_count、reason。",
  listing_subtitle: "返回 listing_subtitle：subtitles 数组，必须正好 3 项；每项含 text、character_count、reason，且不得机械重复标题。",
  listing_description: "返回 listing_description：text、outline 数组和 risk_notes；内容应覆盖简介、特点、场景、人群、规格、包装、使用说明和注意事项，资料不足处不得虚构。",
  selling_points: "返回 selling_points：items 数组（默认 5 项），每项含 title、description、source_fields 数组；另含 feature_benefit_map 和 risk_notes。",
  usage_scenarios: "返回 usage_scenarios：items 数组（默认 5 项），每项含 scene、target_user、description；另含 risk_notes。",
  image_prompt: "返回 image_prompt：summary、global_constraints、slots。slots 必须严格匹配输入 image_template 的 slot_key，每项含 slot_key、prompt、negative_prompt、aspect_ratio、risk_notes。只生成方案和提示词，不声称已生成图片。",
  product_images: "product_images 只用于真实图片 Provider 的结果记录，本次文本模型不得生成或伪造图片 URL。",
});

export function buildListingAiMessages({ context, contentTypes, titleLimits = {}, imageTemplate = null, generationOptions = {} }) {
  const requestedRules = contentTypes.map((type) => TYPE_RULES[type]).filter(Boolean);
  const system = [
    `提示词版本：${LISTING_AI_PROMPT_VERSION}`,
    "你是跨境电商商品上架内容助手。所有结论必须来自输入的 Listing AI Context。",
    "每次输入都是用户当前编辑页的最新值，不得使用未提供的旧页面快照。",
    "严禁虚构品牌、认证、材质、尺寸、重量、承重、配件、功能、库存、销量、售后承诺或平台保证。",
    "不能验证的信息必须放入 risk_notes，不得为了凑数写成事实。",
    "重新生成只产生候选内容，绝不能要求系统静默覆盖人工内容。",
    "只返回 JSON 对象，不要 Markdown、代码块或额外说明。",
    ...requestedRules,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify({ content_types: contentTypes, listing_ai_context: context, title_limits: titleLimits, generation_options: generationOptions, image_template: imageTemplate }) },
  ];
}
