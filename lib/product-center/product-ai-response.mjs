function responseError(message, code = "PRODUCT_AI_RESPONSE_SCHEMA_INVALID") {
  return Object.assign(new Error(message), { code, status: 502 });
}

function boundedText(value, field, maxLength = 2000) {
  if (typeof value !== "string" || !value.trim()) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value.trim().slice(0, maxLength);
}

function stringList(value, field, maxItems = 20) {
  if (!Array.isArray(value)) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value.slice(0, maxItems).map((item, index) => boundedText(item, `${field}[${index}]`, 1000));
}

function optionalText(value, maxLength = 20000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function optionalStringList(value, maxItems = 20) {
  return Array.isArray(value) ? value.slice(0, maxItems).map((item) => optionalText(item, 2000)).filter(Boolean) : [];
}

function objectList(value, field, keys, maxItems = 20) {
  if (!Array.isArray(value)) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value.slice(0, maxItems).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw responseError(`AI 返回字段 ${field}[${index}] 格式错误。`);
    return Object.fromEntries(keys.map((key) => [key, boundedText(item[key], `${field}[${index}].${key}`, 2000)]));
  });
}

export function parseProductAiResponse(content) {
  if (typeof content !== "string" || !content.trim()) throw responseError("AI 未返回内容。", "PRODUCT_AI_EMPTY_RESPONSE");
  if (Buffer.byteLength(content, "utf8") > 512 * 1024) throw responseError("AI 返回内容超过安全处理上限。", "PRODUCT_AI_RESPONSE_TOO_LARGE");
  const cleaned = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  let value;
  try { value = JSON.parse(cleaned); } catch { throw responseError("AI 返回的内容不是有效 JSON。", "PRODUCT_AI_RESPONSE_NOT_JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw responseError("AI 返回的 JSON 结构无效。");
  return Object.freeze({
    product_summary: boundedText(value.product_summary, "product_summary"),
    title_suggestions: optionalStringList(value.title_suggestions, 10),
    description_suggestion: optionalText(value.description_suggestion),
    target_users: stringList(value.target_users, "target_users"),
    user_pain_points: stringList(value.user_pain_points, "user_pain_points"),
    selling_points: objectList(value.selling_points, "selling_points", ["title", "description", "source_field"]),
    usage_scenarios: objectList(value.usage_scenarios, "usage_scenarios", ["scene", "user", "benefit"]),
    feature_benefit_map: objectList(value.feature_benefit_map, "feature_benefit_map", ["feature", "benefit"]),
    risk_notes: stringList(value.risk_notes, "risk_notes"),
  });
}

export function validateProductAiContent(value) {
  return parseProductAiResponse(JSON.stringify(value));
}
