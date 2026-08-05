import { assertDatabaseProvider, DATABASE_DIALECTS } from "../../data/database-provider.mjs";

export class AiContextRepository {
  constructor({ provider }) {
    this.provider = assertDatabaseProvider(provider);
    this.prefix = provider.dialect === DATABASE_DIALECTS.POSTGRESQL ? "app." : "";
  }

  table(name) {
    return `${this.prefix}${name}`;
  }

  placeholder(index) {
    return this.provider.placeholder(index);
  }

  async one(sql, parameters = []) {
    return (await this.provider.query(sql, parameters)).rows[0] || null;
  }

  async all(sql, parameters = []) {
    return (await this.provider.query(sql, parameters)).rows;
  }

  async freshness() {
    const sourceBatches = await this.all(`SELECT source_type,id,collected_at,imported_at,row_count
      FROM ${this.table("growth_source_batches")}
      WHERE id IN (
        SELECT id FROM ${this.table("growth_source_batches")} order_batch
        WHERE order_batch.source_type='mabang_order' AND order_batch.status='applied'
        ORDER BY COALESCE(order_batch.collected_at,order_batch.imported_at,order_batch.created_at) DESC
        LIMIT 1
      ) OR id IN (
        SELECT id FROM ${this.table("growth_source_batches")} inventory_batch
        WHERE inventory_batch.source_type='mabang_inventory' AND inventory_batch.status='applied'
        ORDER BY COALESCE(inventory_batch.collected_at,inventory_batch.imported_at,inventory_batch.created_at) DESC
        LIMIT 1
      ) ORDER BY source_type`);
    const published = await this.one(`SELECT id,analysis_date,published_at,quality_status,rule_set_id
      FROM ${this.table("growth_latest_published_run_v")} LIMIT 1`);
    return { sourceBatches, publishedAnalysis: published };
  }

  async latestValidOrderDay() {
    return (await this.one(`SELECT MAX(SUBSTR(paid_at,1,10)) AS day
      FROM ${this.table("growth_order_headers")}
      WHERE effective_status='valid' AND paid_at IS NOT NULL AND paid_at<>''`))?.day || null;
  }

  async shopMaster(id) {
    return this.one(`SELECT * FROM ${this.table("foundation_store_master_v")}
      WHERE id=${this.placeholder(1)} LIMIT 1`, [id]);
  }

  async shopPublishedMetric(id) {
    return this.one(`SELECT * FROM ${this.table("growth_latest_shop_metrics_v")}
      WHERE internal_shop_id=${this.placeholder(1)} LIMIT 1`, [id]);
  }

  async shopPublishedHistory(id) {
    return this.all(`SELECT metric.analysis_date,metric.own_sales_quantity_7d,
        metric.own_sales_quantity_28d,metric.valid_order_count_7d,
        metric.valid_order_count_28d,metric.saleable_coverage_rate_28d,
        metric.high_performance_coverage_rate_28d,metric.quality_status,
        metric.reason_code,metric.metrics_version
      FROM ${this.table("growth_shop_daily_metrics")} metric
      JOIN ${this.table("growth_analysis_runs")} run ON run.id=metric.analysis_run_id
      WHERE metric.internal_shop_id=${this.placeholder(1)} AND run.status='published'
      ORDER BY metric.analysis_date DESC,run.published_at DESC LIMIT 8`, [id]);
  }

  async shopFactTrend(id, dateFrom) {
    return this.all(`SELECT SUBSTR(header.paid_at,1,10) AS day,
        SUM(line.quantity) AS sales_quantity,
        COUNT(DISTINCT header.source_order_id) AS order_count
      FROM ${this.table("growth_order_headers")} header
      JOIN ${this.table("growth_order_lines")} line ON line.order_header_id=header.id
      WHERE header.internal_shop_id=${this.placeholder(1)}
        AND header.effective_status='valid' AND line.effective_status='valid'
        AND line.is_current=1 AND header.paid_at>=${this.placeholder(2)}
      GROUP BY SUBSTR(header.paid_at,1,10) ORDER BY day`, [id, dateFrom]);
  }

