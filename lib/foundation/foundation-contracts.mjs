import { createHash } from "node:crypto";

export const FOUNDATION_SCHEMA_VERSION = "COMMERCE-OPS-FOUNDATION-1.0.0";

export const FOUNDATION_TASK_STATES = Object.freeze([
  "PENDING",
  "READY",
  "RUNNING",
  "PAUSE_REQUESTED",
  "PAUSED",
  "BLOCKED",
  "RETRY_WAIT",
  "SUCCEEDED",
  "PARTIAL_SUCCESS",
  "FAILED",
  "CANCELLED",
  "DISMISSED",
]);

export const FOUNDATION_PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);

export const FOUNDATION_CAPABILITIES = Object.freeze([
  "orders.read",
  "inventory.read",
  "images.read",
  "listing.read",
  "listing.write",
  "discount.read",
  "discount.write",
]);

export const FOUNDATION_OPERATION_PLAN_STATES = Object.freeze([
  "PREVIEWED",
  "APPROVED",
  "IN_FLIGHT",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
  "EXPIRED",
  "BLOCKED",
  "CANCELLED",
]);

export const FOUNDATION_OPERATION_APPROVAL_MODES = Object.freeze(["human", "system"]);

const OPERATION_PLAN_TRANSITIONS = Object.freeze({
  PREVIEWED: new Set(["APPROVED", "EXPIRED", "BLOCKED", "CANCELLED"]),
  APPROVED: new Set(["IN_FLIGHT", "EXPIRED", "BLOCKED", "CANCELLED"]),
  IN_FLIGHT: new Set(["SUCCEEDED", "FAILED", "UNKNOWN"]),
  UNKNOWN: new Set(["SUCCEEDED", "FAILED", "BLOCKED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  EXPIRED: new Set(),
  BLOCKED: new Set(),
  CANCELLED: new Set(),
});

const SENSITIVE_PLAN_KEYS = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "cookie",
  "authorization",
  "apikey",
  "encryptedpassword",
]);

const TERMINAL_STATES = new Set([
  "SUCCEEDED",
  "PARTIAL_SUCCESS",
  "CANCELLED",
  "DISMISSED",
]);

const TRANSITIONS = Object.freeze({
  PENDING: new Set(["READY", "RUNNING", "CANCELLED"]),
  READY: new Set(["RUNNING", "BLOCKED", "CANCELLED"]),
  RUNNING: new Set([
    "PAUSE_REQUESTED",
    "BLOCKED",
    "RETRY_WAIT",
    "SUCCEEDED",
    "PARTIAL_SUCCESS",
    "FAILED",
    "CANCELLED",
  ]),
  PAUSE_REQUESTED: new Set(["RUNNING", "PAUSED", "FAILED", "CANCELLED"]),
  PAUSED: new Set(["READY", "RUNNING", "CANCELLED"]),
  BLOCKED: new Set(["READY", "RUNNING", "CANCELLED", "DISMISSED"]),
  RETRY_WAIT: new Set(["READY", "RUNNING", "FAILED", "CANCELLED"]),
  FAILED: new Set(["READY", "RETRY_WAIT", "CANCELLED"]),
  SUCCEEDED: new Set(),
  PARTIAL_SUCCESS: new Set(),
  CANCELLED: new Set(),
  DISMISSED: new Set(),
});

const STATE_ALIASES = Object.freeze({
  pending: "PENDING",
  new: "READY",
  ready: "READY",
  acknowledged: "READY",
  reopened: "READY",
  scheduled: "READY",
  running: "RUNNING",
  in_progress: "RUNNING",
  validating: "RUNNING",
  publishing: "RUNNING",
  pause_requested: "PAUSE_REQUESTED",
  paused: "PAUSED",
  monitoring: "PAUSED",
  blocked: "BLOCKED",
  retry_wait: "RETRY_WAIT",
  success: "SUCCEEDED",
  succeeded: "SUCCEEDED",
  completed: "SUCCEEDED",
  published: "SUCCEEDED",
  resolved: "SUCCEEDED",
  partial_success: "PARTIAL_SUCCESS",
  failed: "FAILED",
  skipped: "CANCELLED",
  cancelled: "CANCELLED",
  canceled: "CANCELLED",
  dismissed: "DISMISSED",
});

export function assertFoundationState(value) {
  const state = String(value || "").trim().toUpperCase();
  if (!FOUNDATION_TASK_STATES.includes(state)) {
    throw new TypeError(`Unsupported Foundation task state: ${value}`);
  }
  return state;
}

