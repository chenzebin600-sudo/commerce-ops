import { foundationStableId } from "./foundation-contracts.mjs";

function canonicalSourceSystem(value, fallback = "company_product_center") {
  const source = String(value || "").trim().toLowerCase();
  return [
    "mabang",
    "shopee",
    "lazada",
    "tiktok_shop",
    "company_product_center",
    "commerce_ops",
  ].includes(source) ? source : fallback;
}

function marketplaceSource(platform) {
  const value = String(platform || "").trim().toLowerCase();
  if (value.includes("shopee")) return "shopee";
  if (value.includes("lazada")) return "lazada";
  if (value.includes("tiktok")) return "tiktok_shop";
  return "mabang";
}

export class FoundationMasterDataService {
  constructor({ repository, now = () => new Date() }) {
    this.repository = repository;
    this.now = now;
  }

  async synchronizeOwners() {
    const owners = await this.repository.listGrowthShopOwners();
    for (const owner of owners) {
      await this.repository.upsertOwner({
        id: `foundation:owner:growth:${owner.owner_user_id}`,
        displayName: owner.owner_user_id,
        sourceSystem: "commerce_ops",
        externalKey: owner.owner_user_id,
        status: "active",
        metadata: { derivedFrom: "growth_shops.owner_user_id" },
        createdAt: owner.created_at,
      }, this.now());
    }
    return { synchronizedCount: owners.length };
  }

  async synchronizeWarehouses() {
    const warehouses = await this.repository.listWarehouseFacts();
    for (const warehouse of warehouses) {
      const canonicalKey = `mabang:${warehouse.normalized_name}`;
      const id = `foundation:warehouse:${canonicalKey}`;
      await this.repository.upsertWarehouse({
        id,
        canonicalKey,
        displayName: warehouse.display_name,
        normalizedName: warehouse.normalized_name,
        identityStatus: "review_required",
        metadata: {
          sourceSystem: "mabang",
          observationCount: Number(warehouse.observation_count || 0),
          countryMappingRequired: true,
        },
        createdAt: warehouse.created_at,
      }, this.now());
      await this.repository.upsertIdentityLink({
        id: foundationStableId("identity", "mabang", "warehouse", warehouse.normalized_name),
        entityType: "warehouse",
        entityId: id,
        sourceSystem: "mabang",
        sourceEntityType: "warehouse",
        externalKey: warehouse.display_name,
        normalizedExternalKey: warehouse.normalized_name,
        matchStatus: "unresolved",
        evidence: {
          observationCount: Number(warehouse.observation_count || 0),
          countryMappingRequired: true,
        },
        firstSeenAt: warehouse.created_at,
        lastSeenAt: warehouse.updated_at,
      }, this.now());
    }
    return {
      synchronizedCount: warehouses.length,
      reviewRequiredCount: warehouses.length,
    };
  }

  async synchronizeProductIdentities() {
    const [products, skus] = await Promise.all([
      this.repository.listCanonicalProducts(),
      this.repository.listCanonicalSkus(),
    ]);
    for (const product of products) {
      const sourceSystem = canonicalSourceSystem(product.source_system);
      const normalizedKey = String(product.source_main_sku || "").trim().toLowerCase();
      await this.repository.upsertIdentityLink({
        id: foundationStableId("identity", sourceSystem, "product", normalizedKey),
        entityType: "product",
        entityId: product.id,
        sourceSystem,
        sourceEntityType: "product",
        externalKey: product.source_main_sku,
        normalizedExternalKey: normalizedKey,
        matchStatus: product.identity_status === "confirmed" ? "confirmed" : "suggested",
        evidence: { canonicalTable: "product_models" },
        firstSeenAt: product.created_at,
        lastSeenAt: product.updated_at,
        confirmedBy: product.identity_status === "confirmed" ? "product-center" : null,
        confirmedAt: product.identity_status === "confirmed" ? product.created_at : null,
      }, this.now());
    }
    for (const sku of skus) {
      const sourceSystem = canonicalSourceSystem(sku.source_system);
      await this.repository.upsertIdentityLink({
        id: foundationStableId("identity", sourceSystem, "sku", sku.normalized_sku),
        entityType: "sku",
        entityId: sku.id,
        sourceSystem,
        sourceEntityType: "sku",
        externalKey: sku.source_sku,
        normalizedExternalKey: sku.normalized_sku,
        matchStatus: "confirmed",
        evidence: {
          canonicalTable: "product_skus",
          lifecycleStatus: sku.archived_at ? "archived" : "active",
        },
        firstSeenAt: sku.created_at,
        lastSeenAt: sku.updated_at,
        confirmedBy: "product-center",
        confirmedAt: sku.created_at,
      }, this.now());
    }
    return { productCount: products.length, skuCount: skus.length };
  }

  async synchronizeStoreIdentities() {
    const stores = await this.repository.listCanonicalStores();
    for (const store of stores) {
      const sourceSystem = marketplaceSource(store.platform);
      const normalizedKey = String(store.internal_shop_code || "").trim().toLowerCase();
      await this.repository.upsertIdentityLink({
        id: foundationStableId("identity", sourceSystem, "shop", normalizedKey),
        entityType: "store",
        entityId: store.id,
        sourceSystem,
        sourceEntityType: "shop",
        externalKey: store.internal_shop_code,
        normalizedExternalKey: normalizedKey,
        matchStatus: store.identity_status === "confirmed" ? "confirmed" : "suggested",
        evidence: {
          canonicalTable: "growth_shops",
          displayName: store.display_name,
        },
        firstSeenAt: store.created_at,
        lastSeenAt: store.updated_at,
        confirmedBy: store.identity_status === "confirmed" ? "growth-radar" : null,
        confirmedAt: store.identity_status === "confirmed" ? store.created_at : null,
      }, this.now());
    }
    return { synchronizedCount: stores.length };
  }

  async synchronize() {
    const [owners, warehouses, productIdentities, storeIdentities] = await Promise.all([
      this.synchronizeOwners(),
      this.synchronizeWarehouses(),
      this.synchronizeProductIdentities(),
      this.synchronizeStoreIdentities(),
    ]);
    return { owners, warehouses, productIdentities, storeIdentities };
  }
}
