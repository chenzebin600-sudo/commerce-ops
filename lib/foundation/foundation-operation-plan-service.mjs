import {
  assertFoundationOperationApprovalMode,
  assertFoundationOperationPlanTransition,
  assertNoSensitiveOperationPlanData,
  foundationContentHash,
} from "./foundation-contracts.mjs";

const FINAL_EXECUTION_STATES = new Set(["SUCCEEDED", "FAILED", "UNKNOWN"]);
const UNKNOWN_RECONCILIATION_STATES = new Set(["SUCCEEDED", "FAILED", "BLOCKED"]);

function operationType(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_.:-]{2,100}$/.test(normalized)) {
    throw new TypeError("Operation type must be a stable uppercase identifier");
  }
  return normalized;
}

function clockDate(now) {
  const value = now();
  return value instanceof Date ? value : new Date(value);
}

function mismatchEvidence(plan, current) {
  const actual = {
    scopeHash: foundationContentHash(current.scope),
    sourceSnapshotHash: foundationContentHash(current.sourceSnapshot),
    policyHash: foundationContentHash(current.policy),
    itemsHash: foundationContentHash(current.items),
  };
  const expected = {
    scopeHash: plan.scopeHash,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    policyHash: plan.policyHash,
    itemsHash: plan.itemsHash,
  };
  const changed = Object.keys(expected).filter((key) => expected[key] !== actual[key]);
  return { changed, expected, actual };
}

