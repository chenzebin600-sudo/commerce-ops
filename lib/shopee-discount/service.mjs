import { createHash, randomUUID } from "node:crypto";
import { buildApprovalRoot } from "./approval-hash.mjs";
import { normalizeSku, parseMinorUnits, resolvePriceTier } from "./contracts.mjs";
import { decideVariantPrice } from "./pricing-engine.mjs";
import { validateWarehouseSnapshot } from "./warehouse-validator.mjs";
import { assertShopeeWriteAuthorized } from "./write-security.mjs";
import { foundationContentHash } from "../foundation/foundation-contracts.mjs";

const TIERS = new Set(["DAILY", "EVENT", "MEGA"]);
const WORKFLOWS = new Set(["CURRENT_CORRECTION", "NEXT_RENEWAL"]);
const PREVIEW_FIELDS = new Set([
  "country", "shopIds", "useDefaultShops", "workflow", "defaultTier", "shopOverrides",
  "linkOverrides", "category", "activitySelection", "renewal",
]);
const APPROVAL_FIELDS = new Set(["planId", "merkleRoot", "operatorName", "confirmationText", "privilegedApproval"]);
const EXECUTION_FIELDS = new Set(["planId", "merkleRoot"]);
const INACTIVE = new Set(["UNAVAILABLE", "DELETED", "BANNED", "REVIEW_FAILED", "REVIEW_FAIL", "FAILED"]);

function domainError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", `${name} must be an object`);
  }
  return value;
}

function exactFields(value, allowed, name) {
  object(value, name);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", `${name} contains unknown field ${unknown}`);
}

function requiredText(value, name, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", `${name} is invalid`);
  }
  return value.trim();
}

function canonicalId(value, name) {
  const id = requiredText(value, name, 100);
  if (!/^[1-9]\d*$/.test(id)) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", `${name} is invalid`);
  return id;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "A valid timestamp is required");
  return date.toISOString();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function payloadData(result) {
  return result?.data?.response ?? result?.data ?? result?.response ?? result ?? {};
}

function arrayAt(value, names) {
  for (const name of names) if (Array.isArray(value?.[name])) return value[name];
  return [];
}

function scalarId(value) {
  if (["string", "number", "bigint"].includes(typeof value)) return String(value);
  return "";
}

function statusOf(value) {
  return String(value ?? "NORMAL").trim().toUpperCase();
}

