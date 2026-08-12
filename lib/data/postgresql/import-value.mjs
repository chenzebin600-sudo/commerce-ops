function legacyTimestamp(value, { table, column }) {
  const text = String(value);
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return value;
  if (table !== "advertising_source_batches" || column !== "report_created_at") {
    throw new TypeError(`Unexpected legacy timestamp: ${table}.${column}`);
  }
  return `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:${match[6] || "00"}Z`;
}

function postgresqlSafeJson(value) {
  if (typeof value === "string") return value.replaceAll("\u0000", "\\u0000");
  if (Array.isArray(value)) return value.map(postgresqlSafeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, postgresqlSafeJson(item)]));
  }
  return value;
}

export function encodeImportedPostgresqlValue(value, column) {
  if (value === null || value === undefined) return null;
  switch (column.data_type) {
    case "boolean":
      if (value === true || value === 1 || value === "1") return true;
      if (value === false || value === 0 || value === "0") return false;
      throw new TypeError(`Invalid boolean: ${column.table}.${column.column}`);
    case "json":
    case "jsonb":
      return JSON.stringify(postgresqlSafeJson(typeof value === "string" ? JSON.parse(value) : value));
    case "timestamp with time zone":
      return legacyTimestamp(value, column);
    case "integer":
    case "smallint":
    case "bigint": {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new TypeError(`Invalid integer: ${column.table}.${column.column}`);
      return number;
    }
    case "double precision":
    case "real":
    case "numeric": {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new TypeError(`Invalid number: ${column.table}.${column.column}`);
      return number;
    }
    default:
      return value;
  }
}
