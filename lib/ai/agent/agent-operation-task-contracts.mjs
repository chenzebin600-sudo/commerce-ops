import { assertAgentReference } from "./agent-contracts.mjs";

export const AGENT_OPERATION_TASK_CONTRACT_VERSION =
  "COMMERCE-OPS-AGENT-OPERATION-TASK-1.0.0";

export const AGENT_OPERATION_TASK_PRIORITIES = Object.freeze([
  "P0",
  "P1",
  "P2",
  "P3",
]);

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const CODE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

function taskError(message) {
  return Object.assign(new TypeError(message), {
    code: "AGENT_OPERATION_TASK_INVALID",
  });
}

function identifier(value, label, { optional = false } = {}) {
  const normalized = String(value ?? "").trim();
  if (optional && !normalized) return null;
  if (!IDENTIFIER_PATTERN.test(normalized)) throw taskError(`${label} is invalid`);
  return normalized;
}

function code(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized || normalized.length > 120 || !CODE_PATTERN.test(normalized)) {
    throw taskError(`${label} is invalid`);
  }
  return normalized;
}

function text(value, label, maximum) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw taskError(`${label} is invalid`);
  }
  return normalized;
}

function jsonValue(value, label, maximumBytes) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maximumBytes) {
      throw new TypeError();
    }
    return JSON.parse(encoded);
  } catch {
    throw taskError(`${label} must be bounded JSON`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeBusinessObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw taskError("Agent task business_object must be an object");
  }
  return {
    type: code(input.type, "Agent task business object type"),
    id: identifier(input.id, "Agent task business object id"),
    name: input.name ? text(input.name, "Agent task business object name", 240) : null,
  };
}

function normalizeReason(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw taskError("Agent task reason must be an object");
  }
  return {
    code: code(input.code, "Agent task reason code"),
    summary: text(input.summary, "Agent task reason summary", 600),
  };
}

function normalizeSuggestedAction(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw taskError("Agent task suggested_action must be an object");
  }
  return {
    code: code(input.code, "Agent task suggested action code"),
    summary: text(input.summary, "Agent task suggested action summary", 600),
    parameters: input.parameters === undefined
      ? {}
      : jsonValue(input.parameters, "Agent task suggested action parameters", 8_192),
  };
}

function normalizeEvidence(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) {
    throw taskError("Agent task evidence must contain between 1 and 20 entries");
  }
  return input.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw taskError("Agent task evidence entry is invalid");
    }
    return {
      type: code(entry.type, "Agent task evidence type"),
      label: text(entry.label, "Agent task evidence label", 160),
      value: jsonValue(entry.value, "Agent task evidence value", 2_048),
      source: entry.source ? text(entry.source, "Agent task evidence source", 240) : null,
    };
  });
}

function normalizePriority(value) {
  const normalized = String(value || "P2").trim().toUpperCase();
  if (!AGENT_OPERATION_TASK_PRIORITIES.includes(normalized)) {
    throw taskError("Agent task priority is invalid");
  }
  return normalized;
}

export function normalizeAgentOperationTask(input = {}) {
  const agent = assertAgentReference(input.agent_name, input.agent_version || "1.0.0");
  return deepFreeze({
    contract_version: AGENT_OPERATION_TASK_CONTRACT_VERSION,
    source_agent: agent,
    request_id: identifier(input.request_id, "Agent task request id"),
    idempotency_key: identifier(input.idempotency_key, "Agent task idempotency key"),
    requested_by: identifier(
      input.requested_by || "agent-framework",
      "Agent task requester",
    ),
    correlation_id: identifier(
      input.correlation_id,
      "Agent task correlation id",
      { optional: true },
    ),
    business_object: normalizeBusinessObject(input.business_object),
    reason: normalizeReason(input.reason),
    evidence: normalizeEvidence(input.evidence),
    suggested_action: normalizeSuggestedAction(input.suggested_action),
    priority: normalizePriority(input.priority),
    requires_approval: input.requires_approval === true,
    references: {
      owner_id: identifier(input.owner_id, "Agent task owner id", { optional: true }),
      store_id: identifier(input.store_id, "Agent task store id", { optional: true }),
      warehouse_id: identifier(input.warehouse_id, "Agent task warehouse id", { optional: true }),
      sku_id: identifier(input.sku_id, "Agent task SKU id", { optional: true }),
    },
  });
}
