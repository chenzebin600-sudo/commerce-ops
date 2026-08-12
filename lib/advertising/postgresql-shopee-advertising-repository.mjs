function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function batchRow(row) {
  if (!row) return null;
  return {
    id: row.id, platform: row.platform, reportType: row.report_type, shopId: row.shop_id,
    shopName: row.shop_name, accountName: row.account_name, originalFilename: row.original_filename,
    reportCreatedAt: row.report_created_at, periodFrom: row.period_from, periodTo: row.period_to,
    periodDays: Number(row.period_days), rowCount: Number(row.row_count), summary: json(row.summary_json),
    importedBy: row.imported_by, importedAt: row.imported_at,
  };
}

function factRow(row) {
  if (!row) return null;
  return {
    id: row.id, batchId: row.batch_id, sequence: Number(row.sequence_no), shopId: row.shop_id,
    adKey: row.ad_key, adName: row.ad_name, status: row.ad_status, adType: row.ad_type,
    productId: row.product_id, biddingMethod: row.bidding_method, placement: row.placement,
    startDate: row.start_date, impression: Number(row.impression), clicks: Number(row.clicks),
    addToCart: Number(row.add_to_cart), conversions: Number(row.conversions), itemsSold: Number(row.items_sold),
    gmv: Number(row.gmv), expense: Number(row.expense), roas: Number(row.roas), directRoas: Number(row.direct_roas),
  };
}

function targetRow(row) {
  if (!row) return null;
  return {
    id: row.id, shopId: row.shop_id, targetKey: row.target_key, productId: row.product_id,
    adName: row.ad_name, targetRoas: Number(row.target_roas), sourceType: row.source_type,
    effectiveFrom: row.effective_from, effectiveTo: row.effective_to, updatedAt: row.updated_at,
  };
}

export class PostgresqlShopeeAdvertisingRepository {
  constructor({ provider }) {
    if (!provider?.query || !provider?.transaction) throw new TypeError("PostgreSQL advertising provider is required");
    this.provider = provider;
    this.schema = provider.config?.schema || "app";
  }
  table(name) { return `"${this.schema}"."${name}"`; }

  async findBatchByHash(hash, client = this.provider) {
    return batchRow((await client.query(`SELECT * FROM ${this.table("advertising_source_batches")} WHERE raw_sha256=$1`, [hash])).rows[0]);
  }

  async findBatchById(id, client = this.provider) {
    return batchRow((await client.query(`SELECT * FROM ${this.table("advertising_source_batches")} WHERE id=$1`, [id])).rows[0]);
  }

  async createBatch(batch, facts) {
    return this.provider.transaction(async (transaction) => {
      await transaction.execute(`INSERT INTO ${this.table("advertising_source_batches")} (
        id,platform,report_type,shop_id,shop_name,account_name,original_filename,report_created_at,
        period_from,period_to,period_days,row_count,raw_sha256,summary_json,imported_by,imported_at,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$16)`, [
        batch.id, "shopee", "overall", batch.shopId, batch.shopName, batch.accountName, batch.originalFilename,
        encodeImportedPostgresqlValue(batch.reportCreatedAt, {
          data_type: "timestamp with time zone", table: "advertising_source_batches", column: "report_created_at",
        }), batch.periodFrom, batch.periodTo, batch.periodDays, facts.length, batch.rawSha256,
        JSON.stringify(batch.summary || {}), batch.importedBy, batch.importedAt,
      ]);
      for (const fact of facts) {
        await transaction.execute(`INSERT INTO ${this.table("advertising_performance_facts")} (
          id,batch_id,sequence_no,shop_id,ad_key,ad_name,ad_status,ad_type,product_id,bidding_method,placement,
          start_date,impression,clicks,add_to_cart,conversions,items_sold,gmv,expense,roas,direct_roas,created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [
          fact.id, batch.id, fact.sequence, batch.shopId, fact.adKey, fact.adName || null, fact.status || null,
          fact.adType || null, fact.productId || null, fact.biddingMethod || null, fact.placement || null,
          fact.startDate || null, fact.impression || 0, fact.clicks || 0, fact.addToCart || 0, fact.conversions || 0,
          fact.itemsSold || 0, fact.gmv || 0, fact.expense || 0, fact.roas || 0, fact.directRoas || 0, batch.importedAt,
        ]);
      }
      return this.findBatchByHash(batch.rawSha256, transaction);
    });
  }

  async listBatches({ shopId = null, limit = 40 } = {}) {
    const bounded = Math.min(200, Math.max(1, Number(limit) || 40));
    const where = shopId ? "WHERE shop_id=$1" : "";
    const values = shopId ? [shopId, bounded] : [bounded];
    const limitParameter = shopId ? "$2" : "$1";
    const result = await this.provider.query(`SELECT * FROM ${this.table("advertising_source_batches")} ${where}
      ORDER BY period_to DESC,period_days,imported_at DESC LIMIT ${limitParameter}`, values);
    return result.rows.map(batchRow);
  }

  async listFacts(batchId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("advertising_performance_facts")}
      WHERE batch_id=$1 ORDER BY sequence_no`, [batchId]);
    return result.rows.map(factRow);
  }

  async deleteBatch(batchId) {
    return this.provider.transaction(async (transaction) => {
      const batch = await this.findBatchById(batchId, transaction);
      if (!batch) return null;
      const count = await transaction.query(`SELECT COUNT(*)::int AS count FROM ${this.table("advertising_performance_facts")} WHERE batch_id=$1`, [batchId]);
      await transaction.execute(`DELETE FROM ${this.table("advertising_performance_facts")} WHERE batch_id=$1`, [batchId]);
      await transaction.execute(`DELETE FROM ${this.table("advertising_source_batches")} WHERE id=$1`, [batchId]);
      return { batch, deletedFacts: Number(count.rows[0]?.count || 0) };
    });
  }

  async listTargets(shopId, asOf) {
    const result = await this.provider.query(`SELECT DISTINCT ON (target_key) *
      FROM ${this.table("advertising_target_policies")}
      WHERE shop_id=$1 AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$2)
      ORDER BY target_key,effective_from DESC`, [shopId, asOf]);
    return result.rows.map(targetRow);
  }

  async upsertTargets(targets) {
    await this.provider.transaction(async (transaction) => {
      for (const target of targets) {
        await transaction.execute(`INSERT INTO ${this.table("advertising_target_policies")} (
          id,shop_id,target_key,product_id,ad_name,target_roas,source_type,effective_from,
          effective_to,created_by,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(shop_id,target_key,effective_from) DO UPDATE SET
          product_id=EXCLUDED.product_id,ad_name=EXCLUDED.ad_name,target_roas=EXCLUDED.target_roas,
          source_type=EXCLUDED.source_type,effective_to=EXCLUDED.effective_to,updated_at=EXCLUDED.updated_at`, [
          target.id, target.shopId, target.targetKey, target.productId, target.adName, target.targetRoas,
          target.sourceType, target.effectiveFrom, target.effectiveTo, target.createdBy, target.createdAt, target.updatedAt,
        ]);
      }
    });
    return targets.length;
  }
}
import { encodeImportedPostgresqlValue } from "../data/postgresql/import-value.mjs";
