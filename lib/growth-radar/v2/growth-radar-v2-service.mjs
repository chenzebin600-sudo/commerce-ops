import { createHash, randomUUID } from "node:crypto";
import { GrowthRadarV2Engine } from "./growth-radar-v2-engine.mjs";
import {
  buildAssistantWorkspace,
  emptyAssistantWorkspace,
} from "./growth-radar-v2-assistant.mjs";

const METRICS_CONTRACT_VERSION = "GRV2-METRICS-1.2.0";
const VALID_ORDER_STATUSES = Object.freeze(["已发货", "待处理", "配货中", "已完成"]);
const TASK_TRANSITIONS = Object.freeze({
  NEW: Object.freeze(["ACKNOWLEDGED", "BLOCKED", "DISMISSED"]),
  ACKNOWLEDGED: Object.freeze(["IN_PROGRESS", "BLOCKED", "DISMISSED"]),
  IN_PROGRESS: Object.freeze(["MONITORING", "BLOCKED"]),
  MONITORING: Object.freeze(["RESOLVED", "BLOCKED"]),
  BLOCKED: Object.freeze(["IN_PROGRESS", "DISMISSED"]),
  RESOLVED: Object.freeze(["REOPENED"]),
  DISMISSED: Object.freeze(["REOPENED"]),
  REOPENED: Object.freeze(["ACKNOWLEDGED", "IN_PROGRESS"]),
});
const TASK_EVENT_BY_STATUS = Object.freeze({
  ACKNOWLEDGED: "ACKNOWLEDGED",
  IN_PROGRESS: "STARTED",
  MONITORING: "MONITORING_STARTED",
  RESOLVED: "RESOLVED",
  BLOCKED: "BLOCKED",
  DISMISSED: "DISMISSED",
  REOPENED: "REOPENED",
});

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function shanghaiDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function safeError(error) {
  return {
    code: String(error?.code || "GROWTH_RADAR_V2_ANALYSIS_FAILED").slice(0, 80),
    summary: String(error?.message || "Growth Radar V2 analysis failed.")
      .replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, "[path hidden]")
      .split(/\r?\n/, 1)[0]
      .slice(0, 300),
  };
}

function normalizedSku(value) {
  return String(value || "").normalize("NFKC").trim().toUpperCase();
}

function boundedText(value, label, { required = true, max = 240 } = {}) {
  const text = String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (required && !text) {
    throw new GrowthRadarV2Error("GROWTH_RADAR_V2_CONFIG_INVALID", 400, `${label}不能为空。`);
  }
  if (text.length > max) {
    throw new GrowthRadarV2Error("GROWTH_RADAR_V2_CONFIG_INVALID", 400, `${label}长度不能超过 ${max}。`);
  }
  return text;
}

function finiteInRange(value, label, min, max) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_CONFIG_INVALID",
      400,
      `${label}必须在 ${min} 到 ${max} 之间。`,
    );
  }
  return result;
}

function positiveInteger(value, label, min, max) {
  const result = finiteInRange(value, label, min, max);
  if (!Number.isInteger(result)) {
    throw new GrowthRadarV2Error("GROWTH_RADAR_V2_CONFIG_INVALID", 400, `${label}必须是整数。`);
  }
  return result;
}

function configurationVersion(prefix, at, hash) {
  return `${prefix}-${String(at).replace(/\D/g, "").slice(0, 14)}-${hash.slice(0, 8)}`;
}

function taskRevision(value) {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_TASK_REVISION_INVALID",
      400,
      "任务版本必须是大于等于 1 的整数。",
    );
  }
  return revision;
}

function taskStatus(value) {
  const status = String(value || "").trim().toUpperCase();
  if (!Object.hasOwn(TASK_TRANSITIONS, status)) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_TASK_STATUS_INVALID",
      400,
      "任务目标状态无效。",
    );
  }
  return status;
}

function isoDate(value, label, { required = false } = {}) {
  if (value === null || value === undefined || value === "") {
    if (required) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_SCHEDULE_INVALID",
        400,
        `${label}不能为空。`,
      );
    }
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_TASK_SCHEDULE_INVALID",
      400,
      `${label}不是有效时间。`,
    );
  }
  return date.toISOString();
}

