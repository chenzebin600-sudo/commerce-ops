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

