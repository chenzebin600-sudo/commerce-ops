import { AI_CONTEXT_TYPES } from "../context/ai-context-contracts.mjs";

export const AGENT_CONTRACT_VERSION = "COMMERCE-OPS-AGENT-1.0.0";

export const AGENT_PERMISSION_MODES = Object.freeze([
  "read_only",
  "recommend",
  "execute",
]);

export const AGENT_TASK_DOMAINS = Object.freeze([
  "growth",
  "mabang_data",
  "mabang_images",
  "listing",
  "product",
  "files",
  "customer_service",
]);

const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const TOOL_ACCESS = new Set(["read", "write", "lifecycle"]);

function contractError(message, code) {
  return Object.assign(new TypeError(message), { code });
}

function assertIdentifier(value, label, maximum = 120) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized || normalized.length > maximum || !IDENTIFIER_PATTERN.test(normalized)) {
    throw contractError(`${label} is invalid`, "AGENT_CONTRACT_INVALID");
  }
  return normalized;
}

function assertText(value, label, maximum) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw contractError(`${label} is invalid`, "AGENT_CONTRACT_INVALID");
  }
  return normalized;
}

function assertVersion(value = "1.0.0") {
  const normalized = String(value || "").trim();
  if (!VERSION_PATTERN.test(normalized)) {
    throw contractError("Agent version is invalid", "AGENT_CONTRACT_INVALID");
  }
  return normalized;
}

function assertDependencyVersion(value, label) {
  if (value === undefined || value === null || value === "") {
    throw contractError(`${label} version is required`, "AGENT_CONTRACT_INVALID");
  }
  return assertVersion(value);
}

export function assertAgentReference(name, version = "1.0.0") {
  return Object.freeze({
    name: assertIdentifier(name, "Agent name"),
    version: assertVersion(version),
  });
}

