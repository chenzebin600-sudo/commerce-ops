import { randomUUID } from "node:crypto";
import { runApprovedPlan } from "./executor.mjs";
import { parseMinorUnits } from "./contracts.mjs";

function payload(result) { return result?.data?.response ?? result?.data ?? result?.response ?? result ?? {}; }
function rows(value, ...keys) { for (const key of keys) if (Array.isArray(value?.[key])) return value[key]; return []; }
function id(value) { return value == null ? "" : String(value); }
function price(source, scale, minorNames, decimalNames) {
  for (const candidate of [source, ...rows(source, "price_info", "priceInfo")]) {
    for (const name of minorNames) if (candidate?.[name] != null && /^(?:0|[1-9]\d*)$/.test(String(candidate[name]))) return String(candidate[name]);
    for (const name of decimalNames) if (candidate?.[name] != null) try { return parseMinorUnits(String(candidate[name]), scale).toString(); } catch { /* fail closed below */ }
  }
  return null;
}
function membershipRows(detail) { return rows(detail, "item_list", "items", "discount_item_list"); }
function membershipModel(detail, item) {
  const product = membershipRows(detail).find((entry) => id(entry.item_id ?? entry.itemId) === item.itemId);
  if (!product) return null;
  return rows(product, "model_list", "models").find((entry) => id(entry.model_id ?? entry.modelId ?? "0") === item.modelId) || (item.modelId === "0" ? product : null);
}
function platformEpochMs(value) {
  if (!/^(?:0|[1-9]\d*)$/.test(String(value ?? ""))) return null;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) return null;
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

export function relayNonTransmissionEvidence(intent, response) {
  const expected = String(intent?.operationUuid || "");
  const observed = String(response?.operation_uuid ?? response?.operationUuid ?? "");
  const requestId = String(response?.request_id ?? response?.requestId ?? "").trim();
  const deterministic = Boolean(expected && observed === expected && response?.transmitted === false && requestId);
  return { deterministic, transmitted: response?.transmitted, source: "RELAY", operationUuid: deterministic ? observed : null, relayRequestId: requestId || null };
}

export async function resolveWarehouseSettingsKey(settings, { decryptCiphertext, resolveManagedReference } = {}) {
  const ciphertext = settings?.encryptedWarehouseKeyCiphertext || null;
  const reference = settings?.warehouseKeyReference || null;
  if (Boolean(ciphertext) === Boolean(reference)) throw Object.assign(new Error("Exactly one warehouse credential mode is required"), { code: "SHOPEE_DISCOUNT_WAREHOUSE_KEY_UNAVAILABLE" });
  let key;
  if (ciphertext) {
    if (typeof decryptCiphertext !== "function") throw Object.assign(new Error("Warehouse key decryptor is unavailable"), { code: "SHOPEE_DISCOUNT_WAREHOUSE_KEY_UNAVAILABLE" });
    key = await decryptCiphertext(ciphertext);
  } else {
    if (typeof resolveManagedReference !== "function") throw Object.assign(new Error("Managed warehouse secret resolver is unavailable"), { code: "SHOPEE_DISCOUNT_MANAGED_SECRET_RESOLVER_REQUIRED" });
    key = await resolveManagedReference(reference);
  }
  if (typeof key !== "string" || !key.startsWith("zndr_")) throw Object.assign(new Error("Resolved warehouse key is invalid"), { code: "SHOPEE_DISCOUNT_WAREHOUSE_KEY_INVALID" });
  return key;
}

