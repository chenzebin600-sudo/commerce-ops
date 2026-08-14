import { createHash, randomUUID } from "node:crypto";
import { buildApprovalRoot } from "./approval-hash.mjs";
import { normalizeSku, parseMinorUnits, resolvePriceTier } from "./contracts.mjs";
import { decideVariantPrice } from "./pricing-engine.mjs";
import { validateWarehouseSnapshot } from "./warehouse-validator.mjs";
import { assertShopeeWriteAuthorized } from "./write-security.mjs";
import { foundationContentHash } from "../foundation/foundation-contracts.mjs";
import { SHOPEE_DISCOUNT_APPROVAL_FIELDS, SHOPEE_DISCOUNT_EXECUTION_FIELDS, SHOPEE_DISCOUNT_PREVIEW_FIELDS } from "./request-schemas.mjs";
import { buildRenewalActivityIdentity } from "./renewal-activity.mjs";

const TIERS = new Set(["DAILY", "EVENT", "MEGA"]);
const WORKFLOWS = new Set(["CURRENT_CORRECTION", "NEXT_RENEWAL"]);
const PREVIEW_FIELDS = new Set(SHOPEE_DISCOUNT_PREVIEW_FIELDS);
const APPROVAL_FIELDS = new Set(SHOPEE_DISCOUNT_APPROVAL_FIELDS);
const EXECUTION_FIELDS = new Set(SHOPEE_DISCOUNT_EXECUTION_FIELDS);
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
  return value == null ? "" : String(value).trim().toUpperCase();
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

function approvalItem(variant, decision, tier, watermark, approvedAt, ruleSource, target) {
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
    warehouse_approved_at: approvedAt,
    activity_type: target.activityType,
    target_discount_id: target.targetDiscountId,
    renewal_discount_name: target.renewalDiscountName,
    renewal_marker: target.renewalMarker,
    renewal_price_tier: target.renewalPriceTier,
    renewal_starts_at: target.renewalStartsAt,
    renewal_ends_at: target.renewalEndsAt,
    renewal_fingerprint: target.renewalFingerprint,
  };
}

function warehouseApprovedAt(row, tier) {
  return row?.[`${String(tier).toLowerCase()}ApprovedAt`] ?? null;
}

function renewalActivities({ planId, country, shops, tierForShop, targetStart, targetEnd }) {
  return shops.map(({ shopId }) => {
    const priceTier = tierForShop(shopId);
    return {
      shopId,
      activityType: "NEXT_RENEWAL",
      targetStartsAt: targetStart,
      targetEndsAt: targetEnd,
      metadata: buildRenewalActivityIdentity({
        planId, country, shopId, priceTier, targetStartsAt: targetStart, targetEndsAt: targetEnd,
      }),
    };
  });
}