function taskIdempotencyKey(value) {
  return boundedText(value, "幂等键", { max: 160 });
}

function normalizeCountryMappings(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1000) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_CONFIG_INVALID",
      400,
      "国家映射必须包含 1 到 1000 条仓库记录。",
    );
  }
  const seen = new Set();
  return input.map((row, index) => {
    const sourceWarehouseName = boundedText(row?.sourceWarehouseName, `第 ${index + 1} 行仓库名称`, { max: 160 });
    const normalizedWarehouseName = boundedText(
      row?.normalizedWarehouseName || sourceWarehouseName,
      `第 ${index + 1} 行标准仓库名称`,
      { max: 160 },
    );
    if (seen.has(normalizedWarehouseName)) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_CONFIG_DUPLICATE",
        409,
        `标准仓库名称重复：${normalizedWarehouseName}`,
      );
    }
    seen.add(normalizedWarehouseName);
    const mappingStatus = row?.mappingStatus === "excluded" ? "excluded" : "confirmed";
    const exclusionReason = mappingStatus === "excluded"
      ? boundedText(row?.exclusionReason, `第 ${index + 1} 行排除原因`, { max: 240 })
      : null;
    const countryCode = mappingStatus === "excluded"
      ? "XX"
      : boundedText(row?.countryCode, `第 ${index + 1} 行国家代码`, { max: 2 }).toUpperCase();
    const countryName = mappingStatus === "excluded"
      ? "不参与分析"
      : boundedText(row?.countryName, `第 ${index + 1} 行国家名称`, { max: 80 });
    if (mappingStatus === "confirmed" && (!/^[A-Z]{2}$/.test(countryCode) || countryCode === "ZZ" || countryCode === "XX")) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_CONFIG_INVALID",
        400,
        `第 ${index + 1} 行国家代码必须是有效的两位大写代码。`,
      );
    }
    return {
      sourceWarehouseName,
      normalizedWarehouseName,
      countryCode,
      countryName,
      mappingStatus,
      exclusionReason,
      evidence: {
        source: "growth_radar_v2_configuration",
        note: boundedText(row?.note, "配置说明", { required: false, max: 240 }),
      },
    };
  }).sort((left, right) => left.normalizedWarehouseName.localeCompare(right.normalizedWarehouseName));
}

function inherited(inputValue, existingValue) {
  return inputValue === null || inputValue === undefined || inputValue === ""
    ? existingValue
    : inputValue;
}

