CREATE TABLE growth_country_mapping_sets (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  description TEXT NOT NULL,
  content_sha256 TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_by TEXT,
  activated_at TEXT,
  retired_by TEXT,
  retired_at TEXT
);

CREATE UNIQUE INDEX uq_growth_country_mapping_sets_active
  ON growth_country_mapping_sets(status)
  WHERE status = 'active';

CREATE TABLE growth_warehouse_country_mappings (
  id TEXT PRIMARY KEY,
  mapping_set_id TEXT NOT NULL,
  source_system TEXT NOT NULL CHECK (source_system = 'mabang_inventory'),
  source_warehouse_name TEXT NOT NULL,
  normalized_warehouse_name TEXT NOT NULL,
  country_code TEXT NOT NULL CHECK (country_code <> '' AND country_code <> 'ZZ'),
  country_name TEXT NOT NULL,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('confirmed', 'excluded')),
  exclusion_reason TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mapping_set_id) REFERENCES growth_country_mapping_sets(id) ON DELETE RESTRICT,
  UNIQUE (mapping_set_id, source_system, normalized_warehouse_name),
  CHECK (
    (mapping_status = 'confirmed' AND exclusion_reason IS NULL)
    OR (mapping_status = 'excluded' AND exclusion_reason IS NOT NULL AND exclusion_reason <> '')
  )
);

CREATE INDEX idx_growth_warehouse_country_mappings_country
  ON growth_warehouse_country_mappings(mapping_set_id, country_code, mapping_status);

CREATE TABLE growth_rule_sets (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  metrics_contract_version TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL UNIQUE,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_by TEXT,
  activated_at TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX uq_growth_rule_sets_active
  ON growth_rule_sets(status)
  WHERE status = 'active';

CREATE TABLE growth_analysis_runs (
  id TEXT PRIMARY KEY,
  analysis_date TEXT NOT NULL,
  inventory_batch_id TEXT NOT NULL,
  order_watermark_at TEXT NOT NULL,
  rule_set_id TEXT NOT NULL,
  country_mapping_set_id TEXT NOT NULL,
  shop_scope_fingerprint TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'validating', 'published', 'failed', 'cancelled')
  ),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  quality_summary_json TEXT NOT NULL DEFAULT '{}',
  global_sku_count INTEGER NOT NULL DEFAULT 0 CHECK (global_sku_count >= 0),
  country_sku_count INTEGER NOT NULL DEFAULT 0 CHECK (country_sku_count >= 0),
  shop_count INTEGER NOT NULL DEFAULT 0 CHECK (shop_count >= 0),
  shop_sku_count INTEGER NOT NULL DEFAULT 0 CHECK (shop_sku_count >= 0),
  signal_count INTEGER NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
  started_at TEXT,
  validated_at TEXT,
  published_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_summary TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (inventory_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (rule_set_id) REFERENCES growth_rule_sets(id) ON DELETE RESTRICT,
  FOREIGN KEY (country_mapping_set_id) REFERENCES growth_country_mapping_sets(id) ON DELETE RESTRICT
);

CREATE INDEX idx_growth_analysis_runs_published
  ON growth_analysis_runs(status, analysis_date DESC, published_at DESC);
CREATE INDEX idx_growth_analysis_runs_inventory
  ON growth_analysis_runs(inventory_batch_id, created_at DESC);

