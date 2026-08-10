import { divideDecimals, multiplyDecimals, scaledToDecimal } from "./profit-money.mjs";

export const PROFIT_FX_RULE_VERSION = "PRODUCT_PACKAGE_COUNTRY_FX-1.0.0";

const DIRECTIONS = new Set(["local_per_cny", "cny_per_local", "equivalent"]);
const RELATIVE_EQUIVALENCE_TOLERANCE = 0.01;

function timestampText(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return value ? String(value) : null;
}

function normalizedCandidate(candidate) {
  const countryCode = String(candidate.countryCode || "").trim().toUpperCase();
  const direction = String(candidate.exchangeDirection || "").trim();
  const rateText = String(candidate.exchangeRate ?? "").trim();
  const rate = Number(rateText);
  if (!countryCode || !DIRECTIONS.has(direction) || !Number.isFinite(rate) || rate <= 0) return null;
  const cnyPerLocal = direction === "cny_per_local" ? rate : direction === "equivalent" ? 1 : 1 / rate;
  return {
    countryCode,
    direction,
    rate: rateText,
    cnyPerLocal,
    rowCount: Math.max(0, Number(candidate.rowCount || 0)),
    updatedAt: timestampText(candidate.updatedAt),
  };
}

function newest(values) {
  return values.map(timestampText).filter(Boolean).sort().at(-1) || null;
}

export function resolveCountryExchangeRates(candidates, countryCodes) {
  const normalized = (candidates || []).map(normalizedCandidate).filter(Boolean);
  return [...new Set((countryCodes || []).map((value) => String(value || "").trim().toUpperCase()).filter(Boolean))]
    .sort()
    .map((countryCode) => {
      const rows = normalized.filter((candidate) => candidate.countryCode === countryCode)
        .sort((left, right) => right.rowCount - left.rowCount
          || String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""))
          || left.rate.localeCompare(right.rate));
      if (!rows.length) {
        return {
          countryCode, status: "MISSING", source: "PRODUCT_PACKAGE_CURRENT", sourceField: "国家汇率",
          ruleVersion: PROFIT_FX_RULE_VERSION, rate: null, direction: null, effectiveCnyPerLocal: null,
          sourceRowCount: 0, sourceUpdatedAt: null,
        };
      }
      const primary = rows[0];
      const conflicts = rows.filter((candidate) => {
        const denominator = Math.max(Math.abs(primary.cnyPerLocal), Number.EPSILON);
        return Math.abs(candidate.cnyPerLocal - primary.cnyPerLocal) / denominator > RELATIVE_EQUIVALENCE_TOLERANCE;
      });
      const common = {
        countryCode,
        source: "PRODUCT_PACKAGE_CURRENT",
        sourceField: "国家汇率",
        ruleVersion: PROFIT_FX_RULE_VERSION,
        sourceRowCount: rows.reduce((total, row) => total + row.rowCount, 0),
        sourceUpdatedAt: newest(rows.map((row) => row.updatedAt)),
      };
      if (conflicts.length) {
        return {
          ...common, status: "AMBIGUOUS", rate: null, direction: null, effectiveCnyPerLocal: null,
        };
      }
      return {
        ...common,
        status: "MATCHED",
        rate: primary.rate,
        direction: primary.direction,
        effectiveCnyPerLocal: String(Number(primary.cnyPerLocal.toPrecision(12))),
      };
    });
}

export function convertLocalAmountToCny(value, exchangeRate) {
  if (value === null || value === undefined || value === "" || exchangeRate?.status !== "MATCHED") return null;
  if (exchangeRate.direction === "equivalent") return scaledToDecimal(multiplyDecimals(value, "1"));
  const scaled = exchangeRate.direction === "cny_per_local"
    ? multiplyDecimals(value, exchangeRate.rate)
    : divideDecimals(value, exchangeRate.rate);
  return scaledToDecimal(scaled);
}