function normalizeRuleParameters(input = {}, existing = {}) {
  const existingThresholds = existing.thresholds || {};
  const sourceHighPercentile = finiteInRange(
    inherited(input.sourceHighPercentile, existingThresholds.assortment?.highPercentile),
    "高表现分位",
    0.5,
    0.99,
  );
  const storeLowRatioPercentile = finiteInRange(
    inherited(input.storeLowRatioPercentile, existingThresholds.capture?.lowRatio),
    "店铺低承接阈值",
    0.01,
    0.5,
  );
  const minimumComparisonSize = positiveInteger(
    inherited(input.minimumComparisonSize, existingThresholds.assortment?.minimumSampleSize),
    "最小比较样本",
    5,
    10000,
  );
  const newDays = positiveInteger(
    inherited(input.newDays, existingThresholds.newProduct?.observationDays),
    "新品观察天数",
    1,
    365,
  );
  const slowDays = [
    positiveInteger(inherited(input.slowAttentionDays, existingThresholds.slowMoving?.watchDays), "滞销关注天数", 1, 730),
    positiveInteger(inherited(input.slowHighDays, existingThresholds.slowMoving?.riskDays), "滞销高风险天数", 1, 730),
    positiveInteger(inherited(input.slowCriticalDays, existingThresholds.slowMoving?.severeDays), "滞销严重天数", 1, 730),
  ];
  if (!(slowDays[0] < slowDays[1] && slowDays[1] < slowDays[2])) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_CONFIG_INVALID",
      400,
      "滞销阈值必须按关注、高风险、严重严格递增。",
    );
  }
  const lowStockDays = [
    positiveInteger(inherited(input.lowStockWarningDays, existingThresholds.supply?.warningDays), "缺货关注天数", 1, 365),
    positiveInteger(inherited(input.lowStockHighDays, existingThresholds.supply?.criticalDays), "缺货高风险天数", 1, 365),
    finiteInRange(existingThresholds.supply?.outOfStockDays, "断货天数", 0, 0),
  ];
  if (lowStockDays[0] <= lowStockDays[1]) {
    throw new GrowthRadarV2Error(
      "GROWTH_RADAR_V2_CONFIG_INVALID",
      400,
      "缺货关注天数必须大于缺货高风险天数。",
    );
  }
  const windows = existing.windows || {};
  const dataMinimums = existing.dataMinimums || {};
  const trend = existingThresholds.trend || {};
  const storeGap = existingThresholds.storeGap || {};
  const priority = existingThresholds.priority || {};
  const task = existingThresholds.task || {};
  return {
    metricsContractVersion: METRICS_CONTRACT_VERSION,
    thresholdProfileVersion: boundedText(
      existing.thresholdProfileVersion,
      "阈值配置版本",
      { max: 120 },
    ),
    validOrderStatuses: [...VALID_ORDER_STATUSES],
    windows: {
      trendDays: positiveInteger(windows.trendDays, "趋势窗口", 1, 90),
      captureDays: positiveInteger(windows.captureDays, "承接窗口", 1, 180),
      sourceEvidenceDays: Array.isArray(windows.sourceEvidenceDays)
        ? windows.sourceEvidenceDays.map((value) => positiveInteger(value, "货盘证据窗口", 1, 365))
        : [],
    },
    dataMinimums: {
      trendSourceDays: positiveInteger(dataMinimums.trendSourceDays, "趋势最小数据天数", 1, 365),
      captureSourceDays: positiveInteger(dataMinimums.captureSourceDays, "承接最小数据天数", 1, 365),
      extendedSourceDays: positiveInteger(dataMinimums.extendedSourceDays, "扩展最小数据天数", 1, 365),
    },
    thresholds: {
      trend: {
        changeRate: finiteInRange(trend.changeRate, "趋势变化率", 0, 1),
        minPreviousQuantity: finiteInRange(trend.minPreviousQuantity, "趋势前期最小销量", 0, 100000000),
        minAbsoluteChange: finiteInRange(trend.minAbsoluteChange, "趋势最小绝对变化", 0, 100000000),
        newSalesMinQuantity: finiteInRange(trend.newSalesMinQuantity, "新增销售最小销量", 0, 100000000),
      },
      assortment: {
        highPercentile: sourceHighPercentile,
        midPercentile: finiteInRange(existingThresholds.assortment?.midPercentile, "中表现分位", 0, sourceHighPercentile),
        minimumSampleSize: minimumComparisonSize,
      },
      capture: { lowRatio: storeLowRatioPercentile },
      storeGap: {
        minimumEligibleHighSkus: positiveInteger(storeGap.minimumEligibleHighSkus, "类目缺口最小SKU数", 1, 100000),
        coverageRatio: finiteInRange(storeGap.coverageRatio, "类目覆盖率", 0, 1),
        severeCoverageRatio: finiteInRange(storeGap.severeCoverageRatio, "严重类目覆盖率", 0, 1),
        severeMissingSkus: positiveInteger(storeGap.severeMissingSkus, "严重缺口SKU数", 1, 100000),
      },
      supply: {
        outOfStockDays: lowStockDays[2],
        criticalDays: lowStockDays[1],
        warningDays: lowStockDays[0],
      },
      slowMoving: {
        watchDays: slowDays[0],
        riskDays: slowDays[1],
        severeDays: slowDays[2],
      },
      newProduct: { observationDays: newDays },
      priority: structuredClone(priority),
      task: {
        managerHomeLimit: positiveInteger(task.managerHomeLimit, "店长首页任务上限", 1, 10),
      },
    },
  };
}

