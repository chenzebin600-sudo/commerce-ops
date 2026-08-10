import { createHash } from "node:crypto";
import { buildSalesAssortmentAnalysisSnapshot } from "./sales-assortment-ai-service.mjs";

export const DAILY_REPORT_EVIDENCE_PACK_VERSION = "SALES-ASSORTMENT-EVIDENCE-PACK-2.1.0";
export const DAILY_REPORT_EVIDENCE_PACK_MAX_BYTES = 240 * 1024;

const PRIORITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2, P3: 3 });

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function text(value, maximum = 160) {
  return String(value ?? "").trim().slice(0, maximum);
}

function boundedProjection(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return text(value, 240);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (depth >= 5) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => boundedProjection(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50).map(([key, entry]) => [
        text(key, 120),
        boundedProjection(entry, depth + 1),
      ]),
    );
  }
  return null;
}

function list(value, maximum) {
  return Array.isArray(value) ? value.slice(0, maximum) : [];
}

function source(value) {
  if (!value) return null;
  return {
    filename: text(value.filename, 180) || null,
    rows: number(value.rows),
    collectedAt: text(value.collectedAt, 40) || null,
  };
}

function priority(value) {
  const normalized = text(value, 2).toUpperCase();
  return normalized in PRIORITY_ORDER ? normalized : "P3";
}

function compareImpact(a, b) {
  return (PRIORITY_ORDER[priority(a.priority)] - PRIORITY_ORDER[priority(b.priority)])
    || number(b.impactAmount) - number(a.impactAmount)
    || Math.abs(number(b.changeRate)) - Math.abs(number(a.changeRate))
    || text(a.objectName).localeCompare(text(b.objectName), "zh-CN");
}

function storeEvidence(item, direction) {
  const currentAmount = number(item.current7dAmount ?? item.currentAmount);
  const previousAmount = number(item.previous7dAmount ?? item.previousAmount);
  const amountChange = nullableNumber(item.amountChange) ?? currentAmount - previousAmount;
  return {
    objectType: "store",
    objectName: text(item.store, 120),
    country: text(item.country, 80),
    platform: text(item.platform, 40),
    manager: text(item.manager, 80),
    direction,
    priority: priority(item.priority),
    currentAmount,
    previousAmount,
    amountChange,
    changeRate: nullableNumber(item.changeRate),
    impactAmount: number(item.impactAmount || Math.abs(amountChange)),
  };
}

function productEvidence(item) {
  const currentAmount = number(item.current7dAmount ?? item.currentAmount);
  const previousAmount = number(item.previous7dAmount ?? item.previousAmount);
  const amountChange = nullableNumber(item.amountChange) ?? currentAmount - previousAmount;
  return {
    objectType: "product",
    objectName: text(item.productName, 160),
    mainSku: text(item.mainSku, 80),
    country: text(item.country, 80),
    categoryL1: text(item.categoryL1, 100),
    direction: text(item.trendStatus, 40)
      || (amountChange < 0 ? "decline" : amountChange > 0 ? "growth" : "stable"),
    priority: priority(item.priority),
    currentAmount,
    previousAmount,
    amountChange,
    changeRate: nullableNumber(item.changeRate),
    impactAmount: number(item.impactAmount || Math.abs(amountChange)),
    currentRank: nullableNumber(item.current7dRank),
    previousRank: nullableNumber(item.previous7dRank),
    rankChange: nullableNumber(item.rankChange),
  };
}

function styleEvidence(item, direction) {
  const currentQuantity = number(item.currentQuantity);
  const previousQuantity = number(item.previousQuantity);
  const quantityChange = nullableNumber(item.quantityChange) ?? currentQuantity - previousQuantity;
  return {
    objectType: "style",
    objectName: text(item.style, 140),
    country: text(item.country, 80),
    categoryL1: text(item.categoryL1, 100),
    categoryL2: text(item.categoryL2, 100),
    direction,
    priority: priority(item.priority),
    currentQuantity,
    previousQuantity,
    quantityChange,
    changeRate: nullableNumber(item.changeRate),
    impactAmount: number(item.impactQuantity || Math.abs(quantityChange)),
    impactUnit: "units",
    leadingStores: list(item.storeImpacts, 3).map((store) => ({
      store: text(store.store, 120),
      manager: text(store.manager, 80),
      platform: text(store.platform, 40),
      currentQuantity: number(store.currentQuantity),
      previousQuantity: number(store.previousQuantity),
      quantityChange: number(store.quantityChange),
      changeRate: nullableNumber(store.changeRate),
    })),
  };
}