CREATE TABLE growth_sku_daily_metrics (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  analysis_date TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'country')),
  scope_key TEXT NOT NULL,
  country_code TEXT,
  normalized_source_sku TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  product_name TEXT,
  product_status TEXT NOT NULL,
  category_l1 TEXT,
  category_l2 TEXT,
  mapped_product_id TEXT,
  mapping_status TEXT NOT NULL,
  warehouse_count INTEGER NOT NULL CHECK (warehouse_count >= 1),
  available_quantity NUMERIC,
  in_transit_quantity NUMERIC,
  source_predicted_daily_sales_country_sku NUMERIC,
  source_visible_sales_7d NUMERIC,
  source_visible_sales_28d NUMERIC,
  source_visible_sales_42d NUMERIC,
  effective_daily_sales_28d NUMERIC,
  computed_days_of_supply NUMERIC,
  days_of_supply_status TEXT NOT NULL,
  demand_percentile_28d NUMERIC,
  assortment_percentile NUMERIC,
  inventory_percentile NUMERIC,
  comparison_scope TEXT,
  comparison_sample_size INTEGER,
  assortment_status TEXT CHECK (
    assortment_status IS NULL
    OR assortment_status IN (
      'ASSORTMENT_VERIFIED_HIGH',
      'ASSORTMENT_VERIFIED_MID',
      'ASSORTMENT_LOW',
      'ASSORTMENT_DATA_INSUFFICIENT'
    )
  ),
  warehouse_supply_summary_json TEXT NOT NULL DEFAULT '{}',
  supply_risk_warehouse_count INTEGER NOT NULL DEFAULT 0 CHECK (supply_risk_warehouse_count >= 0),
  supply_critical_warehouse_count INTEGER NOT NULL DEFAULT 0 CHECK (supply_critical_warehouse_count >= 0),
  supply_warning_warehouse_count INTEGER NOT NULL DEFAULT 0 CHECK (supply_warning_warehouse_count >= 0),
  supply_data_issue_warehouse_count INTEGER NOT NULL DEFAULT 0 CHECK (supply_data_issue_warehouse_count >= 0),
  is_source_high_performance INTEGER NOT NULL DEFAULT 0 CHECK (is_source_high_performance IN (0, 1)),
  is_new INTEGER NOT NULL DEFAULT 0 CHECK (is_new IN (0, 1)),
  new_age_days INTEGER,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  reason_code TEXT NOT NULL,
  metrics_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  calculated_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (mapped_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (analysis_run_id, scope_type, scope_key, normalized_source_sku),
  CHECK (
    (scope_type = 'global' AND scope_key = 'GLOBAL' AND country_code IS NULL)
    OR (scope_type = 'country' AND scope_key = country_code AND country_code IS NOT NULL)
  ),
  CHECK (
    metrics_version <> 'GRV2-METRICS-1.2.0'
    OR (
      computed_days_of_supply IS NULL
      AND days_of_supply_status = 'warehouse_aggregate_only'
      AND assortment_status IS NOT NULL
    )
  )
);

CREATE INDEX idx_growth_sku_metrics_demand
  ON growth_sku_daily_metrics(
    analysis_run_id, scope_type, scope_key, category_l2, assortment_percentile DESC
  );
CREATE INDEX idx_growth_sku_metrics_supply_summary
  ON growth_sku_daily_metrics(
    analysis_run_id, scope_type, scope_key, supply_risk_warehouse_count DESC
  );
CREATE INDEX idx_growth_sku_metrics_status
  ON growth_sku_daily_metrics(analysis_run_id, product_status, quality_status);
CREATE INDEX idx_growth_sku_metrics_product
  ON growth_sku_daily_metrics(mapped_product_id, analysis_date DESC);

