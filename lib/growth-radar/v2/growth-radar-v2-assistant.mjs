export const SUPER_MANAGER_CONTRACT_VERSION = "GRV2-SUPER-MANAGER-2.2";

const PRIORITY_ORDER = Object.freeze({
  P0: 4,
  P1: 3,
  P2: 2,
  P3: 1,
});

const STORE_STATE_ORDER = Object.freeze({
  BLOCKED: 4,
  ACTION_REQUIRED: 3,
  WATCH: 2,
  STABLE: 1,
});

export const TASK_LIFECYCLE = Object.freeze([
  "NEW",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "MONITORING",
  "RESOLVED",
  "BLOCKED",
  "DISMISSED",
  "REOPENED",
]);

function finite(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function ratio(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function taskKey(parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && String(part).trim())
    .map((part) => String(part).trim().replace(/[^0-9A-Za-z_-]+/g, "-"))
    .join(":")
    .slice(0, 240);
}

function task(input) {
  return {
    id: taskKey([
      input.type,
      input.managerId || "unassigned",
      input.storeId || "all",
      input.countryCode || "all",
      input.normalizedWarehouseName || "all",
      input.sku || "all",
    ]),
    status: "NEW",
    persisted: false,
    ...input,
  };
}

function storeState(store) {
  if (store.availabilityStatus !== "available" || store.qualityStatus === "blocked") {
    return "BLOCKED";
  }
  if (
    finite(store.supplyConstrainedCount)
    + finite(store.priorityGrowthCount)
    + finite(store.quietEntryCount) > 0
  ) {
    return "ACTION_REQUIRED";
  }
  if (store.anomalyCode !== "STABLE" || finite(store.growthFocusCount) > 0) {
    return "WATCH";
  }
  return "STABLE";
}

function taskSort(left, right) {
  return (
    (PRIORITY_ORDER[right.priority] || 0) - (PRIORITY_ORDER[left.priority] || 0)
    || finite(right.evidence?.sourcePredictedDailySales)
      - finite(left.evidence?.sourcePredictedDailySales)
    || left.id.localeCompare(right.id)
  );
}

function salesTrend(currentValue, previousValue, historyAvailable) {
  const current7d = finite(currentValue);
  const previous7d = finite(previousValue);
  if (!historyAvailable) {
    return {
      status: "INSUFFICIENT_HISTORY",
      current7d,
      previous7d: null,
      changeRate: null,
      dateSemantic: "valid_order_paid_at",
    };
  }
  if (previous7d === 0 && current7d > 0) {
    return {
      status: "NEWLY_SELLING",
      current7d,
      previous7d,
      changeRate: null,
      dateSemantic: "valid_order_paid_at",
    };
  }
  const changeRate = previous7d > 0 ? (current7d - previous7d) / previous7d : 0;
  return {
    status: current7d > previous7d
      ? "GROWING"
      : current7d < previous7d
        ? "DECLINING"
        : "STABLE",
    current7d,
    previous7d,
    changeRate,
    dateSemantic: "valid_order_paid_at",
  };
}

function storeTasks(store) {
  const tasks = [];
  const managerId = store.ownerUserId || null;
  const shared = {
    managerId,
    storeId: store.shopId,
    storeName: store.displayName,
    countryCode: store.countryCode,
    platform: store.platform,
    ruleVersion: store.metricsVersion || null,
    readOnly: true,
  };

  if (store.availabilityStatus !== "available" || store.qualityStatus === "blocked") {
    tasks.push(task({
      ...shared,
      type: "DATA_BLOCKED",
      priority: "P0",
      title: `补齐 ${store.displayName} 的分析数据`,
      reason: "店铺数据或国家映射未达到确定性分析条件。",
      recommendedAction: "先完成配置或数据修复，再生成经营建议。",
      evidence: {
        availabilityStatus: store.availabilityStatus,
        qualityStatus: store.qualityStatus,
        reasonCode: store.reasonCode,
      },
    }));
    return tasks;
  }

  if (finite(store.supplyConstrainedCount) > 0) {
    tasks.push(task({
      ...shared,
      type: "INVENTORY_RISK",
      priority: "P1",
      title: `处理 ${store.displayName} 的供给受限 SKU`,
      reason: `${finite(store.supplyConstrainedCount)} 个高表现货盘 SKU 存在库存约束。`,
      recommendedAction: "核对可用库存、在途量和可售天数后制定补货计划。",
      evidence: {
        supplyConstrainedCount: finite(store.supplyConstrainedCount),
        ownSalesQuantity28d: finite(store.ownSalesQuantity28d),
      },
    }));
  }

  if (finite(store.priorityGrowthCount) > 0) {
    tasks.push(task({
      ...shared,
      type: "GROWTH_OPPORTUNITY",
      priority: "P1",
      title: `复核 ${store.displayName} 的增长跟进款`,
      reason: `${finite(store.priorityGrowthCount)} 个高表现货盘 SKU 的我方承接偏低。`,
      recommendedAction: "核查在线状态与历史动作后，选择优先级最高的 SKU 做小范围运营测试。",
      evidence: {
        priorityGrowthCount: finite(store.priorityGrowthCount),
        highPerformanceCoverageRate28d: ratio(store.highPerformanceCoverageRate28d),
        ownSalesQuantity28d: finite(store.ownSalesQuantity28d),
      },
    }));
  }

  if (finite(store.quietEntryCount) > 0) {
    tasks.push(task({
      ...shared,
      type: "BLUE_OCEAN",
      priority: "P2",
      title: `核查 ${store.displayName} 的蓝海候选`,
      reason: `${finite(store.quietEntryCount)} 个市场已验证 SKU 近 28 天未观察到本店有效销售。`,
      recommendedAction: "核查在线状态后低风险测试。",
      evidence: {
        quietEntryCount: finite(store.quietEntryCount),
        saleableCoverageRate28d: ratio(store.saleableCoverageRate28d),
        evidenceBoundary: "近期无已发货订单不代表未上架",
      },
    }));
  }

  if (!tasks.length && store.anomalyCode === "NO_VALID_SALES_28D") {
    tasks.push(task({
      ...shared,
      type: "STORE_WATCH",
      priority: "P3",
      title: `观察 ${store.displayName} 的销售事实缺口`,
      reason: "近 28 天未观察到合同定义的有效订单。",
      recommendedAction: "核查订单范围、店铺映射和在线状态，不据此判断店铺未上架。",
      evidence: {
        ownSalesQuantity28d: finite(store.ownSalesQuantity28d),
        evidenceBoundary: "近期无已发货订单不代表未上架",
      },
    }));
  }

  return tasks;
}

function warehouseTasks(warehouseRisks, stores) {
  const managersByCountry = new Map();
  for (const store of stores) {
    if (!store.countryCode || !store.ownerUserId) continue;
    if (!managersByCountry.has(store.countryCode)) managersByCountry.set(store.countryCode, new Set());
    managersByCountry.get(store.countryCode).add(store.ownerUserId);
  }
  const tasks = [];
  for (const risk of warehouseRisks || []) {
    const managers = [...(managersByCountry.get(risk.countryCode) || [null])];
    const dataIssue = ["SUPPLY_DATA_CONFLICT", "SUPPLY_DATA_INSUFFICIENT"]
      .includes(risk.supplyStatus);
    const severe = risk.supplyStatus === "OUT_OF_STOCK"
      || risk.supplyStatus === "SUPPLY_DATA_CONFLICT"
      || risk.slowMovingStatus === "SLOW_MOVING_SEVERE";
    for (const managerId of managers) {
      tasks.push(task({
        type: dataIssue ? "DATA_BLOCKED" : "INVENTORY_RISK",
        priority: severe ? "P0" : "P1",
        managerId,
        storeId: null,
        storeName: null,
        countryCode: risk.countryCode,
        sourceWarehouseName: risk.sourceWarehouseName,
        normalizedWarehouseName: risk.normalizedWarehouseName,
        platform: null,
        sku: risk.sku,
        title: `处理 ${risk.normalizedWarehouseName} / ${risk.sku} 的库存信号`,
        reason: dataIssue
          ? "仓库来源库存事实存在缺失或冲突，不能生成经营动作。"
          : `仓库状态为 ${risk.supplyStatus}，滞销状态为 ${risk.slowMovingStatus}。`,
        recommendedAction: dataIssue
          ? "先核对仓库映射、可售天数和库存来源事实。"
          : (risk.supplyStatus === "IN_TRANSIT_ONLY"
            ? "到货后评估。"
            : "核对仓库级可售天数、可用库存和在途量后处理。"),
        ruleVersion: risk.metricsVersion || null,
        readOnly: true,
        evidence: {
          reasonCode: risk.reasonCode,
          countryCode: risk.countryCode,
          sourceWarehouseName: risk.sourceWarehouseName,
          normalizedWarehouseName: risk.normalizedWarehouseName,
          sku: risk.sku,
          supplyStatus: risk.supplyStatus,
          slowMovingStatus: risk.slowMovingStatus,
          sourceCurrentSellableDays: risk.sourceCurrentSellableDays,
          availableQuantity: risk.availableQuantity,
          inTransitQuantity: risk.inTransitQuantity,
          grain: "country_warehouse_sku",
        },
      }));
    }
  }
  return tasks;
}

function crossCountryTasks(products, stores) {
  const bySku = new Map();
  for (const product of products) {
    if (!bySku.has(product.sku)) bySku.set(product.sku, []);
    bySku.get(product.sku).push(product);
  }
  const managerByCountry = new Map();
  for (const store of stores) {
    if (!store.countryCode || !store.ownerUserId) continue;
    if (!managerByCountry.has(store.countryCode)) managerByCountry.set(store.countryCode, store.ownerUserId);
  }

  const tasks = [];
  for (const [sku, rows] of bySku) {
    const validated = rows.filter((row) => (
      row.directionCode === "DEFEND_WINNER"
      || row.directionCode === "PRIORITY_GROWTH"
    ));
    const candidates = rows.filter((row) => (
      row.directionCode === "QUIET_ENTRY"
      && finite(row.ownSalesQuantity28d) === 0
      && finite(row.availableQuantity) > 0
    ));
    if (!validated.length || !candidates.length) continue;
    const source = validated.sort((left, right) => (
      finite(right.sourcePredictedDailySales) - finite(left.sourcePredictedDailySales)
    ))[0];
    for (const candidate of candidates) {
      tasks.push(task({
        type: "CROSS_COUNTRY_CANDIDATE",
        priority: "P2",
        managerId: managerByCountry.get(candidate.countryCode) || null,
        storeId: null,
        storeName: null,
        countryCode: candidate.countryCode,
        platform: null,
        sku,
        title: `核查 ${sku} 的跨国候选`,
        reason: `${sku} 已在 ${source.countryName} 获得验证，但 ${candidate.countryName} 近 28 天未观察到我方有效销售。`,
        recommendedAction: "核查在线状态后低风险测试。",
        ruleVersion: null,
        readOnly: true,
        evidence: {
          validatedCountryCode: source.countryCode,
          candidateCountryCode: candidate.countryCode,
          sourcePredictedDailySales: finite(candidate.sourcePredictedDailySales),
          availableQuantity: finite(candidate.availableQuantity),
          ownSalesQuantity28d: finite(candidate.ownSalesQuantity28d),
          evidenceBoundary: "跨国候选不是自动上架或自动推广指令",
        },
      }));
    }
  }
  return tasks;
}

function limitTasksByManager(tasks, managerId, maxTasks) {
  const filtered = managerId
    ? tasks.filter((entry) => entry.managerId === managerId)
    : tasks;
  const grouped = new Map();
  for (const entry of filtered.sort(taskSort)) {
    const key = entry.managerId || "UNASSIGNED";
    if (!grouped.has(key)) grouped.set(key, []);
    if (grouped.get(key).length < maxTasks) grouped.get(key).push(entry);
  }
  return [...grouped.values()].flat().sort(taskSort);
}

function productKind(directionCode) {
  return ({
    QUIET_ENTRY: "BLUE_OCEAN",
    PRIORITY_GROWTH: "GROWTH",
    DEFEND_WINNER: "STAR",
    SUPPLY_CONSTRAINED: "SUPPLY_RISK",
  })[directionCode] || "OBSERVE";
}

export function buildAssistantWorkspace({
  run,
  overview,
  directions,
  readiness,
  managerId = null,
  maxTasks = 10,
  persistedTasks = null,
  taskPersistenceReady = false,
}) {
  const historyAvailable = readiness.historyDays >= 14;
  const stores = directions.shopComparisons.map((store) => ({
    ...store,
    state: storeState(store),
    trend: salesTrend(
      store.ownSalesQuantity7d,
      store.ownSalesQuantityPrevious7d ?? store.evidence?.ownSalesQuantityPrevious7d,
      historyAvailable,
    ),
  })).sort((left, right) => (
    STORE_STATE_ORDER[right.state] - STORE_STATE_ORDER[left.state]
    || finite(right.priorityGrowthCount) - finite(left.priorityGrowthCount)
    || left.displayName.localeCompare(right.displayName)
  ));

  const products = directions.skuDirections.map((item) => ({
    ...item,
    intelligenceType: productKind(item.directionCode),
    trend: salesTrend(
      item.ownSalesQuantity7d,
      item.ownSalesQuantityPrevious7d,
      historyAvailable,
    ),
    evidenceBoundary: "来源预测日销量是货盘验证参考，不是公司实际销量",
  }));
  const allCandidateTasks = [
    ...stores.flatMap(storeTasks),
    ...warehouseTasks(directions.warehouseRisks, stores),
    ...crossCountryTasks(products, stores),
  ].sort(taskSort);
  const scopedCandidateTasks = managerId
    ? allCandidateTasks.filter((entry) => entry.managerId === managerId)
    : allCandidateTasks;
  const taskLimit = Math.min(10, Math.max(1, Number(maxTasks) || 10));
  const publishable = Boolean(readiness.operationTasksPublishable);
  const taskSource = Array.isArray(persistedTasks) ? persistedTasks : scopedCandidateTasks;
  const operationTasks = publishable
    ? limitTasksByManager(taskSource, managerId, taskLimit)
    : [];

  return {
    contractVersion: SUPER_MANAGER_CONTRACT_VERSION,
    mode: publishable ? "published" : "readiness",
    publishable,
    generatedFromPublishedRun: true,
    taskPersistenceReady,
    taskLifecycle: [...TASK_LIFECYCLE],
    run,
    readiness,
    summary: {
      ...overview,
      actionRequiredStoreCount: stores.filter((store) => store.state === "ACTION_REQUIRED").length,
      watchStoreCount: stores.filter((store) => store.state === "WATCH").length,
      stableStoreCount: stores.filter((store) => store.state === "STABLE").length,
      blockedStoreCount: stores.filter((store) => store.state === "BLOCKED").length,
      candidateTaskCount: scopedCandidateTasks.length,
      publishedTaskCount: operationTasks.length,
    },
    operationTasks,
    candidateTasks: scopedCandidateTasks,
    stores,
    products,
    opportunityMap: directions.categoryCountry,
    managers: directions.managerComparisons,
    directionCounts: directions.directionCounts,
  };
}

export function emptyAssistantWorkspace(readiness) {
  return {
    contractVersion: SUPER_MANAGER_CONTRACT_VERSION,
    mode: "readiness",
    publishable: false,
    generatedFromPublishedRun: false,
    taskPersistenceReady: false,
    taskLifecycle: [...TASK_LIFECYCLE],
    run: null,
    readiness,
    summary: {
      actionRequiredStoreCount: 0,
      watchStoreCount: 0,
      stableStoreCount: 0,
      blockedStoreCount: finite(readiness.unmappedShopCount),
      candidateTaskCount: 0,
      publishedTaskCount: 0,
    },
    operationTasks: [],
    candidateTasks: [],
    stores: [],
    products: [],
    opportunityMap: [],
    managers: [],
    directionCounts: {
      quietEntry: 0,
      priorityGrowth: 0,
      defendWinner: 0,
      supplyConstrained: 0,
    },
  };
}

export const growthRadarV2AssistantInternals = Object.freeze({
  limitTasksByManager,
  productKind,
  storeState,
  taskSort,
  salesTrend,
});