function inventoryEvidence(item) {
  const assortmentAmount = number(item.assortmentAmount);
  const ownAmount = number(item.ownAmount);
  const inventoryValue = number(item.inventoryValue);
  return {
    objectType: "inventory",
    objectName: text(item.productName, 160),
    country: text(item.country, 80),
    style: text(item.style, 140),
    riskType: text(item.type, 40),
    priority: priority(item.priority),
    availableQuantity: number(item.availableQuantity),
    inventoryChange: nullableNumber(item.inventoryChange),
    inventoryChangeRate: nullableNumber(item.inventoryChangeRate),
    daysOfSupply: number(item.daysOfSupply),
    predictedDailySales: number(item.predictedDailySales),
    ownDailySales: number(item.ownDailySales),
    assortmentAmount,
    ownAmount,
    inventoryValue,
    impactAmount: Math.max(assortmentAmount, ownAmount, inventoryValue),
    lastInboundAt: text(item.lastInboundAt, 40) || null,
    deterministicAction: text(item.action, 240),
  };
}

function opportunityEvidence(item) {
  return {
    objectType: "opportunity",
    objectName: text(item.style, 140),
    country: text(item.country, 80),
    categoryL1: text(item.categoryL1, 100),
    categoryL2: text(item.categoryL2, 100),
    priority: number(item.opportunityAmount) >= 10000 ? "P1" : "P2",
    assortmentAmount: number(item.assortmentAmount),
    assortmentDailySales: number(item.assortmentDailySales),
    ownDailySales: number(item.ownDailySales),
    ownDailySalesShare: number(item.ownDailySalesShare),
    availableQuantity: number(item.availableQuantity),
    inventoryValue: number(item.inventoryValue),
    opportunityAmount: number(item.opportunityAmount),
    impactAmount: number(item.opportunityAmount),
    leadingProducts: list(item.leadingProducts, 3).map((product) => ({
      productName: text(product.productName, 160),
      assortmentAmount: number(product.assortmentAmount),
      ownAmount: number(product.ownAmount),
      ownDailySalesShare: number(product.ownDailySalesShare),
      availableQuantity: number(product.availableQuantity),
      opportunityAmount: number(product.opportunityAmount),
    })),
  };
}

function alertEvidence(item) {
  return {
    objectType: text(item.type, 60),
    objectName: text(item.entityName, 160),
    priority: priority(item.priority),
    title: text(item.title, 180),
    dataChange: `${text(item.metricLabel, 80)}: ${text(item.metricValue, 80)}`,
    impactAmount: number(item.impactScore),
    deterministicAction: text(item.action, 240),
    evidence: list(item.evidence, 3).map((entry) => text(entry, 180)).filter(Boolean),
  };
}

