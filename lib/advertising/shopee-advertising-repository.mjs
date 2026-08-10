import { resolveSqliteProvider } from "../data/sqlite/sqlite-provider.mjs";

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function publicBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    platform: row.platform,
    reportType: row.report_type,
    shopId: row.shop_id,
    shopName: row.shop_name,
    accountName: row.account_name,
    originalFilename: row.original_filename,
    reportCreatedAt: row.report_created_at,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    periodDays: Number(row.period_days),
    rowCount: Number(row.row_count),
    summary: parseJson(row.summary_json),
    importedBy: row.imported_by,
    importedAt: row.imported_at,
  };
}

function publicFact(row) {
  return {
    id: row.id,
    batchId: row.batch_id,
    sequence: Number(row.sequence_no),
    shopId: row.shop_id,
    adKey: row.ad_key,
    adName: row.ad_name,
    status: row.ad_status,
    adType: row.ad_type,
    productId: row.product_id,
    biddingMethod: row.bidding_method,
    placement: row.placement,
    startDate: row.start_date,
    impression: Number(row.impression),
    clicks: Number(row.clicks),
    addToCart: Number(row.add_to_cart),
    conversions: Number(row.conversions),
    itemsSold: Number(row.items_sold),
    gmv: Number(row.gmv),
    expense: Number(row.expense),
    roas: Number(row.roas),
    directRoas: Number(row.direct_roas),
  };
}

function publicTarget(row) {
  return {
    id: row.id,
    shopId: row.shop_id,
    targetKey: row.target_key,
    productId: row.product_id,
    adName: row.ad_name,
    targetRoas: Number(row.target_roas),
    sourceType: row.source_type,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    updatedAt: row.updated_at,
  };
}

export class ShopeeAdvertisingRepository {
  constructor({ provider }) {
    this.provider = resolveSqliteProvider(provider);
    this.db = this.provider.connection;
  }

  findBatchByHash(hash) {
    return publicBatch(this.db.prepare("SELECT * FROM advertising_source_batches WHERE raw_sha256=?").get(hash));
  }

  findBatchById(id) {
    return publicBatch(this.db.prepare("SELECT * FROM advertising_source_batches WHERE id=?").get(id));
  }

  createBatch(batch, facts) {
    return this.provider.withBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`INSERT INTO advertising_source_batches (
          id,platform,report_type,shop_id,shop_name,account_name,original_filename,
          report_created_at,period_from,period_to,period_days,row_count,raw_sha256,
          summary_json,imported_by,imported_at,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          batch.id, "shopee", "overall", batch.shopId, batch.shopName, batch.accountName,
          batch.originalFilename, batch.reportCreatedAt, batch.periodFrom, batch.periodTo,
          batch.periodDays, facts.length, batch.rawSha256, JSON.stringify(batch.summary),
          batch.importedBy, batch.importedAt, batch.importedAt,
        );
        const insert = this.db.prepare(`INSERT INTO advertising_performance_facts (
          id,batch_id,sequence_no,shop_id,ad_key,ad_name,ad_status,ad_type,product_id,
          bidding_method,placement,start_date,impression,clicks,add_to_cart,conversions,items_sold,
          gmv,expense,roas,direct_roas,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const fact of facts) insert.run(
          fact.id, batch.id, fact.sequence, batch.shopId, fact.adKey, fact.adName,
          fact.status, fact.adType, fact.productId, fact.biddingMethod, fact.placement, fact.startDate,
          fact.impression, fact.clicks, fact.addToCart, fact.conversions, fact.itemsSold,
          fact.gmv, fact.expense, fact.roas, fact.directRoas, batch.importedAt,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return this.findBatchByHash(batch.rawSha256);
    });
  }

  listBatches({ shopId = null, limit = 40 } = {}) {
    const rows = shopId
      ? this.db.prepare("SELECT * FROM advertising_source_batches WHERE shop_id=? ORDER BY period_to DESC,period_days,imported_at DESC LIMIT ?").all(shopId, limit)
      : this.db.prepare("SELECT * FROM advertising_source_batches ORDER BY period_to DESC,period_days,imported_at DESC LIMIT ?").all(limit);
    return rows.map(publicBatch);
  }

  listFacts(batchId) {
    return this.db.prepare("SELECT * FROM advertising_performance_facts WHERE batch_id=? ORDER BY sequence_no").all(batchId).map(publicFact);
  }

  deleteBatch(batchId) {
    return this.provider.withBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const batch = this.findBatchById(batchId);
        if (!batch) {
          this.db.exec("ROLLBACK");
          return null;
        }
        const deletedFacts = Number(this.db.prepare("SELECT COUNT(*) AS count FROM advertising_performance_facts WHERE batch_id=?").get(batchId)?.count || 0);
        this.db.prepare("DELETE FROM advertising_performance_facts WHERE batch_id=?").run(batchId);
        this.db.prepare("DELETE FROM advertising_source_batches WHERE id=?").run(batchId);
        this.db.exec("COMMIT");
        return { batch, deletedFacts };
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    });
  }

  listTargets(shopId, asOf) {
    return this.db.prepare(`SELECT * FROM advertising_target_policies
      WHERE shop_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?)
      ORDER BY target_key,effective_from DESC`).all(shopId, asOf, asOf)
      .filter((row, index, rows) => index === rows.findIndex((candidate) => candidate.target_key === row.target_key))
      .map(publicTarget);
  }

  upsertTargets(targets) {
    const statement = this.db.prepare(`INSERT INTO advertising_target_policies (
      id,shop_id,target_key,product_id,ad_name,target_roas,source_type,effective_from,
      effective_to,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(shop_id,target_key,effective_from) DO UPDATE SET
      product_id=excluded.product_id,ad_name=excluded.ad_name,target_roas=excluded.target_roas,
      source_type=excluded.source_type,effective_to=excluded.effective_to,
      updated_at=excluded.updated_at`);
    return this.provider.withBusyRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const target of targets) statement.run(
          target.id, target.shopId, target.targetKey, target.productId, target.adName,
          target.targetRoas, target.sourceType, target.effectiveFrom, target.effectiveTo,
          target.createdBy, target.createdAt, target.updatedAt,
        );
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw error;
      }
      return targets.length;
    });
  }
}
