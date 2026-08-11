import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createMabangWorkerRunner } from "../lib/mabang-worker-runner.mjs";
import { createSkuWarehouseInventoryLedger, evaluateSkuWarehouseRoutes, warehouseKey, warehouseScope } from "./sku-warehouse-routing.mjs";

const MAX_BATCH_ORDERS = 100;
const PLAN_TTL_MS = 10 * 60 * 1000;
const BATCH_RECOVERY_MAX_AGE_MS = 45 * 60 * 1000;
export const SKU_REPLACEMENT_SCHEMA_VERSION = 2;
const IGNORED_SKUS = new Set(["直播赠品单", "TKZP001"]);
const COLOR_TERMS = [
  "香槟金色", "香槟金", "香槟色", "玫瑰金色", "玫瑰金", "黑胡桃色", "胡桃木色", "胡桃色", "黑橡木色", "枫樱木色", "樱木色",
  "白柳色", "古檀色", "原木色", "浅木色", "深木色", "自然色", "暖白色", "米白色", "乳白色", "纯白色", "白金色", "白色",
  "哑光黑", "亮光黑", "黑色", "深灰色", "浅灰色", "灰白色", "灰色", "银灰色", "咖啡色", "棕色", "褐色", "金色", "银色",
  "蓝色", "绿色", "粉色", "红色", "黄色", "橙色", "紫色", "透明色", "米色", "卡其色", "奶油色", "木色", "茶色",
  "白", "黑", "灰", "蓝", "绿", "粉", "红", "黄", "橙", "紫", "金", "银",
  "beige", "walnut", "natural", "white", "black", "grey", "gray", "gold", "silver", "blue", "green", "pink", "red", "yellow", "orange", "brown",
];
const COLOR_REGEX = new RegExp(COLOR_TERMS.sort((left, right) => right.length - left.length).map(escapeRegex).join("|"), "giu");
const SPEC_REGEX = /(\d+(?:\.\d+)?)(?:\s*[x×*]\s*(\d+(?:\.\d+)?)){0,3}\s*(mm|毫米|cm|厘米|m|米|kg|公斤|g|克|ml|毫升|l|升|寸|英寸|层|格|门|抽|盒|人位|件套|件|个装|个|只|片|块板|板|包|支|孔)?/giu;
const UNIT_REGEX = /(mm|毫米|cm|厘米|m|米|kg|公斤|g|克|ml|毫升|l|升|寸|英寸|层|格|门|抽|盒|人位|件套|件|个装|个|只|片|块板|板|包|支|孔)/giu;
const CHINESE_DIGITS = new Map([["零", 0], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9]]);

function text(value) { return String(value ?? "").trim(); }
function sku(value) { return text(value).toUpperCase().replace(/\s+/g, ""); }
function number(value) { const parsed = Number(text(value).replace(/,/g, "")); return Number.isFinite(parsed) ? parsed : 0; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function ignored(item) { return IGNORED_SKUS.has(sku(item.stockSku)) || IGNORED_SKUS.has(text(item.title).replace(/\s+/g, "")); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }

function chineseNumberValue(value) {
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [left, right] = value.split("十");
    return (left ? CHINESE_DIGITS.get(left) || 0 : 1) * 10 + (right ? CHINESE_DIGITS.get(right) || 0 : 0);
  }
  return CHINESE_DIGITS.get(value) ?? null;
}

function normalizeChineseSpecs(value) {
  return text(value).replace(/([零一二两三四五六七八九十]{1,3})(层|格|门|抽|盒|人位|件套|件|个装|个|只|片|块板|板|包|支|孔)/g,
    (all, count, unit) => { const parsed = chineseNumberValue(count); return parsed == null ? all : `${parsed}${unit}`; });
}

export function extractSkuNameFeatures(name) {
  const normalized = normalizeChineseSpecs(name).toLowerCase().replace(/(型号|款式|sku)\s*[:：]?\s*\d+/g, "");
  const colors = [...new Set((normalized.match(COLOR_REGEX) || []).map((value) => value.toLowerCase()))];
  const specifications = [];
  for (const match of normalized.matchAll(SPEC_REGEX)) {
    const raw = match[0];
    if (!match[3] && !/[x×*]/.test(raw)) continue;
    const values = [...raw.matchAll(/\d+(?:\.\d+)?/g)].map((value) => Number(value[0]));
    const unit = (raw.match(UNIT_REGEX) || []).at(-1)?.toLowerCase() || "dimension";
    specifications.push({ raw, values, unit });
  }
  const core = normalized.replace(/^(?:[0-9a-z]{1,5})[-—_:：]+/iu, "").replace(COLOR_REGEX, "")
    .replace(SPEC_REGEX, (all, first, second, unit) => (unit || /[x×*]/.test(all) ? "" : all))
    .replace(/[\s\-—_.,，。()（）【】\[\]\/\\:：+]/g, "").replace(/(新款|升级款)/g, "");
  return { colors, specifications, core };
}

function compareSpecifications(original, candidate) {
  const left = original.flatMap((spec) => spec.values.map((value) => ({ value, unit: spec.unit })));
  const right = candidate.flatMap((spec) => spec.values.map((value) => ({ value, unit: spec.unit })));
  if (!left.length && !right.length) return "unspecified";
  if (!left.length || left.length !== right.length) return "different";
  if (!left.every((item, index) => item.unit === right[index].unit || item.unit === "dimension" || right[index].unit === "dimension")) return "different";
  if (left.every((item, index) => Math.abs(item.value - right[index].value) < 1e-9)) return "equal";
  return left.every((item, index) => right[index].value <= item.value)
    && left.some((item, index) => right[index].value < item.value) ? "smaller" : "different";
}