export function createProductionReaders({ shopee, warehouse }) {
  if (!shopee || !warehouse) throw new TypeError("Production read adapters are required");
  const readDiscount = async ({ shopId, discountId, requestId }) => {
    let first = null; const items = [];
    for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
      const page = payload(await shopee.getDiscount({ shopId, discountId, pageNo, pageSize: 100, requestId }));
      first ||= page; items.push(...membershipRows(page));
      if (!(page.more ?? page.has_next_page)) return { ...first, item_list: items };
    }
    throw Object.assign(new Error("Discount detail scan exceeded its bound"), { code: "SHOPEE_DISCOUNT_SHOPEE_PAGINATION" });
  };
  return {
    async getShopAuthorization({ shopId, requestId }) {
      const shops = rows(payload(await shopee.listShops({ requestId })), "shops", "shop_list", "list");
      return { authorized: shops.some((shop) => id(shop.shop_id ?? shop.shopId) === shopId && shop.authorized !== false) };
    },
    async getWarehouseState({ plan, item, requestId }) {
      const tier = item.payload.priceTier;
      const result = await warehouse.scanPrices({ country: plan.country, category: plan.summary?.category || "家具", skus: [item.sku], watermark: item.payload.warehouseWatermark, requestId });
      const row = result?.rows?.find((entry) => entry.sku === item.sku);
      return { targetPriceMinor: row?.[`${tier.toLowerCase()}Minor`] ?? row?.selectedMinor ?? null, watermark: result?.watermark ?? result?.evidence?.watermark, approvedAt: row?.approvedAt ?? row?.[`${tier.toLowerCase()}ApprovedAt`] ?? null };
    },
    async getListingState({ item, requestId }) {
      const base = rows(payload(await shopee.getItemBaseInfo({ shopId: item.shopId, itemIds: [item.itemId], requestId })), "item_list", "items")[0] || {};
      const models = rows(payload(await shopee.getModelList({ shopId: item.shopId, itemId: item.itemId, requestId })), "model", "model_list", "models");
      const model = models.find((entry) => id(entry.model_id ?? entry.modelId) === item.modelId) || base;
      return { status: String(base.item_status ?? base.status ?? "").toUpperCase() === "NORMAL" ? "ACTIVE" : String(base.item_status ?? base.status ?? "UNKNOWN").toUpperCase(), sku: String(model.model_sku ?? base.item_sku ?? "").trim(), originalPriceMinor: price(model, item.scale, ["original_price_minor", "originalMinor"], ["original_price", "originalPrice"]) ?? price(base, item.scale, ["original_price_minor", "originalMinor"], ["original_price", "originalPrice"]) };
    },
    async getDiscountState({ item, activity, requestId }) {
      if (!activity.platformActivityId) {
        const targetStart = new Date(activity.startsAt).getTime();
        const targetEnd = new Date(activity.endsAt).getTime();
        if (!Number.isFinite(targetStart) || !Number.isFinite(targetEnd) || targetStart >= targetEnd) {
          return { conflict: true, activityId: null, membership: false, reasonCode: "INVALID_APPROVED_ACTIVITY_WINDOW" };
        }
        let conflict = false;
        let exactActivityId = null;
        const seen = new Set();
        for (const status of ["upcoming", "ongoing"]) {
          for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
            const page = payload(await shopee.listDiscounts({ shopId: item.shopId, status, pageNo, pageSize: 100, requestId }));
            for (const summary of rows(page, "discount_list", "discounts")) {
              const discountId = id(summary.discount_id ?? summary.discountId);
              if (!discountId || seen.has(discountId)) continue;
              seen.add(discountId);
              const detail = await readDiscount({ shopId: item.shopId, discountId, requestId });
              const start = platformEpochMs(detail.start_time ?? detail.startTime);
              const end = platformEpochMs(detail.end_time ?? detail.endTime);
              if (start == null || end == null || start >= end) {
                conflict = true;
                continue;
              }
              if (start < targetEnd && end > targetStart) {
                const exactMarker = String(detail.discount_name ?? detail.name ?? "") === String(activity.metadata?.discountName ?? "")
                  && start === targetStart && end === targetEnd;
                if (exactMarker) exactActivityId = discountId;
                else conflict = true;
              }
            }
            if (!(page.more ?? page.has_next_page)) break;
            if (pageNo === 100) throw Object.assign(new Error("Discount overlap scan exceeded its bound"), { code: "SHOPEE_DISCOUNT_SHOPEE_PAGINATION" });
          }
        }
        return { conflict, activityId: exactActivityId, membership: false, markerMatch: Boolean(exactActivityId) };
      }
      let memberships = 0;
      for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
        const page = payload(await shopee.listDiscounts({ shopId: item.shopId, status: "ongoing", pageNo, pageSize: 100, requestId }));
        for (const summary of rows(page, "discount_list", "discounts")) {
          const discountId = id(summary.discount_id ?? summary.discountId);
          const detail = await readDiscount({ shopId: item.shopId, discountId, requestId });
          if (membershipModel(detail, item)) memberships += 1;
        }
        if (!(page.more ?? page.has_next_page)) break;
        if (pageNo === 100) throw Object.assign(new Error("Discount overlap scan exceeded its bound"), { code: "SHOPEE_DISCOUNT_SHOPEE_PAGINATION" });
      }
      const target = await readDiscount({ shopId: item.shopId, discountId: activity.platformActivityId, requestId });
      return { conflict: memberships > 1, activityId: id(target.discount_id ?? activity.platformActivityId), membership: Boolean(membershipModel(target, item)) };
    },
    async findActivityByMarker({ activity, requestId }) {
      for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
        const page = payload(await shopee.listDiscounts({ shopId: activity.shopId, status: "all", pageNo, pageSize: 100, requestId }));
        const found = rows(page, "discount_list", "discounts").find((entry) => String(entry.discount_name ?? entry.name ?? "").includes(activity.metadata.marker));
        if (found) return { platformObjectId: id(found.discount_id ?? found.discountId), markerVerified: true };
        if (!(page.more ?? page.has_next_page)) break;
      }
      return null;
    },
    async readbackIntent({ intent, item, activity, requestId }) {
      const platformObjectId = activity.platformActivityId || id((await this.findActivityByMarker({ activity, requestId }))?.platformObjectId);
      if (!platformObjectId) return null;
      const detail = await readDiscount({ shopId: activity.shopId, discountId: platformObjectId, requestId });
      const model = item ? membershipModel(detail, item) : null;
      const name = String(detail.discount_name ?? detail.name ?? "");
      const exactActivity = name === activity.metadata.discountName && id(detail.start_time) === String(new Date(activity.startsAt).getTime() / 1000) && id(detail.end_time) === String(new Date(activity.endsAt).getTime() / 1000);
      return { verified: true, operationUuid: intent.operationUuid, payloadHash: intent.payloadHash, activityId: platformObjectId, platformObjectId, markerVerified: exactActivity, shopId: activity.shopId, discountName: name, marker: exactActivity ? name : null, fingerprint: exactActivity ? activity.metadata.fingerprint : null, startTime: id(detail.start_time), endTime: id(detail.end_time), membership: item ? Boolean(model) : true, itemId: item?.itemId ?? null, modelId: item?.modelId ?? null, priceMinor: item && model ? price(model, item.scale, ["discount_price_minor", "promotion_price_minor"], ["model_promotion_price", "discount_price", "promotion_price"]) : null };
    },
  };
}

export function createManualExecutionRuntime({ repository, foundation, shopeeRead, shopeeWrite, warehouse, writeSecurity, currentPolicyHash, siteCapability, now = () => new Date() }) {
  if (!repository || !foundation || !shopeeWrite || typeof writeSecurity !== "function" || !currentPolicyHash || !siteCapability) throw new TypeError("Complete manual execution runtime is required");
  const readers = createProductionReaders({ shopee: shopeeRead, warehouse });
  return async (planId, { context } = {}) => {
    const actor = context?.identity;
    const identity = context?.privilegedIdentity || actor;
    if (!actor?.actorId || !identity) throw Object.assign(new Error("Authenticated execution identity is required"), { code: "SHOPEE_DISCOUNT_PRIVILEGED_IDENTITY_REQUIRED" });
    return runApprovedPlan(planId, { repository, foundation, readers, shopeeWrite, writeSecurity, currentPolicyHash, siteCapability,
      identity, workerId: `manual:${actor.actorId}:${context.requestId || randomUUID()}`, requestId: context.requestId || randomUUID(), leaseMs: 30_000, now });
  };
}
