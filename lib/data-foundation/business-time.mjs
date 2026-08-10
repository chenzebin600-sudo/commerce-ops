export const COMMERCE_BUSINESS_TIME_ZONE = "Asia/Shanghai";

function parseInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const source = String(value ?? "").trim();
  if (!source) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return { dateOnly: source };
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(source);
  const normalized = source.includes("T") ? source : source.replace(" ", "T");
  const parsed = new Date(hasZone ? normalized : `${normalized}+08:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function commerceBusinessDate(value, timeZone = COMMERCE_BUSINESS_TIME_ZONE) {
  const instant = parseInstant(value);
  if (!instant) return null;
  if (instant.dateOnly) return instant.dateOnly;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