function inventoryRow(raw) {
  const rawName = text(raw["中文名称"] ?? raw["中文名"] ?? raw.chineseName ?? raw.name);
  const suspiciousName = /^(正常销售|停止销售|停售|禁售|淘汰|下架|在售|已停售)$/u.test(rawName);
  const explicitConfidence = text(raw["名称置信度"] ?? raw.nameConfidence).toUpperCase();
  const nameConfidence = explicitConfidence || (rawName && !suspiciousName ? "VERIFIED" : "MISSING");
  return {
    sku: sku(raw["库存SKU编号"] ?? raw["SKU"] ?? raw.sku), warehouse: text(raw["仓库"] ?? raw.warehouse),
    name: suspiciousName ? "" : rawName,
    nameSource: text(raw["名称来源"] ?? raw.nameSource) || (rawName ? "inventory_record" : ""),
    nameConfidence: suspiciousName ? "MISSING" : nameConfidence,
    category1: text(raw["一级目录"] ?? raw.category1), category2: text(raw["二级目录"] ?? raw.category2),
    productStatus: text(raw["商品状态"] ?? raw.salesState ?? raw.productStatus),
    available: number(raw["可用库存量"] ?? raw["可用库存"] ?? raw["可用量"] ?? raw.availableQuantity ?? raw.available),
  };
}

export function aggregateReplacementInventory(records = []) {
  const aggregated = new Map();
  for (const raw of records) {
    const row = inventoryRow(raw);
    if (!row.sku || !row.warehouse) continue;
    const key = `${warehouseKey(row.warehouse)}\u0000${row.sku}`;
    const current = aggregated.get(key) || { ...row, available: 0 };
    current.available += row.available;
    if ((!current.name || current.nameConfidence !== "VERIFIED") && row.nameConfidence === "VERIFIED") {
      current.name = row.name;
      current.nameSource = row.nameSource;
      current.nameConfidence = row.nameConfidence;
    }
    aggregated.set(key, current);
  }
  return [...aggregated.values()];
}

export function createReplacementCandidateIndex(inventory = []) {
  const index = { warehouseNames: [], seenWarehouses: new Set(), byWarehouseCore: new Map(),
    featuresBySku: new Map(), rowBySku: new Map() };
  for (const row of inventory) {
    addReplacementCandidateIndexRow(index, row);
  }
  const { seenWarehouses: _seenWarehouses, ...result } = index;
  return result;
}

function addReplacementCandidateIndexRow(index, row) {
    const warehouse = warehouseKey(row?.warehouse);
    const inventorySku = sku(row?.sku);
    if (!warehouse || !inventorySku || !row?.name || row?.nameConfidence !== "VERIFIED") return;
    const features = extractSkuNameFeatures(row.name);
    if (!features.core) return;
    if (!index.seenWarehouses.has(warehouse)) { index.seenWarehouses.add(warehouse); index.warehouseNames.push(row.warehouse); }
    const key = `${warehouse}\u0000${features.core}`;
    if (!index.byWarehouseCore.has(key)) index.byWarehouseCore.set(key, []);
    index.byWarehouseCore.get(key).push({ row, features });
    if (!index.featuresBySku.has(inventorySku)) index.featuresBySku.set(inventorySku, features);
    if (!index.rowBySku.has(inventorySku)) index.rowBySku.set(inventorySku, row);
}

