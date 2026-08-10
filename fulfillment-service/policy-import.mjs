import { inflateRawSync } from "node:zlib";

const REQUIRED_HEADERS = ["马帮店名", "平台", "国家", "对应物流渠道", "对应仓库"];
const COUNTRY_CODES = new Map([
  ["新加坡", "SG"], ["sg", "SG"], ["singapore", "SG"],
  ["马来", "MY"], ["马来西亚", "MY"], ["my", "MY"], ["malaysia", "MY"],
  ["泰国", "TH"], ["th", "TH"], ["thailand", "TH"],
  ["菲律宾", "PH"], ["ph", "PH"], ["philippines", "PH"],
  ["越南", "VN"], ["vn", "VN"], ["vietnam", "VN"],
  ["印尼", "ID"], ["印度尼西亚", "ID"], ["id", "ID"], ["indonesia", "ID"],
  ["台湾", "TW"], ["tw", "TW"], ["taiwan", "TW"],
]);

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
    if (uncompressedSize > 4 * 1024 * 1024 || expandedSize > 12 * 1024 * 1024) throw new Error("Excel 文件解压后过大");
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

function parseCsv(text) {
  const rows = []; let row = []; let value = ""; let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");
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
  return rows.filter((item) => item.some((cell) => String(cell || "").trim()));
}

export function parseFulfillmentPolicyWorkbook({ filename, buffer }) {
  const extension = String(filename || "").toLowerCase().match(/\.[^.]+$/)?.[0] || "";
  let sheets;
  if (extension === ".csv") sheets = [{ name: "CSV", rows: parseCsv(Buffer.from(buffer).toString("utf8")) }];
  else if (extension === ".xlsx") {
    const entries = unzipEntries(buffer);
    const sharedStrings = parseSharedStrings(entries);
    sheets = workbookSheetPaths(entries).map((sheet) => ({ ...sheet,
      rows: parseWorksheet(entries.get(sheet.path)?.toString("utf8") || "", sharedStrings) }));
  } else throw new Error("仅支持 .xlsx 或 .csv 配置表");
  for (const sheet of sheets) {
    const headerIndex = sheet.rows.findIndex((row) => REQUIRED_HEADERS.every((header) => row.some((cell) => String(cell || "").trim() === header)));
    if (headerIndex < 0) continue;
    const headers = sheet.rows[headerIndex].map((cell) => String(cell || "").trim());
    const index = Object.fromEntries(headers.map((header, position) => [header, position]));
    const rows = sheet.rows.slice(headerIndex + 1).map((row, offset) => ({
      sourceRow: headerIndex + offset + 2,
      shopCode: String(row[index["店编"]] || "").trim(),
      shopName: String(row[index["马帮店名"]] || "").trim(),
      platform: String(row[index["平台"]] || "").trim(),
      country: String(row[index["国家"]] || "").trim(),
      channel: String(row[index["对应物流渠道"]] || "").trim(),
      warehouses: String(row[index["对应仓库"]] || "").trim(),
    })).filter((row) => row.shopName || row.shopCode);
    return { sheetName: sheet.name, rows };
  }
  throw new Error(`未找到必需表头：${REQUIRED_HEADERS.join("、")}`);
}

