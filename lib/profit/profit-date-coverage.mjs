const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value, label = "date") {
  const normalized = String(value || "").trim();
  if (!DATE_PATTERN.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new TypeError(`${label} must be a YYYY-MM-DD date`);
  }
  return normalized;
}

export function addDateDays(value, offset) {
  const date = new Date(`${assertDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(offset || 0));
  return date.toISOString().slice(0, 10);
}

export function inclusiveDateCount(dateFrom, dateTo) {
  const start = assertDate(dateFrom, "dateFrom");
  const end = assertDate(dateTo, "dateTo");
  if (start > end) throw new TypeError("dateFrom must not be after dateTo");
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export function businessDate(value = new Date(), timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const record = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

export function defaultProfitRange(value = new Date()) {
  const dateTo = addDateDays(businessDate(value), -1);
  return { dateFrom: addDateDays(dateTo, -6), dateTo };
}

export function mergeDateRanges(ranges = []) {
  const normalized = ranges
    .map((range) => ({
      dateFrom: assertDate(range.dateFrom, "dateFrom"),
      dateTo: assertDate(range.dateTo, "dateTo"),
    }))
    .filter((range) => range.dateFrom <= range.dateTo)
    .sort((left, right) => left.dateFrom.localeCompare(right.dateFrom) || left.dateTo.localeCompare(right.dateTo));
  const merged = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (!previous || range.dateFrom > addDateDays(previous.dateTo, 1)) {
      merged.push({ ...range });
      continue;
    }
    if (range.dateTo > previous.dateTo) previous.dateTo = range.dateTo;
  }
  return merged;
}

export function missingDateRanges({ dateFrom, dateTo, coveredRanges = [] }) {
  const start = assertDate(dateFrom, "dateFrom");
  const end = assertDate(dateTo, "dateTo");
  if (start > end) throw new TypeError("dateFrom must not be after dateTo");
  const covered = mergeDateRanges(coveredRanges
    .map((range) => ({ dateFrom: range.dateFrom < start ? start : range.dateFrom, dateTo: range.dateTo > end ? end : range.dateTo }))
    .filter((range) => range.dateFrom <= range.dateTo));
  const missing = [];
  let cursor = start;
  for (const range of covered) {
    if (range.dateFrom > cursor) missing.push({ dateFrom: cursor, dateTo: addDateDays(range.dateFrom, -1) });
    cursor = addDateDays(range.dateTo, 1);
    if (cursor > end) break;
  }
  if (cursor <= end) missing.push({ dateFrom: cursor, dateTo: end });
  return missing;
}

export function buildFinanceCoverage({ shops = [], windows = [], dateFrom, dateTo }) {
  const days = inclusiveDateCount(dateFrom, dateTo);
  const windowsByShop = new Map();
  for (const window of windows) {
    const shopId = String(window.connectorShopId || "").trim();
    if (!shopId) continue;
    if (!windowsByShop.has(shopId)) windowsByShop.set(shopId, []);
    windowsByShop.get(shopId).push(window);
  }
  const missingByShop = new Map();
  let coveredShopDays = 0;
  let coveredShopCount = 0;
  let availableDateFrom = null;
  let availableDateTo = null;
  let latestCoverageAt = null;
  for (const window of windows) {
    if (!availableDateFrom || window.dateFrom < availableDateFrom) availableDateFrom = window.dateFrom;
    if (!availableDateTo || window.dateTo > availableDateTo) availableDateTo = window.dateTo;
    if (window.completedAt && (!latestCoverageAt || String(window.completedAt) > latestCoverageAt)) {
      latestCoverageAt = String(window.completedAt);
    }
  }
  for (const shop of shops) {
    const shopId = String(shop.id || shop.connectorShopId || "").trim();
    const missing = missingDateRanges({ dateFrom, dateTo, coveredRanges: windowsByShop.get(shopId) || [] });
    missingByShop.set(shopId, missing);
    const missingDays = missing.reduce((total, range) => total + inclusiveDateCount(range.dateFrom, range.dateTo), 0);
    coveredShopDays += days - missingDays;
    if (!missingDays) coveredShopCount += 1;
  }
  const totalShopDays = shops.length * days;
  const missingShopDays = totalShopDays - coveredShopDays;
  return {
    status: missingShopDays === 0 ? "COVERED" : coveredShopDays === 0 ? "UNCOVERED" : "PARTIAL",
    dateFrom,
    dateTo,
    dayCount: days,
    totalShopCount: shops.length,
    coveredShopCount,
    missingShopCount: shops.length - coveredShopCount,
    totalShopDays,
    coveredShopDays,
    missingShopDays,
    availableDateFrom,
    availableDateTo,
    latestCoverageAt,
    missingByShop,
  };
}

export function publicFinanceCoverage(coverage, source = "RUN_COVERAGE") {
  const { missingByShop, ...summary } = coverage;
  return { ...summary, source };
}
