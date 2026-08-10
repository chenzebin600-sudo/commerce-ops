export function collectColumns(rows) {
  const columns = [];
  const seen = new Set();

  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (!seen.has(column)) {
        seen.add(column);
        columns.push(column);
      }
    }
  }

  return columns;
}

function serializeCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializeCsv(rows) {
  const columns = collectColumns(rows);
  const lines = [columns.map(serializeCell).join(",")];

  for (const row of rows) {
    lines.push(columns.map((column) => serializeCell(row[column])).join(","));
  }

  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function downloadCsv(rows, filename, browserApi = globalThis) {
  if (!rows.length) {
    throw new Error("没有可导出的数据");
  }

  const blob = new browserApi.Blob([serializeCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = browserApi.URL.createObjectURL(blob);
  const anchor = browserApi.document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  browserApi.URL.revokeObjectURL(url);
}