export class ShopeeDiscountService {
  constructor({ repository, foundation, shopee, warehouse, writeSecurity, now = () => new Date(), approvalTtlMs = 10 * 60_000,
    siteCapabilities = null, siteCapability = null, shardSize = 500, policy = null, maxItemPages = 100,
    maxDiscountPages = 100, maxItems = 20_000, modelConcurrency = 8, warehouseChunkSize = 500 } = {}) {
    if (!repository || !foundation?.operationPlans || !shopee || !warehouse || typeof writeSecurity !== "function") {
      throw new TypeError("Shopee Discount service dependencies are required");
    }
    if (!Number.isSafeInteger(shardSize) || shardSize < 1 || shardSize > 1000) throw new TypeError("shardSize is invalid");
    this.repository = repository;
    this.foundation = foundation;
    this.shopee = shopee;
    this.warehouse = warehouse;
    this.writeSecurity = writeSecurity;
    this.now = now;
    this.approvalTtlMs = Math.max(1_000, Math.min(24 * 60 * 60_000, Number(approvalTtlMs) || 0));
    const configuredSites = siteCapabilities || (siteCapability ? { TH: siteCapability } : {});
    this.sites = new Map(Object.entries(configuredSites).map(([country, capability]) => [country.toUpperCase(), {
      currency: requiredText(capability.currency, `${country} site currency`, 10),
      scale: Number.isSafeInteger(capability.scale) ? capability.scale : 2,
      minMinor: String(capability.minMinor), maxMinor: String(capability.maxMinor), stepMinor: String(capability.stepMinor),
    }]));
    for (const [name, value, maximum] of [["maxItemPages", maxItemPages, 1000], ["maxDiscountPages", maxDiscountPages, 1000],
      ["maxItems", maxItems, 100_000], ["modelConcurrency", modelConcurrency, 32], ["warehouseChunkSize", warehouseChunkSize, 1000]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError(`${name} is invalid`);
      this[name] = value;
    }
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
    const issues = [];
    let cursor = "0";
    const seen = new Set();
    for (let page = 0; page < this.maxItemPages; page += 1) {
      if (seen.has(cursor)) throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee item pagination repeated a cursor");
      seen.add(cursor);
      const data = payloadData(await this.shopee.listActiveItems({ shopId, cursor, pageSize: 100, requestId }));
      const parsed = listPage(data);
      for (const row of parsed.rows) {
        const status = row.item_status ?? row.itemStatus ?? row.status;
        if (isActive(status)) output.push(row);
        else if (!statusOf(status)) issues.push({ code: "LISTING_STATUS_UNKNOWN", itemId: scalarId(row.item_id ?? row.itemId) });
      }
      if (output.length > this.maxItems) throw domainError("SHOPEE_DISCOUNT_SCALE_LIMIT", "Shopee listing scope exceeds the configured bound");
      if (!parsed.hasMore) return { rows: output, issues };
      if (!parsed.nextCursor) throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee item pagination was incomplete");
      cursor = parsed.nextCursor;
    }
    throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee item pagination exceeded its bound");
  }

  async #variants(shop, requestId, site) {
    const listingPage = await this.#items(shop.shopId, requestId);
    const summaries = listingPage.rows;
    const baseById = new Map();
    for (let index = 0; index < summaries.length; index += 50) {
      const itemIds = summaries.slice(index, index + 50).map((row) => scalarId(row.item_id ?? row.itemId));
      if (!itemIds.length) continue;
      const data = payloadData(await this.shopee.getItemBaseInfo({ shopId: shop.shopId, itemIds, requestId }));
      for (const row of arrayAt(data, ["item_list", "item", "items"])) baseById.set(scalarId(row.item_id ?? row.itemId), row);
    }
    const output = [], issues = [...listingPage.issues];
    for (let start = 0; start < summaries.length; start += this.modelConcurrency) {
      const batch = summaries.slice(start, start + this.modelConcurrency);
      const resolved = await Promise.all(batch.map(async (summary) => {
      const itemId = canonicalId(scalarId(summary.item_id ?? summary.itemId), "itemId");
      const item = { ...summary, ...(baseById.get(itemId) || {}) };
      if (!isActive(item.item_status ?? item.itemStatus ?? item.status)) return [];
      const data = payloadData(await this.shopee.getModelList({ shopId: shop.shopId, itemId, requestId }));
      let models = arrayAt(data, ["model", "model_list", "models"]);
      if (!models.length) models = [{ model_id: "0", model_sku: item.item_sku ?? item.sku, ...item }];
      const itemVariants = [];
      for (const model of models) {
        const modelStatus = model.model_status ?? model.modelStatus ?? model.status;
        if (!statusOf(modelStatus)) { issues.push({ code: "MODEL_STATUS_UNKNOWN", itemId, modelId: scalarId(model.model_id ?? model.modelId) }); continue; }
        if (INACTIVE.has(statusOf(modelStatus)) || !isActive(modelStatus)) continue;
        const modelId = scalarId(model.model_id ?? model.modelId ?? "0");
        const rawSku = String(model.model_sku ?? model.modelSku ?? item.item_sku ?? item.sku ?? "");
        let sku;
        try { sku = normalizeSku(rawSku); } catch { continue; }
        if (!sku) continue;
        try {
          itemVariants.push({
            shopId: shop.shopId,
            country: shop.country,
            itemId,
            modelId: modelId || "0",
            rawSku,
            sku,
            originalMinor: minor(priceValue(model, item, ["original_price_minor", "originalMinor", "original_price", "originalPrice"]), site.scale, "original price"),
            currentMinor: minor(priceValue(model, item, ["current_discount_minor", "currentMinor", "current_price", "currentPrice", "current_discount_price"]), site.scale, "current price"),
            stock: stockValue(model, item),
          });
        } catch {
          // One malformed variant is isolated from the rest of the preview.
        }
      }
      return itemVariants;
      }));
      output.push(...resolved.flat());
    }
    return { variants: output, issues };
  }

