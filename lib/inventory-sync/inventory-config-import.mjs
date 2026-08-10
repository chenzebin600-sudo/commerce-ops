import { inflateRawSync } from "node:zlib";

const MAX_FILE_BYTES = 1024 * 1024;
const SUPPORTED_MODES = new Set(["按对应仓库匹配"]);
const COUNTRY_CODES = new Map([
  ["新加坡", "SG"], ["sg", "SG"], ["singapore", "SG"],
  ["马来", "MY"], ["马来西亚", "MY"], ["my", "MY"], ["malaysia", "MY"],
  ["泰国", "TH"], ["th", "TH"], ["thailand", "TH"],
  ["菲律宾", "PH"], ["ph", "PH"], ["philippines", "PH"],
  ["越南", "VN"], ["vn", "VN"], ["vietnam", "VN"],
  ["印尼", "ID"], ["印度尼西亚", "ID"], ["id", "ID"], ["indonesia", "ID"],
  ["台湾", "TW"], ["tw", "TW"], ["taiwan", "TW"],
]);

function text(value) {
  return String(value ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

export function normalizeInventoryConfigText(value) {
  return text(value).toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function platformName(value) {
  const normalized = normalizeInventoryConfigText(value);
  if (normalized.includes("shopee")) return "Shopee";
  if (normalized.includes("lazada")) return "Lazada";
  return text(value);
}

function countryCode(value) {
  return COUNTRY_CODES.get(normalizeInventoryConfigText(value)) || text(value).toUpperCase();
}

function splitWarehouses(value) {
  return [...new Set(text(value).split(/[，,、;；/\n\r\t]+/).map(text).filter(Boolean))];
}

function xmlText(value = "") {
  return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function columnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Z]+/i)?.[0]?.toUpperCase() || "A";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

function unzipEntries(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length > MAX_FILE_BYTES) throw new Error("配置表不能超过 1MB");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error("Excel 文件结构无效");
  const count = bytes.readUInt16LE(end + 10);
  if (count > 2000) throw new Error("Excel 文件内容过多");
  let offset = bytes.readUInt32LE(end + 16);
  let expandedSize = 0;
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Excel 文件目录损坏");
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    expandedSize += uncompressedSize;
    if (uncompressedSize > 5 * 1024 * 1024 || expandedSize > 15 * 1024 * 1024) throw new Error("Excel 文件解压后过大");
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8").replace(/\\/g, "/");
    if (bytes.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Excel 文件内容损坏");
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(start, start + compressedSize);
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
    if (content) entries.set(name, content);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function workbookSheetPaths(entries) {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8") || "";
  const relationships = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") || "";
  const targets = new Map([...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)].map((match) => {
    const id = match[1].match(/\bId="([^"]+)"/)?.[1] || "";
    const target = match[1].match(/\bTarget="([^"]+)"/)?.[1] || "";
    return [id, target];
  }).filter(([id, target]) => id && target));
  return [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/g)].map((match) => {
    const target = String(targets.get(match[2]) || "").replace(/^\//, "");
    return { name: xmlText(match[1]), path: target.startsWith("xl/") ? target : `xl/${target.replace(/^\.\//, "")}` };
  });
}

function parseSharedStrings(entries) {
  const xml = entries.get("xl/sharedStrings.xml")?.toString("utf8") || "";
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlText(part[1])).join(""));
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = attributes.match(/\br="([^"]+)"/)?.[1] || `A${rows.length + 1}`;
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || "";
      const raw = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
      const inline = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => xmlText(part[1])).join("");
      let value = inline || (raw == null ? "" : xmlText(raw));
      if (type === "s" && raw != null) value = sharedStrings[Number(raw)] ?? "";
      else if (type === "b") value = raw === "1";
      else if (!type && raw != null && raw !== "" && Number.isFinite(Number(raw))) value = Number(raw);
      row[columnIndex(reference)] = value;
    }
    rows.push(row);
  }
  return rows;
}

function parseCsv(raw) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  const source = String(raw || "").replace(/^\uFEFF/, "");
  for (let index = 0; index <= source.length; index += 1) {
    const char = source[index] ?? "\n";
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { value += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += char;
  }
  return rows.filter((item) => item.some((cell) => text(cell)));
}

