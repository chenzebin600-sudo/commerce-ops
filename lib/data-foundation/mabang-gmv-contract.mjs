export const MABANG_GMV_SOURCE_RULE_VERSION = "MABANG-ORDER-GMV-SOURCE-1.0.0";

function canonicalDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim().replaceAll(",", "");
  const match = text.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const integer = match[2].replace(/^0+(?=\d)/, "") || "0";
  const fraction = String(match[3] || "").replace(/0+$/, "");
  const negative = match[1] && (integer !== "0" || fraction) ? "-" : "";
  return `${negative}${integer}${fraction ? `.${fraction}` : ""}`;
}

function distinctValues(rows, field) {
  return [...new Set((rows || []).map((row) => canonicalDecimal(row?.normalized?.[field])).filter((value) => value !== null))];
}

export function projectMabangOrderGmvSource(rows = []) {
  const originals = distinctValues(rows, "originalProductAmountLocal");
  const discounts = distinctValues(rows, "discountAmountLocal");
  const conflict = originals.length > 1 || discounts.length > 1;
  const confirmed = originals.length === 1 && discounts.length === 1;
  return {
    originalProductAmountLocal: confirmed ? originals[0] : null,
    discountAmountLocal: confirmed ? discounts[0] : null,
    gmvSourceStatus: conflict ? "CONFLICT" : confirmed ? "CONFIRMED" : "MISSING",
    gmvSourceRuleVersion: MABANG_GMV_SOURCE_RULE_VERSION,
  };
}

export { canonicalDecimal as canonicalMabangDecimal };
