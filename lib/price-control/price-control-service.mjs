import { randomUUID } from "node:crypto";
import {
  APPROVED_STATUS,
  PRICE_CONTROL_ACCOUNT_ID,
  PRICE_CONTROL_SOURCE_SYSTEM,
  batchEffectiveAt,
  buildChangeText,
  calculateChange,
  expandSourcePriceRow,
  selectRepresentativePriceChanges,
  stableHash,
} from "./price-control-contracts.mjs";

export class PriceControlError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = "PriceControlError";
    this.code = code;
    this.status = status;
  }
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function comparableWallClock(value) {
  const text = value instanceof Date ? value.toISOString() : String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!match) return Number.NEGATIVE_INFINITY;
  return Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
    Number(String(match[7] || "0").padEnd(3, "0")),
  );
}

function newerThanCurrent(batch, current) {
  if (!current) return true;
  const incomingTime = comparableWallClock(batch.effectiveAt);
  const existingTime = comparableWallClock(current.effectiveAt);
  if (incomingTime !== existingTime) return incomingTime > existingTime;
  return String(batch.applyNo || "") >= String(current.sourceApplyNo || "");
}

function compactNotification(changes, limit = 100) {
  if (!changes.length) return "本次同步未发现控价变化。";
  const visible = selectRepresentativePriceChanges(changes, limit).map((change) => change.changeText);
  if (changes.length > limit) visible.push(`另有 ${changes.length - limit} 条变更，请进入 Commerce Ops 控价变更模块查看。`);
  return visible.join("\n");
}

function adjustmentLabel(status) {
  return status === "ADJUSTED" ? "已调整" : "未调整";
}

export class PriceControlService {
  constructor({
    repository,
    source = null,
    foundationRepository,
    foundationTaskService,
    notificationConfigRepository = null,
    audit = null,
    now = () => new Date(),
    syncEnabled = false,
    manualSyncEnabled = false,
    syncIntervalMs = 60 * 60 * 1000,
    staleRunTimeoutMs = 30 * 60 * 1000,
    batchLimit = 200,
    batchesPerCountry = 1,
  }) {
    this.repository = repository;
    this.source = source;
    this.foundationRepository = foundationRepository;
    this.foundationTaskService = foundationTaskService;
    this.notificationConfigRepository = notificationConfigRepository;
    this.audit = audit;
    this.now = now;
    this.syncEnabled = Boolean(syncEnabled);
    this.manualSyncEnabled = Boolean(manualSyncEnabled);
    this.syncIntervalMs = Math.max(60_000, Number(syncIntervalMs) || 60 * 60 * 1000);
    this.staleRunTimeoutMs = Math.max(60_000, Number(staleRunTimeoutMs) || 30 * 60 * 1000);
    this.batchLimit = Math.max(7, Math.min(Number(batchLimit) || 200, 500));
    this.batchesPerCountry = 1;
  }

  async status({ probe = false } = {}) {
    const schemaReady = await this.repository.isReady();
    const adjustmentWorkflowReady = schemaReady && await this.repository.isAdjustmentWorkflowReady();
    const automationReady = schemaReady && await this.repository.isAutomationReady();
    const automationSettings = automationReady ? await this.repository.getAutomationSettings() : null;
    const sourceConfigured = Boolean(this.source);
    let source = { connected: false, checked: false };
    if (probe && sourceConfigured) {
      try {
        source = { ...(await this.source.status()), checked: true };
      } catch (error) {
        source = {
          connected: false,
          checked: true,
          error: "源数据库连接失败，请检查只读账号与网络配置。",
          errorCode: String(error?.code || "PRICE_CONTROL_SOURCE_UNAVAILABLE").slice(0, 80),
        };
      }
    }
    return {
      schemaReady,
      adjustmentWorkflowReady,
      automationReady,
      sourceConfigured,
      syncEnabled: Boolean(this.syncEnabled || automationSettings?.enabled),
      manualSyncEnabled: this.manualSyncEnabled,
      syncIntervalMs: automationSettings
        ? automationSettings.intervalMinutes * 60_000
        : this.syncIntervalMs,
      batchLimit: this.batchLimit,
      batchesPerScope: this.batchesPerCountry,
      approvalStatus: APPROVED_STATUS,
      source,
    };
  }