export async function createReplacementCandidateIndexAsync(inventory = [], { yieldEvery = 250 } = {}) {
  const index = { warehouseNames: [], seenWarehouses: new Set(), byWarehouseCore: new Map(),
    featuresBySku: new Map(), rowBySku: new Map() };
  const chunkSize = Math.max(1, Number(yieldEvery) || 250);
  for (let position = 0; position < inventory.length; position += 1) {
    addReplacementCandidateIndexRow(index, inventory[position]);
    if ((position + 1) % chunkSize === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const { seenWarehouses: _seenWarehouses, ...result } = index;
  return result;
}

export function findSkuReplacementCandidates({ originalSku, originalName, originalNameConfidence = "VERIFIED", warehouse, quantity = 1,
  inventory = [], candidateIndex = null, limit = 8 }) {
  if (text(originalNameConfidence).toUpperCase() !== "VERIFIED"
      || /^(正常销售|停止销售|停售|禁售|淘汰|下架|在售|已停售)$/u.test(text(originalName))) return [];
  const original = extractSkuNameFeatures(originalName);
  if (!original.core) return [];
  const wantedSku = sku(originalSku);
  const originalRow = candidateIndex?.rowBySku.get(wantedSku)
    || inventory.find((row) => row.sku === wantedSku && row.name);
  const indexedEntries = candidateIndex?.byWarehouseCore.get(`${warehouseKey(warehouse)}\u0000${original.core}`);
  const entries = indexedEntries || inventory.map((row) => ({ row, features: null }));
  return entries.filter(({ row }) => row.sku !== wantedSku && warehouseKey(row.warehouse) === warehouseKey(warehouse)
      && row.available >= number(quantity) && row.name && row.nameConfidence === "VERIFIED" && !/(停售|禁售|淘汰|下架)/.test(row.productStatus)
      && (!originalRow?.category1 || !row.category1 || originalRow.category1 === row.category1))
    .map(({ row, features }) => {
      const candidate = features || extractSkuNameFeatures(row.name);
      if (!candidate.core || candidate.core !== original.core) return null;
      const specRelation = compareSpecifications(original.specifications, candidate.specifications);
      const colorChanged = JSON.stringify(original.colors) !== JSON.stringify(candidate.colors);
      if (!new Set(["equal", "smaller"]).has(specRelation) && !(specRelation === "unspecified" && colorChanged)) return null;
      const kind = specRelation === "smaller" ? (colorChanged ? "SMALLER_COLOR" : "SMALLER") : (colorChanged ? "COLOR" : "SAME");
      return { sku: row.sku, chineseName: row.name, warehouse: row.warehouse, available: row.available,
        productStatus: row.productStatus, category1: row.category1, category2: row.category2, kind,
        label: { SAME: "同款同规格", COLOR: "同款换色", SMALLER: "同款小规格", SMALLER_COLOR: "同款小规格换色" }[kind],
        riskLevel: kind === "SAME" ? "LOW" : kind === "COLOR" ? "MEDIUM" : "HIGH",
        colorChanged, specRelation, originalColors: original.colors, candidateColors: candidate.colors,
        nameSource: row.nameSource, nameConfidence: row.nameConfidence };
    }).filter(Boolean).sort((left, right) => {
      const priority = { SAME: 0, COLOR: 1, SMALLER: 2, SMALLER_COLOR: 3 };
      return priority[left.kind] - priority[right.kind] || right.available - left.available || left.sku.localeCompare(right.sku);
    }).slice(0, limit);
}

function uniqueWarehouses(values = []) {
  const result = []; const seen = new Set();
  for (const value of values) {
    const warehouse = warehouseScope(value); const key = warehouseKey(warehouse);
    if (key && !seen.has(key)) { seen.add(key); result.push(warehouse); }
  }
  return result;
}

function canonicalWarehouses(values = []) {
  return uniqueWarehouses(values).sort((left, right) => warehouseKey(left).localeCompare(warehouseKey(right)));
}

function optionWarehouse(option) {
  return warehouseScope(option && typeof option === "object" ? option.text ?? option.name ?? option.warehouse : option);
}

function canonicalActiveItems(items = []) {
  return items.map((item) => ({
    itemId: text(item.itemId ?? item.id),
    stockSku: sku(item.stockSku ?? item.sku),
    quantity: number(item.quantity),
    currentWarehouse: warehouseScope(item.stockWarehouseName ?? item.currentWarehouse ?? item.warehouse),
    warehouseOptions: (item.warehouseOptions || []).map((option) => ({
      value: text(option && typeof option === "object" ? option.value ?? option.id : ""),
      text: text(option && typeof option === "object" ? option.text ?? option.name ?? option.warehouse : option),
      warehouseKey: warehouseKey(optionWarehouse(option)),
    })).filter((option) => option.warehouseKey)
      .sort((left, right) => left.warehouseKey.localeCompare(right.warehouseKey)
        || left.value.localeCompare(right.value) || left.text.localeCompare(right.text)),
  })).sort((left, right) => left.itemId.localeCompare(right.itemId)
    || left.stockSku.localeCompare(right.stockSku)
    || left.quantity - right.quantity);
}

function canonicalRoute(route) {
  if (!route) return null;
  return {
    mode: text(route.mode), warehouse: warehouseScope(route.warehouse), remaining: number(route.remaining),
    stock: (route.stock || []).map((item) => ({ sku: sku(item.sku), quantity: number(item.quantity), available: number(item.available) }))
      .sort((left, right) => left.sku.localeCompare(right.sku)),
    itemBindings: (route.itemBindings || []).map((binding) => ({ itemId: text(binding.itemId),
      optionValue: text(binding.optionValue), optionText: text(binding.optionText),
      optionWarehouseKey: text(binding.optionWarehouseKey) }))
      .sort((left, right) => left.itemId.localeCompare(right.itemId)),
  };
}

function replacementEvidence(candidate) {
  return {
    sku: sku(candidate?.sku), chineseName: text(candidate?.chineseName), productStatus: text(candidate?.productStatus),
    category1: text(candidate?.category1), category2: text(candidate?.category2), kind: text(candidate?.kind),
    riskLevel: text(candidate?.riskLevel), colorChanged: Boolean(candidate?.colorChanged), specRelation: text(candidate?.specRelation),
    nameSource: text(candidate?.nameSource), nameConfidence: text(candidate?.nameConfidence),
    originalColors: [...(candidate?.originalColors || [])].map(text), candidateColors: [...(candidate?.candidateColors || [])].map(text),
  };
}

function inventoryEvidence(prospectiveItems, inventoryWarehouses, inventory) {
  const requiredSkus = [...new Set(canonicalActiveItems(prospectiveItems).map((item) => item.stockSku).filter(Boolean))].sort();
  const ledger = new Map(inventory.map((row) => [`${warehouseKey(row.warehouse)}\u0000${sku(row.sku)}`, number(row.available)]));
  return canonicalWarehouses(inventoryWarehouses).flatMap((warehouse) => requiredSkus.map((itemSku) => ({
    warehouse, sku: itemSku, available: ledger.get(`${warehouseKey(warehouse)}\u0000${itemSku}`) || 0,
  })));
}

function preWriteEvidence({ activeItems, allowedWarehouses, inventory, candidate, selectedRoute }) {
  const inventoryWarehouses = canonicalWarehouses([
    ...activeItems.map((item) => item.stockWarehouseName),
    ...allowedWarehouses,
  ]);
  return {
    activeItems: canonicalActiveItems(activeItems),
    prospectiveItems: canonicalActiveItems(candidate.prospectiveItems),
    allowedWarehouses: canonicalWarehouses(allowedWarehouses),
    inventoryWarehouses,
    inventory: inventoryEvidence(candidate.prospectiveItems, inventoryWarehouses, inventory),
    selectedRoute: canonicalRoute(selectedRoute),
    warehouseAlternatives: (candidate.warehouseAlternatives || []).map(canonicalRoute),
    replacement: replacementEvidence(candidate),
  };
}

function publicReplacementCandidate(candidate) {
  const { prospectiveItems: _prospectiveItems, ...visible } = candidate;
  return { ...visible, warehouseAlternatives: (visible.warehouseAlternatives || []).map(({ warehouse, mode, remaining }) => ({
    warehouse, mode, remaining,
  })) };
}

function verifiedOrderState(order, record) {
  const activeItems = (order?.items || []).filter((item) => !ignored(item));
  const selectedItem = activeItems.find((item) => text(item.itemId) === record.item.itemId);
  const targetWarehouseKey = warehouseKey(record.targetWarehouse);
  return {
    selectedSku: text(selectedItem?.stockSku),
    skuMatches: sku(selectedItem?.stockSku) === sku(record.replacement.sku),
    warehousesMatch: activeItems.length > 0 && activeItems.every((item) => {
      const itemWarehouseKey = warehouseKey(item.stockWarehouseName);
      return Boolean(itemWarehouseKey) && itemWarehouseKey === targetWarehouseKey;
    }),
    finalWarehouses: uniqueWarehouses(activeItems.map((item) => item.stockWarehouseName)),
  };
}

function warehouseVerificationError(record, state, error) {
  const failure = coded("SKU_REPLACEMENT_WAREHOUSE_VERIFY_FAILED", "SKU 已更换，但最终仓库状态无法确认，请在马帮人工核对");
  const rawCauseCode = text(error?.code);
  failure.diagnostic = {
    version: 1,
    phase: state.phase,
    skuWriteConfirmed: true,
    warehousePreviewAttempted: state.warehousePreviewAttempted,
    warehouseWriteAttempted: state.warehouseWriteAttempted,
    warehouseWriteConfirmed: state.warehouseWriteConfirmed,
    targetSku: record.replacement.sku,
    observedSku: text(state.observedSku),
    targetWarehouse: record.targetWarehouse,
    finalWarehouses: uniqueWarehouses(state.finalWarehouses),
    message: ({
      POST_SKU_INSPECT: "SKU 写入后的订单状态无法确认",
      WAREHOUSE_PREVIEW: "未能生成原计划目标仓库的换仓预览",
      WAREHOUSE_EXECUTE: "换仓写入结果无法确认",
      FINAL_VERIFY: "最终 SKU 与仓库状态无法确认",
    })[state.phase] || "SKU 与仓库状态无法确认",
    cause: {
      code: /^[A-Z0-9_]{1,120}$/.test(rawCauseCode) ? rawCauseCode : "WAREHOUSE_STATE_UNCONFIRMED",
    },
  };
  return failure;
}

function routedReplacementCandidates({ items, item, chineseName, nameConfidence = "VERIFIED", allowedWarehouses, inventory, candidateIndex = null,
  routeInventoryLedger = null, limit = 8 }) {
  const index = candidateIndex || createReplacementCandidateIndex(inventory);
  const inventoryLedger = routeInventoryLedger || createSkuWarehouseInventoryLedger(inventory);
  const grouped = new Map();
  for (const warehouse of index.warehouseNames) {
    for (const candidate of findSkuReplacementCandidates({ originalSku: item.stockSku, originalName: chineseName,
      originalNameConfidence: nameConfidence,
      warehouse, quantity: item.quantity, inventory, candidateIndex: index, limit: 50 })) {
      if (!grouped.has(candidate.sku)) grouped.set(candidate.sku, candidate);
    }
  }
  const candidates = [...grouped.values()].map((candidate) => {
    const routes = evaluateSkuWarehouseRoutes({ items, replacementItemId: item.itemId, replacementSku: candidate.sku,
      allowedWarehouses, inventory, inventoryLedger });
    if (!routes.selected) return null;
    const selectedInventory = inventory.find((row) => row.sku === candidate.sku
      && warehouseKey(row.warehouse) === warehouseKey(routes.selected.warehouse));
    return { ...candidate, warehouse: routes.selected.warehouse, available: selectedInventory?.available || 0,
      warehouseMode: routes.selected.mode, targetWarehouse: routes.selected.warehouse,
      warehouseAlternatives: routes.alternatives, prospectiveItems: routes.prospectiveItems };
  }).filter(Boolean).sort((left, right) => {
    const priority = { SAME: 0, COLOR: 1, SMALLER: 2, SMALLER_COLOR: 3 };
    return priority[left.kind] - priority[right.kind] || right.available - left.available || left.sku.localeCompare(right.sku);
  });
  return candidates.slice(0, limit);
}

export class SkuReplacementService {
  constructor({ rootDir, credentials, hasShopAccess, allowedWarehouses = () => [], warehouseTransferService = null,
    runWorker = null, now = () => new Date() }) {
    this.rootDir = rootDir;
    this.credentials = credentials; this.hasShopAccess = hasShopAccess; this.now = now;
    this.allowedWarehouses = allowedWarehouses; this.warehouseTransferService = warehouseTransferService;
    this.runWorker = runWorker || createMabangWorkerRunner({ rootDir, exportRoot: path.join(rootDir, "storage", "temp") });
    this.plans = new Map();
    this.historyDir = path.join(rootDir, "storage", "sku-replacements");
  }

  async previewBatch({ orderReferences = [] } = {}) {
    const references = [...new Set((Array.isArray(orderReferences) ? orderReferences : []).map(text).filter(Boolean))];
    if (!references.length || references.length > MAX_BATCH_ORDERS || references.some((reference) => !/^[A-Za-z0-9_-]{4,100}$/.test(reference))) {
      throw coded("SKU_REPLACEMENT_ORDERS_INVALID", `请输入 1-${MAX_BATCH_ORDERS} 个有效订单号`);
    }
    const account = this.credentials();
    if (!account?.ok) throw coded(account?.code || "MABANG_ACCOUNT_NOT_CONNECTED", account?.message || "请先连接马帮账号");
    const batchInspection = await this.runWorker({ action: "order-warehouse-inspect-batch", username: account.username, password: account.password,
      orderReferences: references });
    const inspected = []; const failures = (batchInspection.failures || []).map((failure) => ({ orderReference: text(failure.orderReference),
      code: "SKU_REPLACEMENT_INSPECT_FAILED", message: text(failure.message || "订单读取失败").slice(0, 300) }));
    for (const entry of batchInspection.orders || []) {
      if (!entry.order?.shopId || !this.hasShopAccess(entry.order.shopId)) {
        failures.push({ orderReference: text(entry.orderReference), code: "SKU_REPLACEMENT_SHOP_ACCESS_REVOKED", message: "该订单店铺不属于当前马帮账号权限范围" });
      } else inspected.push({ orderReference: text(entry.orderReference), order: entry.order });
    }
    const orderWarehouses = new Map(inspected.map(({ orderReference, order }) => [orderReference,
      uniqueWarehouses(this.allowedWarehouses(order.shopId))]));
    const warehouses = uniqueWarehouses(inspected.flatMap(({ orderReference, order }) => [
      ...(order.items || []).filter((item) => !ignored(item)).map((item) => item.stockWarehouseName),
      ...(orderWarehouses.get(orderReference) || []),
    ]));
    const inventoryResponse = warehouses.length ? await this.runWorker({ action: "inventory", compact: false, warehouseNames: warehouses,
      username: account.username, password: account.password }) : { records: [] };
    const inventory = aggregateReplacementInventory(inventoryResponse.records || []);
    const candidateIndex = await createReplacementCandidateIndexAsync(inventory);
    const routeInventoryLedger = createSkuWarehouseInventoryLedger(inventory);
    const plans = inspected.map(({ orderReference, order }) => {
      const activeItems = (order.items || []).filter((item) => !ignored(item));
      const allowedWarehouses = orderWarehouses.get(orderReference) || [];
      const items = activeItems.map((item) => {
        const currentWarehouse = text(item.stockWarehouseName);
        const currentInventory = inventory.find((row) => row.sku === sku(item.stockSku)
          && warehouseKey(row.warehouse) === warehouseKey(currentWarehouse));
        const productInventory = (currentInventory?.name ? currentInventory : null)
          || inventory.find((row) => row.sku === sku(item.stockSku) && row.name);
        const chineseName = productInventory?.name || text(item.title);
        const nameConfidence = productInventory?.nameConfidence || "MISSING";
        const available = currentInventory?.available || 0;
        const shortage = Math.max(0, number(item.quantity) - available);
        return { itemId: text(item.itemId), originalSku: text(item.stockSku), chineseName, quantity: number(item.quantity),
          currentWarehouse, available, shortage,
          nameSource: productInventory?.nameSource || "", nameConfidence,
          candidates: shortage > 0 ? routedReplacementCandidates({ items: activeItems, item, chineseName, nameConfidence,
            allowedWarehouses, inventory, candidateIndex, routeInventoryLedger }).map(publicReplacementCandidate) : [],
          requiresBundleReview: /(A包|B包|配件包|套装|组合)/i.test(chineseName) };
      });
      return { order: { internalOrderId: text(order.internalOrderId), platformOrderId: text(order.platformOrderId || orderReference),
        shopId: text(order.shopId), platformId: text(order.platformId), orderStatus: text(order.orderStatus) }, items,
      candidateCount: items.reduce((sum, item) => sum + item.candidates.length, 0),
      replaceableItemCount: items.filter((item) => item.shortage > 0 && item.candidates.length).length,
      unresolvedItemCount: items.filter((item) => item.shortage > 0 && !item.candidates.length).length };
    });
    const generatedAt = this.now().toISOString();
    const result = { version: SKU_REPLACEMENT_SCHEMA_VERSION, generatedAt, requestedCount: references.length, plans, failures,
      executionAvailable: true,
      executionBlockReason: "每个商品行需单独选择候选并输入不可撤销确认文字；仅修改马帮履约 SKU，虾皮买家订单商品不变。",
      summary: { inspected: inspected.length, failed: failures.length, ordersWithCandidates: plans.filter((plan) => plan.candidateCount > 0).length,
        replaceableItems: plans.reduce((sum, plan) => sum + plan.replaceableItemCount, 0),
        candidateCount: plans.reduce((sum, plan) => sum + plan.candidateCount, 0) } };
    result.batchHash = hash({ version: result.version, generatedAt, orderReferences: references,
      plans: plans.map((plan) => ({ order: plan.order, candidateCount: plan.candidateCount })), failures });
    result.orderReferences = references;
    this.write("batch-previews", result.batchHash, result);
    return result;
  }

  recoverBatch({ orderReferences = [] } = {}) {
    const references = [...new Set((Array.isArray(orderReferences) ? orderReferences : []).map(text).filter(Boolean))];
    if (!references.length || references.length > MAX_BATCH_ORDERS || references.some((reference) => !/^[A-Za-z0-9_-]{4,100}$/.test(reference))) {
      throw coded("SKU_REPLACEMENT_ORDERS_INVALID", `请输入 1-${MAX_BATCH_ORDERS} 个有效订单号`);
    }
    const wanted = [...references].sort().join("\u0000");
    const directory = path.join(this.historyDir, "batch-previews");
    const candidates = fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => { try { return JSON.parse(fs.readFileSync(path.join(directory, entry.name), "utf8")); } catch { return null; } }).filter(Boolean) : [];
    const source = candidates.filter((record) => {
      const recordReferences = [...new Set((record.orderReferences || []).map(text).filter(Boolean))].sort().join("\u0000");
      const age = this.now().getTime() - Date.parse(record.generatedAt || "");
      return recordReferences === wanted && age >= 0 && age <= BATCH_RECOVERY_MAX_AGE_MS;
    }).sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))[0];
    if (!source) throw coded("SKU_REPLACEMENT_BATCH_RECOVERY_NOT_FOUND", "没有找到这批订单最近完成的 SKU 预览结果");
    if (source.version !== SKU_REPLACEMENT_SCHEMA_VERSION) {
      throw coded("PREVIEW_SCHEMA_OBSOLETE", "最近的 SKU 预览由旧版安全规则生成，必须重新获取");
    }
    return { ...source, recoveredAt: this.now().toISOString() };
  }

  async createPlan({ orderReference, itemId, replacementSku, targetWarehouse = "" } = {}) {
    const reference = text(orderReference); const wantedItemId = text(itemId); const wantedSku = sku(replacementSku);
    const rawTargetWarehouse = String(targetWarehouse ?? ""); const wantedWarehouse = text(rawTargetWarehouse);
    if (!/^[A-Za-z0-9_-]{4,100}$/.test(reference) || !/^\d{1,40}$/.test(wantedItemId) || !wantedSku || wantedSku.length > 160) {
      throw coded("SKU_REPLACEMENT_PLAN_INVALID", "订单、商品行或替换 SKU 无效");
    }
    if (wantedWarehouse.length > 160 || /[\u0000-\u001f\u007f]/.test(rawTargetWarehouse)) {
      throw coded("SKU_REPLACEMENT_PLAN_INVALID", "目标仓库无效");
    }
    const account = this.credentials();
    if (!account?.ok) throw coded(account?.code || "MABANG_ACCOUNT_NOT_CONNECTED", account?.message || "请先连接马帮账号");
    const inspected = await this.runWorker({ action: "order-warehouse-inspect", username: account.username, password: account.password, orderReference: reference });
    const order = inspected.order;
    if (!order?.shopId || !this.hasShopAccess(order.shopId)) throw coded("SKU_REPLACEMENT_SHOP_ACCESS_REVOKED", "该订单店铺不属于当前马帮账号权限范围");
    if (order.trackNumber) throw coded("SKU_REPLACEMENT_ORDER_SHIPPED", "订单已有物流单号，禁止更换 SKU");
    const item = (order.items || []).find((candidate) => text(candidate.itemId) === wantedItemId && !ignored(candidate));
    if (!item) throw coded("SKU_REPLACEMENT_ITEM_CHANGED", "订单商品行已变化，请重新读取");
    if (item.isCombo || /(A包|B包|配件包|套装|组合)/i.test(text(item.title))) throw coded("SKU_REPLACEMENT_COMBO_BLOCKED", "组合商品暂不支持自动更换 SKU");
    const currentWarehouse = text(item.stockWarehouseName);
    const allowedWarehouses = uniqueWarehouses(this.allowedWarehouses(order.shopId));
    const inventoryResponse = await this.runWorker({ action: "inventory", compact: false,
      warehouseNames: uniqueWarehouses([...(order.items || []).filter((candidate) => !ignored(candidate)).map((candidate) => candidate.stockWarehouseName), ...allowedWarehouses]),
      username: account.username, password: account.password });
    const inventory = aggregateReplacementInventory(inventoryResponse.records || []);
    const candidateIndex = await createReplacementCandidateIndexAsync(inventory);
    const routeInventoryLedger = createSkuWarehouseInventoryLedger(inventory);
    const currentInventory = inventory.find((row) => row.sku === sku(item.stockSku)
      && warehouseKey(row.warehouse) === warehouseKey(currentWarehouse));
    const productInventory = (currentInventory?.name ? currentInventory : null)
      || inventory.find((row) => row.sku === sku(item.stockSku) && row.name);
    const chineseName = productInventory?.name || text(item.title);
    const nameConfidence = productInventory?.nameConfidence || "MISSING";
    const available = currentInventory?.available || 0;
    if (number(item.quantity) <= available) throw coded("SKU_REPLACEMENT_NOT_SHORT", "原 SKU 当前库存已足够，无需更换");
    const activeItems = (order.items || []).filter((candidate) => !ignored(candidate));
    const candidate = routedReplacementCandidates({ items: activeItems, item, chineseName, nameConfidence, allowedWarehouses, inventory,
      candidateIndex, routeInventoryLedger, limit: 50 })
      .find((entry) => entry.sku === wantedSku);
    if (!candidate) throw coded("SKU_REPLACEMENT_CANDIDATE_CHANGED", "所选 SKU 已不满足同款、库存及整单定仓规则，请重新读取");
    const selectedRoute = wantedWarehouse
      ? candidate.warehouseAlternatives.find((route) => warehouseKey(route.warehouse) === warehouseKey(wantedWarehouse))
      : candidate.warehouseAlternatives[0];
    if (!selectedRoute) throw coded("SKU_REPLACEMENT_TARGET_WAREHOUSE_INVALID", "目标仓库不在可选范围，请重新读取");
    const selectedInventory = inventory.find((row) => row.sku === candidate.sku
      && warehouseKey(row.warehouse) === warehouseKey(selectedRoute.warehouse));
    const replacement = { ...candidate, warehouse: selectedRoute.warehouse, available: selectedInventory?.available || 0,
      warehouseMode: selectedRoute.mode, targetWarehouse: selectedRoute.warehouse };
    const resolved = await this.runWorker({ action: "order-sku-resolve", username: account.username, password: account.password, replacementSku: wantedSku });
    const createdAt = this.now();
    const record = { version: SKU_REPLACEMENT_SCHEMA_VERSION, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + PLAN_TTL_MS).toISOString(),
      order: { internalOrderId: text(order.internalOrderId), platformOrderId: text(order.platformOrderId || reference), shopId: text(order.shopId),
        platformId: text(order.platformId), orderStatus: text(order.orderStatus) },
      item: { itemId: wantedItemId, originalSku: text(item.stockSku), chineseName,
        nameSource: productInventory?.nameSource || "", nameConfidence, quantity: number(item.quantity), currentWarehouse, available },
      replacement, replacementStockId: text(resolved.result?.stockId), warehouseMode: selectedRoute.mode,
      targetWarehouse: selectedRoute.warehouse, warehouseAlternatives: candidate.warehouseAlternatives,
      prospectiveItems: candidate.prospectiveItems,
      preWriteEvidence: preWriteEvidence({ activeItems, allowedWarehouses, inventory, candidate, selectedRoute }) };
    if (!record.replacementStockId) throw coded("SKU_REPLACEMENT_STOCK_ID_MISSING", "马帮未返回替换 SKU 的库存标识");
    record.planHash = hash(record);
    record.approvalText = `确认更换SKU并整单定仓 ${record.order.platformOrderId} ${record.item.originalSku} -> ${record.replacement.sku} -> ${record.targetWarehouse}`;
    this.plans.set(record.planHash, record);
    this.write("previews", record.planHash, record);
    return record;
  }

  restorePlan(record) {
    if (!record?.planHash || !record?.order?.platformOrderId || !record?.item?.itemId || !record?.replacement?.sku) {
      throw coded("SKU_REPLACEMENT_PLAN_INVALID", "更换计划记录无效");
    }
    if (record.version !== SKU_REPLACEMENT_SCHEMA_VERSION) {
      throw coded("PREVIEW_SCHEMA_OBSOLETE", "更换计划由旧版安全规则生成，禁止执行，请重新读取");
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) throw coded("SKU_REPLACEMENT_PLAN_EXPIRED", "更换计划已过期，请重新读取");
    const expectedHash = hash(Object.fromEntries(Object.entries(record).filter(([key]) => !["planHash", "approvalText"].includes(key))));
    if (record.planHash !== expectedHash) throw coded("SKU_REPLACEMENT_PLAN_HASH_INVALID", "更换计划校验失败");
    const expectedApproval = `确认更换SKU并整单定仓 ${record.order.platformOrderId} ${record.item.originalSku} -> ${record.replacement.sku} -> ${record.targetWarehouse}`;
    if (text(record.approvalText) !== expectedApproval) throw coded("SKU_REPLACEMENT_APPROVAL_INVALID", "更换计划确认文字校验失败");
    this.plans.set(record.planHash, record);
    return record;
  }

  async execute({ planHash, approvalText } = {}) {
    const record = this.plans.get(text(planHash));
    if (!record) throw coded("SKU_REPLACEMENT_PLAN_NOT_FOUND", "更换计划不存在或已经执行，请重新读取");
    if (record.version !== SKU_REPLACEMENT_SCHEMA_VERSION) {
      this.plans.delete(record.planHash);
      throw coded("PREVIEW_SCHEMA_OBSOLETE", "更换计划由旧版安全规则生成，禁止执行，请重新读取");
    }
    if (this.now().getTime() >= Date.parse(record.expiresAt)) { this.plans.delete(record.planHash); throw coded("SKU_REPLACEMENT_PLAN_EXPIRED", "更换计划已过期，请重新读取"); }
    if (text(approvalText) !== record.approvalText) throw coded("SKU_REPLACEMENT_APPROVAL_INVALID", `请输入完整确认文字：${record.approvalText}`);
    if (record.planHash !== hash(Object.fromEntries(Object.entries(record).filter(([key]) => !["planHash", "approvalText"].includes(key))))) throw coded("SKU_REPLACEMENT_PLAN_HASH_INVALID", "更换计划校验失败");
    const account = this.credentials();
    if (!account?.ok || !this.hasShopAccess(record.order.shopId)) throw coded("SKU_REPLACEMENT_ACCESS_CHANGED", "账号或店铺权限已变化，请重新读取");
    this.plans.delete(record.planHash);
    const phaseState = { phase: "PRE_SKU_WRITE", warehousePreviewAttempted: false, warehouseWriteAttempted: false,
      warehouseWriteConfirmed: false, observedSku: "", finalWarehouses: [] };
    try {
      const inspected = await this.runWorker({ action: "order-warehouse-inspect", username: account.username, password: account.password,
        orderReference: record.order.platformOrderId });
      const currentOrder = inspected.order;
      const activeItems = (currentOrder?.items || []).filter((item) => !ignored(item));
      const currentAllowedWarehouses = uniqueWarehouses(this.allowedWarehouses(currentOrder?.shopId));
      const freshInventoryWarehouses = uniqueWarehouses([
        ...(record.preWriteEvidence?.inventoryWarehouses || []),
        ...activeItems.map((item) => item.stockWarehouseName),
        ...currentAllowedWarehouses,
        record.targetWarehouse,
      ]);
      const inventoryResponse = await this.runWorker({ action: "inventory", compact: false, warehouseNames: freshInventoryWarehouses,
        username: account.username, password: account.password });
      const inventory = aggregateReplacementInventory(inventoryResponse.records || []);
      const candidateIndex = await createReplacementCandidateIndexAsync(inventory);
      const routeInventoryLedger = createSkuWarehouseInventoryLedger(inventory);
      const currentItem = activeItems.find((item) => text(item.itemId) === record.item.itemId);
      const freshCandidate = currentItem && routedReplacementCandidates({ items: activeItems, item: currentItem,
        chineseName: record.item.chineseName, nameConfidence: record.item.nameConfidence,
        allowedWarehouses: currentAllowedWarehouses, inventory,
        candidateIndex, routeInventoryLedger, limit: 50 })
        .find((candidate) => candidate.sku === record.replacement.sku);
      const freshSelectedRoute = freshCandidate?.warehouseAlternatives.find((route) => route.mode === record.warehouseMode
        && warehouseKey(route.warehouse) === warehouseKey(record.targetWarehouse));
      const currentEvidence = freshCandidate && freshSelectedRoute ? preWriteEvidence({ activeItems,
        allowedWarehouses: currentAllowedWarehouses, inventory, candidate: freshCandidate, selectedRoute: freshSelectedRoute }) : null;
      if (!currentOrder?.shopId || text(currentOrder.shopId) !== record.order.shopId || !this.hasShopAccess(currentOrder.shopId)
          || currentOrder.trackNumber || !currentItem || !currentEvidence
          || stable(currentEvidence) !== stable(record.preWriteEvidence)) {
        throw coded("SKU_REPLACEMENT_PRECONDITION_CHANGED", "订单商品、店铺仓库规则或库存已变化，请重新读取并生成计划");
      }
      const response = await this.runWorker({ action: "order-sku-change", commit: "ORDER_SKU_CHANGE_CONFIRMED",
        username: account.username, password: account.password, orderReference: record.order.platformOrderId,
        itemId: record.item.itemId, originalSku: record.item.originalSku, replacementSku: record.replacement.sku,
        expectedQuantity: record.item.quantity, expectedWarehouse: record.item.currentWarehouse, expectedStockId: record.replacementStockId });
      let transferSkipped = false;
      let warehouseRouting;
      try {
        phaseState.phase = "POST_SKU_INSPECT";
        const afterSku = await this.runWorker({ action: "order-warehouse-inspect", username: account.username, password: account.password,
          orderReference: record.order.platformOrderId });
        const afterSkuState = verifiedOrderState(afterSku.order, record);
        phaseState.observedSku = afterSkuState.selectedSku;
        phaseState.finalWarehouses = afterSkuState.finalWarehouses;
        if (!afterSkuState.skuMatches) throw coded("SKU_REPLACEMENT_POST_WRITE_SKU_MISMATCH", "SKU 写入后读取结果与目标 SKU 不一致");
        if (afterSkuState.warehousesMatch) {
          transferSkipped = true;
        } else {
          phaseState.phase = "WAREHOUSE_PREVIEW";
          if (!this.warehouseTransferService) throw coded("WAREHOUSE_SERVICE_UNAVAILABLE", "换仓服务不可用");
          phaseState.warehousePreviewAttempted = true;
          const warehousePlan = record.warehouseMode === "KEEP_CURRENT"
            ? await this.warehouseTransferService.previewKeepCurrentReconciliation({ orderReference: record.order.platformOrderId,
              targetWarehouse: record.targetWarehouse, expectedItems: record.prospectiveItems })
            : await this.warehouseTransferService.preview({ orderReference: record.order.platformOrderId,
              targetWarehouse: record.targetWarehouse });
          phaseState.phase = "WAREHOUSE_EXECUTE";
          phaseState.warehouseWriteAttempted = true;
          await this.warehouseTransferService.execute({ planHash: warehousePlan.planHash, approvalText: warehousePlan.approvalText });
          phaseState.warehouseWriteConfirmed = true;
        }
        phaseState.phase = "FINAL_VERIFY";
        const finalInspection = await this.runWorker({ action: "order-warehouse-inspect", username: account.username, password: account.password,
          orderReference: record.order.platformOrderId });
        const finalState = verifiedOrderState(finalInspection.order, record);
        phaseState.observedSku = finalState.selectedSku;
        phaseState.finalWarehouses = finalState.finalWarehouses;
        if (!finalState.skuMatches || !finalState.warehousesMatch) {
          throw coded("SKU_REPLACEMENT_FINAL_STATE_MISMATCH", "最终 SKU 或整单仓库与计划不一致");
        }
        warehouseRouting = { mode: record.warehouseMode, targetWarehouse: record.targetWarehouse,
          transferSkipped, finalWarehouses: finalState.finalWarehouses };
      } catch (error) {
        throw warehouseVerificationError(record, phaseState, error);
      }
      const skuResult = response?.result && typeof response.result === "object" ? response.result : { skuChange: response?.result };
      const completed = { ...record, executedAt: this.now().toISOString(), status: "COMPLETED",
        result: { ...skuResult, warehouseRouting } };
      this.write("executions", record.planHash, completed);
      return completed;
    } catch (error) {
      const code = text(error?.code || "SKU_REPLACEMENT_EXECUTE_FAILED");
      this.write("executions", record.planHash, {
        ...record,
        executedAt: this.now().toISOString(),
        status: /VERIFY_FAILED$/.test(code) ? "MANUAL_REVIEW" : "FAILED",
        code,
        message: text(error?.message || "SKU 更换失败").slice(0, 500),
        diagnostic: error?.diagnostic || null,
      });
      throw error;
    }
  }

  write(folder, id, value) {
    const directory = path.join(this.historyDir, folder); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.json`); const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(temporary, file);
  }
}
