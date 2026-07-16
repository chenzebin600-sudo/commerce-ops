import { randomUUID } from "node:crypto";

export const IDENTIFIER_TYPES = Object.freeze([
  "request_id",
  "task_id",
  "run_id",
  "file_id",
  "analysis_id",
  "job_id",
]);

const STABLE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createIdentifier() {
  return randomUUID();
}

export function normalizeIdentifier(value) {
  const text = String(value || "").trim();
  return STABLE_ID_PATTERN.test(text) ? text : null;
}

export function resolveRequestId(value) {
  return normalizeIdentifier(value) || createIdentifier();
}