  async shopFactInventory(id) {
    return this.one(`SELECT COUNT(DISTINCT inventory.normalized_source_sku) AS sku_count,
        SUM(inventory.available_quantity) AS available_quantity,
        SUM(inventory.in_transit_quantity) AS in_transit_quantity,
        MIN(inventory.days_of_supply) AS minimum_days_of_supply,
        SUM(CASE WHEN inventory.available_quantity<=0 THEN 1 ELSE 0 END) AS out_of_stock_rows
      FROM ${this.table("growth_inventory_snapshots")} inventory
      JOIN (
        SELECT DISTINCT line.normalized_source_sku
        FROM ${this.table("growth_order_lines")} line
        JOIN ${this.table("growth_order_headers")} header ON header.id=line.order_header_id
        WHERE header.internal_shop_id=${this.placeholder(1)}
          AND header.effective_status='valid' AND line.effective_status='valid'
          AND line.is_current=1
      ) sold ON sold.normalized_source_sku=inventory.normalized_source_sku
      WHERE inventory.batch_id=(SELECT id FROM ${this.table("growth_source_batches")}
        WHERE source_type='mabang_inventory' AND status='applied'
        ORDER BY COALESCE(collected_at,imported_at,created_at) DESC LIMIT 1)`, [id]);
  }

  async shopSignals(id) {
    return this.all(`SELECT * FROM ${this.table("growth_latest_signals_v")}
      WHERE internal_shop_id=${this.placeholder(1)}
      ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'warning' THEN 2 ELSE 3 END,detected_at DESC LIMIT 20`, [id]);
  }

  async shopTasks(id) {
    const [foundation, growth] = await Promise.all([
      this.all(`SELECT id,domain,task_kind,state,priority,evidence_json,updated_at
        FROM ${this.table("foundation_open_tasks_v")}
        WHERE store_id=${this.placeholder(1)} ORDER BY priority,updated_at DESC LIMIT 20`, [id]),
      this.all(`SELECT id,task_type,status,priority,reason_code,recommended_action_code,
          evidence_snapshot_json AS evidence_json,updated_at
        FROM ${this.table("growth_open_focus_items_v")}
        WHERE internal_shop_id=${this.placeholder(1)} ORDER BY priority,updated_at DESC LIMIT 20`, [id]),
    ]);
    return { foundation, growth };
  }

  async productMaster(id) {
    return this.one(`SELECT * FROM ${this.table("foundation_product_master_v")}
      WHERE id=${this.placeholder(1)} LIMIT 1`, [id]);
  }

  async productSkus(id) {
    return this.all(`SELECT * FROM ${this.table("foundation_sku_master_v")}
      WHERE model_id=${this.placeholder(1)} ORDER BY normalized_sku,id`, [id]);
  }

  async productPublishedMetrics(id) {
    return this.all(`SELECT metric.* FROM ${this.table("growth_latest_sku_metrics_v")} metric
      JOIN ${this.table("foundation_sku_master_v")} sku ON sku.id=metric.mapped_product_id
      WHERE sku.model_id=${this.placeholder(1)} AND metric.scope_type='country'
      ORDER BY metric.country_code,metric.assortment_percentile DESC`, [id]);
  }

  async productFactSales(id, dateFrom) {
    return this.all(`SELECT SUBSTR(header.paid_at,1,10) AS day,line.mapped_product_id AS sku_id,
        line.normalized_source_sku,SUM(line.quantity) AS sales_quantity
      FROM ${this.table("growth_order_lines")} line
      JOIN ${this.table("growth_order_headers")} header ON header.id=line.order_header_id
      JOIN ${this.table("foundation_sku_master_v")} sku ON sku.id=line.mapped_product_id
      WHERE sku.model_id=${this.placeholder(1)} AND header.paid_at>=${this.placeholder(2)}
        AND header.effective_status='valid' AND line.effective_status='valid' AND line.is_current=1
      GROUP BY SUBSTR(header.paid_at,1,10),line.mapped_product_id,line.normalized_source_sku
      ORDER BY day`, [id, dateFrom]);
  }

  async productFactInventory(id) {
    return this.all(`SELECT inventory.* FROM ${this.table("growth_inventory_snapshots")} inventory
      JOIN ${this.table("foundation_sku_master_v")} sku ON sku.id=inventory.mapped_product_id
      WHERE sku.model_id=${this.placeholder(1)} AND inventory.batch_id=(
        SELECT id FROM ${this.table("growth_source_batches")}
        WHERE source_type='mabang_inventory' AND status='applied'
        ORDER BY COALESCE(collected_at,imported_at,created_at) DESC LIMIT 1)
      ORDER BY inventory.normalized_source_sku,inventory.normalized_warehouse_name`, [id]);
  }

  async productListings(id) {
    return this.all(`SELECT draft.id,draft.product_sku_id,draft.platform,draft.country,
        draft.shop_id,draft.shop_name,draft.status,draft.pricing_json,draft.revision,draft.updated_at
      FROM ${this.table("product_listing_drafts")} draft
      JOIN ${this.table("foundation_sku_master_v")} sku ON sku.id=draft.product_sku_id
      WHERE sku.model_id=${this.placeholder(1)} AND draft.deleted_at IS NULL
      ORDER BY draft.updated_at DESC`, [id]);
  }

