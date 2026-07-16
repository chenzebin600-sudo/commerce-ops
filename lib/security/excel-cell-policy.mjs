export const EXCEL_CELL_ERROR_CODE = "EXCEL_CELL_UNSAFE";

const LEADING_EXCEL_WHITESPACE = /^[\s\u00a0\u1680\u180e\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*/u;
const NEGATIVE_NUMBER_TEXT = /^-(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?%?$/i;
const SAFE_FRAGMENT = Symbol("safe-excel-html-fragment");

export class ExcelCellPolicyError extends Error {
  constructor(message = "Excel cell content could not be made safe.") {
    super(message);
    this.name = "ExcelCellPolicyError";
    this.code = EXCEL_CELL_ERROR_CODE;
  }
}

function formulaCandidate(value) {
  const text = String(value);
  const offset = text.match(LEADING_EXCEL_WHITESPACE)?.[0].length || 0;
  const candidate = text.slice(offset);
  if (!candidate || candidate.startsWith("'")) return null;
  return candidate;
}

export function isUnsafeExcelText(value) {
  if (typeof value !== "string") return false;
  const candidate = formulaCandidate(value);
  if (!candidate) return false;
  const prefix = candidate[0];
  if (prefix === "=" || prefix === "+" || prefix === "@") return true;
  return prefix === "-" && !NEGATIVE_NUMBER_TEXT.test(candidate);
}

export function sanitizeExcelText(value, { trustedFormula = false, onSanitized } = {}) {
  if (typeof value !== "string" || trustedFormula || !isUnsafeExcelText(value)) return value;
  if (onSanitized !== undefined && typeof onSanitized !== "function") throw new ExcelCellPolicyError();
  onSanitized?.();
  return `'${value}`;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function excelHtmlText(value, options) {
  return escapeHtml(sanitizeExcelText(value, options));
}

export function normalizedSanitizationCounts(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const count = Number(item?.count || 0);
    if (!Number.isSafeInteger(count) || count <= 0) return [];
    const sheet = String(item?.sheet || "unknown").replace(/[\r\n\t]/g, " ").slice(0, 31) || "unknown";
    return [{ sheet, count }];
  });
}

function isAllowedExportHref(value) {
  const text = String(value || "").trim();
  if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(text)) return true;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function safeFragment(html) {
  return Object.freeze({ [SAFE_FRAGMENT]: true, html });
}

export function createExcelHtmlRenderer() {
  let sanitizedCount = 0;
  const options = { onSanitized: () => { sanitizedCount += 1; } };
  const text = (value) => safeFragment(excelHtmlText(value, options));
  const link = (url, label) => {
    if (!url) return safeFragment("");
    const visibleText = label || url;
    if (!isAllowedExportHref(url)) return text(visibleText);
    return safeFragment(`<a href="${escapeHtml(url)}">${excelHtmlText(visibleText, options)}</a>`);
  };
  const render = (value) => value?.[SAFE_FRAGMENT] === true ? value.html : excelHtmlText(value, options);
  const table = (title, headers, rows) => `
    <h2>${excelHtmlText(title, options)}</h2>
    <table>
      <tr>${headers.map((header) => `<th>${excelHtmlText(header, options)}</th>`).join("")}</tr>
      ${rows.map((row) => `<tr>${row.map((cell) => `<td>${render(cell)}</td>`).join("")}</tr>`).join("")}
    </table>
  `;
  return Object.freeze({
    text,
    link,
    table,
    get sanitizedCount() {
      return sanitizedCount;
    },
  });
}