  async #discounts(shopId, requestId) {
    const discounts = [];
    for (let pageNo = 1; pageNo <= this.maxDiscountPages; pageNo += 1) {
      const data = payloadData(await this.shopee.listDiscounts({ shopId, status: "ongoing", pageNo, pageSize: 100, requestId }));
      const page = discountPage(data);
      discounts.push(...page.rows);
      if (discounts.length > this.maxItems) throw domainError("SHOPEE_DISCOUNT_SCALE_LIMIT", "Shopee Discount scope exceeds the configured bound");
      if (!page.hasMore) break;
      if (pageNo === this.maxDiscountPages) throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee Discount pagination exceeded its bound");
    }
    const details = [];
    let membershipCount = 0;
    for (const summary of discounts) {
      const discountId = canonicalId(scalarId(summary.discount_id ?? summary.discountId), "discountId");
      const items = [];
      let first = null;
      for (let pageNo = 1; pageNo <= this.maxDiscountPages; pageNo += 1) {
        const data = payloadData(await this.shopee.getDiscount({ shopId, discountId, pageNo, pageSize: 100, requestId }));
        first ||= data;
        const pageItems = arrayAt(data, ["item_list", "items"]);
        items.push(...pageItems);
        membershipCount += pageItems.length;
        if (membershipCount > this.maxItems) throw domainError("SHOPEE_DISCOUNT_SCALE_LIMIT", "Shopee Discount memberships exceed the configured bound");
        const more = Boolean(data?.more ?? data?.has_next_page);
        if (!more) break;
        if (pageNo === this.maxDiscountPages) throw domainError("SHOPEE_DISCOUNT_SHOPEE_PAGINATION", "Shopee Discount detail pagination exceeded its bound");
      }
      details.push({
        discountId,
        status: first?.status ?? first?.discount_status ?? summary.status ?? summary.discount_status ?? "ongoing",
        start_time: first?.start_time ?? first?.startTime ?? summary.start_time ?? summary.startTime ?? null,
        end_time: first?.end_time ?? first?.endTime ?? summary.end_time ?? summary.endTime ?? null,
        items,
      });
    }
    return details;
  }

  async createPreview(rawInput, context = {}) {
    const input = validatePreviewInput(rawInput);
    const security = this.writeSecurity(); // Deliberately read first; preview remains available when writes are disabled.
    const site = this.sites.get(input.country);
    if (!site) throw domainError("SHOPEE_DISCOUNT_SITE_UNSUPPORTED", "No exact site capability is configured for the selected country");
    const shops = await this.#selectedShops(input, context);
    const now = this.now();
    const targetStart = input.renewal?.requestedStartAt || now.toISOString();
    const targetEnd = new Date(new Date(targetStart).getTime() + 30 * 24 * 60 * 60_000).toISOString();
    const sagaKey = sha256({ input: rawInput, actorId: context.actorId || "trusted-session", requestId: context.requestId || null });
    const domainPlanId = `preview-${sagaKey.slice(0, 40)}`;
    const foundationPlanId = `shopee-discount-${sagaKey.slice(0, 40)}`;
    const tierForShop = (shopId) => input.shopOverrides.get(shopId)?.priceTier || input.defaultTier;
    const renewalIdentityByShop = new Map(input.workflow === "NEXT_RENEWAL"
      ? shops.map(({ shopId }) => [shopId, buildRenewalActivityIdentity({
        planId: domainPlanId,
        country: input.country,
        shopId,
        priceTier: tierForShop(shopId),
        targetStartsAt: targetStart,
        targetEndsAt: targetEnd,
      })])
      : []);
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

    const variants = [], ingestionIssues = [];
    const activities = new Map();
    for (const shop of shops) {
      const result = await this.#variants(shop, context.requestId, site);
      variants.push(...result.variants);
      if (variants.length > this.maxItems) throw domainError("SHOPEE_DISCOUNT_SCALE_LIMIT", "Shopee variant scope exceeds the configured bound");
      ingestionIssues.push(...result.issues.map((issue) => ({ ...issue, shopId: shop.shopId })));
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
    for (const issue of ingestionIssues) skip(issue.code, issue);
    const activityByVariant = new Map();
    for (const [shopId, shopActivities] of activities) {
      for (const activity of shopActivities) {
        for (const item of activity.items) {
          const itemId = scalarId(item.item_id ?? item.itemId);
          let models = arrayAt(item, ["model_list", "models"]);
          if (!models.length) models = [{ model_id: "0" }];
          for (const model of models) {
            const key = `${shopId}\u001f${itemId}\u001f${scalarId(model.model_id ?? model.modelId ?? "0") || "0"}`;
            if (!activityByVariant.has(key)) activityByVariant.set(key, []);
            activityByVariant.get(key).push({
              activity,
              membershipActiveAt: timestampMs(model.added_at ?? model.addedAt ?? model.promotion_start_time
                ?? item.added_at ?? item.addedAt ?? item.promotion_start_time),
            });
          }
        }
      }
    }
    const ongoingActivities = new Map();
    const storedActivities = new Map();
    for (const [shopId, shopActivities] of activities) {
      const ongoing = shopActivities.filter((entry) => String(entry.status).toLowerCase() === "ongoing"
        && timestampMs(entry.start_time) != null && timestampMs(entry.start_time) <= this.now().getTime()
        && timestampMs(entry.end_time) != null && timestampMs(entry.end_time) > this.now().getTime());
      ongoingActivities.set(shopId, ongoing);
      const verifiedStored = [];
      for (const entry of ongoing) {
        const stored = await this.repository.getStoredSystemActivity(shopId, entry.discountId);
        if (stored && timestampMs(stored.startsAt) === timestampMs(entry.start_time)
          && timestampMs(stored.endsAt) === timestampMs(entry.end_time) && stored.metadata?.priceTier) {
          verifiedStored.push({ entry, stored });
        }
      }
      storedActivities.set(shopId, verifiedStored);
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
          activities: current.map(({ activity: entry }) => ({
            discountId: entry.discountId,
            startsAt: entry.start_time ?? entry.startTime ?? null,
            endsAt: entry.end_time ?? entry.endTime ?? null,
          })).sort((left, right) => left.discountId.localeCompare(right.discountId)),
        });
        continue;
      }
      let activityTier = null;
      let activity = null;
      const selectedTargets = [...input.activitySelection.values()].filter((entry) => entry.shopId === variant.shopId);
      const verifiedSelected = selectedTargets.map((selection) => ongoingActivities.get(variant.shopId)
        .find((entry) => entry.discountId === selection.discountId))
        .filter(Boolean);
      if (current.length === 1) {
        const membership = current[0];
        activity = membership.activity;
        const stored = await this.repository.getStoredSystemActivity(variant.shopId, activity.discountId);
        const systemTier = stored?.metadata?.priceTier;
        const selected = input.activitySelection.get(`${variant.shopId}\u001f${activity.discountId}`);
        const fetchedOngoing = ongoingActivities.get(variant.shopId).some((entry) => entry.discountId === activity.discountId);
        const storedWindowMatches = !stored || (timestampMs(stored.startsAt) === timestampMs(activity.start_time)
          && timestampMs(stored.endsAt) === timestampMs(activity.end_time));
        if ((stored || selected) && (!fetchedOngoing || (selected && !verifiedSelected.some((entry) => entry.discountId === activity.discountId)) || !storedWindowMatches)) {
          skip("CURRENT_ACTIVITY_TARGET_STALE", { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId, discountId: activity.discountId });
          continue;
        }
        if (!systemTier && !selected) { skip("EXTERNAL_ACTIVITY_TIER_REQUIRED", { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId, discountId: activity.discountId }); continue; }
        activityTier = systemTier || selected.priceTier;
        const endAt = timestampMs(activity.end_time ?? activity.endTime);
        if (input.workflow === "CURRENT_CORRECTION" && endAt != null && endAt > this.now().getTime()
          && endAt - this.now().getTime() <= 24 * 60 * 60_000 && membership.membershipActiveAt != null
          && membership.membershipActiveAt >= endAt - 24 * 60 * 60_000) {
          skip("NEXT_PLAN_REQUIRED", { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId,
            discountId: activity.discountId, activityEndAt: endAt, membershipActiveAt: membership.membershipActiveAt });
          continue;
        }
      } else if (input.workflow === "CURRENT_CORRECTION") {
        const storedTargets = storedActivities.get(variant.shopId);
        const target = selectedTargets.length ? verifiedSelected : storedTargets.map(({ entry }) => entry);
        if ((selectedTargets.length && verifiedSelected.length !== 1) || (!selectedTargets.length && storedTargets.length !== 1)) {
          skip(selectedTargets.length || storedTargets.length > 1 ? "CURRENT_ACTIVITY_AMBIGUOUS" : "CURRENT_ACTIVITY_TARGET_REQUIRED",
            { shopId: variant.shopId, itemId: variant.itemId, modelId: variant.modelId });
          continue;
        }
        activity = target[0];
        activityTier = selectedTargets.length ? selectedTargets[0].priceTier : storedTargets[0].stored.metadata.priceTier;
      }
      const shopTier = input.shopOverrides.get(variant.shopId)?.priceTier ?? activityTier;
      const linkOverride = input.linkOverrides.get(`${variant.shopId}\u001f${variant.itemId}`);
      const tier = resolvePriceTier({ countryTier: input.defaultTier, shopTier, linkTier: linkOverride?.priceTier });
      candidates.push({ variant, tier, ruleSource: linkOverride ? "LINK_OVERRIDE" : shopTier ? "SHOP_OR_ACTIVITY_OVERRIDE" : "COUNTRY_DEFAULT", activity });
    }

    const warehouseByTier = new Map();
    const watermarks = new Set();
    const warehouseWarnings = [];
    let pinnedWatermark = null;
    for (const tier of [...new Set(candidates.map((candidate) => candidate.tier))]) {
      const skus = [...new Set(candidates.filter((candidate) => candidate.tier === tier).map((candidate) => candidate.variant.sku))].sort();
      if (!skus.length) continue;
      const baseline = await this.repository.getLatestWarehouseBaseline({ country: input.country, category: input.category, tier });
      const combinedRows = [];
      for (let start = 0; start < skus.length; start += this.warehouseChunkSize) {
        const chunk = skus.slice(start, start + this.warehouseChunkSize);
        const snapshot = await this.warehouse.scanPrices({ country: input.country, category: input.category, skus: chunk,
          watermark: pinnedWatermark, requestId: context.requestId || randomUUID() });
        const validated = validateWarehouseSnapshot(snapshot, baseline, { tier, maxMissingCount: 0, maxMissingRatio: 0 }, { now: this.now() });
        if (validated.status !== "READY") throw domainError(validated.code || "WAREHOUSE_UNAVAILABLE", "Warehouse price validation blocked the preview");
        const covered = new Set(validated.rows.map(({ sku }) => sku));
        if (chunk.some((sku) => !covered.has(sku))) throw domainError("WAREHOUSE_SKU_COVERAGE_INCOMPLETE", "Warehouse response omitted a requested SKU");
        if (pinnedWatermark != null && validated.evidence.watermark !== pinnedWatermark) throw domainError("WAREHOUSE_WATERMARK_CHANGED", "Warehouse chunks changed watermark");
        pinnedWatermark ||= validated.evidence.watermark;
        combinedRows.push(...validated.rows);
        warehouseWarnings.push(...validated.warnings);
      }
      const rows = new Map(combinedRows.map((row) => [row.sku, row]));
      warehouseByTier.set(tier, rows);
      if (pinnedWatermark) watermarks.add(pinnedWatermark);
      await this.repository.saveWarehouseBaseline({
        id: `warehouse-baseline-${sha256({ country: input.country, category: input.category, tier, watermark: pinnedWatermark }).slice(0, 40)}`,
        scope: { country: input.country, category: input.category, tier }, rows: combinedRows, watermark: pinnedWatermark,
      });
    }

    const ready = [];
    for (const candidate of candidates) {
      const row = warehouseByTier.get(candidate.tier)?.get(candidate.variant.sku);
      const decision = decideVariantPrice({
        originalMinor: candidate.variant.originalMinor,
        currentDiscountMinor: candidate.variant.currentMinor,
        warehouseTargetMinor: row?.selectedMinor ?? "0",
        warehouseResult: row?.warehouseResult,
        site: { minMinor: site.minMinor, maxMinor: site.maxMinor, stepMinor: site.stepMinor },
      });
      if (decision.status !== "READY") { skip(decision.code, { shopId: candidate.variant.shopId, itemId: candidate.variant.itemId, modelId: candidate.variant.modelId, sku: candidate.variant.sku }); continue; }
      const approvedAt = warehouseApprovedAt(row, candidate.tier);
      const renewalIdentity = renewalIdentityByShop.get(candidate.variant.shopId) || null;
      const approvalTarget = {
        activityType: input.workflow,
        targetDiscountId: input.workflow === "CURRENT_CORRECTION" ? candidate.activity?.discountId ?? null : null,
        renewalDiscountName: renewalIdentity?.discountName ?? null,
        renewalMarker: renewalIdentity?.marker ?? null,
        renewalPriceTier: renewalIdentity?.priceTier ?? null,
        renewalStartsAt: input.workflow === "NEXT_RENEWAL" ? targetStart : null,
        renewalEndsAt: input.workflow === "NEXT_RENEWAL" ? targetEnd : null,
        renewalFingerprint: renewalIdentity?.fingerprint ?? null,
      };
      const approval = approvalItem(candidate.variant, decision, candidate.tier,
        row?.watermark || [...watermarks][0] || "", approvedAt, candidate.ruleSource, approvalTarget);
      ready.push({ candidate, decision, approval, warehouseApprovedAt: approvedAt, approvalTarget });
    }
    for (const warning of warehouseWarnings) skip(warning.code);
    ready.sort((left, right) => {
      const a = `${left.approval.shop_id}\u001f${left.approval.item_id}\u001f${left.approval.model_id}`;
      const b = `${right.approval.shop_id}\u001f${right.approval.item_id}\u001f${right.approval.model_id}`;
      return a.localeCompare(b);
    });

    const approvalHash = buildApprovalRoot(ready.map(({ approval }) => approval), { shardSize: this.shardSize });
    const confirmationText = `确认执行 ${input.country} ${shops.length} 店 ${ready.length} 个变体`;
    const expiresAt = new Date(now.getTime() + this.approvalTtlMs).toISOString();
    const policy = this.policy();
    if (!policy || typeof policy.hash !== "string" || !policy.hash || !policy.value) throw new TypeError("Shopee Discount policy provider is invalid");
    const counts = { discovered: variants.length + ingestionIssues.length, ready: ready.length, skipped: variants.length + ingestionIssues.length - ready.length, blocked: 0 };
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
    let domainPlan = await this.repository.getPlan(domainPlanId);
    if (domainPlan?.state === "PREVIEWED") return { ...domainPlan, confirmationText, policyHash: domainPlan.policyHash, summary: domainPlan.summary };
    if (domainPlan?.state === "BLOCKED") throw domainError("SHOPEE_DISCOUNT_PREVIEW_SAGA_BLOCKED", "A prior preview attempt is durably blocked and requires a new request identity");
    if (!domainPlan) domainPlan = await this.repository.createPlan({
      id: domainPlanId,
      foundationPlanId: null,
      country: input.country,
      ...(input.workflow === "NEXT_RENEWAL" ? {
        activities: renewalActivities({
          planId: domainPlanId,
          country: input.country,
          shops,
          tierForShop,
          targetStart,
          targetEnd,
        }),
      } : (() => {
        const currentActivities = [...new Map(ready.map(({ approval }) => [approval.shop_id, {
        shopId: approval.shop_id,
        activityType: "CURRENT_CORRECTION",
        platformActivityId: approval.target_discount_id,
        targetStartsAt: targetStart,
        targetEndsAt: targetEnd,
        metadata: { workflow: "CURRENT_CORRECTION", targetDiscountId: approval.target_discount_id },
        }])).values()];
        return currentActivities.length ? { activities: currentActivities } : { shopIds: shops.map(({ shopId }) => shopId) };
      })()),
      targetStartsAt: targetStart,
      targetEndsAt: targetEnd,
      sourceSnapshotHash: foundationContentHash(sourceSnapshot),
      policyHash: policy.hash,
      expiresAt,
      createdAt: now,
      createdBy: context.actorId || "shopee-discount-preview",
      summary: { ...summary, previewSagaId: sagaKey },
    });
    let foundationPlan = domainPlan.foundationPlanId ? await this.foundation.operationPlans.get(domainPlan.foundationPlanId) : null;
    let sagaPhase = "FOUNDATION_BIND";
    try {
      foundationPlan ||= await this.foundation.operationPlans.create({
        id: foundationPlanId,
        operationType: "SHOPEE.DISCOUNT.PRICE_MATCH",
        scope: { country: input.country, shopIds: shops.map(({ shopId }) => shopId).sort(), workflow: input.workflow },
        sourceSnapshot,
        policy: policy.value,
        items: [],
        summary: { ...summary, previewSagaId: sagaKey },
        approvalMode: "human",
        approvalText: confirmationText,
        ttlMs: this.approvalTtlMs,
        createdBy: context.actorId || "shopee-discount-preview",
      });
      if (foundationPlan?.summary?.merkleRoot !== approvalHash.root) {
        throw domainError("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Foundation could not bind the preview root");
      }
      domainPlan = await this.repository.bindFoundationPlan(domainPlan.id, foundationPlan.id);
      sagaPhase = "SHARDS";
      const existingShards = new Map((await this.repository.listPlanShards(domainPlan.id)).map((shard) => [shard.shardIndex, shard]));
      for (let shardIndex = 0; shardIndex < approvalHash.shardHashes.length; shardIndex += 1) {
        if (existingShards.has(shardIndex)) {
          if (existingShards.get(shardIndex).shardHash !== approvalHash.shardHashes[shardIndex]) throw domainError("SHOPEE_DISCOUNT_PREVIEW_SAGA_CONFLICT", "Persisted shard differs from resumed preview");
          continue;
        }
      const shard = ready.slice(shardIndex * this.shardSize, (shardIndex + 1) * this.shardSize);
      await this.repository.appendPlanShard({
        planId: domainPlan.id,
        shardIndex,
        shardHash: approvalHash.shardHashes[shardIndex],
        items: shard.map(({ candidate, decision, approval, warehouseApprovedAt: approvedAt, approvalTarget }, index) => ({
          sequence: shardIndex * this.shardSize + index,
          shopId: candidate.variant.shopId,
          itemId: candidate.variant.itemId,
          modelId: candidate.variant.modelId,
          sku: candidate.variant.sku,
          currency: site.currency,
          scale: site.scale,
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
            warehouseApprovedAt: approvedAt,
            approvalTarget,
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
        try { await this.repository.appendEvent({
        id: `preview-issue-${sha256({ planId: sealed.id, code }).slice(0, 40)}`,
        planId: sealed.id,
        eventType: "PREVIEW_ISSUE",
        reasonCode: code,
        evidence: { count, samples: issueSamples.get(code) || [] },
        actorId: context.actorId || "shopee-discount-preview",
        }); } catch {}
      }
      return { ...sealed, confirmationText, policyHash: sealed.policyHash, summary };
    } catch (cause) {
      const failureCode = sagaPhase === "FOUNDATION_BIND" ? "SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED"
        : cause?.code || "SHOPEE_DISCOUNT_PREVIEW_SAGA_FAILED";
      // Foundation creation can commit before its audit append fails. Recover the
      // deterministic saga identity so compensation also covers that partial phase.
      foundationPlan ||= await this.foundation.operationPlans.get(foundationPlanId).catch(() => null);
      const current = await this.repository.getPlan(domainPlan.id);
      if (current && ["PREVIEWING", "PREVIEWED", "APPROVED"].includes(current.state)) {
        await this.repository.markPlanState({ planId: current.id, fromState: current.state, toState: "BLOCKED",
          expectedVersion: current.stateVersion, reasonCode: failureCode }).catch(() => {});
      }
      if (foundationPlan) await this.foundation.operationPlans.block(foundationPlan.id, {
        reasonCode: failureCode, evidence: { previewSagaId: sagaKey },
      }).catch(() => {});
      throw domainError(failureCode, "Preview saga failed and was blocked", { causeCode: cause?.code || null });
    }
  }

  async #assertPlanScope(planId, context = {}) {
    if (!Array.isArray(context.authorizedShopIds)) return;
    const allowed = new Set(context.authorizedShopIds.map(String));
    const shops = await this.repository.getPlanShopIds(planId);
    if (!shops.length || shops.some((shopId) => !allowed.has(shopId))) throw domainError("SHOPEE_DISCOUNT_SHOP_NOT_AUTHORIZED", "Plan is outside the authorized shop scope");
  }

  async getPreview(planId, context = {}) {
    const plan = await this.repository.getPlan(requiredText(planId, "planId", 100));
    if (!plan) throw domainError("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Preview was not found");
    await this.#assertPlanScope(plan.id, context);
    return { ...plan, confirmationText: plan.summary.confirmationText };
  }

  async listPreviewItems(planId, filters = {}, context = {}) {
    await this.getPreview(planId, context);
    exactFields(filters, new Set(["cursor", "pageSize", "shopId", "status", "code"]), "preview item filters");
    const pageSize = Math.max(1, Math.min(100, Number(filters.pageSize) || 50));
    const cursor = filters.cursor == null ? -1 : Number(filters.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < -1) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "cursor is invalid");
    return this.repository.listPlanItems(planId, { cursor, pageSize,
      shopId: filters.shopId ? canonicalId(filters.shopId, "shopId") : null,
      status: filters.status ? requiredText(filters.status, "status", 40) : null,
      code: filters.code ? requiredText(filters.code, "code", 100) : null });
  }

  async #approval(planId) {
    return this.repository.getPlanApproval(planId);
  }

  async approvePreview(input, context = {}) {
    exactFields(input, APPROVAL_FIELDS, "approval");
    const planId = requiredText(input.planId, "planId", 100);
    const merkleRoot = requiredText(input.merkleRoot, "merkleRoot", 128);
    const operatorName = requiredText(input.operatorName, "operatorName", 100);
    const confirmationText = requiredText(input.confirmationText, "confirmationText", 300);
    const plan = await this.getPreview(planId, context);
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
    } else if (plan.state !== "PREVIEWED") throw domainError("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Only a previewed plan can be approved");
    if (plan.merkleRoot !== merkleRoot) throw domainError("SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH", "Approval root does not match the preview");
    if (plan.summary.confirmationText !== confirmationText) throw domainError("SHOPEE_DISCOUNT_APPROVAL_TEXT_MISMATCH", "Confirmation text does not match the preview");
    if (!plan.expiresAt || this.now().getTime() >= new Date(plan.expiresAt).getTime()) throw domainError("SHOPEE_DISCOUNT_PLAN_EXPIRED", "Preview approval has expired");
    const currentPolicy = this.policy();
    if (plan.policyHash !== currentPolicy.hash) throw domainError("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Approval policy changed after preview");
    const foundationPlan = await this.foundation.operationPlans.get(plan.foundationPlanId);
    if (!foundationPlan || foundationPlan.summary?.merkleRoot !== plan.merkleRoot) throw domainError("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Foundation preview binding is unavailable");
    try {
      if (!existing) try {
        await this.repository.approvePlan({
          planId,
          merkleRoot,
          policyHash: currentPolicy.hash,
          approval: {
            id: `approval-${sha256(supplied).slice(0, 40)}`,
            actorId: context.actorId || "trusted-session",
            actorName: operatorName,
            mode: "human",
            evidence: { confirmationText, privilegedBinding, approvalIdentity: context.privilegedIdentity || null },
          },
          expectedVersion: plan.stateVersion,
        });
      } catch (cause) {
        const concurrent = await this.#approval(planId);
        const stored = concurrent && { merkleRoot: concurrent.merkleRoot, operatorName: concurrent.actorName,
          confirmationText: concurrent.evidence.confirmationText, privilegedBinding: concurrent.evidence.privilegedBinding ?? null, actorId: concurrent.actorId };
        if (!stored || canonicalJson(stored) !== canonicalJson(supplied)) throw cause;
      }
      await this.repository.recordApprovalSagaPhase(planId, "DOMAIN_APPROVED", supplied);
      await this.foundation.operationPlans.approve(foundationPlan.id, {
        planHash: foundationPlan.planHash,
        approvalText: confirmationText,
        actorType: "user",
        actorId: context.actorId || "trusted-session",
      });
      await this.repository.recordApprovalSagaPhase(planId, "BOTH_APPROVED", {
        ...supplied, foundationPlanId: foundationPlan.id, foundationPlanHash: foundationPlan.planHash,
      });
    } catch (cause) {
      let compensationFailed = false;
      const current = await this.repository.getPlan(planId);
      if (current?.state === "APPROVED") await this.repository.markPlanState({ planId, fromState: "APPROVED", toState: "BLOCKED",
        expectedVersion: current.stateVersion, reasonCode: cause?.code || "SHOPEE_DISCOUNT_APPROVAL_SAGA_FAILED" }).catch(() => { compensationFailed = true; });
      await this.foundation.operationPlans.block(foundationPlan.id, { reasonCode: cause?.code || "SHOPEE_DISCOUNT_APPROVAL_SAGA_FAILED",
        evidence: { planId, merkleRoot } }).catch(() => { compensationFailed = true; });
      if (compensationFailed) await this.repository.recordApprovalSagaPhase(planId, "COMPENSATION_FAILED", {
        causeCode: cause?.code || "SHOPEE_DISCOUNT_APPROVAL_SAGA_FAILED",
      }).catch(() => {});
      throw cause;
    }
    return this.getPreview(planId, context);
  }

  async requestExecution(input, context = {}) {
    exactFields(input, EXECUTION_FIELDS, "execution request");
    const plan = await this.getPreview(requiredText(input.planId, "planId", 100), context);
    const merkleRoot = requiredText(input.merkleRoot, "merkleRoot", 128);
    if (plan.merkleRoot !== merkleRoot) throw domainError("SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH", "Execution root does not match the approved plan");
    if (plan.state !== "APPROVED") throw domainError("SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED", "Plan is not approved");
    if (!plan.expiresAt || this.now().getTime() >= new Date(plan.expiresAt).getTime()) throw domainError("SHOPEE_DISCOUNT_PLAN_EXPIRED", "Approved plan has expired");
    if (plan.policyHash !== this.policy().hash) throw domainError("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Execution policy changed after approval");
    const approval = await this.#approval(plan.id);
    if (!approval || approval.merkleRoot !== plan.merkleRoot || approval.policyHash !== plan.policyHash) throw domainError("SHOPEE_DISCOUNT_EXECUTION_NOT_APPROVED", "Exact approval binding is missing");
    const approvalPhase = await this.repository.getApprovalSagaPhase(plan.id);
    const foundationPlan = await this.foundation.operationPlans.get(plan.foundationPlanId);
    if (approvalPhase?.phase !== "BOTH_APPROVED" || foundationPlan?.state !== "APPROVED"
      || foundationPlan.summary?.merkleRoot !== plan.merkleRoot || foundationPlan.policyHash !== plan.policyHash
      || foundationPlan.approvedBy !== approval.actorId
      || approvalPhase.evidence?.foundationPlanHash !== foundationPlan.planHash) {
      throw domainError("SHOPEE_DISCOUNT_FOUNDATION_APPROVAL_REQUIRED", "Execution requires matching domain and Foundation approvals");
    }
    const security = this.writeSecurity();
    assertShopeeWriteAuthorized(security, {
      action: "execute_plan",
      identity: security.mode === "separate_execute_identity" ? context.privilegedIdentity ?? context.identity : context.identity,
      approvalIdentity: approval.evidence.approvalIdentity,
    });
    if (plan.itemCount < 1) throw domainError("SHOPEE_DISCOUNT_NO_EXECUTABLE_ITEMS", "Approved plan contains no executable items");
    const counts = await this.repository.countPlanItemsByShop(plan.id);
    for (const row of counts) {
      assertShopeeWriteAuthorized(security, {
        action: "execute",
        identity: security.mode === "separate_execute_identity" ? context.privilegedIdentity ?? context.identity : context.identity,
        approvalIdentity: approval.evidence.approvalIdentity,
        country: plan.country,
        shopId: row.shopId,
        batchSize: row.itemCount,
      });
    }
    const storage = await this.repository.getStorageMode();
    if (!storage.productionScale && (counts.length > 1 || plan.itemCount > 10)) throw domainError("SHOPEE_DISCOUNT_SQLITE_LIMIT", "SQLite execution exceeds pilot limits");
    const current = await this.repository.listExecutionJobs(plan.id);
    if (current[0]) {
      return { ...current[0], reused: true };
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
      const concurrent = await this.repository.listExecutionJobs(plan.id);
      if (!concurrent[0]) throw cause;
      return { ...concurrent[0], reused: true };
    }
  }

  async listRuns(filters = {}, context = {}) {
    exactFields(filters, new Set(["status", "planId", "limit"]), "run filters");
    return this.repository.listRunsScoped({ ...filters, status: filters.status ? requiredText(filters.status, "status", 40) : null,
      planId: filters.planId ? requiredText(filters.planId, "planId", 100) : null }, context.authorizedShopIds);
  }

  async listActivities(filters = {}, context = {}) {
    exactFields(filters, new Set(["shopId", "status", "limit"]), "activity filters");
    return this.repository.listActivitiesScoped({ ...filters, shopId: filters.shopId ? canonicalId(filters.shopId, "shopId") : null,
      status: filters.status ? requiredText(filters.status, "status", 40) : null }, context.authorizedShopIds);
  }

  async listIssues(filters = {}, context = {}) {
    exactFields(filters, new Set(["planId", "code", "limit"]), "issue filters");
    return this.repository.listIssuesScoped({ ...filters, planId: filters.planId ? requiredText(filters.planId, "planId", 100) : null,
      code: filters.code ? requiredText(filters.code, "code", 100) : null }, context.authorizedShopIds);
  }

  async requestManualScan(input, context = {}) {
    exactFields(input, new Set(["country", "shopIds"]), "manual scan");
    const country = requiredText(input.country, "country", 3).toUpperCase();
    if (!Array.isArray(input.shopIds) || !input.shopIds.length) throw domainError("SHOPEE_DISCOUNT_INPUT_INVALID", "shopIds are required");
    const shopIds = input.shopIds.map((id) => canonicalId(id, "shopId"));
    if (new Set(shopIds).size !== shopIds.length) throw domainError("SHOPEE_DISCOUNT_OVERRIDE_CONFLICT", "Duplicate shop IDs are not allowed");
    const available = await this.listShops(context);
    const selected = shopIds.map((id) => available.find((shop) => shop.shopId === id));
    if (selected.some((shop) => !shop)) throw domainError("SHOPEE_DISCOUNT_SHOP_NOT_AUTHORIZED", "A scan shop is unhealthy or unauthorized");
    if (selected.some((shop) => shop.country !== country)) throw domainError("SHOPEE_DISCOUNT_SHOP_COUNTRY_MISMATCH", "Scan shops must belong to the selected country");
    try { return await this.repository.createDueJob({
      jobType: "MANUAL_SCAN",
      dedupeKey: `manual:${country}:${randomUUID()}`,
      dueAt: this.now(),
      payload: { country, shopIds: [...shopIds].sort() },
      createdBy: context.actorId || "trusted-session",
    }); } catch (cause) {
      if (!/UNIQUE|duplicate/i.test(String(cause?.message || cause))) throw cause;
      throw domainError("SHOPEE_DISCOUNT_SCAN_ALREADY_QUEUED", "An identical manual scan is already queued");
    }
  }
}

export { domainError as shopeeDiscountError };