export class GrowthRadarV2Error extends Error {
  constructor(code, status = 400, message = null) {
    super(message || code);
    this.name = "GrowthRadarV2Error";
    this.code = code;
    this.status = status;
  }
}

export class GrowthRadarV2Service {
  constructor({ repository, engine = new GrowthRadarV2Engine(), now = () => new Date() }) {
    if (!repository) throw new TypeError("Growth Radar V2 repository is required");
    this.repository = repository;
    this.engine = engine;
    this.now = now;
  }

  async inputContract(actorLabel = "local_session") {
    const [inventoryBatch, ruleSet, countryMappingSet, shops, orderWatermark] = await Promise.all([
      this.repository.latestInventoryBatch(),
      this.repository.activeRuleSet(),
      this.repository.activeCountryMappingSet(),
      this.repository.confirmedShops(),
      this.repository.latestOrderWatermark(),
    ]);
    if (!inventoryBatch) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_INVENTORY_UNAVAILABLE",
        409,
        "No applied Mabang inventory batch is available.",
      );
    }
    if (!ruleSet) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_RULE_SET_UNAVAILABLE",
        409,
        "No active Growth Radar V2 rule set is available.",
      );
    }
    if (ruleSet.metrics_contract_version !== METRICS_CONTRACT_VERSION) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_RULE_SET_VERSION_MISMATCH",
        409,
        `Active rule set must use ${METRICS_CONTRACT_VERSION}.`,
      );
    }
    const configuredStatuses = [...new Set(
      (ruleSet.parameters?.validOrderStatuses || []).map((value) => String(value || "").trim()),
    )].sort();
    const requiredStatuses = [...VALID_ORDER_STATUSES].sort();
    if (JSON.stringify(configuredStatuses) !== JSON.stringify(requiredStatuses)) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_ORDER_STATUS_CONTRACT_MISMATCH",
        409,
        "Active rule set does not contain the four GRV2-METRICS-1.2.0 order statuses.",
      );
    }
    if (!countryMappingSet) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_COUNTRY_MAPPING_SET_UNAVAILABLE",
        409,
        "No active country mapping set is available.",
      );
    }
    const at = this.now().toISOString();
    const watermark = orderWatermark
      || inventoryBatch.collected_at
      || inventoryBatch.imported_at
      || inventoryBatch.created_at
      || at;
    const analysisDate = shanghaiDate(
      inventoryBatch.collected_at || inventoryBatch.imported_at || inventoryBatch.created_at || at,
    );
    const shopScopeFingerprint = fingerprint(shops.map((shop) => ({
      id: shop.id,
      platform: shop.platform,
      countryCode: shop.country_code,
      ownerUserId: shop.owner_user_id || null,
      categoryScope: shop.primary_category_scope_json || "[]",
      revision: Number(shop.revision || 1),
    })));
    const inputFingerprint = fingerprint({
      inventoryBatchId: inventoryBatch.id,
      orderWatermarkAt: watermark,
      ruleSetId: ruleSet.id,
      ruleSetHash: ruleSet.content_sha256,
      countryMappingSetId: countryMappingSet.id,
      countryMappingSetHash: countryMappingSet.content_sha256,
      shopScopeFingerprint,
      metricsContractVersion: METRICS_CONTRACT_VERSION,
    });
    return {
      at,
      actorLabel,
      analysisDate,
      inventoryBatch,
      orderWatermarkAt: watermark,
      ruleSet,
      countryMappingSet,
      shops,
      shopScopeFingerprint,
      inputFingerprint,
    };
  }

  async analyze({ actorLabel = "local_session" } = {}) {
    const contract = await this.inputContract(actorLabel);
    const existing = await this.repository.runByFingerprint(contract.inputFingerprint);
    if (existing) {
      const taskSync = existing.status === "published"
        ? await this.trySyncPublishedTasks(existing, actorLabel)
        : { synced: false, reason: "RUN_NOT_PUBLISHED" };
      return { run: existing, reused: true, taskSync };
    }

    let run = await this.repository.createRun({
      id: randomUUID(),
      analysisDate: contract.analysisDate,
      inventoryBatchId: contract.inventoryBatch.id,
      orderWatermarkAt: contract.orderWatermarkAt,
      ruleSetId: contract.ruleSet.id,
      countryMappingSetId: contract.countryMappingSet.id,
      shopScopeFingerprint: contract.shopScopeFingerprint,
      inputFingerprint: contract.inputFingerprint,
      status: "pending",
      qualityStatus: "degraded",
      qualitySummary: { stage: "pending" },
      createdBy: actorLabel,
      createdAt: contract.at,
      updatedAt: contract.at,
    });

    try {
      run = await this.repository.updateRun(run.id, {
        status: "running",
        startedAt: contract.at,
        qualitySummary: { stage: "loading_inputs" },
        updatedAt: contract.at,
      });
      const [inventoryRows, orderRows, warehouseMappings] = await Promise.all([
        this.repository.inventoryRowsForBatch(contract.inventoryBatch.id),
        this.repository.validOrderRows(
          contract.orderWatermarkAt,
          contract.ruleSet.parameters.validOrderStatuses,
        ),
        this.repository.warehouseCountryMappings(contract.countryMappingSet.id),
      ]);
      const projection = this.engine.compute({
        analysisRunId: run.id,
        analysisDate: contract.analysisDate,
        inventoryBatchId: contract.inventoryBatch.id,
        orderWatermarkAt: contract.orderWatermarkAt,
        countryMappingSetId: contract.countryMappingSet.id,
        ruleSet: contract.ruleSet,
        inventoryRows,
        orderRows,
        shops: contract.shops,
        warehouseMappings,
        calculatedAt: this.now().toISOString(),
      });
      await this.repository.writeProjection(run.id, projection);
      const validationAt = this.now().toISOString();
      await this.repository.updateRun(run.id, {
        status: "validating",
        qualityStatus: projection.qualityStatus,
        qualitySummary: { ...projection.qualitySummary, stage: "validating" },
        ...projection.counts,
        updatedAt: validationAt,
      });
      run = await this.repository.publishRun(run.id, projection.counts, {
        qualityStatus: projection.qualityStatus,
        qualitySummary: { ...projection.qualitySummary, stage: "published" },
        at: validationAt,
      });
      const taskSync = await this.trySyncPublishedTasks(run, actorLabel);
      return { run, reused: false, taskSync };
    } catch (error) {
      const failure = safeError(error);
      if (run.status !== "published") {
        await this.repository.updateRun(run.id, {
          status: "failed",
          qualityStatus: "blocked",
          qualitySummary: { stage: "failed", errorCode: failure.code },
          errorCode: failure.code,
          errorSummary: failure.summary,
          finishedAt: this.now().toISOString(),
          updatedAt: this.now().toISOString(),
        }).catch(() => {});
      }
      if (error instanceof GrowthRadarV2Error) throw error;
      throw new GrowthRadarV2Error(failure.code, 500, failure.summary);
    }
  }

  async status() {
    const [latestPublished, latestAttempt, inventoryBatch] = await Promise.all([
      this.repository.latestPublishedRun(),
      this.repository.latestAttempt(),
      this.repository.latestInventoryBatch(),
    ]);
    return {
      metricsVersion: METRICS_CONTRACT_VERSION,
      latestPublished,
      latestAttempt,
      latestInventoryBatch: inventoryBatch ? {
        id: inventoryBatch.id,
        collectedAt: inventoryBatch.collected_at || null,
        importedAt: inventoryBatch.imported_at || null,
        rowCount: Number(inventoryBatch.row_count || 0),
        scopeStatus: inventoryBatch.source_scope_status || "unconfirmed",
      } : null,
      servingPreviousPublishedRun: Boolean(
        latestPublished && latestAttempt && latestAttempt.id !== latestPublished.id
        && latestAttempt.status === "failed",
      ),
    };
  }

  async requirePublishedRun() {
    const run = await this.repository.latestPublishedRun();
    if (!run) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_NOT_PUBLISHED",
        404,
        "No published Growth Radar V2 analysis is available.",
      );
    }
    return run;
  }

  async requireTaskPersistence() {
    const readiness = await this.repository.assistantReadiness();
    if (!readiness.taskPersistenceReady) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_PERSISTENCE_UNAVAILABLE",
        409,
        "运营任务持久化尚未启用。",
      );
    }
    return readiness;
  }

  async overview() {
    const run = await this.requirePublishedRun();
    return { run, summary: await this.repository.overview(run.id) };
  }

  async directions() {
    const run = await this.requirePublishedRun();
    return { run, ...(await this.repository.directionSummary(run.id)) };
  }

  async assistantWorkspace({ managerId = null, maxTasks = 10 } = {}) {
    const readiness = await this.repository.assistantReadiness();
    if (!readiness.analysisSchemaReady || !readiness.publishedAnalysisAvailable) {
      return emptyAssistantWorkspace(readiness);
    }
    const run = await this.requirePublishedRun();
    const [overview, directions] = await Promise.all([
      this.repository.overview(run.id),
      this.repository.directionSummary(run.id),
    ]);
    const persistedTasks = readiness.taskPersistenceReady
      ? (await this.repository.listFocusItems({
          ownerUserId: managerId,
          activeOnly: true,
          page: 1,
          pageSize: 500,
        })).items
      : null;
    return buildAssistantWorkspace({
      run,
      overview,
      directions,
      readiness,
      managerId,
      maxTasks,
      persistedTasks,
      taskPersistenceReady: readiness.taskPersistenceReady,
    });
  }

  async syncPublishedTasks(run, actorLabel = "system") {
    const readiness = await this.repository.assistantReadiness();
    if (!readiness.taskPersistenceReady) {
      return { synced: false, reason: "TASK_PERSISTENCE_SCHEMA_NOT_APPROVED" };
    }
    if (!readiness.operationTasksPublishable) {
      return { synced: false, reason: "READINESS_BLOCKED", blockers: readiness.blockers };
    }
    const [overview, directions] = await Promise.all([
      this.repository.overview(run.id),
      this.repository.directionSummary(run.id),
    ]);
    const projection = buildAssistantWorkspace({
      run,
      overview,
      directions,
      readiness,
      maxTasks: 10,
      taskPersistenceReady: true,
    });
    const result = await this.repository.syncFocusItems(run.id, projection.candidateTasks, {
      actor: `system:${boundedText(actorLabel, "操作人", { max: 100 })}`,
      at: this.now().toISOString(),
    });
    return {
      synced: true,
      candidateCount: projection.candidateTasks.length,
      activeTaskCount: result.total,
    };
  }

  async trySyncPublishedTasks(run, actorLabel = "system") {
    try {
      return await this.syncPublishedTasks(run, actorLabel);
    } catch (error) {
      const failure = safeError(error);
      return {
        synced: false,
        reason: "TASK_SYNC_FAILED",
        errorCode: failure.code,
        errorSummary: failure.summary,
      };
    }
  }

  async assistantConfiguration() {
    return this.repository.assistantConfiguration();
  }

  async listTasks(filters = {}) {
    const readiness = await this.requireTaskPersistence();
    const run = await this.requirePublishedRun();
    return {
      run,
      readiness,
      ...(await this.repository.listFocusItems({
        ...filters,
        activeOnly: filters.activeOnly !== false,
      })),
    };
  }

  async taskDetail(id) {
    await this.requireTaskPersistence();
    const item = await this.repository.focusItemById(boundedText(id, "任务 ID", { max: 80 }));
    if (!item) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_NOT_FOUND",
        404,
        "运营任务不存在。",
      );
    }
    return {
      item,
      events: await this.repository.focusItemEvents(item.id),
    };
  }

  async transitionTask(id, input = {}, { actorLabel = "local_session" } = {}) {
    await this.requireTaskPersistence();
    const taskId = boundedText(id, "任务 ID", { max: 80 });
    const toStatus = taskStatus(input.status);
    const allowedFrom = Object.entries(TASK_TRANSITIONS)
      .filter(([, targets]) => targets.includes(toStatus))
      .map(([from]) => from);
    const reasonRequired = ["BLOCKED", "RESOLVED", "DISMISSED"].includes(toStatus);
    const reasonCode = boundedText(
      input.reasonCode || (reasonRequired ? "" : `MANUAL_${toStatus}`),
      "任务原因",
      { required: reasonRequired, max: 100 },
    );
    const dueAt = isoDate(input.dueAt, "到期时间");
    const snoozedUntil = isoDate(input.snoozedUntil, "复核时间");
    if (toStatus === "MONITORING" && !dueAt && !snoozedUntil) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_SCHEDULE_INVALID",
        400,
        "进入观察状态时必须设置到期时间或复核时间。",
      );
    }
    const result = await this.repository.transitionFocusItem({
      id: taskId,
      expectedRevision: taskRevision(input.expectedRevision),
      allowedFrom,
      toStatus,
      eventType: TASK_EVENT_BY_STATUS[toStatus],
      actor: boundedText(actorLabel, "操作人", { max: 128 }),
      reasonCode,
      note: boundedText(input.note, "任务备注", { required: false, max: 1000 }),
      dueAt,
      snoozedUntil,
      evidence: input.evidence && typeof input.evidence === "object" ? input.evidence : {},
      idempotencyKey: taskIdempotencyKey(input.idempotencyKey),
      at: this.now().toISOString(),
    });
    return this.taskMutationResult(result);
  }

  async assignTask(id, input = {}, { actorLabel = "local_session" } = {}) {
    await this.requireTaskPersistence();
    const result = await this.repository.assignFocusItem({
      id: boundedText(id, "任务 ID", { max: 80 }),
      ownerUserId: boundedText(input.ownerUserId, "店长", { max: 128 }),
      expectedRevision: taskRevision(input.expectedRevision),
      actor: boundedText(actorLabel, "操作人", { max: 128 }),
      reasonCode: boundedText(input.reasonCode || "MANUAL_ASSIGNMENT", "分配原因", { max: 100 }),
      note: boundedText(input.note, "分配备注", { required: false, max: 1000 }),
      idempotencyKey: taskIdempotencyKey(input.idempotencyKey),
      at: this.now().toISOString(),
    });
    return this.taskMutationResult(result);
  }

  async scheduleTask(id, input = {}, { actorLabel = "local_session" } = {}) {
    await this.requireTaskPersistence();
    const dueAt = isoDate(input.dueAt, "到期时间");
    const snoozedUntil = isoDate(input.snoozedUntil, "复核时间");
    if (!dueAt && !snoozedUntil) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_SCHEDULE_INVALID",
        400,
        "必须设置到期时间或复核时间。",
      );
    }
    const result = await this.repository.scheduleFocusItem({
      id: boundedText(id, "任务 ID", { max: 80 }),
      dueAt,
      snoozedUntil,
      expectedRevision: taskRevision(input.expectedRevision),
      actor: boundedText(actorLabel, "操作人", { max: 128 }),
      reasonCode: boundedText(input.reasonCode || "MANUAL_SCHEDULE", "计划原因", { max: 100 }),
      note: boundedText(input.note, "计划备注", { required: false, max: 1000 }),
      idempotencyKey: taskIdempotencyKey(input.idempotencyKey),
      at: this.now().toISOString(),
    });
    return this.taskMutationResult(result);
  }

  taskMutationResult(result) {
    if (result?.notFound) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_NOT_FOUND",
        404,
        "运营任务不存在。",
      );
    }
    if (result?.conflict) {
      const error = new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_REVISION_CONFLICT",
        409,
        "任务已被其他操作更新，请刷新后重试。",
      );
      error.currentItem = result.item || null;
      throw error;
    }
    if (result?.invalidTransition) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_TASK_TRANSITION_INVALID",
        409,
        "任务状态已经变化，请刷新后重试。",
      );
    }
    return result;
  }

  async configuration() {
    const [configuration, latestPublished] = await Promise.all([
      this.repository.configurationSnapshot(),
      this.repository.latestPublishedRun(),
    ]);
    return {
      ...configuration,
      metricsContractVersion: METRICS_CONTRACT_VERSION,
      pendingAnalysisRefresh: Boolean(
        latestPublished && (
          latestPublished.countryMappingSetId !== configuration.activeCountryMappingSet?.id
          || latestPublished.ruleSetId !== configuration.activeRuleSet?.id
        )
      ),
      publishedConfiguration: latestPublished ? {
        analysisRunId: latestPublished.id,
        countryMappingSetId: latestPublished.countryMappingSetId,
        ruleSetId: latestPublished.ruleSetId,
        publishedAt: latestPublished.publishedAt,
      } : null,
    };
  }

  async saveCountryMappings(input = {}, { actorLabel = "local_session" } = {}) {
    const at = this.now().toISOString();
    const actor = boundedText(actorLabel, "操作人", { max: 128 });
    const mappings = normalizeCountryMappings(input.mappings);
    const content = { sourceSystem: "mabang_inventory", mappings };
    const contentSha256 = fingerprint(content);
    const result = await this.repository.saveCountryMappingSet({
      id: randomUUID(),
      version: configurationVersion("GRV2-COUNTRY", at, contentSha256),
      description: boundedText(input.description || "用户维护的仓库国家映射", "配置说明", { max: 240 }),
      contentSha256,
      mappings,
      actor,
      at,
    });
    return { ...result, pendingAnalysisRefresh: true };
  }

  async saveRuleSet(input = {}, { actorLabel = "local_session" } = {}) {
    const at = this.now().toISOString();
    const actor = boundedText(actorLabel, "操作人", { max: 128 });
    const activeRuleSet = await this.repository.activeRuleSet();
    if (!activeRuleSet || activeRuleSet.metrics_contract_version !== METRICS_CONTRACT_VERSION) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_RULE_SET_VERSION_MISMATCH",
        409,
        `Active rule set must use ${METRICS_CONTRACT_VERSION}.`,
      );
    }
    const parameters = normalizeRuleParameters(input, activeRuleSet.parameters);
    const contentSha256 = fingerprint(parameters);
    const result = await this.repository.saveRuleSet({
      id: randomUUID(),
      version: configurationVersion("GRV2-RULES", at, contentSha256),
      metricsContractVersion: METRICS_CONTRACT_VERSION,
      parameters,
      contentSha256,
      actor,
      at,
    });
    return { ...result, pendingAnalysisRefresh: true };
  }

  async listAssortment(filters = {}) {
    const run = await this.requirePublishedRun();
    return { run, ...(await this.repository.listAssortment(run.id, filters)) };
  }

  async listSignals(filters = {}) {
    const run = await this.requirePublishedRun();
    return { run, ...(await this.repository.listSignals(run.id, filters)) };
  }

  async listStores(filters = {}) {
    const run = await this.requirePublishedRun();
    return { run, ...(await this.repository.listStores(run.id, filters)) };
  }

  async storeDetail(shopId, filters = {}) {
    const run = await this.requirePublishedRun();
    const detail = await this.repository.storeDetail(run.id, shopId, filters);
    if (!detail) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_STORE_NOT_FOUND",
        404,
        "The requested store is not present in the latest published analysis.",
      );
    }
    return { run, ...detail };
  }

  async skuDetail(sku) {
    const run = await this.requirePublishedRun();
    const detail = await this.repository.skuDetail(run.id, normalizedSku(sku));
    if (!detail) {
      throw new GrowthRadarV2Error(
        "GROWTH_RADAR_V2_SKU_NOT_FOUND",
        404,
        "The requested SKU is not present in the latest published analysis.",
      );
    }
    return { run, ...detail };
  }
}

export const growthRadarV2ServiceInternals = Object.freeze({
  fingerprint,
  shanghaiDate,
  normalizeCountryMappings,
  normalizeRuleParameters,
});
