export const DATA_SCOPE = Object.freeze({
  GLOBAL: "GLOBAL",
  MODULE_LOCAL: "MODULE_LOCAL",
});

export const DATA_ACCESS_MODE = Object.freeze({
  READ: "READ",
  WRITE: "WRITE",
  ADMIN: "ADMIN",
});

export const DATA_SOURCE_CODES = Object.freeze({
  MABANG_ORDERS: "MABANG_ORDERS",
  MABANG_INVENTORY: "MABANG_INVENTORY",
  PRODUCT_PACKAGE_DB: "PRODUCT_PACKAGE_DB",
  PRICE_CONTROL_DB: "PRICE_CONTROL_DB",
  SHOP_MASTER: "SHOP_MASTER",
  PLATFORM_CONNECTOR: "PLATFORM_CONNECTOR",
});

// Values persisted by existing ingestion pipelines. Keep these separate from
// dataset codes: a source-system identity is not a business dataset identity.
export const SOURCE_SYSTEM_VALUES = Object.freeze({
  MABANG: "mabang",
  MABANG_ORDER_BATCH: "mabang_order",
  MABANG_INVENTORY_BATCH: "mabang_inventory",
  PRODUCT_PACKAGE: "ai_project_a_product_package",
  PRICE_CONTROL: "ai_project_a",
  SHOP_MASTER: "commerce_shop_registry",
  PLATFORM_GATEWAY: "platform_gateway",
});

export const PRODUCT_PACKAGE_SOURCE_SYSTEM = SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE;
export const PRICE_CONTROL_SOURCE_SYSTEM = SOURCE_SYSTEM_VALUES.PRICE_CONTROL;

export const DATASET_CODES = Object.freeze({
  MABANG_ORDER_FACTS: "MABANG_ORDER_FACTS",
  MABANG_INVENTORY_CURRENT: "MABANG_INVENTORY_CURRENT",
  PRODUCT_PACKAGE_CURRENT: "PRODUCT_PACKAGE_CURRENT",
  PRODUCT_MASTER_CURRENT: "PRODUCT_MASTER_CURRENT",
  PRICE_CONTROL_CURRENT: "PRICE_CONTROL_CURRENT",
  SHOP_MASTER_CURRENT: "SHOP_MASTER_CURRENT",
  PRICE_CONTROL_SHOP_SCOPE: "PRICE_CONTROL_SHOP_SCOPE",
  PLATFORM_API_CONTROL: "PLATFORM_API_CONTROL",
});

export const DATA_MODULES = Object.freeze({
  SALES_ASSORTMENT: "sales_assortment",
  PRICE_CONTROL: "price_control",
  PRODUCT_CENTER: "product_center",
  PLATFORM_CONNECTIONS: "platform_connections",
  GROWTH_RADAR: "growth_radar",
});

const allowedScopes = new Set(Object.values(DATA_SCOPE));
const allowedAccessModes = new Set(Object.values(DATA_ACCESS_MODE));