function workbookSheets(filename, buffer) {
  const extension = text(filename).toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  if (extension === ".csv") return [{ name: "CSV", rows: parseCsv(Buffer.from(buffer).toString("utf8")) }];
  if (extension !== ".xlsx") throw new Error("仅支持 .xlsx 或 .csv 配置表");
  const entries = unzipEntries(buffer);
  const sharedStrings = parseSharedStrings(entries);
  return workbookSheetPaths(entries).map((sheet) => ({
    ...sheet,
    rows: parseWorksheet(entries.get(sheet.path)?.toString("utf8") || "", sharedStrings),
  }));
}

function headerIndex(headers, aliases) {
  return headers.findIndex((header) => aliases.includes(text(header)));
}

function sheetCandidate(sheet) {
  const headerRowIndex = sheet.rows.findIndex((row) => {
    const headers = row.map(text);
    return headerIndex(headers, ["店编"]) >= 0
      && headerIndex(headers, ["马帮店名"]) >= 0
      && headerIndex(headers, ["平台"]) >= 0
      && headerIndex(headers, ["国家"]) >= 0
      && headerIndex(headers, ["当前对应仓库（参考）", "当前对应仓库", "对应仓库"]) >= 0;
  });
  if (headerRowIndex < 0) return null;
  const headers = sheet.rows[headerRowIndex].map(text);
  const modeColumn = headerIndex(headers, ["同步方式（必填）", "同步方式"]);
  const score = (sheet.name === "库存同步配置" ? 100 : sheet.name === "多仓待填写" ? 80 : 10) + (modeColumn >= 0 ? 20 : 0);
  return { sheet, headerRowIndex, headers, modeColumn, score };
}

export function parseInventorySyncConfigWorkbook({ filename, buffer }) {
  const candidates = workbookSheets(filename, buffer).map(sheetCandidate).filter(Boolean).sort((left, right) => right.score - left.score);
  const candidate = candidates[0];
  if (!candidate) throw new Error("未找到库存同步配置表头：店编、马帮店名、平台、国家、对应仓库");
  const { sheet, headerRowIndex, headers } = candidate;
  const position = (aliases) => headerIndex(headers, aliases);
  const columns = {
    shopCode: position(["店编"]),
    shopName: position(["马帮店名"]),
    platform: position(["平台"]),
    country: position(["国家"]),
    warehouses: position(["当前对应仓库（参考）", "当前对应仓库", "对应仓库"]),
    syncMode: position(["同步方式（必填）", "同步方式"]),
    specifiedWarehouse: position(["指定同步仓（方式①）", "指定同步仓"]),
    primaryWarehouse: position(["主仓（方式②）", "主仓"]),
    secondaryWarehouse: position(["副仓（方式②）", "副仓"]),
    skuWarehouseNote: position(["SKU对应仓说明（方式③）", "SKU对应仓说明"]),
  };
  const value = (row, index) => index < 0 ? "" : text(row[index]);
  const rows = sheet.rows.slice(headerRowIndex + 1).map((row, offset) => ({
    sourceRow: headerRowIndex + offset + 2,
    shopCode: value(row, columns.shopCode),
    shopName: value(row, columns.shopName),
    platform: platformName(value(row, columns.platform)),
    country: value(row, columns.country),
    countryCode: countryCode(value(row, columns.country)),
    warehouses: splitWarehouses(value(row, columns.warehouses)),
    syncMode: value(row, columns.syncMode) || "按对应仓库匹配",
    specifiedWarehouse: value(row, columns.specifiedWarehouse),
    primaryWarehouse: value(row, columns.primaryWarehouse),
    secondaryWarehouse: value(row, columns.secondaryWarehouse),
    skuWarehouseNote: value(row, columns.skuWarehouseNote),
  })).filter((row) => row.shopCode || row.shopName);
  return { sheetName: sheet.name, rows };
}

function buildIsolatedPools(readyRows) {
  return readyRows.map((row, index) => ({
    id: `import-pool-${index + 1}`,
    name: `${row.shopName || row.matchedShopName || row.countryCode || "导入"}库存池`,
    shopIds: [row.shopId],
    warehouseNames: [...row.matchedWarehouses].sort((a, b) => a.localeCompare(b, "zh-CN")),
  }));
}