function jsonClone(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${label} must be an object`, "AGENT_CONTRACT_INVALID");
  }
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) throw new TypeError();
    return JSON.parse(encoded);
  } catch {
    throw contractError(`${label} must be JSON serializable`, "AGENT_CONTRACT_INVALID");
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeInputContexts(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw contractError("Agent input_context must contain at least one context", "AGENT_CONTRACT_INVALID");
  }
  const seen = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw contractError("Agent input_context entry is invalid", "AGENT_CONTRACT_INVALID");
    }
    const type = String(entry.type || "").trim().toLowerCase();
    if (!AI_CONTEXT_TYPES.includes(type) || seen.has(type)) {
      throw contractError("Agent input_context type is invalid or duplicated", "AGENT_CONTRACT_INVALID");
    }
    seen.add(type);
    return {
      type,
      version: assertDependencyVersion(entry.version, `Agent ${type} context`),
      required: entry.required !== false,
      multiple: entry.multiple === true,
    };
  });
}

function normalizeTools(input) {
  if (!Array.isArray(input)) {
    throw contractError("Agent tools must be an array", "AGENT_CONTRACT_INVALID");
  }
  const seen = new Set();
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw contractError("Agent tool entry is invalid", "AGENT_CONTRACT_INVALID");
    }
    const name = assertIdentifier(entry.name, "Agent tool name");
    const dependencyVersion = assertDependencyVersion(entry.version, `Agent ${name} tool`);
    const access = String(entry.access || "read").trim().toLowerCase();
    const permission = assertIdentifier(entry.permission, "Agent tool permission");
    if (!TOOL_ACCESS.has(access) || seen.has(name)) {
      throw contractError("Agent tool access is invalid or tool is duplicated", "AGENT_CONTRACT_INVALID");
    }
    seen.add(name);
    return {
      name,
      version: dependencyVersion,
      access,
      permission,
      description: entry.description
        ? assertText(entry.description, "Agent tool description", 500)
        : null,
    };
  });
}

function normalizeOutputSchema(input) {
  const output = jsonClone(input, "Agent output_schema");
  const schema = jsonClone(output.schema, "Agent output_schema.schema");
  if (schema.type !== "object") {
    throw contractError("Agent output schema root type must be object", "AGENT_CONTRACT_INVALID");
  }
  return {
    id: assertIdentifier(output.id, "Agent output schema id"),
    version: assertVersion(output.version),
    schema,
  };
}

function normalizePermission(input) {
  const permission = jsonClone(input, "Agent permission");
  const mode = String(permission.mode || "").trim().toLowerCase();
  const taskDomain = String(permission.task_domain || "").trim().toLowerCase();
  if (!AGENT_PERMISSION_MODES.includes(mode)) {
    throw contractError("Agent permission mode is invalid", "AGENT_CONTRACT_INVALID");
  }
  if (!AGENT_TASK_DOMAINS.includes(taskDomain)) {
    throw contractError("Agent permission task_domain is invalid", "AGENT_CONTRACT_INVALID");
  }
  if (!Array.isArray(permission.scopes)) {
    throw contractError("Agent permission scopes must be an array", "AGENT_CONTRACT_INVALID");
  }
  const scopes = [...new Set(permission.scopes.map((scope) => (
    assertIdentifier(scope, "Agent permission scope")
  )))].sort();
  return {
    mode,
    task_domain: taskDomain,
    scopes,
    requires_human_approval: permission.requires_human_approval === true,
  };
}

export function defineAgent(input = {}) {
  const reference = assertAgentReference(input.name, input.version);
  const tools = normalizeTools(input.tools);
  const permission = normalizePermission(input.permission);
  const missingScopes = tools
    .map((tool) => tool.permission)
    .filter((scope) => !permission.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw contractError("Agent tool permissions must be declared in permission.scopes", "AGENT_PERMISSION_SCOPE_MISSING");
  }
  if (tools.some((tool) => tool.access === "write")
      && (permission.mode !== "execute" || !permission.requires_human_approval)) {
    throw contractError(
      "Agents with write tools require execute permission and human approval",
      "AGENT_WRITE_PERMISSION_INVALID",
    );
  }
  if (permission.mode === "read_only" && tools.some((tool) => tool.access !== "read")) {
    throw contractError("Read-only agents cannot declare write tools", "AGENT_WRITE_PERMISSION_INVALID");
  }
  return deepFreeze({
    contract_version: AGENT_CONTRACT_VERSION,
    name: reference.name,
    version: reference.version,
    description: assertText(input.description, "Agent description", 1_000),
    input_context: normalizeInputContexts(input.input_context),
    tools,
    output_schema: normalizeOutputSchema(input.output_schema),
    permission,
  });
}

export function assertAgentContextReferences(definition, input) {
  if (!Array.isArray(input)) {
    throw contractError("Agent context references must be an array", "AGENT_CONTEXT_REFERENCE_INVALID");
  }
  const references = input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw contractError("Agent context reference is invalid", "AGENT_CONTEXT_REFERENCE_INVALID");
    }
    const type = String(entry.type || "").trim().toLowerCase();
    const id = assertText(entry.id, "Agent context subject id", 200);
    const allowed = definition.input_context.find((candidate) => candidate.type === type);
    if (!allowed) {
      throw contractError("Agent context type is not declared by the definition", "AGENT_CONTEXT_REFERENCE_INVALID");
    }
    const requestedVersion = entry.version === undefined || entry.version === null || entry.version === ""
      ? allowed.version
      : assertVersion(entry.version);
    if (requestedVersion !== allowed.version) {
      throw contractError("Agent context version does not match its definition", "AGENT_CONTEXT_REFERENCE_INVALID");
    }
    return { type, version: allowed.version, id };
  });
  for (const context of definition.input_context) {
    const count = references.filter((entry) => entry.type === context.type).length;
    if (context.required && count === 0) {
      throw contractError(`Agent requires ${context.type} context`, "AGENT_CONTEXT_REFERENCE_MISSING");
    }
    if (!context.multiple && count > 1) {
      throw contractError(`Agent accepts only one ${context.type} context`, "AGENT_CONTEXT_REFERENCE_INVALID");
    }
  }
  const unique = new Set(references.map((entry) => `${entry.type}\u001f${entry.id}`));
  if (unique.size !== references.length) {
    throw contractError("Agent context references contain duplicates", "AGENT_CONTEXT_REFERENCE_INVALID");
  }
  return deepFreeze(references);
}
