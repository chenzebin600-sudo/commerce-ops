import { decimalToScaled, percentageString } from "./profit-money.mjs";

export const PROFIT_GMV_RULE_VERSION = "MABANG-ORDER-GMV-1.1.0";

export function expenseRate(expenseValue, gmvValue) {
  if (expenseValue === null || expenseValue === undefined || gmvValue === null || gmvValue === undefined) return null;
  const denominator = decimalToScaled(gmvValue);
  if (denominator <= 0n) return null;
  return percentageString(decimalToScaled(expenseValue), denominator);
}

export function emptyGmvMetrics(expectedGmvDayCount = 0, issues = []) {
  return {
    gmvDataStatus: "PARTIAL",
    gmvValue: null,
    knownGmvValue: "0",
    gmvOrderCount: 0,
    confirmedGmvOrderCount: 0,
    missingGmvOrderCount: 0,
    conflictingGmvOrderCount: 0,
    invalidGmvOrderCount: 0,
    gmvSourceCoveredDayCount: 0,
    expectedGmvDayCount,
    gmvSourceBatchCount: 0,
    gmvMappingSources: [],
    gmvRuleVersions: [PROFIT_GMV_RULE_VERSION],
    gmvDateBasis: "MABANG_PAID_AT_ASIA_SHANGHAI",
    gmvIssues: issues,
  };
}

function withExpenseRate(row) {
  const rate = row.expenseDataStatus === "COMPLETE" && row.gmvDataStatus === "COMPLETE"
    ? expenseRate(row.expenseValue, row.gmvValue) : null;
  const gmvIssues = [...new Set([
    ...(row.gmvIssues || []),
    ...(row.gmvDataStatus === "COMPLETE" && decimalToScaled(row.gmvValue || "0") <= 0n
      ? ["GMV_DENOMINATOR_NOT_POSITIVE"] : []),
  ])];
  return {
    ...row,
    expenseRate: rate,
    expenseRateDataStatus: rate === null ? "PARTIAL" : "COMPLETE",
    gmvIssues,
  };
}

export async function decorateGmvResults({ repository, platform, results = [], shops = [], range }) {
  const expected = Math.round((Date.parse(`${range.dateTo}T00:00:00Z`) - Date.parse(`${range.dateFrom}T00:00:00Z`)) / 86_400_000) + 1;
  const unavailable = (issues) => results.map((row) => withExpenseRate({ ...row, ...emptyGmvMetrics(expected, issues) }));
  if (typeof repository?.gmvAggregatesForRange !== "function") return unavailable(["GMV_REPOSITORY_UNAVAILABLE"]);
  if (typeof repository.isGmvReady === "function" && !await repository.isGmvReady()) {
    return unavailable(["PROFIT_GMV_MIGRATION_REQUIRED"]);
  }
  const metadataByConnector = new Map((shops || []).map((shop) => [String(shop.id || shop.connectorShopId), shop]));
  const resultByConnector = new Map(results.map((row) => [String(row.connectorShopId), row]));
  const targetIds = [...new Set([...metadataByConnector.keys(), ...resultByConnector.keys()])];
  const targets = targetIds.map((connectorShopId) => {
    const row = resultByConnector.get(connectorShopId) || {};
    const shop = metadataByConnector.get(connectorShopId) || {};
    return {
      connectorShopId,
      canonicalShopId: shop.directoryShopId || row.canonicalShopId || null,
      growthShopId: shop.growthShopId || null,
      normalizedShopName: shop.normalizedShopName || null,
      shopName: shop.shopName || row.shopName,
    };
  });
  const aggregates = await repository.gmvAggregatesForRange({ platform, shops: targets, ...range });
  const byShop = new Map(aggregates.map((row) => [row.connectorShopId, row]));
  return results.map((row) => withExpenseRate({
    ...row,
    ...(byShop.get(row.connectorShopId) || emptyGmvMetrics(expected, ["GMV_SHOP_MAPPING_UNAVAILABLE"])),
  }));
}