  async automation() {
    await this.assertSchemaReady();
    const ready = await this.repository.isAutomationReady();
    const robots = this.notificationConfigRepository
      ? (await this.notificationConfigRepository.listDingtalkConfigs())
        .filter((robot) => robot.enabled)
        .map((robot) => ({
          id: robot.id,
          name: robot.name,
          enabled: robot.enabled,
          webhookConfigured: robot.webhookConfigured,
          secretConfigured: robot.secretConfigured,
          atAll: robot.atAll,
          atMobiles: robot.atMobiles,
        }))
      : [];
    return {
      ready,
      settings: ready ? await this.repository.getAutomationSettings() : null,
      robots,
      defaults: { intervalMinutes: 60, minimumIntervalMinutes: 15 },
    };
  }

  async recoverStaleRun({ requestedBy = "price-control-scheduler" } = {}) {
    await this.assertSchemaReady();
    const activeRun = await this.repository.getActiveRun();
    if (!activeRun) return null;
    const now = this.now();
    const lastHeartbeatAt = Date.parse(activeRun.updatedAt || activeRun.startedAt || activeRun.createdAt || "");
    if (!Number.isFinite(lastHeartbeatAt)) return null;
    const staleBefore = new Date(now.getTime() - this.staleRunTimeoutMs);
    if (lastHeartbeatAt > staleBefore.getTime()) return null;
    const errorCode = "PRICE_CONTROL_STALE_RUN_RECOVERED";
    const errorMessage = `控价同步 ${activeRun.id} 已超过 ${this.staleRunTimeoutMs}ms 无心跳，系统自动按失败收尾。`;
    const recovered = await this.repository.recoverStaleRun(activeRun.id, {
      staleBefore: staleBefore.toISOString(),
      errorCode,
      errorMessage,
    }, now);
    if (!recovered) return null;
    await this.audit?.recordSafely({
      module: "price_control",
      action: "product.price_control.sync.failed",
      status: "failed",
      actorType: "system",
      actorIdentifier: requestedBy,
      runId: activeRun.id,
      errorCode,
      errorSummary: new Error(errorMessage),
      metadata: {
        triggerType: activeRun.triggerType,
        mode: activeRun.syncMode,
        staleRunRecovered: true,
        previousUpdatedAt: activeRun.updatedAt,
        foundationRecovered: recovered.foundationRecovered,
      },
    });
    return recovered;
  }

  async saveAutomation(input, { requestedBy = "commerce-ops" } = {}) {
    await this.assertSchemaReady();
    if (!await this.repository.isAutomationReady()) {
      throw new PriceControlError(
        "PRICE_CONTROL_AUTOMATION_MIGRATION_REQUIRED",
        503,
        "控价定时任务迁移尚未正式启用。",
      );
    }
    const intervalMinutes = Number.parseInt(input?.intervalMinutes, 10) || 60;
    if (intervalMinutes < 15 || intervalMinutes > 1440) {
      throw new PriceControlError("PRICE_CONTROL_INTERVAL_INVALID", 400, "获取间隔必须在 15 分钟到 24 小时之间。");
    }
    const enabled = Boolean(input?.enabled);
    const notifyOnChange = input?.notifyOnChange !== false;
    const notifyOnFailure = input?.notifyOnFailure !== false;
    const dingtalkConfigId = input?.dingtalkConfigId ? String(input.dingtalkConfigId) : null;
    if (enabled && !this.source) {
      throw new PriceControlError("PRICE_CONTROL_SOURCE_NOT_CONFIGURED", 503, "控价源数据库尚未配置。");
    }
    let robot = null;
    if (dingtalkConfigId && this.notificationConfigRepository) {
      robot = await this.notificationConfigRepository.getDingtalkConfig(dingtalkConfigId);
    }
    if ((notifyOnChange || notifyOnFailure) && (!robot || !robot.enabled || !robot.webhookConfigured)) {
      throw new PriceControlError("PRICE_CONTROL_DINGTALK_REQUIRED", 400, "请选择一个已启用的钉钉机器人。");
    }
    const settings = await this.repository.saveAutomationSettings({
      enabled,
      intervalMinutes,
      dingtalkConfigId,
      notifyOnChange,
      notifyOnFailure,
    }, this.now());
    await this.audit?.recordSafely({
      module: "price_control",
      action: "product.price_control.automation.updated",
      status: "success",
      actorType: "user",
      actorIdentifier: requestedBy,
      metadata: {
        enabled,
        intervalMinutes,
        robotConfigured: Boolean(dingtalkConfigId),
        notifyOnChange,
        notifyOnFailure,
      },
    });
    return settings;
  }

