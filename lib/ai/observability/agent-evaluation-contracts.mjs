export const AGENT_EVALUATION_CONTRACT_VERSION = "COMMERCE-OPS-AGENT-EVALUATION-1.0.0";

export const AGENT_EVALUATION_VERDICTS = Object.freeze([
  "pass",
  "warning",
  "fail",
  "not_evaluated",
]);

export const AGENT_EVALUATOR_TYPES = Object.freeze([
  "deterministic",
  "human",
  "model",
]);

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const VERDICTS = new Set(AGENT_EVALUATION_VERDICTS);
const EVALUATOR_TYPES = new Set(AGENT_EVALUATOR_TYPES);

function contractError(message) {
  return Object.assign(new TypeError(message), { code: "AGENT_EVALUATION_INVALID" });
}

function text(value, label, maximum = 200) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f]/.test(normalized)) {
    throw contractError(`${label} is invalid`);
  }
  return normalized;
}

function identifier(value, label) {
  const normalized = text(value, label, 120).toLowerCase();
  if (!IDENTIFIER.test(normalized)) throw contractError(`${label} is invalid`);
  return normalized;
}

function version(value, label) {
  const normalized = text(value, label, 80);
  if (!VERSION.test(normalized)) throw contractError(`${label} is invalid`);
  return normalized;
}

function score(value) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw contractError("Agent evaluation score must be between 0 and 100");
  }
  return Math.round(normalized * 100) / 100;
}

export function defineAgentEvaluation(input = {}) {
  const evaluatorType = String(input.evaluator_type || "").trim().toLowerCase();
  const verdict = String(input.verdict || "").trim().toLowerCase();
  if (!EVALUATOR_TYPES.has(evaluatorType)) throw contractError("Agent evaluator type is invalid");
  if (!VERDICTS.has(verdict)) throw contractError("Agent evaluation verdict is invalid");
  const normalizedScore = score(input.score);
  if (verdict !== "not_evaluated" && normalizedScore === null) {
    throw contractError("Evaluated Agent runs require a score");
  }
  return Object.freeze({
    contract_version: AGENT_EVALUATION_CONTRACT_VERSION,
    run_id: text(input.run_id, "Agent run id"),
    metric: identifier(input.metric, "Agent evaluation metric"),
    evaluator: Object.freeze({
      type: evaluatorType,
      name: identifier(input.evaluator_name, "Agent evaluator name"),
      version: version(input.evaluator_version, "Agent evaluator version"),
    }),
    score: normalizedScore,
    verdict,
    evidence_digest: input.evidence_digest
      ? text(input.evidence_digest, "Agent evaluation evidence digest", 64)
      : null,
    reason_code: input.reason_code
      ? identifier(input.reason_code, "Agent evaluation reason code")
      : null,
    evaluated_at: input.evaluated_at
      ? new Date(input.evaluated_at).toISOString()
      : new Date().toISOString(),
  });
}

export function agentEvaluationModel() {
  return Object.freeze({
    contractVersion: AGENT_EVALUATION_CONTRACT_VERSION,
    storage: "append-only operation_audit_events action agent.evaluation.recorded",
    evaluatorTypes: AGENT_EVALUATOR_TYPES,
    verdicts: AGENT_EVALUATION_VERDICTS,
    scoreRange: Object.freeze({ minimum: 0, maximum: 100 }),
    requiredEvidence: Object.freeze([
      "run_id",
      "metric",
      "evaluator type/name/version",
      "score or not_evaluated",
      "verdict",
      "evidence_digest when source evidence exists",
    ]),
    privacy: "Store digests and reason codes only; never store raw Context, Prompt, Tool payloads, or business output.",
  });
}