export function assertFoundationPriority(value = "P2") {
  const priority = String(value || "").trim().toUpperCase();
  if (!FOUNDATION_PRIORITIES.includes(priority)) {
    throw new TypeError(`Unsupported Foundation priority: ${value}`);
  }
  return priority;
}

export function normalizeDomainTaskState(value, fallback = "BLOCKED") {
  const key = String(value || "").trim().toLowerCase().replaceAll("-", "_");
  if (!key) return assertFoundationState(fallback);
  return STATE_ALIASES[key] || assertFoundationState(fallback);
}

export function canTransitionFoundationTask(fromState, toState) {
  const from = assertFoundationState(fromState);
  const to = assertFoundationState(toState);
  return from === to || TRANSITIONS[from].has(to);
}

export function assertFoundationTransition(fromState, toState) {
  const from = assertFoundationState(fromState);
  const to = assertFoundationState(toState);
  if (!canTransitionFoundationTask(from, to)) {
    throw Object.assign(
      new Error(`Foundation task cannot transition from ${from} to ${to}.`),
      { code: "FOUNDATION_TASK_TRANSITION_INVALID", fromState: from, toState: to },
    );
  }
  return { from, to };
}

export function isTerminalFoundationState(value) {
  return TERMINAL_STATES.has(assertFoundationState(value));
}

export function assertFoundationOperationPlanState(value) {
  const state = String(value || "").trim().toUpperCase();
  if (!FOUNDATION_OPERATION_PLAN_STATES.includes(state)) {
    throw new TypeError(`Unsupported Foundation operation plan state: ${value}`);
  }
  return state;
}

export function assertFoundationOperationApprovalMode(value = "human") {
  const mode = String(value || "").trim().toLowerCase();
  if (!FOUNDATION_OPERATION_APPROVAL_MODES.includes(mode)) {
    throw new TypeError(`Unsupported Foundation operation approval mode: ${value}`);
  }
  return mode;
}

export function assertFoundationOperationPlanTransition(fromState, toState) {
  const from = assertFoundationOperationPlanState(fromState);
  const to = assertFoundationOperationPlanState(toState);
  if (from !== to && !OPERATION_PLAN_TRANSITIONS[from].has(to)) {
    throw Object.assign(
      new Error(`Foundation operation plan cannot transition from ${from} to ${to}.`),
      { code: "FOUNDATION_OPERATION_PLAN_TRANSITION_INVALID", fromState: from, toState: to },
    );
  }
  return { from, to };
}

function canonicalValue(value, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Operation plan numbers must be finite");
    return Object.is(value, -0) ? 0 : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported operation plan value type: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Operation plan content must not contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Operation plan content must use plain objects");
    }
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) {
        throw new TypeError(`Operation plan field ${key} must not be undefined`);
      }
      output[key] = canonicalValue(value[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function foundationCanonicalJson(value) {
  return JSON.stringify(canonicalValue(value, new Set()));
}

export function foundationContentHash(value) {
  return createHash("sha256").update(foundationCanonicalJson(value)).digest("hex");
}

export function assertNoSensitiveOperationPlanData(value, path = "plan") {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveOperationPlanData(item, `${path}[${index}]`));
    return value;
  }
  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SENSITIVE_PLAN_KEYS.has(normalizedKey)) {
      throw Object.assign(new Error(`Sensitive field is not allowed in an operation plan: ${path}.${key}`), {
        code: "FOUNDATION_OPERATION_PLAN_SENSITIVE_DATA",
        field: `${path}.${key}`,
      });
    }
    assertNoSensitiveOperationPlanData(nested, `${path}.${key}`);
  }
  return value;
}

export function foundationAccountId(sourceSystem, credentialRefId) {
  const source = String(sourceSystem || "").trim().toLowerCase();
  const ref = String(credentialRefId || "").trim();
  if (!source || !ref) throw new TypeError("Source system and credential reference are required");
  return `foundation:account:${source}:${ref}`;
}

export function foundationStableId(namespace, ...parts) {
  const identity = parts.map((part) => String(part ?? "").trim()).join("\u001f");
  if (!identity.replaceAll("\u001f", "")) throw new TypeError("Stable identity parts are required");
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `foundation:${namespace}:${digest}`;
}

export function toJson(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

export function parseFoundationJson(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