  async productSignals(id) {
    return this.all(`SELECT signal.* FROM ${this.table("growth_latest_signals_v")} signal
      JOIN ${this.table("foundation_sku_master_v")} sku
        ON sku.normalized_sku=signal.normalized_source_sku
      WHERE sku.model_id=${this.placeholder(1)}
      ORDER BY CASE signal.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'warning' THEN 2 ELSE 3 END,signal.detected_at DESC LIMIT 30`, [id]);
  }

  async productTasks(id) {
    return this.all(`SELECT task.* FROM ${this.table("foundation_open_tasks_v")} task
      JOIN ${this.table("foundation_sku_master_v")} sku ON sku.id=task.sku_id
      WHERE sku.model_id=${this.placeholder(1)} ORDER BY task.priority,task.updated_at DESC LIMIT 30`, [id]);
  }

  async skuMaster(id) {
    return this.one(`SELECT * FROM ${this.table("foundation_sku_master_v")}
      WHERE id=${this.placeholder(1)} LIMIT 1`, [id]);
  }

  async skuPublishedMetrics(id) {
    return this.all(`SELECT * FROM ${this.table("growth_latest_sku_metrics_v")}
      WHERE mapped_product_id=${this.placeholder(1)} ORDER BY scope_type,country_code`, [id]);
  }

  async skuPublishedWarehouseMetrics(id) {
    return this.all(`SELECT * FROM ${this.table("growth_latest_sku_warehouse_metrics_v")}
      WHERE mapped_product_id=${this.placeholder(1)} ORDER BY country_code,normalized_warehouse_name`, [id]);
  }

  async skuFactSales(id, dateFrom) {
    return this.all(`SELECT SUBSTR(header.paid_at,1,10) AS day,SUM(line.quantity) AS sales_quantity,
        COUNT(DISTINCT header.source_order_id) AS order_count
      FROM ${this.table("growth_order_lines")} line
      JOIN ${this.table("growth_order_headers")} header ON header.id=line.order_header_id
      WHERE line.mapped_product_id=${this.placeholder(1)} AND header.paid_at>=${this.placeholder(2)}
        AND header.effective_status='valid' AND line.effective_status='valid' AND line.is_current=1
      GROUP BY SUBSTR(header.paid_at,1,10) ORDER BY day`, [id, dateFrom]);
  }

  async skuFactInventory(id) {
    return this.all(`SELECT * FROM ${this.table("growth_inventory_snapshots")}
      WHERE mapped_product_id=${this.placeholder(1)} AND batch_id=(
        SELECT id FROM ${this.table("growth_source_batches")}
        WHERE source_type='mabang_inventory' AND status='applied'
        ORDER BY COALESCE(collected_at,imported_at,created_at) DESC LIMIT 1)
      ORDER BY normalized_warehouse_name`, [id]);
  }

  async skuListings(id) {
    return this.all(`SELECT id,product_sku_id,platform,country,shop_id,shop_name,status,pricing_json,
        revision,updated_at FROM ${this.table("product_listing_drafts")}
      WHERE product_sku_id=${this.placeholder(1)} AND deleted_at IS NULL
      ORDER BY updated_at DESC`, [id]);
  }

  async skuPriceHistory(id) {
    return this.all(`SELECT country_raw,cost_cny,exchange_rate,cost_local,price_tier_45,created_at
      FROM ${this.table("product_cost_snapshots")} WHERE sku_id=${this.placeholder(1)}
      ORDER BY created_at DESC LIMIT 12`, [id]);
  }

  async skuSignals(id) {
    return this.all(`SELECT signal.* FROM ${this.table("growth_latest_signals_v")} signal
      JOIN ${this.table("foundation_sku_master_v")} sku
        ON sku.normalized_sku=signal.normalized_source_sku
      WHERE sku.id=${this.placeholder(1)}
      ORDER BY CASE signal.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
        WHEN 'warning' THEN 2 ELSE 3 END,signal.detected_at DESC LIMIT 20`, [id]);
  }

  async skuTasks(id) {
    const [foundation, growth] = await Promise.all([
      this.all(`SELECT id,domain,task_kind,state,priority,evidence_json,updated_at
        FROM ${this.table("foundation_open_tasks_v")}
        WHERE sku_id=${this.placeholder(1)} ORDER BY priority,updated_at DESC LIMIT 20`, [id]),
      this.all(`SELECT focus.* FROM ${this.table("growth_open_focus_items_v")} focus
        JOIN ${this.table("foundation_sku_master_v")} sku
          ON sku.normalized_sku=focus.normalized_source_sku
        WHERE sku.id=${this.placeholder(1)} ORDER BY focus.priority,focus.updated_at DESC LIMIT 20`, [id]),
    ]);
    return { foundation, growth };
  }
}
