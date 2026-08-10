import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { normalizeSku } from "./product-package-contract.mjs";

function rowValue(row) {
  return {
    productSkuId: row.product_sku_id,
    productModelId: row.product_model_id || null,
    categoryId: row.category_id,
    categoryL1: row.category_l1 || null,
    categoryL2: row.category_l2 || null,
    countryCode: row.country_code || null,
    stockSku: row.stock_sku,
    mainSku: row.main_sku || null,
    productName: row.product_name,
    styleName: row.style_name || null,
    salesSpec: row.sales_spec || null,
    revision: Number(row.revision || 0),
    updatedAt: row.updated_at,
  };
}

export class ProductCoreReadFacade {
  constructor({ provider }) {
    if (!provider) throw new TypeError("Database provider is required");
    this.provider = createPortableRepositoryExecutor(provider);
  }

  async resolveExactSku({ sku, countryCode = null } = {}) {
    const normalizedSku = normalizeSku(sku);
    if (!normalizedSku) return { status: "MISSING_SKU", normalizedSku: null, candidates: [] };
    const parameters = [normalizedSku];
    const countryClause = countryCode
      ? `AND UPPER(s.country_raw)=${this.provider.placeholder(parameters.push(String(countryCode).toUpperCase()))}`
      : "";
    const result = await this.provider.query(
      `SELECT s.id product_sku_id,s.model_id product_model_id,s.category_id,
         c1.source_name category_l1,c2.source_name category_l2,
         s.country_raw country_code,s.sku_code_normalized stock_sku,s.source_main_sku main_sku,
         s.source_product_name product_name,s.source_style_name style_name,s.source_sales_spec sales_spec,
         s.revision,s.updated_at
       FROM product_skus s
       JOIN product_categories c2 ON c2.id=s.category_id
       LEFT JOIN product_categories c1 ON c1.id=c2.parent_id
       WHERE s.sku_code_normalized=${this.provider.placeholder(1)}
         ${countryClause}
         AND s.archived_at IS NULL AND s.deleted_at IS NULL
       ORDER BY s.updated_at DESC,s.id`,
      parameters,
    );
    const candidates = result.rows.map(rowValue);
    if (!candidates.length) return { status: "NOT_FOUND", normalizedSku, candidates: [] };
    const identities = new Set(candidates.map((item) => `${item.productModelId || ""}\u0000${item.productSkuId}`));
    if (identities.size > 1) return { status: "AMBIGUOUS", normalizedSku, candidates };
    const product = candidates[0];
    if (!product.productModelId) return { status: "MODEL_MAPPING_REQUIRED", normalizedSku, product, candidates };
    return { status: "RESOLVED", normalizedSku, product, candidates };
  }
}
