import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../database-provider.mjs";

function json(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function iso() {
  return new Date().toISOString();
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    productId: row.product_sku_id,
    country: row.country,
    sku: row.sku,
    platform: row.platform,
    shopId: row.shop_id || null,
    shopName: row.shop_name || null,
    marketplace: row.marketplace || null,
    platformCategoryId: row.platform_category_id || null,
    platformCategoryName: row.platform_category_name || null,
    listingMode: row.listing_mode,
    title: row.title || "",
    subtitle: row.subtitle || "",
    description: row.description || "",
    searchKeywords: json(row.search_keywords_json, []),
    brand: row.brand || "",
    model: row.model || "",
    targetUsers: row.target_users || "",
    contentLanguage: row.content_language,
    sellingPoints: json(row.selling_points_json, []),
    usageScenarios: json(row.usage_scenarios_json, []),
    platformAttributes: json(row.platform_attributes_json, []),
    variants: json(row.variants_json, []),
    pricing: json(row.pricing_json, {}),
    media: json(row.media_json, {}),
    logistics: json(row.logistics_json, {}),
    compliance: json(row.compliance_json, {}),
    status: row.status,
    validationResult: json(row.validation_result_json, {}),
    revision: Number(row.revision || 1),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

export class ProductListingRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  async list(productId) {
    const rows = await this.provider.query(`SELECT * FROM ${this.table("product_listing_drafts")}
      WHERE product_sku_id=${this.provider.placeholder(1)} AND deleted_at IS NULL ORDER BY updated_at DESC`, [productId]);
    return rows.rows.map(serialize);
  }

  async get(id, client = this.provider) {
    const row = (await client.query(`SELECT * FROM ${this.table("product_listing_drafts")} WHERE id=${client.placeholder(1)}`, [id])).rows[0];
    return serialize(row);
  }

  async upsert(input) {
    return this.provider.transaction(async (tx) => {
      const existing = (await tx.query(`SELECT id FROM ${this.table("product_listing_drafts")}
        WHERE product_sku_id=${tx.placeholder(1)} AND platform=${tx.placeholder(2)} AND country=${tx.placeholder(3)}
          AND shop_key=${tx.placeholder(4)} AND deleted_at IS NULL LIMIT 1`,
      [input.productId, input.platform, input.country, input.shopKey])).rows[0];
      const now = iso();
      const columns = [
        "shop_id", "shop_name", "marketplace", "platform_category_id", "platform_category_name", "listing_mode",
        "title", "subtitle", "description", "search_keywords_json", "brand", "model", "target_users", "content_language",
        "selling_points_json", "usage_scenarios_json", "platform_attributes_json", "variants_json", "pricing_json", "media_json",
        "logistics_json", "compliance_json", "status", "validation_result_json", "updated_by", "updated_at",
      ];
      const values = [
        input.shopId, input.shopName, input.marketplace, input.platformCategoryId, input.platformCategoryName, input.listingMode,
        input.title, input.subtitle, input.description, JSON.stringify(input.searchKeywords), input.brand, input.model, input.targetUsers,
        input.contentLanguage, JSON.stringify(input.sellingPoints), JSON.stringify(input.usageScenarios), JSON.stringify(input.platformAttributes),
        JSON.stringify(input.variants), JSON.stringify(input.pricing), JSON.stringify(input.media), JSON.stringify(input.logistics),
        JSON.stringify(input.compliance), input.status, JSON.stringify(input.validationResult), input.updatedBy, now,
      ];
      if (existing) {
        const assignments = columns.map((column, index) => `${column}=${tx.placeholder(index + 1)}`);
        assignments.push("revision=revision+1");
        values.push(existing.id);
        await tx.execute(`UPDATE ${this.table("product_listing_drafts")} SET ${assignments.join(",")}
          WHERE id=${tx.placeholder(values.length)}`, values);
        return this.get(existing.id, tx);
      }
      const id = randomUUID();
      const insertColumns = [
        "id", "product_sku_id", "country", "sku", "platform", "shop_key", ...columns,
        "created_by", "created_at", "deleted_at",
      ];
      const insertValues = [
        id, input.productId, input.country, input.sku, input.platform, input.shopKey, ...values,
        input.updatedBy, now, null,
      ];
      const placeholders = insertValues.map((_, index) => tx.placeholder(index + 1));
      await tx.execute(`INSERT INTO ${this.table("product_listing_drafts")} (${insertColumns.join(",")}) VALUES (${placeholders.join(",")})`, insertValues);
      return this.get(id, tx);
    });
  }

  async softDelete(productId, draftId, operatorLabel) {
    const now = iso();
    const result = await this.provider.execute(`UPDATE ${this.table("product_listing_drafts")} SET status='archived',deleted_at=${this.provider.placeholder(1)},
      updated_by=${this.provider.placeholder(2)},updated_at=${this.provider.placeholder(3)},revision=revision+1
      WHERE id=${this.provider.placeholder(4)} AND product_sku_id=${this.provider.placeholder(5)} AND deleted_at IS NULL`,
    [now, operatorLabel, now, draftId, productId]);
    return result.rowCount > 0;
  }

  async softDeleteAll(productId, operatorLabel) {
    const now = iso();
    const result = await this.provider.execute(`UPDATE ${this.table("product_listing_drafts")} SET status='archived',deleted_at=${this.provider.placeholder(1)},
      updated_by=${this.provider.placeholder(2)},updated_at=${this.provider.placeholder(3)},revision=revision+1
      WHERE product_sku_id=${this.provider.placeholder(4)} AND deleted_at IS NULL`,
    [now, operatorLabel, now, productId]);
    return result.rowCount;
  }
}