CREATE TABLE growth_sku_warehouse_daily_metrics (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  analysis_date TEXT NOT NULL,
  country_code TEXT NOT NULL,
  source_warehouse_name TEXT NOT NULL,
  normalized_warehouse_name TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  product_name TEXT,
  product_status TEXT NOT NULL,
  category_l1 TEXT,
  category_l2 TEXT,
  mapped_product_id TEXT,
  mapping_status TEXT NOT NULL,
  available_quantity NUMERIC,
  in_transit_quantity NUMERIC,
  source_current_sellable_days NUMERIC CHECK (
    source_current_sellable_days IS NULL OR source_current_sellable_days >= 0
  ),
  source_predicted_daily_sales NUMERIC,
  source_visible_sales_7d NUMERIC,
  source_visible_sales_28d NUMERIC,
  source_visible_sales_42d NUMERIC,
  supply_status TEXT NOT NULL CHECK (
    supply_status IN (
      'SUPPLY_DATA_INSUFFICIENT',
      'SUPPLY_DATA_CONFLICT',
      'OUT_OF_STOCK',
      'IN_TRANSIT_ONLY',
      'SUPPLY_CRITICAL',
      'SUPPLY_WARNING',
      'SUPPLY_HEALTHY'
    )
  ),
  slow_moving_status TEXT NOT NULL CHECK (
    slow_moving_status IN (
      'NOT_APPLICABLE',
      'NORMAL',
      'SLOW_MOVING_WATCH',
      'SLOW_MOVING_RISK',
      'SLOW_MOVING_SEVERE'
    )
  ),
  availability_status TEXT NOT NULL CHECK (
    availability_status IN ('available', 'degraded', 'unavailable')
  ),
  quality_status TEXT NOT NULL CHECK (
    quality_status IN ('confirmed', 'degraded', 'blocked')
  ),
  reason_code TEXT NOT NULL,
  metrics_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  calculated_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (mapped_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (
    analysis_run_id,
    country_code,
    normalized_warehouse_name,
    normalized_source_sku
  ),
  CHECK (normalized_warehouse_name <> ''),
  CHECK (country_code <> '' AND country_code <> 'ZZ')
);

CREATE INDEX idx_growth_sku_warehouse_metrics_risk
  ON growth_sku_warehouse_daily_metrics(
    analysis_run_id,
    country_code,
    supply_status,
    source_current_sellable_days,
    normalized_warehouse_name
  );
CREATE INDEX idx_growth_sku_warehouse_metrics_sku
  ON growth_sku_warehouse_daily_metrics(
    analysis_run_id,
    country_code,
    normalized_source_sku,
    normalized_warehouse_name
  );
CREATE INDEX idx_growth_sku_warehouse_metrics_product
  ON growth_sku_warehouse_daily_metrics(mapped_product_id, analysis_date DESC);

CREATE TABLE growth_shop_daily_metrics (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  analysis_date TEXT NOT NULL,
  internal_shop_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  owner_user_id TEXT,
  country_code TEXT NOT NULL,
  own_sales_quantity_7d NUMERIC NOT NULL DEFAULT 0,
  own_sales_quantity_28d NUMERIC NOT NULL DEFAULT 0,
  valid_order_count_7d INTEGER NOT NULL DEFAULT 0 CHECK (valid_order_count_7d >= 0),
  valid_order_count_28d INTEGER NOT NULL DEFAULT 0 CHECK (valid_order_count_28d >= 0),
  eligible_saleable_sku_count INTEGER,
  sold_eligible_sku_count_28d INTEGER,
  saleable_coverage_rate_28d NUMERIC,
  eligible_high_performance_sku_count INTEGER,
  sold_high_performance_sku_count_28d INTEGER,
  high_performance_coverage_rate_28d NUMERIC,
  key_performer_count INTEGER NOT NULL DEFAULT 0 CHECK (key_performer_count >= 0),
  growth_focus_count INTEGER NOT NULL DEFAULT 0 CHECK (growth_focus_count >= 0),
  new_opportunity_count INTEGER NOT NULL DEFAULT 0 CHECK (new_opportunity_count >= 0),
  slow_risk_count INTEGER NOT NULL DEFAULT 0 CHECK (slow_risk_count >= 0),
  low_stock_risk_count INTEGER NOT NULL DEFAULT 0 CHECK (low_stock_risk_count >= 0),
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  reason_code TEXT NOT NULL,
  metrics_version TEXT NOT NULL,
  country_mapping_set_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  calculated_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  FOREIGN KEY (country_mapping_set_id) REFERENCES growth_country_mapping_sets(id) ON DELETE RESTRICT,
  UNIQUE (analysis_run_id, internal_shop_id)
);

CREATE INDEX idx_growth_shop_metrics_run
  ON growth_shop_daily_metrics(analysis_run_id, platform, owner_user_id, display_name);

CREATE TABLE growth_shop_sku_daily_metrics (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  analysis_date TEXT NOT NULL,
  internal_shop_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  product_name TEXT,
  category_l1 TEXT,
  category_l2 TEXT,
  mapped_product_id TEXT,
  own_sales_quantity_7d NUMERIC NOT NULL DEFAULT 0,
  own_sales_quantity_28d NUMERIC NOT NULL DEFAULT 0,
  valid_order_count_7d INTEGER NOT NULL DEFAULT 0 CHECK (valid_order_count_7d >= 0),
  valid_order_count_28d INTEGER NOT NULL DEFAULT 0 CHECK (valid_order_count_28d >= 0),
  last_sold_at TEXT,
  source_visible_sales_7d NUMERIC,
  source_visible_sales_28d NUMERIC,
  source_visible_sales_42d NUMERIC,
  shop_to_source_visible_ratio_28d NUMERIC,
  shop_to_source_visible_ratio_percentile_28d NUMERIC,
  shop_sales_percentile_28d NUMERIC,
  eligible_saleable INTEGER NOT NULL DEFAULT 0 CHECK (eligible_saleable IN (0, 1)),
  eligible_high_performance INTEGER NOT NULL DEFAULT 0 CHECK (eligible_high_performance IN (0, 1)),
  is_key_performer INTEGER NOT NULL DEFAULT 0 CHECK (is_key_performer IN (0, 1)),
  is_growth_focus_candidate INTEGER NOT NULL DEFAULT 0 CHECK (is_growth_focus_candidate IN (0, 1)),
  available_quantity NUMERIC,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  reason_code TEXT NOT NULL,
  metrics_version TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  calculated_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  FOREIGN KEY (mapped_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (analysis_run_id, internal_shop_id, normalized_source_sku)
);

CREATE INDEX idx_growth_shop_sku_metrics_focus
  ON growth_shop_sku_daily_metrics(
    analysis_run_id, internal_shop_id, is_growth_focus_candidate, is_key_performer
  );
CREATE INDEX idx_growth_shop_sku_metrics_sales
  ON growth_shop_sku_daily_metrics(
    analysis_run_id, internal_shop_id, own_sales_quantity_28d DESC
  );

CREATE TABLE growth_signals (
  id TEXT PRIMARY KEY,
  analysis_run_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (
    signal_type IN ('opportunity', 'risk', 'highlight', 'data_quality')
  ),
  rule_code TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN ('sku', 'warehouse_sku', 'shop_sku', 'shop', 'run')
  ),
  country_code TEXT,
  source_warehouse_name TEXT,
  normalized_warehouse_name TEXT,
  normalized_source_sku TEXT,
  internal_shop_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('information', 'warning', 'high', 'critical')),
  reason_code TEXT NOT NULL,
  recommended_action_code TEXT NOT NULL,
  availability_status TEXT NOT NULL CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  detected_at TEXT NOT NULL,
  FOREIGN KEY (analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  UNIQUE (analysis_run_id, dedupe_key),
  CHECK (
    (source_warehouse_name IS NULL AND normalized_warehouse_name IS NULL)
    OR (
      source_warehouse_name IS NOT NULL
      AND source_warehouse_name <> ''
      AND normalized_warehouse_name IS NOT NULL
      AND normalized_warehouse_name <> ''
    )
  ),
  CHECK (
    subject_type <> 'warehouse_sku'
    OR normalized_warehouse_name IS NOT NULL
  )
);

CREATE INDEX idx_growth_signals_type
  ON growth_signals(analysis_run_id, signal_type, severity, rule_code);
CREATE INDEX idx_growth_signals_sku
  ON growth_signals(analysis_run_id, normalized_source_sku, internal_shop_id);
CREATE INDEX idx_growth_signals_shop
  ON growth_signals(analysis_run_id, internal_shop_id, signal_type, severity);
CREATE INDEX idx_growth_signals_warehouse
  ON growth_signals(
    analysis_run_id,
    country_code,
    normalized_warehouse_name,
    normalized_source_sku,
    signal_type
  );

CREATE VIEW growth_latest_published_run_v AS
SELECT *
FROM growth_analysis_runs
WHERE id = (
  SELECT id
  FROM growth_analysis_runs
  WHERE status = 'published'
  ORDER BY analysis_date DESC, published_at DESC, id DESC
  LIMIT 1
);

CREATE VIEW growth_latest_sku_metrics_v AS
SELECT metric.*
FROM growth_sku_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW growth_latest_sku_warehouse_metrics_v AS
SELECT metric.*
FROM growth_sku_warehouse_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW growth_latest_country_supply_summary_v AS
SELECT
  metric.analysis_run_id,
  metric.country_code,
  COUNT(DISTINCT metric.normalized_warehouse_name) AS warehouse_count,
  COUNT(DISTINCT metric.normalized_source_sku) AS affected_sku_count,
  SUM(CASE WHEN metric.supply_status = 'OUT_OF_STOCK' THEN 1 ELSE 0 END)
    AS out_of_stock_count,
  SUM(CASE WHEN metric.supply_status = 'IN_TRANSIT_ONLY' THEN 1 ELSE 0 END)
    AS in_transit_only_count,
  SUM(CASE WHEN metric.supply_status = 'SUPPLY_CRITICAL' THEN 1 ELSE 0 END)
    AS critical_count,
  SUM(CASE WHEN metric.supply_status = 'SUPPLY_WARNING' THEN 1 ELSE 0 END)
    AS warning_count,
  SUM(CASE
    WHEN metric.supply_status IN ('SUPPLY_DATA_INSUFFICIENT', 'SUPPLY_DATA_CONFLICT')
    THEN 1 ELSE 0
  END) AS data_issue_count,
  SUM(metric.available_quantity) AS available_quantity,
  SUM(metric.in_transit_quantity) AS in_transit_quantity
FROM growth_latest_sku_warehouse_metrics_v metric
GROUP BY metric.analysis_run_id, metric.country_code;

CREATE VIEW growth_latest_shop_metrics_v AS
SELECT metric.*
FROM growth_shop_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW growth_latest_shop_sku_metrics_v AS
SELECT metric.*
FROM growth_shop_sku_daily_metrics metric
JOIN growth_latest_published_run_v latest ON latest.id = metric.analysis_run_id;

CREATE VIEW growth_latest_signals_v AS
SELECT signal.*
FROM growth_signals signal
JOIN growth_latest_published_run_v latest ON latest.id = signal.analysis_run_id;

INSERT INTO growth_country_mapping_sets (
  id, version, status, description, content_sha256,
  created_by, created_at, activated_by, activated_at
) VALUES (
  'gr-country-map-empty-v1',
  'GRV2-COUNTRY-MAP-EMPTY-1',
  'active',
  'Empty confirmed country mapping baseline. Global metrics remain available; country metrics remain unavailable.',
  '1ab4b0a94abf5abdc09a1f56858bb9be3f373c311a778187fbbd90dd95359746',
  'system',
  '2026-07-25T00:00:00.000Z',
  'system',
  '2026-07-25T00:00:00.000Z'
);

INSERT INTO growth_rule_sets (
  id, version, status, metrics_contract_version, parameters_json, content_sha256,
  effective_from, created_by, created_at, activated_by, activated_at
) VALUES (
  'gr-rule-grv2-metrics-1-0-1',
  'GRV2-METRICS-1.0.1',
  'active',
  'GRV2-METRICS-1.0.1',
  '{"metricsContractVersion":"GRV2-METRICS-1.0.1","validOrderStatuses":["已发货"],"windows":{"salesDays":[7,28,42],"newDays":90},"thresholds":{"sourceHighPercentile":0.8,"storeLowRatioPercentile":0.2,"slowDays":[60,90,180],"lowStockDays":[14,7,0],"minimumComparisonSize":30}}',
  'e5946d254085c3242386fb2d28222f8ea6df270709e1b7a6a4fe5fb4210b217d',
  '2026-07-25T00:00:00.000Z',
  'system',
  '2026-07-25T00:00:00.000Z',
  'system',
  '2026-07-25T00:00:00.000Z'
);