function overallSevenDay(storeRows) {
  const currentAmount = storeRows.reduce((total, item) => total + number(item.current7dAmount), 0);
  const previousAmount = storeRows.reduce((total, item) => total + number(item.previous7dAmount), 0);
  const amountChange = currentAmount - previousAmount;
  return {
    currentAmount,
    previousAmount,
    amountChange,
    changeRate: previousAmount > 0 ? Math.round((amountChange / previousAmount) * 1000) / 10 : null,
    impactAmount: Math.abs(amountChange),
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function evidencePackError(message, code) {
  return Object.assign(new Error(message), { code });
}

export function dailyReportEvidencePackBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertDailyReportEvidencePack(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw evidencePackError(
      "Daily report Evidence Pack must be an object",
      "DAILY_REPORT_EVIDENCE_PACK_INVALID",
    );
  }
  if (value.contract !== DAILY_REPORT_EVIDENCE_PACK_VERSION) {
    throw evidencePackError(
      "Daily report Evidence Pack contract is invalid",
      "DAILY_REPORT_EVIDENCE_PACK_VERSION_INVALID",
    );
  }
  const bytes = dailyReportEvidencePackBytes(value);
  if (bytes > DAILY_REPORT_EVIDENCE_PACK_MAX_BYTES) {
    throw evidencePackError(
      `Daily report Evidence Pack exceeds ${DAILY_REPORT_EVIDENCE_PACK_MAX_BYTES} bytes`,
      "DAILY_REPORT_EVIDENCE_PACK_TOO_LARGE",
    );
  }
  const { digest: suppliedDigest, ...unsigned } = value;
  if (!/^[a-f0-9]{64}$/.test(String(suppliedDigest || "")) || digest(unsigned) !== suppliedDigest) {
    throw evidencePackError(
      "Daily report Evidence Pack digest is invalid",
      "DAILY_REPORT_EVIDENCE_PACK_DIGEST_INVALID",
    );
  }
  return value;
}

export function buildDailyReportEvidencePack(dashboard, {
  storesPerDirection = 4,
  productsPerDirection = 4,
  stylesPerDirection = 3,
  inventoryLimit = 6,
  opportunityLimit = 6,
  alertLimit = 6,
} = {}) {
  if (!dashboard || typeof dashboard !== "object") {
    throw new TypeError("Daily report dashboard is required for the evidence pack");
  }
  const snapshot = buildSalesAssortmentAnalysisSnapshot(dashboard);
  const storeDeclines = list(snapshot.storeDeclines, 30).map((item) => storeEvidence(item, "decline"));
  const storeGrowth = list(snapshot.storeGrowth, 30).map((item) => storeEvidence(item, "growth"));
  const productRows = list(snapshot.productSalesRanking, 30).map(productEvidence);
  const productDeclines = productRows.filter((item) => item.direction === "decline");
  const productGrowth = productRows.filter((item) => ["growth", "new_activity"].includes(item.direction));
  const styleDeclines = list(snapshot.styleDeclines, 20).map((item) => styleEvidence(item, "decline"));
  const styleGrowth = list(snapshot.styleGrowth, 20).map((item) => styleEvidence(item, "growth"));
  const inventoryRisks = list(snapshot.inventoryInsights, 30).map(inventoryEvidence).sort(compareImpact);
  const opportunities = list(snapshot.businessOpportunities, 40).map(opportunityEvidence)
    .sort((a, b) => number(b.opportunityAmount) - number(a.opportunityAmount)
      || number(b.assortmentAmount) - number(a.assortmentAmount));
  const priorityAlerts = list(dashboard.priorityAlerts, 30).map(alertEvidence).sort(compareImpact);
  const pack = {
    contract: DAILY_REPORT_EVIDENCE_PACK_VERSION,
    metricContract: boundedProjection(snapshot.contract),
    reportDate: dashboard?.dailyReport?.reportDate || snapshot.period?.dateTo || null,
    selectedFilters: boundedProjection(snapshot.selectedFilters),
    period: boundedProjection(snapshot.period),
    sources: {
      order: source(snapshot.sources?.order),
      inventory: source(snapshot.sources?.inventory),
      productPackage: source(snapshot.sources?.productPackage),
    },
    quality: boundedProjection(snapshot.quality),
    operatingOverview: {
      summary: boundedProjection(snapshot.summary),
      priorityAlerts: priorityAlerts.slice(0, alertLimit),
    },
    storeAnomalies: {
      declines: storeDeclines.sort(compareImpact).slice(0, storesPerDirection),
      growth: storeGrowth.sort(compareImpact).slice(0, storesPerDirection),
    },
    productAnomalies: {
      productDeclines: productDeclines.sort(compareImpact).slice(0, productsPerDirection),
      productGrowth: productGrowth.sort(compareImpact).slice(0, productsPerDirection),
      styleDeclines: styleDeclines.sort(compareImpact).slice(0, stylesPerDirection),
      styleGrowth: styleGrowth.sort(compareImpact).slice(0, stylesPerDirection),
    },
    inventoryRisks: inventoryRisks.slice(0, inventoryLimit),
    businessOpportunities: opportunities.slice(0, opportunityLimit),
    sevenDayTrends: {
      window: boundedProjection(snapshot.dailyMovementWindows?.stores7d?.window),
      sufficient: snapshot.dailyMovementWindows?.stores7d?.sufficient !== false,
      overall: overallSevenDay(dashboard.storeSalesTrend || []),
      storeDeclines: storeDeclines.sort(compareImpact).slice(0, 3),
      storeGrowth: storeGrowth.sort(compareImpact).slice(0, 3),
      productDeclines: productDeclines.sort(compareImpact).slice(0, 3),
      productGrowth: productGrowth.sort(compareImpact).slice(0, 3),
    },
    selection: {
      method: "priority_then_absolute_business_impact",
      limits: {
        storesPerDirection,
        productsPerDirection,
        stylesPerDirection,
        inventory: inventoryLimit,
        opportunities: opportunityLimit,
        alerts: alertLimit,
      },
    },
  };
  return assertDailyReportEvidencePack(Object.freeze({ ...pack, digest: digest(pack) }));
}
