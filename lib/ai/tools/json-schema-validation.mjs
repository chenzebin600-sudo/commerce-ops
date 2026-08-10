function schemaError(message, code) {
  return Object.assign(new TypeError(message), { code });
}

function matchesType(type, value) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateNode(schema, value, path) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `${path} has an invalid schema`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} is not an allowed value`;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matchesType(type, value))) {
    return `${path} has an invalid type`;
  }
  if (value === null) return null;

  if (typeof value === "string") {
    if (Number.isFinite(schema.minLength) && value.length < schema.minLength) {
      return `${path} is shorter than allowed`;
    }
    if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) {
      return `${path} is longer than allowed`;
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern).test(value)) return `${path} has an invalid format`;
      } catch {
        return `${path} has an invalid schema pattern`;
      }
    }
  }

  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      return `${path} is smaller than allowed`;
    }
    if (Number.isFinite(schema.maximum) && value > schema.maximum) {
      return `${path} is larger than allowed`;
    }
  }

  if (Array.isArray(value)) {
    if (Number.isFinite(schema.minItems) && value.length < schema.minItems) {
      return `${path} has too few items`;
    }
    if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) {
      return `${path} has too many items`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateNode(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) return `${path}.${required} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (extra) return `${path}.${extra} is not allowed`;
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateNode(childSchema, value[key], `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

export function assertJsonSchemaValue(schema, value, {
  code = "JSON_SCHEMA_INVALID",
  label = "value",
} = {}) {
  const error = validateNode(schema, value, label);
  if (error) throw schemaError(error, code);
  return value;
}