function requiredText(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function normalizedList(value) {
  return Object.freeze([...new Set((value || []).map((item) => requiredText(item, "consumer module")))]);
}

export function defineDatasetContract(input) {
  if (!input || typeof input !== "object") throw new TypeError("dataset contract is required");
  const code = requiredText(input.code, "dataset code");
  const sourceCode = requiredText(input.sourceCode, "source code");
  const scope = requiredText(input.scope, "dataset scope").toUpperCase();
  if (!allowedScopes.has(scope)) throw new TypeError(`unsupported dataset scope: ${scope}`);
  const ownerModuleId = requiredText(input.ownerModuleId, "owner module id");
  const consumers = normalizedList(input.consumers);
  if (scope === DATA_SCOPE.MODULE_LOCAL && consumers.some((moduleId) => moduleId !== ownerModuleId)) {
    throw new TypeError(`module-local dataset ${code} cannot bind a foreign consumer`);
  }
  return Object.freeze({
    code,
    name: requiredText(input.name, "dataset name"),
    sourceCode,
    persistedSourceValue: input.persistedSourceValue ? requiredText(input.persistedSourceValue, "persisted source value") : null,
    sourceRelation: requiredText(input.sourceRelation, "source relation"),
    canonicalRelation: requiredText(input.canonicalRelation, "canonical relation"),
    scope,
    ownerModuleId,
    consumers,
    grain: requiredText(input.grain, "dataset grain"),
    businessKeys: normalizedList(input.businessKeys),
    contractVersion: requiredText(input.contractVersion || "1.0.0", "contract version"),
    freshnessSlaMinutes: Math.max(0, Number(input.freshnessSlaMinutes || 0)),
  });
}

const contracts = [
  defineDatasetContract({
    code: DATASET_CODES.MABANG_ORDER_FACTS,
    name: "马帮订单事实",
    sourceCode: DATA_SOURCE_CODES.MABANG_ORDERS,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.MABANG_ORDER_BATCH,
    sourceRelation: "app.growth_order_headers + app.growth_order_lines",
    canonicalRelation: "app.canonical_mabang_order_lines_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.SALES_ASSORTMENT,
    consumers: [DATA_MODULES.SALES_ASSORTMENT, DATA_MODULES.GROWTH_RADAR],
    grain: "one current order line",
    businessKeys: ["source_order_id", "source_line_key"],
    freshnessSlaMinutes: 24 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.MABANG_INVENTORY_CURRENT,
    name: "马帮当前库存",
    sourceCode: DATA_SOURCE_CODES.MABANG_INVENTORY,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.MABANG_INVENTORY_BATCH,
    sourceRelation: "app.growth_inventory_snapshots",
    canonicalRelation: "app.canonical_mabang_inventory_current_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.SALES_ASSORTMENT,
    consumers: [DATA_MODULES.SALES_ASSORTMENT, DATA_MODULES.GROWTH_RADAR],
    grain: "one SKU and warehouse in the latest applied snapshot",
    businessKeys: ["normalized_source_sku", "normalized_warehouse_name", "snapshot_at"],
    freshnessSlaMinutes: 24 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.PRODUCT_PACKAGE_CURRENT,
    name: "当前产品包",
    sourceCode: DATA_SOURCE_CODES.PRODUCT_PACKAGE_DB,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE,
    sourceRelation: "app.product_package_rows",
    canonicalRelation: "app.canonical_product_package_current_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.PRODUCT_CENTER,
    consumers: [DATA_MODULES.PRODUCT_CENTER, DATA_MODULES.SALES_ASSORTMENT, DATA_MODULES.GROWTH_RADAR],
    grain: "one country, SKU, warehouse and row occurrence",
    businessKeys: ["source_row_key"],
    freshnessSlaMinutes: 24 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.PRICE_CONTROL_CURRENT,
    name: "当前控价",
    sourceCode: DATA_SOURCE_CODES.PRICE_CONTROL_DB,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.PRICE_CONTROL,
    sourceRelation: "app.product_sku_current_prices",
    canonicalRelation: "app.canonical_price_control_current_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.PRICE_CONTROL,
    consumers: [DATA_MODULES.PRICE_CONTROL],
    grain: "one country, SKU, platform, shop type and price type",
    businessKeys: ["price_key"],
    freshnessSlaMinutes: 2 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.PRODUCT_MASTER_CURRENT,
    name: "当前产品主数据",
    sourceCode: DATA_SOURCE_CODES.PRODUCT_PACKAGE_DB,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.PRODUCT_PACKAGE,
    sourceRelation: "app.product_skus",
    canonicalRelation: "app.canonical_product_sku_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.PRODUCT_CENTER,
    consumers: [DATA_MODULES.PRODUCT_CENTER, DATA_MODULES.SALES_ASSORTMENT, DATA_MODULES.GROWTH_RADAR],
    grain: "one country and stock SKU",
    businessKeys: ["canonical_product_id"],
    freshnessSlaMinutes: 24 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.SHOP_MASTER_CURRENT,
    name: "店铺主数据",
    sourceCode: DATA_SOURCE_CODES.SHOP_MASTER,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.SHOP_MASTER,
    sourceRelation: "app.commerce_shop_registry",
    canonicalRelation: "app.canonical_shop_master_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.PLATFORM_CONNECTIONS,
    consumers: [DATA_MODULES.PRICE_CONTROL, DATA_MODULES.PLATFORM_CONNECTIONS, DATA_MODULES.SALES_ASSORTMENT, DATA_MODULES.GROWTH_RADAR],
    grain: "one platform seller shop",
    businessKeys: ["platform", "provider_shop_id"],
    freshnessSlaMinutes: 24 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.PRICE_CONTROL_SHOP_SCOPE,
    name: "控价店铺适用范围",
    sourceCode: DATA_SOURCE_CODES.PRICE_CONTROL_DB,
    sourceRelation: "app.product_sku_current_prices + app.commerce_shop_registry",
    canonicalRelation: "app.canonical_price_control_shop_v",
    scope: DATA_SCOPE.GLOBAL,
    ownerModuleId: DATA_MODULES.PRICE_CONTROL,
    consumers: [DATA_MODULES.PRICE_CONTROL],
    grain: "one current controlled price applied to one active shop",
    businessKeys: ["price_key", "shop_id"],
    freshnessSlaMinutes: 2 * 60,
  }),
  defineDatasetContract({
    code: DATASET_CODES.PLATFORM_API_CONTROL,
    name: "平台 API 控制面",
    sourceCode: DATA_SOURCE_CODES.PLATFORM_CONNECTOR,
    persistedSourceValue: SOURCE_SYSTEM_VALUES.PLATFORM_GATEWAY,
    sourceRelation: "app.platform_api_application_profiles + app.commerce_shop_account_bindings + app.shop_external_identities",
    canonicalRelation: "app.canonical_shop_platform_api_v",
    scope: DATA_SCOPE.MODULE_LOCAL,
    ownerModuleId: DATA_MODULES.PLATFORM_CONNECTIONS,
    consumers: [DATA_MODULES.PLATFORM_CONNECTIONS],
    grain: "one shop and API application binding with capability set",
    businessKeys: ["shop_id", "account_id"],
    freshnessSlaMinutes: 15,
  }),
];

export const UNIFIED_DATASET_CATALOG = Object.freeze(Object.fromEntries(
  contracts.map((contract) => [contract.code, contract]),
));

export function getDatasetContract(datasetCode) {
  const code = requiredText(datasetCode, "dataset code");
  const contract = UNIFIED_DATASET_CATALOG[code];
  if (!contract) throw new TypeError(`unknown dataset: ${code}`);
  return contract;
}

export function defineModuleBinding({ datasetCode, moduleId, accessMode = DATA_ACCESS_MODE.READ } = {}) {
  const contract = getDatasetContract(datasetCode);
  const normalizedModuleId = requiredText(moduleId, "module id");
  const normalizedAccess = requiredText(accessMode, "access mode").toUpperCase();
  if (!allowedAccessModes.has(normalizedAccess)) throw new TypeError(`unsupported access mode: ${normalizedAccess}`);
  if (contract.scope === DATA_SCOPE.MODULE_LOCAL && normalizedModuleId !== contract.ownerModuleId) {
    throw new TypeError(`dataset ${contract.code} is local to ${contract.ownerModuleId}`);
  }
  return Object.freeze({ datasetCode: contract.code, moduleId: normalizedModuleId, accessMode: normalizedAccess });
}

export const DEFAULT_MODULE_BINDINGS = Object.freeze(contracts.flatMap((contract) => {
  const bindings = contract.consumers.map((moduleId) => defineModuleBinding({
    datasetCode: contract.code,
    moduleId,
    accessMode: DATA_ACCESS_MODE.READ,
  }));
  if (!bindings.some((binding) => binding.moduleId === contract.ownerModuleId)) {
    bindings.push(defineModuleBinding({ datasetCode: contract.code, moduleId: contract.ownerModuleId }));
  }
  return bindings;
}));

export function moduleDatasetMatrix(bindings = DEFAULT_MODULE_BINDINGS) {
  const result = {};
  for (const binding of bindings) {
    const normalized = defineModuleBinding(binding);
    result[normalized.moduleId] ||= [];
    result[normalized.moduleId].push(normalized.datasetCode);
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(result).map(([moduleId, datasetCodes]) => [moduleId, Object.freeze([...new Set(datasetCodes)].sort())]),
  ));
}