  async claimDueAutomation(now = this.now()) {
    if (!await this.repository.isAutomationReady()) return null;
    return this.repository.claimDueAutomation(now);
  }

  async completeAutomation(input, now = this.now()) {
    if (!await this.repository.isAutomationReady()) return null;
    return this.repository.completeAutomationRun(input, now);
  }

  async recordNotification(runId, input, now = this.now()) {
    return this.repository.updateRunNotification(runId, input, now);
  }

  async overview() {
    if (!await this.repository.isReady()) return {
      totalChanges: 0, upCount: 0, downCount: 0, affectedSkuCount: 0,
      latestDetectedAt: null, currentPriceCount: 0, currentSkuCount: 0,
      latestEffectiveAt: null, filters: { countries: [], categories: [], batches: [] },
    };
    return this.repository.overview();
  }

  async listChanges(filters) {
    await this.assertSchemaReady();
    return this.repository.listChanges(filters);
  }

  async getChange(id) {
    await this.assertSchemaReady();
    const item = await this.repository.getChange(id);
    if (!item) throw new PriceControlError("PRICE_CONTROL_CHANGE_NOT_FOUND", 404, "控价变更记录不存在。");
    return item;
  }

  async listChangeRounds(filters) {
    await this.assertAdjustmentWorkflowReady();
    return { rounds: await this.repository.listChangeRounds(filters) };
  }

  async copyChangeRound(syncRunId, { requestedBy = "commerce-ops" } = {}) {
    await this.assertAdjustmentWorkflowReady();
    const id = String(syncRunId || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      throw new PriceControlError("PRICE_CONTROL_ROUND_ID_INVALID", 400, "控价变更轮次无效。");
    }
    const round = await this.repository.getChangeRound(id);
    if (!round) throw new PriceControlError("PRICE_CONTROL_ROUND_NOT_FOUND", 404, "控价变更轮次不存在。");
    let items;
    try {
      items = await this.repository.listChangeRoundCopyItems(id);
    } catch (error) {
      if (error?.code === "PRICE_CONTROL_ROUND_COPY_TOO_LARGE") {
        throw new PriceControlError(
          error.code,
          413,
          `本轮包含 ${error.total} 条变更，超过一次复制上限 ${error.limit} 条，请先缩小范围。`,
        );
      }
      throw error;
    }
    const header = [
      `控价变更轮次：${round.id}`,
      `最近变更时间：${round.lastDetectedAt || "—"}`,
      `源库控价更新时间：${round.sourceBusinessUpdatedAt || "—"}`,
      `涉及 SKU：${round.affectedSkuCount}；有效变更：${round.changeCount}；已调整：${round.adjustedCount}；未调整：${round.unadjustedCount}`,
      "",
    ];
    const lines = items.map((item, index) => {
      const remark = item.adjustmentRemark ? `；备注：${item.adjustmentRemark}` : "";
      return `${index + 1}. ${item.changeText}；处理状态：${adjustmentLabel(item.adjustmentStatus)}${remark}`;
    });
    const result = { round, count: items.length, text: [...header, ...lines].join("\n") };
    await this.audit?.recordSafely({
      module: "price_control",
      action: "product.price_control.round.copied",
      status: "success",
      actorType: "user",
      actorIdentifier: requestedBy,
      runId: id,
      metadata: {
        syncRunId: id,
        changeCount: items.length,
        affectedSkuCount: round.affectedSkuCount,
      },
    });
    return result;
  }