export class FoundationOperationPlanService {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository;
    this.now = now;
  }

  async create({
    id = null,
    taskId = null,
    operationType: requestedOperationType,
    scope,
    sourceSnapshot,
    policy,
    items = [],
    summary = {},
    approvalMode = "human",
    approvalText = null,
    ttlMs = 10 * 60_000,
    createdBy = "foundation",
  }) {
    const type = operationType(requestedOperationType);
    const mode = assertFoundationOperationApprovalMode(approvalMode);
    const content = { scope, sourceSnapshot, policy, items, summary };
    assertNoSensitiveOperationPlanData(content);
    if (taskId && !await this.repository.getTask(taskId)) {
      throw Object.assign(new Error("Foundation task does not exist."), {
        code: "FOUNDATION_TASK_NOT_FOUND",
      });
    }
    if (mode === "human" && !String(approvalText || "").trim()) {
      throw new TypeError("Human-approved operation plans require exact approval text");
    }
    const createdAt = clockDate(this.now);
    if (id) {
      const byId = await this.repository.getOperationPlan(id);
      if (byId) {
        if (byId.operationType !== type || byId.summary?.previewSagaId !== summary?.previewSagaId) {
          throw Object.assign(new Error("Foundation operation plan idempotency identity conflicts."), { code: "FOUNDATION_OPERATION_PLAN_IDEMPOTENCY_CONFLICT" });
        }
        return byId;
      }
    }
    const boundedTtl = Math.max(1_000, Math.min(24 * 60 * 60_000, Number(ttlMs) || 0));
    const expiresAt = new Date(createdAt.getTime() + boundedTtl).toISOString();
    const hashes = {
      scopeHash: foundationContentHash(scope),
      sourceSnapshotHash: foundationContentHash(sourceSnapshot),
      policyHash: foundationContentHash(policy),
      itemsHash: foundationContentHash(items),
      approvalTextHash: approvalText ? foundationContentHash({ text: String(approvalText) }) : null,
    };
    const planHash = foundationContentHash({
      contractVersion: 1,
      taskId,
      operationType: type,
      approvalMode: mode,
      createdAt: createdAt.toISOString(),
      expiresAt,
      ...hashes,
      summary,
    });
    const existing = await this.repository.findOperationPlanByHash(planHash);
    if (existing) return existing;
    const plan = await this.repository.insertOperationPlan({
      id,
      taskId,
      operationType: type,
      state: "PREVIEWED",
      approvalMode: mode,
      ...hashes,
      planHash,
      scope,
      sourceSnapshot,
      policy,
      items,
      summary,
      expiresAt,
      createdBy,
      createdAt: createdAt.toISOString(),
    }, createdAt);
    await this.repository.addOperationPlanEvent({
      planId: plan.id,
      eventType: "CREATED",
      fromState: null,
      toState: plan.state,
      actorType: "system",
      actorId: createdBy,
      evidence: { planHash, operationType: type, expiresAt },
      idempotencyKey: `${plan.id}:created`,
      planVersion: plan.stateVersion,
    }, createdAt);
    return plan;
  }

  async get(planId) {
    return this.repository.getOperationPlan(planId);
  }

  async list(filters = {}) {
    return this.repository.listOperationPlans(filters);
  }

  async events(planId) {
    return this.repository.listOperationPlanEvents(planId);
  }

  async approve(planId, {
    planHash,
    approvalText = null,
    actorType = "user",
    actorId,
  }) {
    const plan = await this.#required(planId);
    await this.#assertFresh(plan);
    if (plan.state === "APPROVED") {
      if (plan.planHash === planHash && plan.approvedBy === actorId) return plan;
      throw Object.assign(new Error("Operation plan approval was already bound to different input."), { code: "FOUNDATION_OPERATION_APPROVAL_CHANGED" });
    }
    if (plan.state !== "PREVIEWED") {
      assertFoundationOperationPlanTransition(plan.state, "APPROVED");
    }
    if (plan.planHash !== planHash) {
      throw Object.assign(new Error("Operation plan hash does not match the preview."), {
        code: "FOUNDATION_OPERATION_PLAN_HASH_MISMATCH",
      });
    }
    if (!actorId) throw new TypeError("Approval actor is required");
    if (plan.approvalMode === "human") {
      if (actorType !== "user") throw new TypeError("Human plans must be approved by a user");
      const actualTextHash = foundationContentHash({ text: String(approvalText || "") });
      if (actualTextHash !== plan.approvalTextHash) {
        throw Object.assign(new Error("Operation approval text does not match the preview."), {
          code: "FOUNDATION_OPERATION_APPROVAL_TEXT_MISMATCH",
        });
      }
    } else if (actorType !== "system") {
      throw new TypeError("System plans must be approved by a system actor");
    }
    try { return await this.#transition(plan, "APPROVED", {
      eventType: "APPROVED",
      actorType,
      actorId,
      changes: {
        approvedBy: actorId,
        approvedAt: clockDate(this.now).toISOString(),
      },
      evidence: { planHash: plan.planHash, approvalMode: plan.approvalMode },
    }); } catch (cause) {
      if (cause?.code !== "FOUNDATION_OPERATION_PLAN_VERSION_CONFLICT") throw cause;
      const current = await this.#required(planId);
      if (current.state === "APPROVED" && current.planHash === planHash && current.approvedBy === actorId) return current;
      throw cause;
    }
  }

  async block(planId, { reasonCode, actorId = "foundation-saga", evidence = {} } = {}) {
    const plan = await this.#required(planId);
    if (plan.state === "BLOCKED") return plan;
    if (!["PREVIEWED", "APPROVED", "IN_FLIGHT"].includes(plan.state)) {
      assertFoundationOperationPlanTransition(plan.state, "BLOCKED");
    }
    return this.#transition(plan, "BLOCKED", { eventType: "BLOCKED", actorType: "system", actorId,
      reasonCode, evidence, changes: { lastErrorCode: reasonCode, lastErrorMessage: "Operation plan saga blocked." } });
  }

  async beginExecution(planId, {
    planHash,
    scope,
    sourceSnapshot,
    policy,
    items,
    actorId = "foundation-executor",
  }) {
    const plan = await this.#required(planId);
    await this.#assertFresh(plan);
    if (plan.planHash !== planHash) {
      return this.#blockAndThrow(plan, "FOUNDATION_OPERATION_PLAN_HASH_MISMATCH", {
        suppliedPlanHash: planHash || null,
      });
    }
    for (const [key, value] of Object.entries({ scope, sourceSnapshot, policy, items })) {
      if (value === undefined) throw new TypeError(`Current ${key} is required before execution`);
    }
    const current = { scope, sourceSnapshot, policy, items };
    assertNoSensitiveOperationPlanData(current);
    const mismatch = mismatchEvidence(plan, current);
    if (mismatch.changed.length) {
      return this.#blockAndThrow(plan, "FOUNDATION_OPERATION_PLAN_INPUT_DRIFT", mismatch);
    }
    return this.#transition(plan, "IN_FLIGHT", {
      eventType: "EXECUTION_STARTED",
      actorType: "system",
      actorId,
      changes: { startedAt: clockDate(this.now).toISOString() },
      evidence: { planHash: plan.planHash },
    });
  }

  async finish(planId, outcome, {
    result = {},
    errorCode = null,
    errorMessage = null,
    actorId = "foundation-executor",
    evidence = {},
  } = {}) {
    const state = String(outcome || "").trim().toUpperCase();
    if (!FINAL_EXECUTION_STATES.has(state)) {
      throw new TypeError(`Unsupported operation execution outcome: ${outcome}`);
    }
    const plan = await this.#required(planId);
    if (plan.state !== "IN_FLIGHT") assertFoundationOperationPlanTransition(plan.state, state);
    assertNoSensitiveOperationPlanData({ result, evidence });
    return this.#transition(plan, state, {
      eventType: state === "UNKNOWN" ? "EXECUTION_RESULT_UNKNOWN" : "EXECUTION_FINISHED",
      actorType: "system",
      actorId,
      reasonCode: errorCode,
      message: errorMessage,
      changes: {
        result,
        finishedAt: state === "UNKNOWN" ? null : clockDate(this.now).toISOString(),
        lastErrorCode: errorCode || (state === "UNKNOWN" ? "OPERATION_RESULT_UNKNOWN" : null),
        lastErrorMessage: errorMessage,
      },
      evidence,
    });
  }

  async reconcileUnknown(planId, outcome, {
    result = {},
    evidence,
    actorId = "foundation-reconciler",
    reasonCode = "OFFICIAL_READBACK",
    message = null,
  }) {
    const state = String(outcome || "").trim().toUpperCase();
    if (!UNKNOWN_RECONCILIATION_STATES.has(state)) {
      throw new TypeError(`Unsupported UNKNOWN reconciliation outcome: ${outcome}`);
    }
    if (!evidence || !Object.keys(evidence).length) {
      throw new TypeError("UNKNOWN reconciliation requires official readback evidence");
    }
    const plan = await this.#required(planId);
    if (plan.state !== "UNKNOWN") assertFoundationOperationPlanTransition(plan.state, state);
    assertNoSensitiveOperationPlanData({ result, evidence });
    return this.#transition(plan, state, {
      eventType: "UNKNOWN_RECONCILED",
      actorType: "system",
      actorId,
      reasonCode,
      message,
      changes: {
        result,
        finishedAt: clockDate(this.now).toISOString(),
        lastErrorCode: state === "SUCCEEDED" ? null : reasonCode,
        lastErrorMessage: state === "SUCCEEDED" ? null : message,
      },
      evidence,
    });
  }

  async #required(planId) {
    const plan = await this.repository.getOperationPlan(planId);
    if (!plan) {
      throw Object.assign(new Error("Foundation operation plan does not exist."), {
        code: "FOUNDATION_OPERATION_PLAN_NOT_FOUND",
      });
    }
    return plan;
  }

  async #assertFresh(plan) {
    if (plan.expiresAt > clockDate(this.now).toISOString()) return plan;
    if (["PREVIEWED", "APPROVED"].includes(plan.state)) {
      await this.#transition(plan, "EXPIRED", {
        eventType: "EXPIRED",
        actorType: "system",
        actorId: "foundation-clock",
        reasonCode: "FOUNDATION_OPERATION_PLAN_EXPIRED",
      });
    }
    throw Object.assign(new Error("Foundation operation plan has expired."), {
      code: "FOUNDATION_OPERATION_PLAN_EXPIRED",
    });
  }

  async #blockAndThrow(plan, reasonCode, evidence) {
    const blocked = await this.#transition(plan, "BLOCKED", {
      eventType: "EXECUTION_BLOCKED",
      actorType: "system",
      actorId: "foundation-validator",
      reasonCode,
      evidence,
      changes: { lastErrorCode: reasonCode, lastErrorMessage: "Operation plan validation failed." },
    });
    throw Object.assign(new Error("Operation plan validation failed before execution."), {
      code: reasonCode,
      plan: blocked,
      evidence,
    });
  }

  async #transition(plan, toState, {
    eventType,
    actorType,
    actorId,
    reasonCode = null,
    message = null,
    changes = {},
    evidence = {},
  }) {
    const transition = assertFoundationOperationPlanTransition(plan.state, toState);
    if (transition.from === transition.to) return plan;
    const updated = await this.repository.updateOperationPlan(plan.id, {
      ...changes,
      state: transition.to,
    }, { expectedVersion: plan.stateVersion, now: clockDate(this.now) });
    await this.repository.addOperationPlanEvent({
      planId: plan.id,
      eventType,
      fromState: plan.state,
      toState: updated.state,
      actorType,
      actorId,
      reasonCode,
      message,
      evidence,
      idempotencyKey: `${plan.id}:state:${updated.stateVersion}`,
      planVersion: updated.stateVersion,
    }, clockDate(this.now));
    return updated;
  }
}
