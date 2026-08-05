export const AI_CONTEXT_VERSION = "AI-CONTEXT-1.0.0";

export const AI_CONTEXT_TYPES = Object.freeze(["shop", "product", "sku"]);

export function assertAiContextType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!AI_CONTEXT_TYPES.includes(type)) throw Object.assign(
    new TypeError(`Unsupported AI context type: ${value}`),
    { code: "AI_CONTEXT_TYPE_INVALID" },
  );
  return type;
}

export function assertAiContextSubjectId(value) {
  const id = String(value || "").trim();
  if (!id || id.length > 200 || /[\u0000-\u001f]/.test(id)) throw Object.assign(
    new TypeError("AI context subject id is invalid"),
    { code: "AI_CONTEXT_SUBJECT_INVALID" },
  );
  return id;
}

export function aiContextNotFound(type, id) {
  return Object.assign(new Error(`${type} context subject was not found`), {
    code: "AI_CONTEXT_SUBJECT_NOT_FOUND",
    contextType: type,
    subjectId: id,
  });
}

export function buildAiContextEnvelope({ type, id, generatedAt, freshness, quality, data }) {
  return Object.freeze({
    contextVersion: AI_CONTEXT_VERSION,
    contextType: assertAiContextType(type),
    subject: Object.freeze({ type, id: assertAiContextSubjectId(id) }),
    generatedAt: generatedAt.toISOString(),
    freshness: Object.freeze(freshness || {}),
    quality: Object.freeze({
      status: quality?.status || "available",
      evidenceSource: quality?.evidenceSource || "structured_facts",
      limitations: Object.freeze([...(quality?.limitations || [])]),
    }),
    data: Object.freeze(data || {}),
  });
}
