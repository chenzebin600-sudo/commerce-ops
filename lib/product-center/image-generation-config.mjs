export const IMAGE_AI_UNCONFIGURED_MESSAGE = "尚未配置图片生成模型API，目前仅支持生成图片方案和提示词。";

export const DEFAULT_IMAGE_TEMPLATE = Object.freeze({
  key: "marketplace-standard-7",
  label: "标准商品图 7 张",
  slots: Object.freeze([
    Object.freeze({ key: "primary", type: "primary", label: "大主图", aspectRatio: "1:1" }),
    Object.freeze({ key: "selling-point", type: "secondary", label: "核心卖点图", aspectRatio: "1:1" }),
    Object.freeze({ key: "scenario-1", type: "secondary", label: "使用场景图 1", aspectRatio: "1:1" }),
    Object.freeze({ key: "scenario-2", type: "secondary", label: "使用场景图 2", aspectRatio: "1:1" }),
    Object.freeze({ key: "detail", type: "secondary", label: "细节展示图", aspectRatio: "1:1" }),
    Object.freeze({ key: "dimensions", type: "secondary", label: "尺寸或结构说明图", aspectRatio: "1:1" }),
    Object.freeze({ key: "package-feature", type: "secondary", label: "包装或功能补充图", aspectRatio: "1:1" }),
  ]),
});

function parseTemplate(value) {
  if (!value) return DEFAULT_IMAGE_TEMPLATE;
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("IMAGE_AI_TEMPLATE_JSON 必须是有效 JSON。"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.slots) || !parsed.slots.length || parsed.slots.length > 30) {
    throw new Error("IMAGE_AI_TEMPLATE_JSON 必须包含 1 到 30 个图片槽位。");
  }
  const keys = new Set();
  const slots = parsed.slots.map((slot, index) => {
    const key = String(slot?.key || "").trim().slice(0, 100);
    if (!key || keys.has(key)) throw new Error("图片模板槽位 key 必须非空且唯一。");
    keys.add(key);
    return Object.freeze({
      key,
      type: String(slot.type || "secondary").trim().slice(0, 50),
      label: String(slot.label || `图片 ${index + 1}`).trim().slice(0, 200),
      aspectRatio: String(slot.aspectRatio || "1:1").trim().slice(0, 40),
    });
  });
  return Object.freeze({ key: String(parsed.key || "custom").trim().slice(0, 100), label: String(parsed.label || "自定义图片模板").trim().slice(0, 200), slots: Object.freeze(slots) });
}
export function resolveImageGenerationConfig(env = {}) {
  const provider = String(env.IMAGE_AI_PROVIDER || "").trim().slice(0, 100);
  const apiKey = String(env.IMAGE_AI_API_KEY || "").trim();
  const baseUrl = String(env.IMAGE_AI_BASE_URL || "").trim().slice(0, 1000);
  const model = String(env.IMAGE_AI_MODEL || "").trim().slice(0, 200);
  return Object.freeze({
    configured: Boolean(provider && apiKey && model),
    provider,
    apiKey,
    baseUrl,
    model,
    template: parseTemplate(env.IMAGE_AI_TEMPLATE_JSON),
    message: provider && apiKey && model ? "图片生成模型已配置。" : IMAGE_AI_UNCONFIGURED_MESSAGE,
  });
}
