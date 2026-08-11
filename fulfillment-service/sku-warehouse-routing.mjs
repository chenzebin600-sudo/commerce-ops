function text(value) { return String(value ?? "").trim(); }
function sku(value) { return text(value).replace(/\s+/g, "").toUpperCase(); }
function quantity(value) {
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function warehouseScope(value) {
  return String(value ?? "").trim().replace(/\/[-\d.]+$/, "").trim();
}
export function warehouseKey(value) {
  return warehouseScope(value).replace(/\s+/g, "").toUpperCase();
}

function itemSku(item) { return sku(item.stockSku ?? item.sku); }
function itemWarehouse(item) { return warehouseScope(item.stockWarehouseName ?? item.currentWarehouse ?? item.warehouse); }
function itemId(item) { return text(item.itemId ?? item.id); }
function optionWarehouse(option) {
  if (option && typeof option === "object") return warehouseScope(option.text ?? option.name ?? option.warehouse);
  return warehouseScope(option);
}

function inventoryLedger(records = []) {
  const ledger = new Map();
  for (const row of records) {
    const warehouse = warehouseKey(row?.["仓库"] ?? row?.warehouse);
    const inventorySku = sku(row?.["库存SKU编号"] ?? row?.["SKU"] ?? row?.sku);
    if (!warehouse || !inventorySku) continue;
    const key = `${warehouse}\u0000${inventorySku}`;
    ledger.set(key, (ledger.get(key) || 0) + quantity(row?.["可用库存量"] ?? row?.["可用库存"] ?? row?.["可用量"] ?? row?.availableQuantity ?? row?.available));
  }
  return ledger;
}

function requirements(items) {
  const required = new Map();
  for (const item of items) {
    const currentSku = itemSku(item);
    if (!currentSku) continue;
    required.set(currentSku, (required.get(currentSku) || 0) + quantity(item.quantity));
  }
  return required;
}

function routeFor({ mode, warehouse, required, ledger }) {
  const key = warehouseKey(warehouse);
  const stock = [...required].map(([requiredSku, requiredQuantity]) => ({
    sku: requiredSku,
    quantity: requiredQuantity,
    available: ledger.get(`${key}\u0000${requiredSku}`) || 0,
  }));
  if (!stock.every((item) => item.available >= item.quantity)) return null;
  return {
    mode,
    warehouse,
    remaining: stock.reduce((total, item) => total + item.available - item.quantity, 0),
    stock,
  };
}

function originalWarehouse(items) {
  const warehouses = items.map(itemWarehouse).filter(Boolean);
  if (warehouses.length !== items.length || !warehouses.length) return null;
  return warehouses.every((warehouse) => warehouseKey(warehouse) === warehouseKey(warehouses[0])) ? warehouses[0] : null;
}

function exposesWarehouse(item, warehouse) {
  return (item.warehouseOptions || []).some((option) => warehouseKey(optionWarehouse(option)) === warehouseKey(warehouse));
}

export function evaluateSkuWarehouseRoutes({ items = [], replacementItemId, replacementSku, allowedWarehouses = [], inventory = [] } = {}) {
  const replacementId = text(replacementItemId);
  const replacement = sku(replacementSku);
  const prospectiveItems = (Array.isArray(items) ? items : []).map((item) =>
    itemId(item) === replacementId ? { ...item, stockSku: replacement } : { ...item });
  const required = requirements(prospectiveItems);
  const ledger = inventoryLedger(Array.isArray(inventory) ? inventory : []);
  const currentWarehouse = originalWarehouse(prospectiveItems);
  const keep = currentWarehouse ? routeFor({ mode: "KEEP_CURRENT", warehouse: currentWarehouse, required, ledger }) : null;
  if (keep) {
    return { originalWarehouse: currentWarehouse, prospectiveItems, selected: keep, alternatives: [keep] };
  }

  const moveWarehouses = [];
  const seen = new Set();
  for (const value of Array.isArray(allowedWarehouses) ? allowedWarehouses : []) {
    const warehouse = warehouseScope(value);
    const key = warehouseKey(warehouse);
    if (key && !seen.has(key)) {
      seen.add(key);
      moveWarehouses.push(warehouse);
    }
  }
  const nonReplacedItems = prospectiveItems.filter((item) => itemId(item) !== replacementId);
  const moves = moveWarehouses
    .filter((warehouse) => !currentWarehouse || warehouseKey(warehouse) !== warehouseKey(currentWarehouse))
    .filter((warehouse) => nonReplacedItems.every((item) => exposesWarehouse(item, warehouse)))
    .map((warehouse) => routeFor({ mode: "MOVE_WHOLE_ORDER", warehouse, required, ledger }))
    .filter(Boolean)
    .sort((left, right) => right.remaining - left.remaining || left.warehouse.localeCompare(right.warehouse, "zh-CN"));

  return {
    originalWarehouse: currentWarehouse,
    prospectiveItems,
    selected: moves[0] || null,
    alternatives: moves,
  };
}
