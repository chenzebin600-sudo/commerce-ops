const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

function dateError() {
  return Object.assign(new Error("利润日期范围无效。"), { code: "PROFIT_DATE_RANGE_INVALID", status: 400 });
}

function isoDate(value) {
  if (typeof value === "string" && DATE_PATTERN.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw dateError();
  return date.toISOString().slice(0, 10);
}

function utcDate(value) {
  const text = isoDate(value);
  return new Date(`${text}T00:00:00Z`);
}

function addDays(value, amount) {
  return new Date(utcDate(value).getTime() + Number(amount) * DAY_MS).toISOString().slice(0, 10);
}

function optionalCutoff(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  if (!DATE_PATTERN.test(normalized)) throw dateError();
  return normalized;
}

function monthParts(value, offset = 0) {
  const date = utcDate(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
}

function monthBounds(value, offset = 0) {
  const first = monthParts(value, offset);
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  return {
    month: first.toISOString().slice(0, 7),
    dateFrom: first.toISOString().slice(0, 10),
    dateTo: new Date(next.getTime() - DAY_MS).toISOString().slice(0, 10),
  };
}

function shopeeMonth(value, offset = 0) {
  return monthBounds(value, offset);
}

function lazadaCompleteWeeks(value, offset = 0) {
  const month = monthBounds(value, offset);
  const first = utcDate(month.dateFrom);
  const last = utcDate(month.dateTo);
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const sundayOffset = last.getUTCDay();
  return {
    month: month.month,
    dateFrom: addDays(month.dateFrom, -mondayOffset),
    dateTo: addDays(month.dateTo, -sundayOffset),
  };
}

function shanghaiBusinessDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${record.year}-${record.month}-${record.day}`;
}

export function resolveProfitBillingPeriod({
  platform,
  preset = "CURRENT_BILLING_PERIOD",
  referenceDate = new Date(),
  dateFrom,
  dateTo,
  transactionCutoffDate = null,
} = {}) {
  const normalizedPlatform = String(platform || "").trim().toUpperCase();
  const normalizedPreset = String(preset || "CURRENT_BILLING_PERIOD").trim().toUpperCase();
  if (!new Set(["LAZADA", "SHOPEE"]).has(normalizedPlatform)) throw dateError();
  let period;
  if (normalizedPreset === "CUSTOM") {
    if (!DATE_PATTERN.test(String(dateFrom || "")) || !DATE_PATTERN.test(String(dateTo || "")) || dateFrom > dateTo) throw dateError();
    period = { month: null, dateFrom, dateTo };
  } else if (new Set(["CURRENT_BILLING_PERIOD", "LAST_BILLING_PERIOD"]).has(normalizedPreset)) {
    const offset = normalizedPreset === "LAST_BILLING_PERIOD" ? -1 : 0;
    period = normalizedPlatform === "SHOPEE"
      ? shopeeMonth(referenceDate, offset)
      : lazadaCompleteWeeks(referenceDate, offset);
  } else {
    throw dateError();
  }
  const yesterday = addDays(shanghaiBusinessDate(referenceDate), -1);
  const current = normalizedPreset === "CURRENT_BILLING_PERIOD";
  const cutoff = optionalCutoff(transactionCutoffDate);
  const naturalDateTo = current && period.dateTo > yesterday ? yesterday : period.dateTo;
  const transactionDateTo = cutoff && naturalDateTo > cutoff ? cutoff : naturalDateTo;
  const transactionDateFrom = cutoff && period.dateFrom > cutoff ? cutoff : period.dateFrom;
  return {
    platform: normalizedPlatform,
    preset: normalizedPreset,
    accountingMonth: period.month,
    accountingRange: { dateFrom: period.dateFrom, dateTo: period.dateTo },
    transactionRange: {
      dateFrom: transactionDateFrom,
      dateTo: transactionDateTo < transactionDateFrom ? transactionDateFrom : transactionDateTo,
    },
    transactionCutoffDate: cutoff,
    cutoffApplied: Boolean(cutoff && naturalDateTo > cutoff),
  };
}

export function profitBillingPresets(referenceDate = new Date(), { transactionCutoffDate = null } = {}) {
  return {
    referenceDate: shanghaiBusinessDate(referenceDate),
    platforms: Object.fromEntries(["LAZADA", "SHOPEE"].map((platform) => [platform, {
      current: resolveProfitBillingPeriod({ platform, preset: "CURRENT_BILLING_PERIOD", referenceDate, transactionCutoffDate }),
      last: resolveProfitBillingPeriod({ platform, preset: "LAST_BILLING_PERIOD", referenceDate, transactionCutoffDate }),
    }])),
  };
}
