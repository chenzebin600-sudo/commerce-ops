import { randomUUID } from "node:crypto";
import {
  assertFoundationTransition,
  foundationStableId,
  normalizeDomainTaskState,
} from "./foundation-contracts.mjs";

export class FoundationTaskService {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository;
    this.now = now;
  }

  async create(input) {
    const existing = await this.repository.findTaskByDomainRef(
      input.domain,
      input.domainRefType,
      input.domainRefId,
    );
    if (existing) {
      if (existing.idempotencyKey !== input.idempotencyKey) {
        throw Object.assign(new Error("Domain task already has a Foundation envelope."), {
          code: "FOUNDATION_TASK_DOMAIN_REF_CONFLICT",
          taskId: existing.id,
        });
      }
      return existing;
    }
    const task = await this.repository.insertTask({
      ...input,
      authorityMode: "foundation",
      state: input.state || "PENDING",
      createdBy: input.createdBy || "foundation",
    }, this.now());
    await this.repository.addTaskEvent({
      taskId: task.id,
      eventType: "CREATED",
      fromState: null,
      toState: task.state,
      actorType: "system",
      actorId: input.createdBy || "foundation",
      evidence: input.evidence,
      idempotencyKey: `${task.id}:created`,
      taskVersion: task.stateVersion,
    }, this.now());
    return task;
  }

  async project(input) {
    const state = normalizeDomainTaskState(input.sourceState, input.fallbackState || "BLOCKED");
    const before = await this.repository.findTaskByDomainRef(
      input.domain,
      input.domainRefType,
      input.domainRefId,
    );
    const task = await this.repository.upsertTaskProjection({
      ...input,
      id: input.id || foundationStableId(
        "task",
        input.domain,
        input.domainRefType,
        input.domainRefId,
      ),
      executionMode: input.executionMode || "system",
      state,
      createdBy: input.createdBy || "foundation-projection",
    }, this.now());
    if (!before || before.state !== task.state || before.sourceState !== task.sourceState) {
      await this.repository.addTaskEvent({
        taskId: task.id,
        eventType: before ? "PROJECTED_STATE_CHANGED" : "PROJECTED",
        fromState: before?.state || null,
        toState: task.state,
        sourceState: task.sourceState,
        actorType: "system",
        actorId: "foundation-projection",
        evidence: task.evidence,
        idempotencyKey: `${task.id}:projection:${task.stateVersion}`,
        taskVersion: task.stateVersion,
      }, this.now());
    }
    return task;
  }

  async transition(taskId, toState, {
    actorType = "system",
    actorId = "foundation",
    reasonCode = null,
    message = null,
    evidence = {},
    result = undefined,
    errorCode = undefined,
    errorMessage = undefined,
    availableAt = undefined,
  } = {}) {
    const current = await this.repository.getTask(taskId);
    if (!current) {
      throw Object.assign(new Error("Foundation task does not exist."), {
        code: "FOUNDATION_TASK_NOT_FOUND",
      });
    }
    if (current.authorityMode !== "foundation") {
      throw Object.assign(new Error("Projected tasks must be changed in their owning domain."), {
        code: "FOUNDATION_TASK_PROJECTION_READ_ONLY",
      });
    }
    const transition = assertFoundationTransition(current.state, toState);
    if (transition.from === transition.to) return current;
    const timestamp = this.now().toISOString();
    const terminal = ["SUCCEEDED", "PARTIAL_SUCCESS", "FAILED", "CANCELLED", "DISMISSED"]
      .includes(transition.to);
    const task = await this.repository.updateTask(taskId, {
      state: transition.to,
      startedAt: transition.to === "RUNNING"
        ? current.startedAt || timestamp
        : current.startedAt,
      finishedAt: terminal ? timestamp : null,
      availableAt: availableAt === undefined ? current.availableAt : availableAt,
      result: result === undefined ? current.result : result,
      lastErrorCode: errorCode === undefined ? current.lastErrorCode : errorCode,
      lastErrorMessage: errorMessage === undefined ? current.lastErrorMessage : errorMessage,
    }, { expectedVersion: current.stateVersion, now: this.now() });
    await this.repository.addTaskEvent({
      taskId,
      eventType: "STATE_CHANGED",
      fromState: current.state,
      toState: task.state,
      actorType,
      actorId,
      reasonCode,
      message,
      evidence,
      idempotencyKey: `${taskId}:state:${task.stateVersion}`,
      taskVersion: task.stateVersion,
    }, this.now());
    return task;
  }

  async scheduleRetry(taskId, {
    actorId = "foundation",
    delayMs = 60_000,
    reasonCode = "RETRY_SCHEDULED",
    message = null,
  } = {}) {
    const current = await this.repository.getTask(taskId);
    if (!current) throw Object.assign(new Error("Foundation task does not exist."), {
      code: "FOUNDATION_TASK_NOT_FOUND",
    });
    if (current.attemptCount >= current.maxAttempts) {
      return this.transition(taskId, "FAILED", {
        actorId,
        reasonCode: "MAX_ATTEMPTS_REACHED",
        message: message || "Maximum retry attempts reached.",
      });
    }
    const availableAt = new Date(this.now().getTime() + Math.max(0, delayMs)).toISOString();
    const updated = await this.repository.updateTask(taskId, {
      state: "RETRY_WAIT",
      attemptCount: current.attemptCount + 1,
      availableAt,
      finishedAt: null,
    }, { expectedVersion: current.stateVersion, now: this.now() });
    await this.repository.addTaskEvent({
      taskId,
      eventType: "RETRY_SCHEDULED",
      fromState: current.state,
      toState: updated.state,
      actorType: "system",
      actorId,
      reasonCode,
      message,
      evidence: { availableAt, attemptCount: updated.attemptCount },
      idempotencyKey: `${taskId}:retry:${updated.stateVersion}`,
      taskVersion: updated.stateVersion,
    }, this.now());
    return updated;
  }

  async acquireLease(taskId, {
    leaseOwner,
    ttlMs = 60_000,
  }) {
    if (!leaseOwner) throw new TypeError("Lease owner is required");
    return this.repository.acquireTaskLease(taskId, {
      leaseOwner,
      leaseToken: randomUUID(),
      ttlMs: Math.max(1000, ttlMs),
    }, this.now());
  }

  async renewLease(taskId, leaseToken, { ttlMs = 60_000 } = {}) {
    return this.repository.renewTaskLease(taskId, {
      leaseToken,
      ttlMs: Math.max(1000, ttlMs),
    }, this.now());
  }

  async releaseLease(taskId, leaseToken) {
    return this.repository.releaseTaskLease(taskId, leaseToken);
  }
}

