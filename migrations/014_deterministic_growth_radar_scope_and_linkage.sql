ALTER TABLE growth_source_batches
  ADD COLUMN source_scope_status TEXT NOT NULL DEFAULT 'unconfirmed'
  CHECK (source_scope_status IN ('unconfirmed', 'confirmed'));

ALTER TABLE growth_source_batches
  ADD COLUMN pii_filtered_field_count INTEGER NOT NULL DEFAULT 0
  CHECK (pii_filtered_field_count >= 0);

ALTER TABLE growth_order_lines ADD COLUMN source_warehouse_name TEXT;
ALTER TABLE growth_order_lines ADD COLUMN normalized_source_warehouse_name TEXT;

CREATE INDEX idx_growth_order_lines_sku_warehouse
  ON growth_order_lines(normalized_source_sku, normalized_source_warehouse_name, is_current);

ALTER TABLE growth_inventory_snapshots
  ADD COLUMN normalized_warehouse_name TEXT NOT NULL DEFAULT '';
ALTER TABLE growth_inventory_snapshots ADD COLUMN product_status TEXT;
ALTER TABLE growth_inventory_snapshots ADD COLUMN category_level_1 TEXT;
ALTER TABLE growth_inventory_snapshots ADD COLUMN category_level_2 TEXT;
ALTER TABLE growth_inventory_snapshots ADD COLUMN category_level_3 TEXT;
ALTER TABLE growth_inventory_snapshots ADD COLUMN source_visible_sales_7d NUMERIC;
ALTER TABLE growth_inventory_snapshots ADD COLUMN source_visible_sales_28d NUMERIC;
ALTER TABLE growth_inventory_snapshots ADD COLUMN source_visible_sales_42d NUMERIC;
ALTER TABLE growth_inventory_snapshots
  ADD COLUMN source_scope_status TEXT NOT NULL DEFAULT 'unconfirmed'
  CHECK (source_scope_status IN ('unconfirmed', 'confirmed'));

CREATE UNIQUE INDEX uq_growth_inventory_snapshot_grain
  ON growth_inventory_snapshots(snapshot_at, normalized_source_sku, normalized_warehouse_name)
  WHERE normalized_source_sku <> '' AND normalized_warehouse_name <> '';

CREATE INDEX idx_growth_inventory_snapshots_warehouse
  ON growth_inventory_snapshots(normalized_warehouse_name, snapshot_at);

CREATE TABLE growth_order_inventory_links (
  id TEXT PRIMARY KEY,
  order_line_id TEXT NOT NULL,
  order_source_batch_id TEXT NOT NULL,
  inventory_snapshot_id TEXT,
  inventory_source_batch_id TEXT NOT NULL,
  match_key_version TEXT NOT NULL CHECK (match_key_version = 'source_sku_warehouse_v1'),
  normalized_source_sku TEXT NOT NULL,
  normalized_source_warehouse_name TEXT NOT NULL,
  match_status TEXT NOT NULL CHECK (match_status IN ('matched', 'unmatched')),
  unmatched_reason TEXT,
  order_effective_status TEXT NOT NULL CHECK (order_effective_status IN ('valid', 'pending', 'invalid_cancelled', 'unconfirmed')),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_line_id) REFERENCES growth_order_lines(id) ON DELETE RESTRICT,
  FOREIGN KEY (order_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (inventory_snapshot_id) REFERENCES growth_inventory_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY (inventory_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  UNIQUE (order_line_id, inventory_source_batch_id)
);

CREATE INDEX idx_growth_order_inventory_links_batch_status
  ON growth_order_inventory_links(inventory_source_batch_id, match_status, is_current);

CREATE TABLE growth_sku_warehouse_sales_metrics (
  id TEXT PRIMARY KEY,
  inventory_snapshot_id TEXT NOT NULL UNIQUE,
  inventory_source_batch_id TEXT NOT NULL,
  order_source_batch_id TEXT,
  snapshot_at TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  normalized_source_warehouse_name TEXT NOT NULL,
  own_sales_quantity_7d NUMERIC,
  own_sales_order_count_7d INTEGER,
  own_sales_effective_line_count_7d INTEGER,
  own_sales_window_started_at TEXT,
  own_sales_window_ended_at TEXT,
  own_sales_quantity_7d_status TEXT NOT NULL CHECK (own_sales_quantity_7d_status IN ('confirmed', 'unavailable')),
  source_visible_sales_7d NUMERIC,
  source_visible_sales_28d NUMERIC,
  source_visible_sales_42d NUMERIC,
  source_predicted_daily_sales NUMERIC,
  source_predicted_daily_sales_status TEXT NOT NULL
    CHECK (source_predicted_daily_sales_status IN ('source_prediction_not_actual', 'unavailable')),
  source_scope_status TEXT NOT NULL DEFAULT 'unconfirmed'
    CHECK (source_scope_status IN ('unconfirmed', 'confirmed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (inventory_snapshot_id) REFERENCES growth_inventory_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY (inventory_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (order_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_growth_sku_warehouse_sales_metrics_grain
  ON growth_sku_warehouse_sales_metrics(snapshot_at, normalized_source_sku, normalized_source_warehouse_name);