  async updateAdjustment(id, input, { requestedBy = "commerce-ops" } = {}) {
    await this.assertAdjustmentWorkflowReady();
    const status = String(input?.status || "").toUpperCase();
    if (!['UNADJUSTED', 'ADJUSTED'].includes(status)) {
      throw new PriceControlError("PRICE_CONTROL_ADJUSTMENT_STATUS_INVALID", 400, "处理状态必须是已调整或未调整。");
    }
    const remark = String(input?.remark || "").trim();
    if (remark.length > 500) {
      throw new PriceControlError("PRICE_CONTROL_ADJUSTMENT_REMARK_TOO_LONG", 400, "处理备注不能超过 500 个字符。");
    }
    const change = await this.repository.getChange(id);
    if (!change) throw new PriceControlError("PRICE_CONTROL_CHANGE_NOT_FOUND", 404, "控价变更记录不存在。");
    if (change.validityStatus !== "VALID") {
      throw new PriceControlError("PRICE_CONTROL_INVALID_CHANGE_READ_ONLY", 409, "失效的历史误报只能查看，不能标记处理状态。");
    }
    if (change.adjustmentStatus === status && (change.adjustmentRemark || "") === remark) return change;
    const updatedBy = String(requestedBy || "commerce-ops").slice(0, 128);
    const updated = await this.repository.updateAdjustment(id, { status, remark, updatedBy }, this.now());
    let foundationEvidenceRecorded = false;
    if (updated?.foundationTaskId && typeof this.foundationTaskService?.recordEvidence === "function") {
      try {
        const task = await this.foundationRepository.getTask(updated.foundationTaskId);
        const summary = await this.repository.getTaskAdjustmentSummary(updated.foundationTaskId);
        if (task) {
          await this.foundationTaskService.recordEvidence(updated.foundationTaskId, {
            eventType: "PRICE_CONTROL_ADJUSTMENT_UPDATED",
            actorType: "user",
            actorId: updatedBy,
            reasonCode: "PRICE_CONTROL_OPERATOR_DISPOSITION",
            message: `控价变更 ${updated.id} 标记为${adjustmentLabel(status)}。`,
            evidence: { changeId: updated.id, adjustmentStatus: status, remark: remark || null },
            result: {
              ...(task.result || {}),
              priceControlAdjustment: {
                ...summary,
                lastChangeId: updated.id,
                lastStatus: status,
                updatedAt: updated.adjustmentUpdatedAt,
                updatedBy,
              },
            },
          });
          foundationEvidenceRecorded = true;
        }
      } catch {
        foundationEvidenceRecorded = false;
      }
    }
    await this.audit?.recordSafely({
      module: "price_control",
      action: "product.price_control.adjustment.updated",
      status: "success",
      actorType: "user",
      actorIdentifier: updatedBy,
      taskId: updated?.foundationTaskId || null,
      runId: updated?.syncRunId || null,
      metadata: {
        changeId: updated?.id,
        previousAdjustmentStatus: change.adjustmentStatus,
        adjustmentStatus: status,
        remarkPresent: Boolean(remark),
        remarkLength: remark.length,
        foundationEvidenceRecorded,
      },
    });
    return updated;
  }

  async listRuns(filters) {
    await this.assertSchemaReady();
    return this.repository.listRuns(filters);
  }

  async listCurrentPrices(filters) {
    await this.assertSchemaReady();
    return this.repository.listCurrentPrices(filters);
  }

