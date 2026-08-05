function cleanJsonContent(value) {
  return String(value || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function createAiOutputValidator({ schemaId, validate, parse = (content) => content } = {}) {
  const id = String(schemaId || "").trim();
  if (!id || id.length > 120) throw new TypeError("AI output schema id is required");
  if (typeof validate !== "function") throw new TypeError("AI output validator function is required");
  if (typeof parse !== "function") throw new TypeError("AI output parser function is required");
  return Object.freeze({
    schemaId: id,
    validate(content) {
      const value = parse(content);
      const result = validate(value);
      if (result === false) return { valid: false, value: null };
      if (result && typeof result === "object" && Object.hasOwn(result, "valid")) {
        return { valid: Boolean(result.valid), value: result.value ?? value };
      }
      return { valid: true, value: result === true || result === undefined ? value : result };
    },
  });
}

export function createJsonObjectOutputValidator({ schemaId, validate = () => true } = {}) {
  return createAiOutputValidator({
    schemaId,
    parse(content) {
      const parsed = JSON.parse(cleanJsonContent(content));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("AI output must be a JSON object");
      return parsed;
    },
    validate,
  });
}

export function validateAiOutput(content, validator = null) {
  if (!validator) return { valid: true, schemaId: null, value: null, error: null };
  if (!validator.schemaId || typeof validator.validate !== "function") {
    throw new TypeError("AI output validator contract is invalid");
  }
  try {
    const result = validator.validate(content);
    return {
      valid: Boolean(result?.valid),
      schemaId: String(validator.schemaId),
      value: result?.valid ? result.value : null,
      error: result?.valid ? null : "AI output did not satisfy the required schema",
    };
  } catch {
    return {
      valid: false,
      schemaId: String(validator.schemaId),
      value: null,
      error: "AI output did not satisfy the required schema",
    };
  }
}