export function buildInventoryConfigImportPreview({ rows, shops = [], warehouseOptions = [], selectedPlatform = "Shopee" }) {
  const activePlatform = platformName(selectedPlatform) || "Shopee";
  const shopList = Array.isArray(shops) ? shops : [];
  const warehousesByKey = new Map();
  for (const item of warehouseOptions) {
    const name = text(item?.name ?? item);
    if (!name) continue;
    const key = normalizeInventoryConfigText(name);
    const candidates = warehousesByKey.get(key) || [];
    candidates.push(name);
    warehousesByKey.set(key, candidates);
  }
  const duplicateRows = new Map();
  for (const row of rows) {
    const key = `${platformName(row.platform)}\u0000${countryCode(row.countryCode || row.country)}\u0000${normalizeInventoryConfigText(row.shopName)}`;
    duplicateRows.set(key, (duplicateRows.get(key) || 0) + 1);
  }
  const previewRows = rows.map((source, index) => {
    const issues = [];
    const warnings = [];
    const platform = platformName(source.platform);
    const wantedCountry = countryCode(source.countryCode || source.country);
    const wantedName = normalizeInventoryConfigText(source.shopName);
    const rowKey = `${platform}\u0000${wantedCountry}\u0000${wantedName}`;
    if (platform !== activePlatform) issues.push(`当前选择 ${activePlatform}，已跳过 ${platform || "未知平台"} 店铺`);
    if (!SUPPORTED_MODES.has(text(source.syncMode))) issues.push(`同步方式暂不支持：${text(source.syncMode) || "空"}`);
    if ((duplicateRows.get(rowKey) || 0) > 1) issues.push("配置表内店铺重复");
    const candidates = shopList.filter((shop) => normalizeInventoryConfigText(shop.name || shop.shopName) === wantedName
      && (!wantedCountry || !shop.site || countryCode(shop.site) === wantedCountry));
    const shop = candidates.length === 1 ? candidates[0] : null;
    if (!source.shopName) issues.push("店铺名称为空");
    if (!shop && platform === activePlatform) issues.push(candidates.length > 1 ? "店铺匹配不唯一" : `当前马帮账号未找到该${activePlatform}店铺`);
    if (!source.warehouses.length) issues.push("对应仓库为空");
    const matchedWarehouses = [];
    for (const warehouse of source.warehouses) {
      const matches = warehousesByKey.get(normalizeInventoryConfigText(warehouse)) || [];
      if (matches.length === 1) matchedWarehouses.push(matches[0]);
      else issues.push(matches.length > 1 ? `仓库匹配不唯一：${warehouse}` : `未找到仓库：${warehouse}`);
    }
    if (source.specifiedWarehouse || source.primaryWarehouse || source.secondaryWarehouse) {
      warnings.push("指定同步仓、主仓和副仓在当前模式下不会参与计算");
    }
    const ready = platform === activePlatform && issues.length === 0 && Boolean(shop) && matchedWarehouses.length === source.warehouses.length;
    return {
      id: String(index + 1),
      sourceRow: source.sourceRow,
      shopCode: source.shopCode,
      shopName: source.shopName,
      platform,
      countryCode: wantedCountry,
      syncMode: source.syncMode,
      sourceWarehouses: source.warehouses,
      matchedWarehouses: [...new Set(matchedWarehouses)],
      shopId: shop ? text(shop.id || shop.shopId) : "",
      matchedShopName: shop ? text(shop.name || shop.shopName) : "",
      ready,
      issues,
      warnings,
    };
  });
  const readyRows = previewRows.filter((row) => row.ready);
  const inventoryPools = buildIsolatedPools(readyRows);
  return {
    rows: previewRows,
    inventoryPools,
    summary: {
      total: previewRows.length,
      ready: readyRows.length,
      needsReview: previewRows.length - readyRows.length,
      shopee: previewRows.filter((row) => row.platform === "Shopee").length,
      lazada: previewRows.filter((row) => row.platform === "Lazada").length,
      inventoryPoolCount: inventoryPools.length,
      warningCount: previewRows.filter((row) => row.warnings.length).length,
    },
  };
}