export function normalizePolicyImportText(value) {
  return String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function platformName(value) {
  const normalized = normalizePolicyImportText(value);
  if (normalized.includes("shopee")) return "Shopee";
  if (normalized.includes("lazada")) return "Lazada";
  return String(value || "").trim();
}

function countryCode(value) {
  return COUNTRY_CODES.get(normalizePolicyImportText(value)) || String(value || "").trim().toUpperCase();
}

function splitWarehouses(value) {
  return [...new Set(String(value || "").split(/[，,、;；/\n\r\t]+/).map((item) => item.trim()).filter(Boolean))];
}

function exactChannelText(value) {
  return String(value || "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
}

function channelReference(raw) {
  const text = exactChannelText(raw);
  const bracketed = text.match(/^(.*?)\s*[【[]([^\]】]+)[\]】]\s*$/);
  if (!bracketed) return { channelName: text, logisticsName: "", hasLogisticsName: false };
  return { channelName: exactChannelText(bracketed[1]), logisticsName: exactChannelText(bracketed[2]), hasLogisticsName: true };
}

function channelCandidates(raw, channels, shop, currentChannelId = "") {
  const reference = channelReference(raw);
  if (!reference.channelName) return [];
  const platform = platformName(shop.platform);
  const eligible = channels.filter((channel) => channel.active
    && (!channel.platformId || String(channel.platformId) === String(shop.platformId || ""))
    && (!channel.countryCode || String(channel.countryCode).toUpperCase() === String(shop.countryCode || "").toUpperCase())
    && (!platform || normalizePolicyImportText(channel.logisticsName).includes(normalizePolicyImportText(platform))
      || normalizePolicyImportText(channel.channelName).includes(normalizePolicyImportText(platform))
      || (platform === "Shopee" && /shopee/i.test(channel.logisticsName))
      || (platform === "Lazada" && /lazada/i.test(channel.logisticsName))));
  return eligible.filter((channel) => exactChannelText(channel.channelName) === reference.channelName
    && (!reference.hasLogisticsName || exactChannelText(channel.logisticsName) === reference.logisticsName))
    .map((channel) => ({ channel, score: String(channel.channelId) === String(currentChannelId || "") ? 2 : 1 }))
    .sort((left, right) => right.score - left.score);
}

export function buildFulfillmentPolicyImportPreview({ rows, shops, channels, warehouseOptions, policies, allowOverwrite = false, hasAccess = () => true }) {
  const shopList = [...shops.values?.() || shops || []];
  const policyMap = policies instanceof Map ? policies : new Map((policies || []).map((policy) => [String(policy.shopId), policy]));
  const warehouses = new Map((warehouseOptions || []).map((name) => [normalizePolicyImportText(name), String(name).trim()]));
  const previewRows = rows.map((source, index) => {
    const wantedPlatform = platformName(source.platform);
    const wantedCountry = countryCode(source.country);
    const wantedName = normalizePolicyImportText(source.shopName);
    const matchingShops = shopList.filter((shop) => normalizePolicyImportText(shop.shopName || shop.name) === wantedName
      && platformName(shop.platform) === wantedPlatform && countryCode(shop.countryCode) === wantedCountry);
    const issues = [];
    const shop = matchingShops.length === 1 ? matchingShops[0] : null;
    if (!source.shopName) issues.push("店铺名称为空");
    if (!shop) issues.push(matchingShops.length > 1 ? "店铺匹配不唯一" : "当前账号下未找到对应店铺");
    if (shop && !hasAccess(shop.shopId)) issues.push("店铺已不在当前账号权限范围");
    const policy = shop ? policyMap.get(String(shop.shopId)) : null;
    if (shop && !policy) issues.push("店铺配置不存在");
    const reviewed = policy && policy.updatedBy !== "catalog_sync";
    if (reviewed && !allowOverwrite) issues.push("已有人工确认配置，未勾选覆盖");
    if (!source.channel) issues.push("物流渠道为空");
    const candidates = shop ? channelCandidates(source.channel, channels || [], shop, policy?.channelId) : [];
    const topScore = candidates[0]?.score || 0;
    const top = candidates.filter((item) => item.score === topScore);
    const selectedChannel = top.length === 1 ? top[0].channel : null;
    if (source.channel && !selectedChannel) issues.push(top.length > 1 ? "物流渠道匹配不唯一" : "未匹配到有效物流渠道");
    const sourceWarehouses = splitWarehouses(source.warehouses);
    const matchedWarehouses = sourceWarehouses.map((name) => warehouses.get(normalizePolicyImportText(name))).filter(Boolean);
    const missingWarehouses = sourceWarehouses.filter((name) => !warehouses.has(normalizePolicyImportText(name)));
    if (!sourceWarehouses.length) issues.push("仓库为空");
    if (missingWarehouses.length) issues.push(`未匹配仓库：${missingWarehouses.join("、")}`);
    const ready = Boolean(shop && policy && selectedChannel && sourceWarehouses.length && !missingWarehouses.length && hasAccess(shop.shopId)
      && (!reviewed || allowOverwrite));
    return {
      id: String(index + 1), sourceRow: source.sourceRow, shopCode: source.shopCode, shopName: source.shopName,
      platform: wantedPlatform, countryCode: wantedCountry, sourceChannel: source.channel,
      sourceWarehouses, shopId: shop ? String(shop.shopId) : "", matchedShopName: shop?.shopName || "",
      channelId: selectedChannel?.channelId || "", channelName: selectedChannel
        ? `${selectedChannel.channelName}${selectedChannel.logisticsName ? ` · ${selectedChannel.logisticsName}` : ""}` : "",
      warehouses: matchedWarehouses, policyVersion: policy?.version || 0, reviewed: Boolean(reviewed), ready, issues,
    };
  });
  return previewRows;
}
