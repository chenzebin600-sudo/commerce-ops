import { assertAiContextType } from "./ai-context-contracts.mjs";

export const AI_CONTEXT_REGISTRY_VERSION = "AI-CONTEXT-REGISTRY-1.0.0";

const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function registryError(message, code = "AI_CONTEXT_REGISTRY_INVALID") {
  return Object.assign(new TypeError(message), { code });
}

function text(value, label, maximum) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw registryError(`${label} is invalid`);
  }
  return normalized;
}

function version(value = "1.0.0") {
  const normalized = String(value || "").trim();
  if (!VERSION_PATTERN.test(normalized)) throw registryError("Context version is invalid");
  return normalized;
}

function jsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw registryError(`${label} must be an object`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw registryError(`${label} must be JSON serializable`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function keyOf(type, versionValue) {
  return `${type}@${versionValue}`;
}

function definitionOf(input) {
  const type = assertAiContextType(input.type);
  return deepFreeze({
    registryVersion: AI_CONTEXT_REGISTRY_VERSION,
    type,
    version: version(input.version),
    description: text(input.description, "Context description", 500),
    source: "structured_data",
    inputSchema: jsonObject(input.inputSchema, "Context input schema"),
    outputContextType: type,
  });
}

export class AiContextRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(input) {
    if (typeof input?.resolve !== "function") {
      throw registryError("Context resolver is required");
    }
    const definition = definitionOf(input);
    const key = keyOf(definition.type, definition.version);
    const current = this.entries.get(key);
    if (current) {
      if (JSON.stringify(current.definition) !== JSON.stringify(definition)) {
        throw registryError(
          `Context ${definition.type} is already registered with another definition`,
          "AI_CONTEXT_DEFINITION_CONFLICT",
        );
      }
      return current.definition;
    }
    this.entries.set(key, { definition, resolve: input.resolve });
    return definition;
  }

  get(typeValue, versionValue = "1.0.0") {
    const type = assertAiContextType(typeValue);
    return this.entries.get(keyOf(type, version(versionValue)))?.definition || null;
  }

  require(typeValue, versionValue = "1.0.0") {
    const type = assertAiContextType(typeValue);
    const normalizedVersion = version(versionValue);
    const entry = this.entries.get(keyOf(type, normalizedVersion));
    if (!entry) {
      throw Object.assign(new Error(`Context ${type}@${normalizedVersion} is not registered`), {
        code: "AI_CONTEXT_NOT_REGISTERED",
        contextType: type,
        contextVersion: normalizedVersion,
      });
    }
    return entry;
  }

  list() {
    return [...this.entries.values()]
      .map((entry) => entry.definition)
      .sort((left, right) => keyOf(left.type, left.version).localeCompare(keyOf(right.type, right.version)));
  }

  async resolve(typeValue, versionOrInput = "1.0.0", inputValue = {}) {
    const hasExplicitVersion = typeof versionOrInput === "string";
    const contextVersion = hasExplicitVersion ? versionOrInput : "1.0.0";
    const input = hasExplicitVersion ? inputValue : versionOrInput;
    const entry = this.require(typeValue, contextVersion);
    const context = await entry.resolve(jsonObject(input, "Context resolver input"));
    if (!context || context.contextType !== entry.definition.outputContextType) {
      throw Object.assign(new Error("Context resolver returned an incompatible envelope"), {
        code: "AI_CONTEXT_OUTPUT_INVALID",
        contextType: entry.definition.type,
      });
    }
    return context;
  }
}