function isActive(value) {
  const status = statusOf(value);
  return status === "NORMAL" || status === "ACTIVE" || status === "ENABLED";
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const number = Number(value);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function minor(value, scale, name) {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return parseMinorUnits(String(value), scale).toString();
  if (typeof value === "string" && /^(?:0|\d+)\.\d+$/.test(value)) return parseMinorUnits(value, scale).toString();
  throw domainError("SHOPEE_DISCOUNT_LISTING_INVALID", `${name} is invalid`);
}

function priceValue(model, item, names) {
  for (const source of [model, item]) {
    for (const name of names) if (source?.[name] != null) return source[name];
    for (const price of arrayAt(source, ["price_info", "priceInfo"])) {
      for (const name of names) if (price?.[name] != null) return price[name];
    }
  }
  return null;
}

function stockValue(model, item) {
  const direct = model?.stock ?? model?.stock_info?.stock ?? item?.stock ?? item?.stock_info?.stock;
  if (Number.isFinite(Number(direct))) return Number(direct);
  const seller = arrayAt(model?.stock_info_v2 ?? item?.stock_info_v2, ["seller_stock", "sellerStock"]);
  return seller.reduce((sum, entry) => sum + Math.max(0, Number(entry?.stock) || 0), 0);
}

function listPage(data) {
  return {
    rows: arrayAt(data, ["item", "item_list", "items"]),
    hasMore: Boolean(data?.has_next_page ?? data?.has_more ?? data?.more),
    nextCursor: scalarId(data?.next_offset ?? data?.next_cursor ?? data?.nextCursor),
  };
}

function discountPage(data) {
  return {
    rows: arrayAt(data, ["discount_list", "discounts"]),
    hasMore: Boolean(data?.more ?? data?.has_next_page),
  };
}

function normalizeShops(result, authorized) {
  const data = payloadData(result);
  const rows = Array.isArray(data) ? data : arrayAt(data, ["shops", "shop_list", "list"]);
  const allowed = authorized ? new Set(authorized.map(String)) : null;
  return rows.map((row) => ({
    shopId: scalarId(row.shop_id ?? row.shopId),
    country: String(row.country ?? row.region ?? row.site ?? "").trim().toUpperCase(),
    name: String(row.shop_name ?? row.shopName ?? row.name ?? "").trim(),
    healthy: row.healthy !== false && !new Set(["DISABLED", "ERROR", "EXPIRED", "BANNED", "UNHEALTHY"]).has(statusOf(row.health_status ?? row.healthStatus ?? row.status)),
  })).filter((row) => /^[1-9]\d*$/.test(row.shopId) && /^[A-Z]{2,3}$/.test(row.country) && (!allowed || allowed.has(row.shopId)));
}

function validateTierEntries(entries, name, keyOf) {
  if (!Array.isArray(entries)) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", `${name} must be an array`);
  const output = new Map();
  for (const entry of entries) {
    object(entry, name);
    const allowed = name === "linkOverrides" ? new Set(["shopId", "itemId", "priceTier", "note"])
      : name === "activitySelection" ? new Set(["shopId", "discountId", "priceTier"])
        : new Set(["shopId", "priceTier"]);
    exactFields(entry, allowed, name);
    const tier = requiredText(entry.priceTier, `${name}.priceTier`, 20).toUpperCase();
    if (!TIERS.has(tier)) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", `${name}.priceTier is unsupported`);
    const normalized = {
      shopId: canonicalId(entry.shopId, `${name}.shopId`),
      ...(entry.itemId == null ? {} : { itemId: canonicalId(entry.itemId, `${name}.itemId`) }),
      ...(entry.discountId == null ? {} : { discountId: canonicalId(entry.discountId, `${name}.discountId`) }),
      priceTier: tier,
      ...(entry.note == null ? {} : { note: requiredText(entry.note, `${name}.note`, 200) }),
    };
    const key = keyOf(normalized);
    if (output.has(key)) throw domainError("SHOPEE_DISCOUNT_OVERRIDE_CONFLICT", `Duplicate or conflicting ${name}`);
    output.set(key, normalized);
  }
  return output;
}

function validatePreviewInput(input) {
  exactFields(input, PREVIEW_FIELDS, "preview");
  const country = requiredText(input.country, "country", 3).toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(country)) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "country is invalid");
  const workflow = requiredText(input.workflow, "workflow", 30).toUpperCase();
  const defaultTier = requiredText(input.defaultTier, "defaultTier", 20).toUpperCase();
  if (!WORKFLOWS.has(workflow) || !TIERS.has(defaultTier)) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "workflow or tier is unsupported");
  if (!Array.isArray(input.shopIds)) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "shopIds must be an array");
  const shopIds = input.shopIds.map((id) => canonicalId(id, "shopIds"));
  if (new Set(shopIds).size !== shopIds.length) throw domainError("SHOPEE_DISCOUNT_OVERRIDE_CONFLICT", "Duplicate shop IDs are not allowed");
  if (shopIds.length && input.useDefaultShops === true) throw domainError("SHOPEE_DISCOUNT_SHOP_SCOPE_CONFLICT", "Explicit and default shop scopes cannot be combined");
  if (!shopIds.length && input.useDefaultShops !== true) throw domainError("SHOPEE_DISCOUNT_SHOP_SCOPE_REQUIRED", "An explicit shop scope is required");
  if (input.useDefaultShops != null && typeof input.useDefaultShops !== "boolean") throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "useDefaultShops must be boolean");
  const category = requiredText(input.category, "category", 100);
  const shopOverrides = validateTierEntries(input.shopOverrides, "shopOverrides", (entry) => entry.shopId);
  const linkOverrides = validateTierEntries(input.linkOverrides, "linkOverrides", (entry) => `${entry.shopId}\u001f${entry.itemId}`);
  const activitySelection = validateTierEntries(input.activitySelection ?? [], "activitySelection", (entry) => `${entry.shopId}\u001f${entry.discountId}`);
  let renewal = null;
  if (workflow === "NEXT_RENEWAL") {
    exactFields(input.renewal, new Set(["requestedStartAt", "durationDays"]), "renewal");
    if (input.renewal.durationDays !== 30) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "renewal durationDays must be 30");
    renewal = { requestedStartAt: iso(input.renewal.requestedStartAt), durationDays: 30 };
  } else if (input.renewal != null) {
    throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "renewal is only valid for NEXT_RENEWAL");
  }
  return { country, shopIds, useDefaultShops: input.useDefaultShops === true, workflow, defaultTier, category, shopOverrides, linkOverrides, activitySelection, renewal };
}

function approvalItem(variant, decision, tier, watermark, ruleSource) {
  return {
    shop_id: variant.shopId,
    item_id: variant.itemId,
    model_id: variant.modelId,
    country: variant.country,
    sku: variant.sku,
    original_minor: variant.originalMinor,
    target_minor: decision.targetMinor,
    price_source: decision.source,
    price_tier: tier,
    rule_source: ruleSource,
    warehouse_watermark: watermark,
  };
}

function parseJson(value, fallback = {}) {
  try { return typeof value === "string" ? JSON.parse(value) : (value ?? fallback); } catch { return fallback; }
}

function mapPlanItem(row) {
  return {
    id: row.id,
    planId: row.plan_id,
    shopId: row.shop_id,
    itemId: row.item_id,
    modelId: row.model_id,
    sku: row.sku,
    currency: row.currency,
    scale: Number(row.scale),
    currentPriceMinor: row.current_price_minor,
    controlPriceMinor: row.control_price_minor,
    targetPriceMinor: row.target_price_minor,
    payloadHash: row.payload_hash,
    payload: parseJson(row.payload_json),
    executionStatus: row.execution_status,
    executionReasonCode: row.execution_reason_code,
  };
}

export class ShopeeDiscountService {
  constructor({ repository, foundation, shopee, warehouse, writeSecurity, now = () => new Date(), approvalTtlMs = 10 * 60_000,
    siteCapability = {}, shardSize = 500, policy = null } = {}) {
    if (!repository || !foundation?.operationPlans || !shopee || !warehouse || typeof writeSecurity !== "function") {
      throw new TypeError("Shopee Discount service dependencies are required");
    }
    if (!Number.isSafeInteger(shardSize) || shardSize < 1 || shardSize > 1000) throw new TypeError("shardSize is invalid");
    this.repository = repository;
    this.provider = repository.provider;
    this.foundation = foundation;
    this.shopee = shopee;
    this.warehouse = warehouse;
    this.writeSecurity = writeSecurity;
    this.now = now;
    this.approvalTtlMs = Math.max(1_000, Math.min(24 * 60 * 60_000, Number(approvalTtlMs) || 0));
    this.site = {
      currency: requiredText(siteCapability.currency ?? "THB", "site currency", 10),
      scale: Number.isSafeInteger(siteCapability.scale) ? siteCapability.scale : 2,
      minMinor: String(siteCapability.minMinor ?? "1"),
      maxMinor: String(siteCapability.maxMinor ?? "999999999"),
      stepMinor: String(siteCapability.stepMinor ?? "1"),
    };
    this.shardSize = shardSize;
    this.policy = policy || (() => {
      const value = { version: 1, fallback: "ORIGINAL_1_PERCENT_OFF", staleApprovalWarningDays: 35 };
      return { hash: foundationContentHash(value), value };
    });
  }

