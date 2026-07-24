import { randomUUID } from "node:crypto";
import { DATABASE_DIALECTS, assertDatabaseProvider } from "../data/database-provider.mjs";
import { normalizeSku } from "./extraction.mjs";

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function jsonValue(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function serializeBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    sourceBatchId: row.source_batch_id || null,
    mode: row.mode,
    status: row.status,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    pausedAt: row.paused_at || null,
    currentPage: Number(row.current_page || 0),
    totalPages: row.total_pages === null ? null : Number(row.total_pages),
    discoveredSkus: Number(row.discovered_skus || 0),
    downloadedImages: Number(row.downloaded_images || 0),
    missingImages: Number(row.missing_images || 0),
    duplicateImages: Number(row.duplicate_images || 0),
    failedImages: Number(row.failed_images || 0),
    linkedProducts: Number(row.linked_products || 0),
    sharedCountryLinks: Number(row.shared_country_links || 0),
    filenameMismatches: Number(row.filename_mismatches || 0),
    interfaceProfile: jsonValue(row.interface_profile_json, {}),
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeDiscovery(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    sourceSku: row.source_sku,
    normalizedSku: row.source_sku_normalized,
    productName: row.product_name || null,
    warehouseName: row.warehouse_name || null,
    sourceImageUrl: row.source_image_url || null,
    imageSrc: row.image_src || null,
    imageDataSrc: row.image_data_src || null,
    imageSrcset: row.image_srcset || null,
    imageBackgroundUrl: row.image_background_url || null,
    sourceKind: row.source_kind,
    sourcePage: Number(row.source_page),
    sourceRowNumber: Number(row.source_row_number),
    filenameSku: row.filename_sku || null,
    validationStatus: row.validation_status,
    qualityIssueCode: row.quality_issue_code || null,
    downloadStatus: row.download_status,
    assetId: row.asset_id || null,
    downloadAttempts: Number(row.download_attempts || 0),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    discoveredAt: row.discovered_at,
    lastCheckedAt: row.last_checked_at,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
  };
}

function serializeAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceSystem: row.source_system,
    sourceUrl: row.source_url || null,
    storageFileId: row.storage_file_id,
    originalFilename: row.original_filename,
    storageFilename: row.storage_filename,
    relativePath: row.relative_path,
    sha256: row.sha256,
    mimeType: row.mime_type,
    width: Number(row.width),
    height: Number(row.height),
    fileSize: Number(row.file_size),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    assetId: row.asset_id,
    sourceSku: row.source_sku,
    normalizedSku: row.source_sku_normalized,
    productId: row.product_id,
    countryCode: row.country_code || "",
    mediaRole: row.media_role,
    mappingStatus: row.mapping_status,
    linkedAt: row.linked_at,
    linkedBy: row.linked_by,
    confirmedAt: row.confirmed_at || null,
    confirmedBy: row.confirmed_by || null,
    productName: row.source_product_name || null,
  };
}

const BATCH_FIELDS = Object.freeze({
  status: "status", startedAt: "started_at", completedAt: "completed_at", pausedAt: "paused_at",
  currentPage: "current_page", totalPages: "total_pages", interfaceProfile: "interface_profile_json",
  lastErrorCode: "last_error_code", lastErrorMessage: "last_error_message",
});

