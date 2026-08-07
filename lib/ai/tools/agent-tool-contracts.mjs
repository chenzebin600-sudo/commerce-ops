export const AGENT_TOOL_REGISTRY_VERSION = "COMMERCE-OPS-TOOL-REGISTRY-1.0.0";

export const AGENT_TOOL_ACCESS = Object.freeze(["read", "write", "lifecycle"]);
export const AGENT_TOOL_DATABASE_ACCESS = Object.freeze(["forbidden", "service_only"]);
export const AGENT_TOOL_EXTERNAL_ACCESS = Object.freeze(["forbidden", "gateway_only"]);

const NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function toolError(message, code = "AGENT_TOOL_CONTRACT_INVALID") {
  return Object.assign(new TypeError(message), { code });
}

function name(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized.length > 120 || !NAME_PATTERN.test(normalized)) {
    throw toolError(`${label} is invalid`);
  }
  return normalized;
}

function version(value = "1.0.0") {
  const normalized = String(value || "").trim();
  if (!VERSION_PATTERN.test(normalized)) throw toolError("Agent tool version is invalid");
  return normalized;
}

export function assertAgentToolVersion(value = "1.0.0") {
  return version(value);
}

function text(value, label, maximum) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw toolError(`${label} is invalid`);
  }
  return normalized;
}

function jsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw toolError(`${label} must be an object`);
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw toolError(`${label} must be JSON serializable`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function assertAgentToolName(value) {
  return name(value, "Agent tool name");
}

export function defineAgentTool(input = {}) {
  const access = String(input.access || "read").trim().toLowerCase();
  if (!AGENT_TOOL_ACCESS.includes(access)) throw toolError("Agent tool access is invalid");
  const databaseAccess = String(input.database_access || "service_only").trim().toLowerCase();
  const externalAccess = String(input.external_access || "forbidden").trim().toLowerCase();
  if (!AGENT_TOOL_DATABASE_ACCESS.includes(databaseAccess)) {
    throw toolError("Agent tool database access is invalid");
  }
  if (!AGENT_TOOL_EXTERNAL_ACCESS.includes(externalAccess)) {
    throw toolError("Agent tool external access is invalid");
  }
  const inputSchema = jsonObject(input.input_schema, "Agent tool input schema");
  const outputSchema = jsonObject(input.output_schema, "Agent tool output schema");
  if (inputSchema.type !== "object" || outputSchema.type !== "object") {
    throw toolError("Agent tool schemas must have an object root");
  }
  return deepFreeze({
    registry_version: AGENT_TOOL_REGISTRY_VERSION,
    name: name(input.name, "Agent tool name"),
    version: version(input.version),
    description: text(input.description, "Agent tool description", 500),
    access,
    permission: name(input.permission, "Agent tool permission"),
    input_schema: inputSchema,
    output_schema: outputSchema,
    boundary: {
      database_access: databaseAccess,
      external_access: externalAccess,
    },
  });
}