  async status() {
    const [storageMode, settings] = await Promise.all([this.repository.getStorageMode(), this.repository.getSettings()]);
    return {
      storageMode,
      writeSecurity: this.writeSecurity().safeStatus,
      enabled: settings?.enabled === true,
      warehouseConfigured: Boolean(settings?.encryptedWarehouseKeyCiphertext || settings?.warehouseKeyReference),
    };
  }

  async listShops(context = {}) {
    const rows = normalizeShops(await this.shopee.listShops({ requestId: context.requestId }), context.authorizedShopIds);
    return rows.filter((row) => row.healthy);
  }

  async #selectedShops(input, context) {
    const all = await this.listShops(context);
    const countryShops = all.filter((shop) => shop.country === input.country);
    const selected = input.useDefaultShops ? countryShops : input.shopIds.map((id) => all.find((shop) => shop.shopId === id));
    if (selected.some((shop) => !shop)) throw domainError("SHOPEE_DISCOUNT_SHOP_NOT_AUTHORIZED", "A selected shop is unavailable or unauthorized");
    if (selected.some((shop) => shop.country !== input.country)) throw domainError("SHOPEE_DISCOUNT_SHOP_COUNTRY_MISMATCH", "All shops must belong to the chosen country");
    if (!selected.length) throw domainError("SHOPEE_DISCOUNT_SHOP_SCOPE_REQUIRED", "No authorized healthy shop is available for the country");
    return selected;
  }

  async #items(shopId, requestId) {
    const output = [];
    let cursor = "0";
    const seen = new Set();
    for (let page = 0; page < 10_000; page += 1) {
      if (seen.has(cursor)) throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee item pagination repeated a cursor");
      seen.add(cursor);
      const data = payloadData(await this.shopee.listActiveItems({ shopId, cursor, pageSize: 100, requestId }));
      const parsed = listPage(data);
      output.push(...parsed.rows.filter((row) => isActive(row.item_status ?? row.itemStatus ?? row.status)));
      if (!parsed.hasMore) return output;
      if (!parsed.nextCursor) throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee item pagination was incomplete");
      cursor = parsed.nextCursor;
    }
    throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee item pagination exceeded its bound");
  }

  async #variants(shop, requestId) {
    const summaries = await this.#items(shop.shopId, requestId);
    const baseById = new Map();
    for (let index = 0; index < summaries.length; index += 50) {
      const itemIds = summaries.slice(index, index + 50).map((row) => scalarId(row.item_id ?? row.itemId));
      if (!itemIds.length) continue;
      const data = payloadData(await this.shopee.getItemBaseInfo({ shopId: shop.shopId, itemIds, requestId }));
      for (const row of arrayAt(data, ["item_list", "item", "items"])) baseById.set(scalarId(row.item_id ?? row.itemId), row);
    }
    const output = [];
    for (const summary of summaries) {
      const itemId = canonicalId(scalarId(summary.item_id ?? summary.itemId), "itemId");
      const item = { ...summary, ...(baseById.get(itemId) || {}) };
      if (!isActive(item.item_status ?? item.itemStatus ?? item.status)) continue;
      const data = payloadData(await this.shopee.getModelList({ shopId: shop.shopId, itemId, requestId }));
      let models = arrayAt(data, ["model", "model_list", "models"]);
      if (!models.length) models = [{ model_id: "0", model_sku: item.item_sku ?? item.sku, ...item }];
      for (const model of models) {
        if (INACTIVE.has(statusOf(model.model_status ?? model.modelStatus ?? model.status)) || !isActive(model.model_status ?? model.modelStatus ?? model.status)) continue;
        const modelId = scalarId(model.model_id ?? model.modelId ?? "0");
        const rawSku = String(model.model_sku ?? model.modelSku ?? item.item_sku ?? item.sku ?? "");
        let sku;
        try { sku = normalizeSku(rawSku); } catch { continue; }
        if (!sku) continue;
        try {
          output.push({
            shopId: shop.shopId,
            country: shop.country,
            itemId,
            modelId: modelId || "0",
            rawSku,
            sku,
            originalMinor: minor(priceValue(model, item, ["original_price_minor", "originalMinor", "original_price", "originalPrice"]), this.site.scale, "original price"),
            currentMinor: minor(priceValue(model, item, ["current_discount_minor", "currentMinor", "current_price", "currentPrice", "current_discount_price"]), this.site.scale, "current price"),
            stock: stockValue(model, item),
            activeAt: timestampMs(item.update_time ?? item.updateTime ?? item.create_time ?? item.createTime),
          });
        } catch {
          // One malformed variant is isolated from the rest of the preview.
        }
      }
    }
    return output;
  }

  async #discounts(shopId, requestId) {
    const discounts = [];
    for (let pageNo = 1; pageNo <= 10_000; pageNo += 1) {
      const data = payloadData(await this.shopee.listDiscounts({ shopId, status: "ongoing", pageNo, pageSize: 100, requestId }));
      const page = discountPage(data);
      discounts.push(...page.rows);
      if (!page.hasMore) break;
    }
    const details = [];
    for (const summary of discounts) {
      const discountId = canonicalId(scalarId(summary.discount_id ?? summary.discountId), "discountId");
      const items = [];
      let first = null;
      for (let pageNo = 1; pageNo <= 10_000; pageNo += 1) {
        const data = payloadData(await this.shopee.getDiscount({ shopId, discountId, pageNo, pageSize: 100, requestId }));
        first ||= data;
        items.push(...arrayAt(data, ["item_list", "items"]));
        if (!Boolean(data?.more ?? data?.has_next_page)) break;
      }
      details.push({ ...summary, ...(first || {}), discountId, items });
    }
    return details;
  }

  async createPreview(rawInput, context = {}) {
    const input = validatePreviewInput(rawInput);
    const security = this.writeSecurity(); // Deliberately read first; preview remains available when writes are disabled.
    const shops = await this.#selectedShops(input, context);
    const selectedShopIds = new Set(shops.map(({ shopId }) => shopId));
    for (const overrides of [input.shopOverrides, input.linkOverrides, input.activitySelection]) {
      if ([...overrides.values()].some(({ shopId }) => !selectedShopIds.has(shopId))) {
        throw domainError("SHOPEE_DISCOUNT_OVERRIDE_SCOPE_MISMATCH", "An override references a shop outside the selected authorized scope");
      }
    }
    const storage = await this.repository.getStorageMode();
    if (!storage.productionScale && shops.length > storage.pilotLimits.shops) {
      throw domainError("SHOPEE_DISCOUNT_SQLITE_LIMIT", "SQLite preview is limited to one shop and ten variants");
    }

    const variants = [];
    const activities = new Map();
    for (const shop of shops) {
      variants.push(...await this.#variants(shop, context.requestId));
      activities.set(shop.shopId, await this.#discounts(shop.shopId, context.requestId));
    }
    if (!storage.productionScale && variants.length > storage.pilotLimits.variants) {
      throw domainError("SHOPEE_DISCOUNT_SQLITE_LIMIT", "SQLite preview is limited to one shop and ten variants");
    }

    const codes = {};
    const issueSamples = new Map();
    const skip = (code, evidence = null) => {
      codes[code] = (codes[code] || 0) + 1;
      if (evidence && (issueSamples.get(code)?.length || 0) < 20) {
        if (!issueSamples.has(code)) issueSamples.set(code, []);
        issueSamples.get(code).push(evidence);
      }
    };
    const activityByVariant = new Map();
    const endingSoonByShop = new Map();
    for (const [shopId, shopActivities] of activities) {
      let soonestEnd = null;
      for (const activity of shopActivities) {
        const endAt = timestampMs(activity.end_time ?? activity.endTime);
        if (endAt != null && endAt > this.now().getTime() && endAt - this.now().getTime() <= 24 * 60 * 60_000) soonestEnd = Math.min(soonestEnd ?? endAt, endAt);
        for (const item of activity.items) {
          const itemId = scalarId(item.item_id ?? item.itemId);
          let models = arrayAt(item, ["model_list", "models"]);
          if (!models.length) models = [{ model_id: "0" }];
          for (const model of models) {
            const key = `${shopId}\u001f${itemId}\u001f${scalarId(model.model_id ?? model.modelId ?? "0") || "0"}`;
            if (!activityByVariant.has(key)) activityByVariant.set(key, []);
            activityByVariant.get(key).push(activity);
          }
        }
      }
      endingSoonByShop.set(shopId, soonestEnd);
    }

    const normalizedSkuGroups = new Map();
    for (const variant of variants) {
      const key = variant.sku.toUpperCase();
      if (!normalizedSkuGroups.has(key)) normalizedSkuGroups.set(key, []);
      normalizedSkuGroups.get(key).push(variant);
    }
    const duplicateVariants = new Set();
    for (const group of normalizedSkuGroups.values()) {
      if (new Set(group.map((variant) => variant.rawSku)).size > 1) for (const variant of group) duplicateVariants.add(`${variant.shopId}\u001f${variant.itemId}\u001f${variant.modelId}`);
    }

    const candidates = [];
    for (const variant of variants) {
      const variantKey = `${variant.shopId}\u001f${variant.itemId}\u001f${variant.modelId}`;
      if (duplicateVariants.has(variantKey)) { skip("WAREHOUSE_DUPLICATE_SKU", { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId, sku: variant.sku }); continue; }
      const current = activityByVariant.get(variantKey) || [];
      if (current.length > 1) {
        skip("DISCOUNT_OVERLAP", {
          shopId: variant.shopId,
          itemId: variant.itemId,
          modelId: variant.modelId,
          activities: current.map((entry) => ({
            discountId: entry.discountId,
            startsAt: entry.start_time ?? entry.startTime ?? null,
            endsAt: entry.end_time ?? entry.endTime ?? null,
          })).sort((left, right) => left.discountId.localeCompare(right.discountId)),
        });
        continue;
      }
      let activityTier = null;
      let activity = null;
      if (current.length === 1) {
        [activity] = current;
        const name = String(activity.discount_name ?? activity.discountName ?? "");
        const systemTier = name.match(/(?:^|[-_])(DAILY|EVENT|MEGA)(?:[-_]|$)/i)?.[1]?.toUpperCase() || null;
        const selected = input.activitySelection.get(`${variant.shopId}\u001f${activity.discountId}`);
        if (!systemTier && !selected) { skip("EXTERNAL_ACTIVITY_TIER_REQUIRED", { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId, discountId: activity.discountId }); continue; }
        activityTier = systemTier || selected.priceTier;
      } else if (input.workflow === "CURRENT_CORRECTION" && endingSoonByShop.get(variant.shopId)
        && variant.activeAt != null && endingSoonByShop.get(variant.shopId) - variant.activeAt <= 24 * 60 * 60_000) {
        skip("CURRENT_ACTIVITY_ENDING_SOON", { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId, activityEndAt: endingSoonByShop.get(variant.shopId) });
        continue;
      }
      const shopTier = input.shopOverrides.get(variant.shopId)?.priceTier ?? activityTier;
      const linkOverride = input.linkOverrides.get(`${variant.shopId}\u001f${variant.itemId}`);
      const tier = resolvePriceTier({ countryTier: input.defaultTier, shopTier, linkTier: linkOverride?.priceTier });
      candidates.push({ variant, tier, ruleSource: linkOverride ? "LINK_OVERRIDE" : shopTier ? "SHOP_OR_ACTIVITY_OVERRIDE" : "COUNTRY_DEFAULT", activity });
    }

    const warehouseByTier = new Map();
    const watermarks = new Set();
    const warehouseWarnings = [];
    for (const tier of [...new Set(candidates.map((candidate) => candidate.tier))]) {
      const skus = [...new Set(candidates.filter((candidate) => candidate.tier === tier).map((candidate) => candidate.variant.sku))].sort();
      if (!skus.length) continue;
      const snapshot = await this.warehouse.scanPrices({ country: input.country, category: input.category, skus, requestId: context.requestId || randomUUID() });
      const validated = validateWarehouseSnapshot(snapshot, null, { tier, maxMissingCount: 0, maxMissingRatio: 0 }, { now: this.now() });
      if (validated.status !== "READY") throw domainError(validated.code || "WAREHOUSE_UNAVAILABLE", "Warehouse price validation blocked the preview");
      const rows = new Map(validated.rows.map((row) => [row.sku, row]));
      warehouseByTier.set(tier, rows);
      if (validated.evidence.watermark) watermarks.add(validated.evidence.watermark);
      warehouseWarnings.push(...validated.warnings);
    }

    const ready = [];
    for (const candidate of candidates) {
      const row = warehouseByTier.get(candidate.tier)?.get(candidate.variant.sku);
      const decision = decideVariantPrice({
        originalMinor: candidate.variant.originalMinor,
        currentDiscountMinor: candidate.variant.currentMinor,
        warehouseTargetMinor: row?.selectedMinor ?? "0",
        warehouseResult: row?.warehouseResult ?? "VALIDATED_MISSING",
        site: { minMinor: this.site.minMinor, maxMinor: this.site.maxMinor, stepMinor: this.site.stepMinor },
      });
      if (decision.status !== "READY") { skip(decision.code, { shopId: candidate.variant.shopId, itemId: candidate.variant.itemId, modelId: candidate.variant.modelId, sku: candidate.variant.sku }); continue; }
      const approval = approvalItem(candidate.variant, decision, candidate.tier, row?.watermark || [...watermarks][0] || "", candidate.ruleSource);
      ready.push({ candidate, decision, approval });
    }
    for (const warning of warehouseWarnings) skip(warning.code);
    ready.sort((left, right) => {
      const a = `${left.approval.shop_id}\u001f${left.approval.item_id}\u001f${left.approval.model_id}`;
      const b = `${right.approval.shop_id}\u001f${right.approval.item_id}\u001f${right.approval.model_id}`;
      return a.localeCompare(b);
    });

    const approvalHash = buildApprovalRoot(ready.map(({ approval }) => approval), { shardSize: this.shardSize });
    const confirmationText = `确认执行 ${input.country} ${shops.length} 店 ${ready.length} 个变体`;
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.approvalTtlMs).toISOString();
    const policy = this.policy();
    if (!policy || typeof policy.hash !== "string" || !policy.hash || !policy.value) throw new TypeError("Shopee Discount policy provider is invalid");
    const counts = { discovered: variants.length, ready: ready.length, skipped: variants.length - ready.length, blocked: 0 };
    const summary = {
      counts,
      codes,
      shopCount: shops.length,
      shardCount: approvalHash.shardHashes.length,
      merkleRoot: approvalHash.root,
      confirmationText,
      writeSecurity: security.safeStatus,
    };
    const sourceSnapshot = { merkleRoot: approvalHash.root, warehouseWatermarks: [...watermarks].sort(), shopIds: shops.map(({ shopId }) => shopId).sort() };
    const targetStart = input.renewal?.requestedStartAt || now.toISOString();
    const targetEnd = new Date(new Date(targetStart).getTime() + 30 * 24 * 60 * 60_000).toISOString();
    let foundationPlan;
    try {
      foundationPlan = await this.foundation.operationPlans.create({
        operationType: "SHOPEE.DISCOUNT.PRICE_MATCH",
        scope: { country: input.country, shopIds: shops.map(({ shopId }) => shopId).sort(), workflow: input.workflow },
        sourceSnapshot,
        policy: policy.value,
        items: [],
        summary,
        approvalMode: "human",
        approvalText: confirmationText,
        ttlMs: this.approvalTtlMs,
        createdBy: context.actorId || "shopee-discount-preview",
      });
      if (foundationPlan?.summary?.merkleRoot !== approvalHash.root) {
        throw domainError("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Foundation could not bind the preview root");
      }
    } catch (cause) {
      const blocked = await this.repository.createPlan({
        foundationPlanId: null,
        country: input.country,
        shopIds: shops.map(({ shopId }) => shopId),
        targetStartsAt: targetStart,
        targetEndsAt: targetEnd,
        sourceSnapshotHash: foundationContentHash(sourceSnapshot),
        policyHash: policy.hash,
        expiresAt,
        createdAt: now,
        createdBy: context.actorId || "shopee-discount-preview",
        summary,
      });
      await this.repository.markPlanState({
        planId: blocked.id,
        fromState: "PREVIEWING",
        toState: "BLOCKED",
        expectedVersion: blocked.stateVersion,
        reasonCode: "SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED",
      });
      throw domainError("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Foundation could not bind the preview root", { causeCode: cause?.code || null });
    }
    const domainPlan = await this.repository.createPlan({
      foundationPlanId: foundationPlan.id,
      country: input.country,
      shopIds: shops.map(({ shopId }) => shopId),
      targetStartsAt: targetStart,
      targetEndsAt: targetEnd,
      sourceSnapshotHash: foundationContentHash(sourceSnapshot),
      policyHash: policy.hash,
      expiresAt,
      createdAt: now,
      createdBy: context.actorId || "shopee-discount-preview",
      summary: { ...summary, foundationPlanHash: foundationPlan.planHash },
    });
    for (let shardIndex = 0; shardIndex < approvalHash.shardHashes.length; shardIndex += 1) {
      const shard = ready.slice(shardIndex * this.shardSize, (shardIndex + 1) * this.shardSize);
      await this.repository.appendPlanShard({
        planId: domainPlan.id,
        shardIndex,
        shardHash: approvalHash.shardHashes[shardIndex],
        items: shard.map(({ candidate, decision, approval }, index) => ({
          sequence: shardIndex * this.shardSize + index,
          shopId: candidate.variant.shopId,
          itemId: candidate.variant.itemId,
          modelId: candidate.variant.modelId,
          sku: candidate.variant.sku,
          currency: this.site.currency,
          scale: this.site.scale,
          currentPriceMinor: candidate.variant.currentMinor,
          controlPriceMinor: decision.source === "WAREHOUSE" ? decision.targetMinor : null,
          targetPriceMinor: decision.targetMinor,
          payloadHash: sha256(approval),
          payload: {
            priceTier: approval.price_tier,
            priceSource: approval.price_source,
            ruleSource: approval.rule_source,
            originalMinor: approval.original_minor,
            warehouseWatermark: approval.warehouse_watermark,
            stock: candidate.variant.stock,
            activity: candidate.activity ? {
              discountId: candidate.activity.discountId,
              startsAt: candidate.activity.start_time ?? candidate.activity.startTime ?? null,
              endsAt: candidate.activity.end_time ?? candidate.activity.endTime ?? null,
            } : null,
          },
        })),
      });
    }
    const sealed = await this.repository.sealPlan({
      planId: domainPlan.id,
      merkleRoot: approvalHash.root,
      itemCount: ready.length,
      shardCount: approvalHash.shardHashes.length,
      expectedVersion: domainPlan.stateVersion,
    });
    for (const [code, count] of Object.entries(codes)) {
      await this.repository.appendEvent({
        planId: sealed.id,
        eventType: "PREVIEW_ISSUE",
        reasonCode: code,
        evidence: { count, samples: issueSamples.get(code) || [] },
        actorId: context.actorId || "shopee-discount-preview",
      });
    }
    return { ...sealed, confirmationText, policyHash: sealed.policyHash, summary };
  }

  async getPreview(planId) {
    const plan = await this.repository.getPlan(requiredText(planId, "planId", 100));
    if (!plan) throw domainError("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Preview was not found");
    return { ...plan, confirmationText: plan.summary.confirmationText };
  }

  async listPreviewItems(planId, filters = {}) {
    await this.getPreview(planId);
    exactFields(filters, new Set(["cursor", "pageSize", "shopId", "status", "code"]), "preview item filters");
    const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || 50));
    const cursor = filters.cursor == null ? -1 : Number(filters.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "cursor is invalid");
    const params = [planId, cursor];
    const clauses = [`plan_id=${this.provider.placeholder(1)}`, `sequence_no>${this.provider.placeholder(2)}`];
    if (filters.shopId) { params.push(canonicalId(filters.shopId, "shopId")); clauses.push(`shop_id=${this.provider.placeholder(params.length)}`); }
    if (filters.status) { params.push(requiredText(filters.status, "status", 40)); clauses.push(`execution_status=${this.provider.placeholder(params.length)}`); }
    if (filters.code) { params.push(requiredText(filters.code, "code", 100)); clauses.push(`execution_reason_code=${this.provider.placeholder(params.length)}`); }
    params.push(pageSize + 1);
    const result = await this.provider.query(`SELECT * FROM shopee_discount_plan_items WHERE ${clauses.join(" AND ")} ORDER BY sequence_no LIMIT ${this.provider.placeholder(params.length)}`, params);
    const hasMore = result.rows.length > pageSize;
    const rows = result.rows.slice(0, pageSize);
    return { items: rows.map(mapPlanItem), nextCursor: hasMore ? String(rows.at(-1).sequence_no) : null, pageSize };
  }

  async #approval(planId) {
    const result = await this.provider.query(`SELECT * FROM shopee_discount_approvals WHERE plan_id=${this.provider.placeholder(1)}`, [planId]);
    const row = result.rows[0];
    return row ? { merkleRoot: row.merkle_root, policyHash: row.policy_hash, actorId: row.actor_id, actorName: row.actor_name, evidence: parseJson(row.evidence_json), approvedAt: row.approved_at } : null;
  }

  async approvePreview(input, context = {}) {
    exactFields(input, APPROVAL_FIELDS, "approval");
    const planId = requiredText(input.planId, "planId", 100);
    const merkleRoot = requiredText(input.merkleRoot, "merkleRoot", 128);
    const operatorName = requiredText(input.operatorName, "operatorName", 100);
    const confirmationText = requiredText(input.confirmationText, "confirmationText", 300);
    const plan = await this.getPreview(planId);
    const existing = await this.#approval(planId);
    const security = this.writeSecurity();
    let privilegedBinding = null;
    if (security.mode === "separate_execute_identity") {
      assertShopeeWriteAuthorized(security, { action: "approve", identity: context.privilegedIdentity });
      exactFields(input.privilegedApproval, new Set(["planId", "merkleRoot", "policyHash", "expiresAt"]), "privilegedApproval");
      privilegedBinding = {
        planId: requiredText(input.privilegedApproval.planId, "privilegedApproval.planId", 100),
        merkleRoot: requiredText(input.privilegedApproval.merkleRoot, "privilegedApproval.merkleRoot", 128),
        policyHash: requiredText(input.privilegedApproval.policyHash, "privilegedApproval.policyHash", 128),
        expiresAt: iso(input.privilegedApproval.expiresAt),
      };
      if (privilegedBinding.planId !== plan.id || privilegedBinding.merkleRoot !== plan.merkleRoot
        || privilegedBinding.policyHash !== plan.policyHash || privilegedBinding.expiresAt !== plan.expiresAt) {
        throw domainError("SHOPEE_DISCOUNT_PRIVILEGED_APPROVAL_MISMATCH", "Privileged approval does not bind the exact plan");
      }
    } else if (input.privilegedApproval != null) {
      throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "privilegedApproval is not valid in trusted single-role mode");
    }
    const supplied = { merkleRoot, operatorName, confirmationText, privilegedBinding, actorId: context.actorId || "trusted-session" };
    if (existing) {
      const stored = { merkleRoot: existing.merkleRoot, operatorName: existing.actorName, confirmationText: existing.evidence.confirmationText, privilegedBinding: existing.evidence.privilegedBinding ?? null, actorId: existing.actorId };
      if (canonicalJson(stored) !== canonicalJson(supplied)) throw domainError("SHOPEE_DISCOUNT_APPROVAL_CHANGED", "An approved preview cannot be changed");
      return plan;
    }
    if (plan.state !== "PREVIEWED") throw domainError("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Only a previewed plan can be approved");
    if (plan.merkleRoot !== merkleRoot) throw domainError("SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH", "Approval root does not match the preview");
    if (plan.summary.confirmationText !== confirmationText) throw domainError("SHOPEE_DISCOUNT_APPROVAL_TEXT_MISMATCH", "Confirmation text does not match the preview");
    if (!plan.expiresAt || this.now().getTime() >= new Date(plan.expiresAt).getTime()) throw domainError("SHOPEE_DISCOUNT_PLAN_EXPIRED", "Preview approval has expired");
    const currentPolicy = this.policy();
    if (plan.policyHash !== currentPolicy.hash) throw domainError("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Approval policy changed after preview");
    const foundationPlan = await this.foundation.operationPlans.get(plan.foundationPlanId);
    if (!foundationPlan || foundationPlan.summary?.merkleRoot !== plan.merkleRoot) throw domainError("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Foundation preview binding is unavailable");
    await this.foundation.operationPlans.approve(foundationPlan.id, {
      planHash: foundationPlan.planHash,
      approvalText: confirmationText,
      actorType: "user",
      actorId: context.actorId || "trusted-session",
    });
    await this.repository.approvePlan({
      planId,
      merkleRoot,
      policyHash: currentPolicy.hash,
      approval: {
        actorId: context.actorId || "trusted-session",
        actorName: operatorName,
        mode: "human",
        evidence: { confirmationText, privilegedBinding, approvalIdentity: context.privilegedIdentity || null },
      },
      expectedVersion: plan.stateVersion,
    });
    return this.getPreview(planId);
  }

  async requestExecution(input, context = {}) {
    exactFields(input, EXECUTION_FIELDS, "execution request");
    const plan = await this.getPreview(requiredText(input.planId, "planId", 100));
    const merkleRoot = requiredText(input.merkleRoot, "merkleRoot", 128);
    if (plan.merkleRoot !== merkleRoot) throw domainError("SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH", "Execution root does not match the approved plan");
    if (plan.state !== "APPROVED") throw domainError("SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED", "Plan is not approved");
    if (!plan.expiresAt || this.now().getTime() >= new Date(plan.expiresAt).getTime()) throw domainError("SHOPEE_DISCOUNT_PLAN_EXPIRED", "Approved plan has expired");
    if (plan.policyHash !== this.policy().hash) throw domainError("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Execution policy changed after approval");
    const approval = await this.#approval(plan.id);
    if (!approval || approval.merkleRoot !== plan.merkleRoot || approval.policyHash !== plan.policyHash) throw domainError("SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED", "Exact approval binding is missing");
    const security = this.writeSecurity();
    const countsResult = await this.provider.query(`SELECT shop_id,COUNT(*) item_count FROM shopee_discount_plan_items WHERE plan_id=${this.provider.placeholder(1)} GROUP BY shop_id`, [plan.id]);
    for (const row of countsResult.rows) {
      assertShopeeWriteAuthorized(security, {
        action: "execute",
        identity: security.mode === "separate_execute_identity" ? context.privilegedIdentity ?? context.identity : context.identity,
        approvalIdentity: approval.evidence.approvalIdentity,
        country: plan.country,
        shopId: row.shop_id,
        batchSize: Number(row.item_count),
      });
    }
    const storage = await this.repository.getStorageMode();
    if (!storage.productionScale && (countsResult.rows.length > 1 || plan.itemCount > 10)) throw domainError("SHOPEE_DISCOUNT_SQLITE_LIMIT", "SQLite execution exceeds pilot limits");
    const current = await this.provider.query(`SELECT * FROM shopee_discount_jobs WHERE plan_id=${this.provider.placeholder(1)} AND job_type='EXECUTE' ORDER BY created_at LIMIT 1`, [plan.id]);
    if (current.rows[0]) {
      const row = current.rows[0];
      return { id: row.id, planId: row.plan_id, jobType: row.job_type, status: row.status, createdAt: row.created_at, reused: true };
    }
    try {
      const job = await this.repository.createJob({
        id: `execute-${sha256(plan.id).slice(0, 32)}`,
        planId: plan.id,
        jobType: "EXECUTE",
        status: "PENDING",
        input: { planId: plan.id, merkleRoot: plan.merkleRoot, policyHash: plan.policyHash },
        createdBy: context.actorId || "trusted-session",
      });
      return { ...job, reused: false };
    } catch (cause) {
      const concurrent = await this.provider.query(`SELECT * FROM shopee_discount_jobs WHERE plan_id=${this.provider.placeholder(1)} AND job_type='EXECUTE' ORDER BY created_at LIMIT 1`, [plan.id]);
      if (!concurrent.rows[0]) throw cause;
      const row = concurrent.rows[0];
      return { id: row.id, planId: row.plan_id, jobType: row.job_type, status: row.status, createdAt: row.created_at, reused: true };
    }
  }

  async listRuns(filters = {}) {
    exactFields(filters, new Set(["status", "planId", "limit"]), "run filters");
    const params = [];
    const clauses = [];
    if (filters.status) { params.push(requiredText(filters.status, "status", 40)); clauses.push(`status=${this.provider.placeholder(params.length)}`); }
    if (filters.planId) { params.push(requiredText(filters.planId, "planId", 100)); clauses.push(`plan_id=${this.provider.placeholder(params.length)}`); }
    params.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    const result = await this.provider.query(`SELECT id,plan_id,job_type,status,counters_json,last_error_code,created_at,updated_at FROM shopee_discount_jobs ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC,id LIMIT ${this.provider.placeholder(params.length)}`, params);
    return result.rows.map((row) => ({ id: row.id, planId: row.plan_id, jobType: row.job_type, status: row.status, counters: parseJson(row.counters_json), lastErrorCode: row.last_error_code, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async listActivities(filters = {}) {
    exactFields(filters, new Set(["shopId", "status", "limit"]), "activity filters");
    const params = [];
    const clauses = [];
    if (filters.shopId) { params.push(canonicalId(filters.shopId, "shopId")); clauses.push(`shop_id=${this.provider.placeholder(params.length)}`); }
    if (filters.status) { params.push(requiredText(filters.status, "status", 40)); clauses.push(`status=${this.provider.placeholder(params.length)}`); }
    params.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    const result = await this.provider.query(`SELECT id,plan_id,shop_id,activity_type,platform_activity_id,target_starts_at,target_ends_at,status,metadata_json FROM shopee_discount_activities ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY target_starts_at DESC,id LIMIT ${this.provider.placeholder(params.length)}`, params);
    return result.rows.map((row) => ({ id: row.id, planId: row.plan_id, shopId: row.shop_id, activityType: row.activity_type, platformActivityId: row.platform_activity_id, startsAt: row.target_starts_at, endsAt: row.target_ends_at, status: row.status, metadata: parseJson(row.metadata_json) }));
  }

  async listIssues(filters = {}) {
    exactFields(filters, new Set(["planId", "code", "limit"]), "issue filters");
    const params = [];
    const clauses = ["reason_code IS NOT NULL"];
    if (filters.planId) { params.push(requiredText(filters.planId, "planId", 100)); clauses.push(`plan_id=${this.provider.placeholder(params.length)}`); }
    if (filters.code) { params.push(requiredText(filters.code, "code", 100)); clauses.push(`reason_code=${this.provider.placeholder(params.length)}`); }
    params.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    const result = await this.provider.query(`SELECT id,plan_id,job_id,event_type,reason_code,evidence_json,occurred_at FROM shopee_discount_events WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC,id LIMIT ${this.provider.placeholder(params.length)}`, params);
    return result.rows.map((row) => ({ id: row.id, planId: row.plan_id, jobId: row.job_id, eventType: row.event_type, code: row.reason_code, evidence: parseJson(row.evidence_json), occurredAt: row.occurred_at }));
  }

  async requestManualScan(input, context = {}) {
    exactFields(input, new Set(["country", "shopIds"]), "manual scan");
    const country = requiredText(input.country, "country", 3).toUpperCase();
    if (!Array.isArray(input.shopIds) || !input.shopIds.length) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "shopIds are required");
    const shopIds = input.shopIds.map((id) => canonicalId(id, "shopId"));
    return this.repository.createDueJob({
      jobType: "MANUAL_SCAN",
      dedupeKey: `manual:${country}:${shopIds.sort().join(",")}:${this.now().toISOString().slice(0, 16)}`,
      dueAt: this.now(),
      payload: { country, shopIds },
      createdBy: context.actorId || "trusted-session",
    });
  }
}

export { domainError as shopeeDiscountError };