  async repairNullSemantics({ requestedBy = "commerce-ops" } = {}) {
    await this.assertSchemaReady();
    const result = await this.repository.repairNullSemantics({ requestedBy }, this.now());
    const invalidOnlyTaskIds = await this.repository.listInvalidOnlyTaskIds();
    let tasksCancelled = 0;
    let tasksAlreadyTerminal = 0;
    for (const taskId of invalidOnlyTaskIds) {
      const task = await this.foundationRepository.getTask(taskId);
      if (!task) continue;
      if (["PENDING", "READY", "RUNNING", "PAUSE_REQUESTED", "PAUSED", "BLOCKED", "RETRY_WAIT", "FAILED"].includes(task.state)) {
        await this.foundationTaskService.transition(taskId, "CANCELLED", {
          actorType: "system",
          actorId: requestedBy,
          reasonCode: "PRICE_CONTROL_NULL_SEMANTICS_REPAIR",
          message: "关联控价事件由源库 NULL 误判产生，已保留事件并标记失效。",
          evidence: {
            invalidReason: "SOURCE_NULL_NOT_MAINTAINED",
            invalidatedAt: result.invalidatedAt,
          },
          result: { disposition: "invalidated", repair: "price_control_null_semantics_v1" },
        });
        tasksCancelled += 1;
      } else {
        tasksAlreadyTerminal += 1;
      }
    }
    const completed = { ...result, invalidOnlyTaskCount: invalidOnlyTaskIds.length, tasksCancelled, tasksAlreadyTerminal };
    await this.audit?.recordSafely({
      module: "price_control",
      action: "product.price_control.null_semantics.repaired",
      status: "success",
      actorType: "user",
      actorIdentifier: requestedBy,
      metadata: completed,
    });
    return completed;
  }

  async assertSchemaReady() {
    if (!await this.repository.isReady()) {
      throw new PriceControlError(
        "PRICE_CONTROL_MIGRATION_REQUIRED",
        503,
        "控价变更候选迁移尚未获批应用，当前仅提供设计与隔离验证。",
      );
    }
  }

  async assertAdjustmentWorkflowReady() {
    await this.assertSchemaReady();
    if (!await this.repository.isAdjustmentWorkflowReady()) {
      throw new PriceControlError(
        "PRICE_CONTROL_ADJUSTMENT_MIGRATION_REQUIRED",
        503,
        "控价变更处理状态迁移尚未正式启用。",
      );
    }
  }