export class MabangImageRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) { return `${this.prefix}${name}`; }

  placeholders(client, count) {
    return Array.from({ length: count }, (_, index) => client.placeholder(index + 1));
  }

  async createBatch({ accountId, mode, createdBy, sourceBatchId = null }) {
    const id = randomUUID();
    const now = iso();
    const p = this.placeholders(this.provider, 9);
    await this.provider.execute(`INSERT INTO ${this.table("mabang_sku_image_batches")} (
      id,account_id,source_batch_id,mode,status,created_by,created_at,updated_at,interface_profile_json
    ) VALUES (${p.join(",")})`, [id, accountId, sourceBatchId, mode, "pending", createdBy, now, now, "{}"]);
    return this.getBatch(id);
  }

  async getBatch(id) {
    const row = (await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_batches")}
      WHERE id=${this.provider.placeholder(1)}`, [id])).rows[0];
    return serializeBatch(row);
  }

  async listBatches({ limit = 50 } = {}) {
    const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
    const rows = await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_batches")}
      ORDER BY created_at DESC LIMIT ${capped}`);
    return rows.rows.map(serializeBatch);
  }

  async updateBatch(id, changes = {}) {
    const entries = Object.entries(changes).filter(([key]) => BATCH_FIELDS[key]);
    if (!entries.length) return this.getBatch(id);
    const values = entries.map(([key, value]) => key === "interfaceProfile" ? JSON.stringify(value || {}) : value);
    values.push(iso(), id);
    const setters = entries.map(([key], index) => `${BATCH_FIELDS[key]}=${this.provider.placeholder(index + 1)}`);
    setters.push(`updated_at=${this.provider.placeholder(entries.length + 1)}`);
    await this.provider.execute(`UPDATE ${this.table("mabang_sku_image_batches")} SET ${setters.join(",")}
      WHERE id=${this.provider.placeholder(entries.length + 2)}`, values);
    return this.getBatch(id);
  }

  async requestPause(id) {
    const now = iso();
    await this.provider.execute(`UPDATE ${this.table("mabang_sku_image_batches")} SET status='pause_requested',updated_at=${this.provider.placeholder(1)}
      WHERE id=${this.provider.placeholder(2)} AND status='running'`, [now, id]);
    return this.getBatch(id);
  }

  async upsertCheckpoint({ batchId, pageNumber, pageHash = "", rowCount = 0, discoveredCount = 0,
    failedCount = 0, status = "running", errorCode = null, completedAt = null }) {
    const now = iso();
    const found = (await this.provider.query(`SELECT id FROM ${this.table("mabang_sku_image_checkpoints")}
      WHERE batch_id=${this.provider.placeholder(1)} AND page_number=${this.provider.placeholder(2)}`,
    [batchId, pageNumber])).rows[0];
    if (found) {
      const p = this.placeholders(this.provider, 10);
      await this.provider.execute(`UPDATE ${this.table("mabang_sku_image_checkpoints")} SET
        page_hash=${p[0]},row_count=${p[1]},discovered_count=${p[2]},failed_count=${p[3]},status=${p[4]},
        error_code=${p[5]},completed_at=${p[6]},updated_at=${p[7]} WHERE batch_id=${p[8]} AND page_number=${p[9]}`,
      [pageHash, rowCount, discoveredCount, failedCount, status, errorCode, completedAt, now, batchId, pageNumber]);
    } else {
      const p = this.placeholders(this.provider, 12);
      await this.provider.execute(`INSERT INTO ${this.table("mabang_sku_image_checkpoints")} (
        id,batch_id,page_number,page_hash,row_count,discovered_count,failed_count,status,error_code,completed_at,created_at,updated_at
      ) VALUES (${p.join(",")})`, [randomUUID(), batchId, pageNumber, pageHash, rowCount, discoveredCount,
        failedCount, status, errorCode, completedAt, now, now]);
    }
  }

  async latestCheckpoint(batchId) {
    const row = (await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_checkpoints")}
      WHERE batch_id=${this.provider.placeholder(1)} ORDER BY page_number DESC LIMIT 1`, [batchId])).rows[0];
    return row ? {
      pageNumber: Number(row.page_number), pageHash: row.page_hash, rowCount: Number(row.row_count),
      discoveredCount: Number(row.discovered_count), failedCount: Number(row.failed_count), status: row.status,
      errorCode: row.error_code || null, completedAt: row.completed_at || null,
    } : null;
  }

  async saveDiscoveries(batchId, rows) {
    const now = iso();
    await this.provider.transaction(async (tx) => {
      for (const row of rows) {
        const normalized = normalizeSku(row.sourceSku);
        if (!normalized) continue;
        const exists = (await tx.query(`SELECT id FROM ${this.table("mabang_sku_image_discoveries")}
          WHERE batch_id=${tx.placeholder(1)} AND source_page=${tx.placeholder(2)}
          AND source_row_number=${tx.placeholder(3)} AND source_sku_normalized=${tx.placeholder(4)}`,
        [batchId, row.sourcePage, row.sourceRowNumber, normalized])).rows[0];
        if (exists) {
          const p = this.placeholders(tx, 15);
          await tx.execute(`UPDATE ${this.table("mabang_sku_image_discoveries")} SET
            product_name=${p[0]},warehouse_name=${p[1]},source_image_url=${p[2]},image_src=${p[3]},image_data_src=${p[4]},
            image_srcset=${p[5]},image_background_url=${p[6]},source_kind=${p[7]},filename_sku=${p[8]},
            validation_status=${p[9]},quality_issue_code=${p[10]},last_checked_at=${p[11]}
            WHERE id=${p[12]} AND batch_id=${p[13]} AND source_sku_normalized=${p[14]}`,
          [row.productName, row.warehouseName, row.sourceImageUrl, row.imageSrc, row.imageDataSrc,
            row.imageSrcset, row.imageBackgroundUrl, row.sourceKind, row.filenameSku, row.validationStatus,
            row.qualityIssueCode, now, exists.id, batchId, normalized]);
        } else {
          const p = this.placeholders(tx, 24);
          await tx.execute(`INSERT INTO ${this.table("mabang_sku_image_discoveries")} (
            id,batch_id,source_sku,source_sku_normalized,product_name,warehouse_name,source_image_url,image_src,image_data_src,
            image_srcset,image_background_url,source_kind,source_page,source_row_number,filename_sku,validation_status,
            quality_issue_code,download_status,asset_id,download_attempts,http_status,discovered_at,last_checked_at,error_code
          ) VALUES (${p.join(",")})`, [randomUUID(), batchId, row.sourceSku, normalized, row.productName, row.warehouseName,
            row.sourceImageUrl, row.imageSrc, row.imageDataSrc, row.imageSrcset, row.imageBackgroundUrl, row.sourceKind,
            row.sourcePage, row.sourceRowNumber, row.filenameSku, row.validationStatus, row.qualityIssueCode,
            row.sourceImageUrl ? "pending" : "missing", null, 0, null, now, now, row.sourceImageUrl ? null : "IMAGE_URL_MISSING"]);
        }
      }
    });
  }

  async listDiscoveries(batchId, { status = "", limit = 500, offset = 0 } = {}) {
    const values = [batchId];
    let where = `batch_id=${this.provider.placeholder(1)}`;
    if (status) {
      values.push(status);
      where += ` AND download_status=${this.provider.placeholder(2)}`;
    }
    const capped = Math.max(1, Math.min(Number(limit) || 500, 2000));
    const start = Math.max(0, Number(offset) || 0);
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_discoveries")}
      WHERE ${where} ORDER BY source_page,source_row_number LIMIT ${capped} OFFSET ${start}`, values);
    return result.rows.map(serializeDiscovery);
  }

  async pendingDownloads(batchId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_discoveries")}
      WHERE batch_id=${this.provider.placeholder(1)} AND download_status IN ('pending','failed')
      ORDER BY source_page,source_row_number`, [batchId]);
    return result.rows.map(serializeDiscovery);
  }

  async discoveriesForPage(batchId, pageNumber) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_discoveries")}
      WHERE batch_id=${this.provider.placeholder(1)} AND source_page=${this.provider.placeholder(2)}
      ORDER BY source_row_number`, [batchId, pageNumber]);
    return result.rows.map(serializeDiscovery);
  }

  async failedDownloads(batchId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("mabang_sku_image_discoveries")}
      WHERE batch_id=${this.provider.placeholder(1)} AND download_status='failed'
      ORDER BY source_page,source_row_number`, [batchId]);
    return result.rows.map(serializeDiscovery);
  }

  async selectedSkuKeys(batchId) {
    const result = await this.provider.query(`SELECT DISTINCT source_sku_normalized
      FROM ${this.table("mabang_sku_image_discoveries")}
      WHERE batch_id=${this.provider.placeholder(1)} AND source_sku_normalized IS NOT NULL
      ORDER BY source_sku_normalized`, [batchId]);
    return result.rows.map((row) => normalizeSku(row.source_sku_normalized)).filter(Boolean);
  }

  async updateDiscovery(id, changes = {}) {
    const map = {
      downloadStatus: "download_status", assetId: "asset_id", downloadAttempts: "download_attempts",
      httpStatus: "http_status", validationStatus: "validation_status", errorCode: "error_code", errorMessage: "error_message",
    };
    const entries = Object.entries(changes).filter(([key]) => map[key]);
    if (!entries.length) return;
    const values = entries.map(([, value]) => value);
    values.push(iso(), id);
    const set = entries.map(([key], index) => `${map[key]}=${this.provider.placeholder(index + 1)}`);
    set.push(`last_checked_at=${this.provider.placeholder(entries.length + 1)}`);
    await this.provider.execute(`UPDATE ${this.table("mabang_sku_image_discoveries")} SET ${set.join(",")}
      WHERE id=${this.provider.placeholder(entries.length + 2)}`, values);
  }

  async findAssetBySha256(sha256) {
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_media_assets")}
      WHERE sha256=${this.provider.placeholder(1)}`, [sha256])).rows[0];
    return serializeAsset(row);
  }

  async getAsset(id) {
    const row = (await this.provider.query(`SELECT * FROM ${this.table("product_media_assets")}
      WHERE id=${this.provider.placeholder(1)}`, [id])).rows[0];
    return serializeAsset(row);
  }

  async createAsset(input) {
    const now = iso();
    const p = this.placeholders(this.provider, 15);
    await this.provider.execute(`INSERT INTO ${this.table("product_media_assets")} (
      id,source_system,source_url,storage_file_id,original_filename,storage_filename,relative_path,sha256,mime_type,
      width,height,file_size,status,created_at,updated_at
    ) VALUES (${p.join(",")})`, [input.id, input.sourceSystem, input.sourceUrl, input.storageFileId, input.originalFilename,
      input.storageFilename, input.relativePath, input.sha256, input.mimeType, input.width, input.height,
      input.fileSize, input.status || "available", now, now]);
    return this.getAsset(input.id);
  }

  async productsForSku(sourceSku) {
    const normalized = normalizeSku(sourceSku);
    const result = await this.provider.query(`SELECT id,source_sku,sku_code_normalized,country_raw,source_product_name
      FROM ${this.table("product_skus")} WHERE sku_code_normalized=${this.provider.placeholder(1)}
      AND archived_at IS NULL AND deleted_at IS NULL ORDER BY country_raw,id`, [normalized]);
    return result.rows.map((row) => ({
      id: row.id, sourceSku: row.source_sku, normalizedSku: row.sku_code_normalized,
      countryCode: row.country_raw || "", productName: row.source_product_name,
    }));
  }

  async productHasAnyImage(productId) {
    const row = (await this.provider.query(`SELECT
      (SELECT count(*) FROM ${this.table("product_images")} WHERE sku_id=${this.provider.placeholder(1)} AND status='available')
      + (SELECT count(*) FROM ${this.table("product_media_links")} l JOIN ${this.table("product_media_assets")} a ON a.id=l.asset_id
        WHERE l.product_id=${this.provider.placeholder(2)} AND l.mapping_status IN ('suggested','confirmed') AND a.status='available') total`,
    [productId, productId])).rows[0];
    return Number(row?.total || 0) > 0;
  }

  async hasManualPrimary(productId) {
    const row = (await this.provider.query(`SELECT count(*) total FROM ${this.table("product_images")}
      WHERE sku_id=${this.provider.placeholder(1)} AND status='available' AND is_primary=1`, [productId])).rows[0];
    return Number(row?.total || 0) > 0;
  }

  async skuNeedsImage(sourceSku) {
    const products = await this.productsForSku(sourceSku);
    if (!products.length) return false;
    const states = await Promise.all(products.map((product) => this.productHasAnyImage(product.id)));
    return states.some((hasImage) => !hasImage);
  }

  async linkAssetToMatchingProducts({ assetId, sourceSku, linkedBy }) {
    const products = await this.productsForSku(sourceSku);
    const now = iso();
    const links = [];
    for (const product of products) {
      const manualPrimary = await this.hasManualPrimary(product.id);
      const hasImage = await this.productHasAnyImage(product.id);
      const role = !manualPrimary && !hasImage ? "suggested_primary" : "gallery";
      const found = (await this.provider.query(`SELECT * FROM ${this.table("product_media_links")}
        WHERE asset_id=${this.provider.placeholder(1)} AND product_id=${this.provider.placeholder(2)}`,
      [assetId, product.id])).rows[0];
      if (found) {
        links.push(serializeLink({ ...found, source_product_name: product.productName }));
        continue;
      }
      const p = this.placeholders(this.provider, 11);
      const id = randomUUID();
      await this.provider.execute(`INSERT INTO ${this.table("product_media_links")} (
        id,asset_id,source_sku,source_sku_normalized,product_id,country_code,media_role,mapping_status,linked_at,linked_by,confirmed_at
      ) VALUES (${p.join(",")})`, [id, assetId, sourceSku, normalizeSku(sourceSku), product.id,
        product.countryCode, role, "suggested", now, linkedBy, null]);
      links.push(await this.getLink(id));
    }
    return links;
  }

  async getLink(id) {
    const row = (await this.provider.query(`SELECT l.*,s.source_product_name FROM ${this.table("product_media_links")} l
      JOIN ${this.table("product_skus")} s ON s.id=l.product_id WHERE l.id=${this.provider.placeholder(1)}`, [id])).rows[0];
    return serializeLink(row);
  }

  async linksForAsset(assetId) {
    const rows = await this.provider.query(`SELECT l.*,s.source_product_name FROM ${this.table("product_media_links")} l
      JOIN ${this.table("product_skus")} s ON s.id=l.product_id
      WHERE l.asset_id=${this.provider.placeholder(1)} ORDER BY l.country_code,l.linked_at`, [assetId]);
    return rows.rows.map(serializeLink);
  }

  async confirmPrimary(linkId, actor) {
    const link = await this.getLink(linkId);
    if (!link) return null;
    if (await this.hasManualPrimary(link.productId)) {
      const error = new Error("该产品已有人工主图，马帮图片不会覆盖。 ");
      error.code = "MANUAL_PRIMARY_EXISTS";
      error.status = 409;
      throw error;
    }
    const now = iso();
    await this.provider.transaction(async (tx) => {
      await tx.execute(`UPDATE ${this.table("product_media_links")} SET media_role='gallery'
        WHERE product_id=${tx.placeholder(1)} AND id<>${tx.placeholder(2)} AND media_role='primary'`, [link.productId, linkId]);
      await tx.execute(`UPDATE ${this.table("product_media_links")} SET media_role='primary',mapping_status='confirmed',
        confirmed_at=${tx.placeholder(1)},confirmed_by=${tx.placeholder(2)} WHERE id=${tx.placeholder(3)}`,
      [now, actor, linkId]);
    });
    return this.getLink(linkId);
  }

  async recomputeBatchCounters(batchId) {
    const p = this.provider.placeholder(1);
    const discovery = (await this.provider.query(`SELECT
      count(DISTINCT source_sku_normalized) discovered,
      sum(CASE WHEN download_status='downloaded' THEN 1 ELSE 0 END) downloaded,
      sum(CASE WHEN download_status='duplicate' THEN 1 ELSE 0 END) duplicates,
      sum(CASE WHEN download_status='missing' THEN 1 ELSE 0 END) missing,
      sum(CASE WHEN download_status='failed' THEN 1 ELSE 0 END) failed,
      sum(CASE WHEN quality_issue_code='IMAGE_FILENAME_SKU_MISMATCH' THEN 1 ELSE 0 END) mismatches
      FROM ${this.table("mabang_sku_image_discoveries")} WHERE batch_id=${p}`, [batchId])).rows[0] || {};
    const links = (await this.provider.query(`SELECT count(DISTINCT l.product_id) linked,
      count(DISTINCT CASE WHEN c.country_count>1 THEN l.product_id END) shared
      FROM ${this.table("product_media_links")} l
      JOIN ${this.table("mabang_sku_image_discoveries")} d ON d.asset_id=l.asset_id AND d.batch_id=${p}
      JOIN (SELECT source_sku_normalized,count(DISTINCT country_code) country_count FROM ${this.table("product_media_links")}
        GROUP BY source_sku_normalized) c ON c.source_sku_normalized=l.source_sku_normalized`, [batchId])).rows[0] || {};
    const now = iso();
    const values = [Number(discovery.discovered || 0), Number(discovery.downloaded || 0), Number(discovery.duplicates || 0),
      Number(discovery.missing || 0), Number(discovery.failed || 0), Number(discovery.mismatches || 0),
      Number(links.linked || 0), Number(links.shared || 0), now, batchId];
    const q = this.placeholders(this.provider, values.length);
    await this.provider.execute(`UPDATE ${this.table("mabang_sku_image_batches")} SET discovered_skus=${q[0]},downloaded_images=${q[1]},
      duplicate_images=${q[2]},missing_images=${q[3]},failed_images=${q[4]},filename_mismatches=${q[5]},
      linked_products=${q[6]},shared_country_links=${q[7]},updated_at=${q[8]} WHERE id=${q[9]}`, values);
    return this.getBatch(batchId);
  }
}

export const mabangImageSerializers = Object.freeze({ serializeBatch, serializeDiscovery, serializeAsset, serializeLink });
