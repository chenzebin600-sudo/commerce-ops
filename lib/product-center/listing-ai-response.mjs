function responseError(message) {
  return Object.assign(new Error(message), { code: "PRODUCT_AI_RESPONSE_SCHEMA_INVALID", status: 502 });
}

function text(value, field, max = 30000) {
  if (typeof value !== "string" || !value.trim()) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value.trim().slice(0, max);
}

function optionalText(value, max = 30000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function strings(value, field, { min = 0, max = 20 } = {}) {
  if (!Array.isArray(value) || value.length < min) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value.slice(0, max).map((item, index) => text(item, `${field}[${index}]`, 4000));
}

function candidates(value, field) {
  if (!Array.isArray(value) || value.length < 1) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value.slice(0, 3).map((item, index) => {
    if (!item || typeof item !== "object") throw responseError(`AI 返回字段 ${field}[${index}] 格式错误。`);
    const candidateText = text(item.text, `${field}[${index}].text`, 2000);
    return { text: candidateText, character_count: [...candidateText].length, reason: optionalText(item.reason, 2000) };
  });
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw responseError(`AI 返回字段 ${field} 缺失或格式错误。`);
  return value;
}

export function parseListingAiResponse(content, contentTypes) {
  if (typeof content !== "string" || !content.trim()) throw Object.assign(new Error("AI 未返回内容。"), { code: "PRODUCT_AI_EMPTY_RESPONSE", status: 502 });
  if (Buffer.byteLength(content, "utf8") > 512 * 1024) throw Object.assign(new Error("AI 返回内容超过安全处理上限。"), { code: "PRODUCT_AI_RESPONSE_TOO_LARGE", status: 502 });
  const cleaned = content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  let root;
  try { root = JSON.parse(cleaned); } catch { throw Object.assign(new Error("AI 返回的内容不是有效 JSON。"), { code: "PRODUCT_AI_RESPONSE_NOT_JSON", status: 502 }); }
  if (!root || typeof root !== "object" || Array.isArray(root)) throw responseError("AI 返回的 JSON 结构无效。");
  const result = {};
  for (const type of contentTypes) {
    if (type === "target_audience") {
      const value = object(root.target_audience, type);
      result[type] = { target_users: strings(value.target_users, "target_audience.target_users", { min: 1, max: 10 }), reasoning_summary: optionalText(value.reasoning_summary), risk_notes: strings(value.risk_notes || [], "target_audience.risk_notes") };
    } else if (type === "product_positioning" || type === "content_style") {
      const value = object(root[type], type);
      result[type] = { text: text(value.text, `${type}.text`, 4000), reasoning_summary: optionalText(value.reasoning_summary), risk_notes: strings(value.risk_notes || [], `${type}.risk_notes`) };
    } else if (type === "listing_title") {
      const value = object(root.listing_title, type);
      result[type] = { titles: candidates(value.titles, "listing_title.titles"), risk_notes: strings(value.risk_notes || [], "listing_title.risk_notes") };
    } else if (type === "listing_subtitle") {
      const value = object(root.listing_subtitle, type);
      result[type] = { subtitles: candidates(value.subtitles, "listing_subtitle.subtitles"), risk_notes: strings(value.risk_notes || [], "listing_subtitle.risk_notes") };
    } else if (type === "listing_description") {
      const value = object(root.listing_description, type);
      result[type] = { text: text(value.text, "listing_description.text"), outline: strings(value.outline || [], "listing_description.outline"), risk_notes: strings(value.risk_notes || [], "listing_description.risk_notes") };
    } else if (type === "selling_points") {
      const value = object(root.selling_points, type);
      result[type] = {
        items: (Array.isArray(value.items) ? value.items : []).slice(0, 10).map((item, index) => ({
          title: text(item?.title, `selling_points.items[${index}].title`, 1000),
          description: text(item?.description, `selling_points.items[${index}].description`, 4000),
          source_fields: strings(item?.source_fields || [], `selling_points.items[${index}].source_fields`, { min: 1, max: 20 }),
        })),
        feature_benefit_map: (Array.isArray(value.feature_benefit_map) ? value.feature_benefit_map : []).slice(0, 20).map((item) => ({ feature: optionalText(item?.feature, 2000), benefit: optionalText(item?.benefit, 2000) })).filter((item) => item.feature || item.benefit),
        risk_notes: strings(value.risk_notes || [], "selling_points.risk_notes"),
      };
      if (!result[type].items.length) throw responseError("AI 返回字段 selling_points.items 缺失或格式错误。");
    } else if (type === "usage_scenarios") {
      const value = object(root.usage_scenarios, type);
      result[type] = {
        items: (Array.isArray(value.items) ? value.items : []).slice(0, 10).map((item, index) => ({
          scene: text(item?.scene, `usage_scenarios.items[${index}].scene`, 1000),
          target_user: text(item?.target_user, `usage_scenarios.items[${index}].target_user`, 2000),
          description: text(item?.description, `usage_scenarios.items[${index}].description`, 4000),
        })),
        risk_notes: strings(value.risk_notes || [], "usage_scenarios.risk_notes"),
      };
      if (!result[type].items.length) throw responseError("AI 返回字段 usage_scenarios.items 缺失或格式错误。");
    } else if (type === "image_prompt") {
      const value = object(root.image_prompt, type);
      result[type] = {
        summary: text(value.summary, "image_prompt.summary", 4000),
        global_constraints: strings(value.global_constraints || [], "image_prompt.global_constraints"),
        slots: (Array.isArray(value.slots) ? value.slots : []).slice(0, 30).map((item, index) => ({
          slot_key: text(item?.slot_key, `image_prompt.slots[${index}].slot_key`, 100),
          prompt: text(item?.prompt, `image_prompt.slots[${index}].prompt`, 8000),
          negative_prompt: optionalText(item?.negative_prompt, 4000),
          aspect_ratio: optionalText(item?.aspect_ratio, 40) || "1:1",
          risk_notes: strings(item?.risk_notes || [], `image_prompt.slots[${index}].risk_notes`),
        })),
      };
      if (!result[type].slots.length) throw responseError("AI 返回字段 image_prompt.slots 缺失或格式错误。");
    }
  }
  return Object.freeze(result);
}

export function contentResultForRecord(type, output) {
  return output?.[type] && typeof output[type] === "object" ? output[type] : {};
}