  async sync({ mode = "incremental", triggerType = "manual", requestedBy = "commerce-ops" } = {}) {
    await this.assertSchemaReady();
    if (!this.source) throw new PriceControlError("PRICE_CONTROL_SOURCE_NOT_CONFIGURED", 503, "控价源数据库尚未配置。");
    if (triggerType === "manual" && !this.manualSyncEnabled) {
      throw new PriceControlError("PRICE_CONTROL_MANUAL_SYNC_DISABLED", 403, "手动控价同步尚未启用。");
    }
    if (triggerType === "scheduled" && !this.syncEnabled) {
      const automationSettings = await this.repository.getAutomationSettings();
      if (!automationSettings?.enabled) {
        throw new PriceControlError("PRICE_CONTROL_SCHEDULE_DISABLED", 403, "控价定时同步尚未启用。");
      }
    }
    const syncMode = mode === "baseline" ? "baseline" : "incremental";
    if (syncMode === "incremental" && await this.repository.currentPriceCount() === 0) {
      throw new PriceControlError("PRICE_CONTROL_BASELINE_REQUIRED", 409, "首次同步必须先建立控价基线，不会把全部现有价格误报为新增。 ");
    }
    await this.recoverStaleRun({ requestedBy });
    const activeRun = await this.repository.getActiveRun();
    if (activeRun) {
      throw new PriceControlError("PRICE_CONTROL_SYNC_IN_PROGRESS", 409, `已有控价同步正在执行：${activeRun.id}`);
    }

    const startedAt = this.now();
    const inputFingerprint = stableHash(syncMode, triggerType, startedAt.toISOString().slice(0, 10));
    const run = await this.repository.createRun({ triggerType, syncMode, inputFingerprint }, startedAt);
    let sourceRun = null;
    const totals = { batchesSeen: 0, batchesApplied: 0, sourceRowsSeen: 0, pricePointsSeen: 0, changeCount: 0 };
    const allChanges = [];
    let sourceMetadata = {};
    let sourceBusinessUpdatedAt = null;
    try {
      sourceRun = await this.foundationRepository.upsertSourceRun({
        sourceSystem: PRICE_CONTROL_SOURCE_SYSTEM,
        accountId: PRICE_CONTROL_ACCOUNT_ID,
        domain: "product",
        sourceRefType: "price_control_sync_run",
        sourceRefId: run.id,
        status: "RUNNING",
        inputFingerprint,
        evidence: { triggerType, syncMode, requestedBy },
        startedAt: startedAt.toISOString(),
      }, startedAt);
      await this.repository.updateRun(run.id, { foundationSourceRunId: sourceRun.id }, startedAt);

      sourceMetadata = typeof this.source.fetchMetadata === "function" ? await this.source.fetchMetadata() : {};
      await this.repository.updateRun(run.id, {
        sourceCheckedAt: sourceMetadata.sourceCheckedAt || null,
        sourceTableUpdatedAt: sourceMetadata.tableUpdatedAt || null,
      }, this.now());
      const discovered = await this.source.fetchLatestApprovedBatches({
        limit: this.batchLimit,
        perCountry: this.batchesPerCountry,
      });
      await this.foundationRepository.upsertAccount({
        id: PRICE_CONTROL_ACCOUNT_ID,
        sourceSystem: PRICE_CONTROL_SOURCE_SYSTEM,
        displayName: "AI Project A read-only source",
        credentialRefType: "environment",
        credentialRefId: "PRICE_CONTROL_MYSQL_*",
        status: "active",
        metadata: { readOnlyRequired: true, secretStored: false },
        lastVerifiedAt: this.now().toISOString(),
      }, this.now());
      const batches = [...new Map(discovered
        .filter((batch) => batch.approvalStatus === APPROVED_STATUS)
        .map((batch) => [batch.applyNo, batch])).values()]
        .sort((left, right) => `${left.effectiveAt}|${left.applyNo}`.localeCompare(`${right.effectiveAt}|${right.applyNo}`));
      sourceBusinessUpdatedAt = batches.at(-1)?.effectiveAt || null;
      totals.batchesSeen = batches.length;
      const seenPriceKeys = new Set();

      for (const batchInput of [...batches].reverse()) {
        await this.repository.touchRun(run.id, this.now());
        const sourceRows = await this.source.fetchApprovedBatch(batchInput);
        totals.sourceRowsSeen += sourceRows.length;
        const pointsByKey = new Map();
        for (const row of sourceRows) {
          for (const point of expandSourcePriceRow(row)) pointsByKey.set(point.priceKey, point);
        }
        const points = [...pointsByKey.values()].sort((left, right) => left.priceKey.localeCompare(right.priceKey));
        const activePoints = points.filter((point) => point.priceValue !== null);
        totals.pricePointsSeen += activePoints.length;
        const latestActivePoints = activePoints.filter((point) => {
          if (seenPriceKeys.has(point.priceKey)) return false;
          seenPriceKeys.add(point.priceKey);
          return true;
        });
        const effectiveAt = isoDate(batchInput.effectiveAt || batchEffectiveAt(batchInput));
        const batchFingerprint = stableHash(
          batchInput.applyNo,
          batchInput.countryCode,
          effectiveAt,
          JSON.stringify(points.map((point) => [point.priceKey, point.priceValue, point.productNameCn, point.categoryName])),
        );
        const existingBatch = await this.repository.getBatch(batchInput.applyNo);
        if (existingBatch?.batch_fingerprint === batchFingerprint) {
          await this.repository.touchRun(run.id, this.now());
          continue;
        }

        const batch = {
          ...batchInput,
          approvalStatus: APPROVED_STATUS,
          sourceRowCount: sourceRows.length,
          effectiveAt,
          batchFingerprint,
        };
        // A NULL price means this batch did not maintain that price dimension.
        // Only concrete source values participate in current-state updates and
        // change detection. Explicit removals require a future source-side flag.
        const current = await this.repository.getCurrentPrices(latestActivePoints.map((point) => point.priceKey));
        const snapshots = activePoints.map((point) => {
          const id = stableHash("snapshot", batch.applyNo, point.priceKey);
          return {
            ...point,
            id,
            rowFingerprint: stableHash(point.sourceRowKey, point.priceKey, point.priceValue, point.productNameCn, point.categoryName),
          };
        });
        const snapshotIds = new Map(snapshots.map((snapshot) => [snapshot.priceKey, snapshot.id]));
        const currentUpdates = [];
        const changes = [];
        for (const point of latestActivePoints) {
          const previous = current.get(point.priceKey) || null;
          if (!newerThanCurrent(batch, previous)) continue;
          currentUpdates.push({ ...point, snapshotId: snapshotIds.get(point.priceKey) });
          if (syncMode === "baseline") continue;
          if (!previous?.priceValue) continue;
          const delta = calculateChange(previous?.priceValue ?? null, point.priceValue);
          if (!delta) continue;
          const change = {
            id: randomUUID(),
            ...point,
            ...delta,
            changeFingerprint: stableHash(batch.applyNo, point.priceKey, delta.oldPrice, delta.newPrice),
          };
          change.changeText = buildChangeText(change);
          changes.push(change);
        }
        const existingFingerprints = await this.repository.getExistingChangeFingerprints(
          changes.map((change) => change.changeFingerprint),
        );
        const newChanges = changes.filter((change) => !existingFingerprints.has(change.changeFingerprint));
        let foundationTask = null;
        if (newChanges.length) {
          foundationTask = await this.foundationTaskService.create({
            domain: "product",
            taskKind: "price_control_change_review",
            executionMode: "human",
            domainRefType: "price_control_batch_country",
            domainRefId: `${batch.applyNo}:${batch.countryCode}`,
            sourceState: "approved_price_changed",
            state: "READY",
            priority: "P1",
            accountId: PRICE_CONTROL_ACCOUNT_ID,
            sourceRunId: sourceRun.id,
            idempotencyKey: `price-control-change:${batch.applyNo}:${batch.countryCode}`,
            input: {
              applyNo: batch.applyNo,
              countryCode: batch.countryCode,
              changeCount: newChanges.length,
              changeIds: newChanges.slice(0, 100).map((change) => change.id),
            },
            evidence: {
              approvedAt: batch.approvedAt,
              effectiveAt: batch.effectiveAt,
              notificationPreview: compactNotification(newChanges, 20),
            },
            createdBy: requestedBy,
          });
          for (const change of newChanges) change.foundationTaskId = foundationTask.id;
        }
        const applied = await this.repository.applyBatch({
          runId: run.id,
          batch,
          snapshots,
          currentUpdates,
          currentRemovals: [],
          changes: newChanges,
        }, this.now());
        const persistedIds = new Set(applied.persistedChangeIds || []);
        const persistedChanges = newChanges.filter((change) => persistedIds.has(change.id));
        await this.repository.touchRun(run.id, this.now());
        totals.batchesApplied += 1;
        totals.changeCount += persistedChanges.length;
        allChanges.push(...persistedChanges);
        if (persistedChanges.length) {
          await this.audit?.recordSafely({
            module: "price_control",
            action: "product.price_control.change.detected",
            status: "success",
            runId: run.id,
            taskId: foundationTask?.id || null,
            metadata: {
              country: batch.countryCode,
              batchId: batch.applyNo,
              rowCount: sourceRows.length,
              changeCount: persistedChanges.length,
            },
          });
        }
      }

      const finishedAt = this.now();
      const watermarkAt = batches.at(-1)?.effectiveAt || null;
      const sourceVersion = typeof this.source.sourceVersion === "function"
        ? this.source.sourceVersion(batches)
        : stableHash(...batches.map((batch) => `${batch.applyNo}:${batch.effectiveAt}`));
      const completed = await this.repository.updateRun(run.id, {
        status: "SUCCEEDED",
        sourceVersion,
        sourceCheckedAt: sourceMetadata.sourceCheckedAt || null,
        sourceTableUpdatedAt: sourceMetadata.tableUpdatedAt || null,
        sourceBusinessUpdatedAt,
        fetchedAt: finishedAt.toISOString(),
        watermarkAt,
        ...totals,
        finishedAt: finishedAt.toISOString(),
      }, finishedAt);
      await this.foundationRepository.upsertSourceRun({
        id: sourceRun.id,
        sourceSystem: PRICE_CONTROL_SOURCE_SYSTEM,
        accountId: PRICE_CONTROL_ACCOUNT_ID,
        domain: "product",
        sourceRefType: "price_control_sync_run",
        sourceRefId: run.id,
        status: "SUCCEEDED",
        watermarkAt,
        inputFingerprint,
        evidence: {
          ...totals,
          sourceVersion,
          sourceCheckedAt: sourceMetadata.sourceCheckedAt || null,
          sourceTableUpdatedAt: sourceMetadata.tableUpdatedAt || null,
          sourceBusinessUpdatedAt,
          fetchedAt: finishedAt.toISOString(),
        },
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
      }, finishedAt);
      await this.audit?.recordSafely({
        module: "price_control",
        action: "product.price_control.sync.succeeded",
        status: "success",
        runId: run.id,
        metadata: { triggerType, mode: syncMode, batchId: batches.at(-1)?.applyNo, rowCount: totals.sourceRowsSeen, changeCount: totals.changeCount },
      });
      return { run: completed, changes: allChanges, notificationText: compactNotification(allChanges) };
    } catch (error) {
      const finishedAt = this.now();
      await this.repository.updateRun(run.id, {
        status: "FAILED",
        ...totals,
        sourceCheckedAt: sourceMetadata.sourceCheckedAt || null,
        sourceTableUpdatedAt: sourceMetadata.tableUpdatedAt || null,
        sourceBusinessUpdatedAt,
        fetchedAt: finishedAt.toISOString(),
        errorCode: error?.code || "PRICE_CONTROL_SYNC_FAILED",
        errorMessage: String(error?.message || error).slice(0, 500),
        finishedAt: finishedAt.toISOString(),
      }, finishedAt).catch(() => null);
      if (sourceRun) {
        await this.foundationRepository.upsertSourceRun({
          id: sourceRun.id,
          sourceSystem: PRICE_CONTROL_SOURCE_SYSTEM,
          accountId: PRICE_CONTROL_ACCOUNT_ID,
          domain: "product",
          sourceRefType: "price_control_sync_run",
          sourceRefId: run.id,
          status: "FAILED",
          inputFingerprint,
          evidence: {
            ...totals,
            errorCode: error?.code || "PRICE_CONTROL_SYNC_FAILED",
            sourceCheckedAt: sourceMetadata.sourceCheckedAt || null,
            sourceTableUpdatedAt: sourceMetadata.tableUpdatedAt || null,
            sourceBusinessUpdatedAt,
            fetchedAt: finishedAt.toISOString(),
          },
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        }, finishedAt).catch(() => null);
      }
      await this.audit?.recordSafely({
        module: "price_control",
        action: "product.price_control.sync.failed",
        status: "failed",
        runId: run.id,
        errorCode: error?.code || "PRICE_CONTROL_SYNC_FAILED",
        errorSummary: error,
        metadata: { triggerType, mode: syncMode, rowCount: totals.sourceRowsSeen, changeCount: totals.changeCount },
      });
      throw error;
    }
  }
}
