ALTER TABLE product_import_batches ADD COLUMN unmatched_count INTEGER NOT NULL DEFAULT 0 CHECK (unmatched_count >= 0);
ALTER TABLE product_import_batches ADD COLUMN will_write_count INTEGER NOT NULL DEFAULT 0 CHECK (will_write_count >= 0);

ALTER TABLE product_import_rows ADD COLUMN source_warehouse_raw TEXT;
ALTER TABLE product_import_rows ADD COLUMN source_row_key TEXT;
ALTER TABLE product_import_rows ADD COLUMN row_occurrence INTEGER NOT NULL DEFAULT 1 CHECK (row_occurrence >= 1);
ALTER TABLE product_import_rows ADD COLUMN raw_types_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE product_import_rows ADD COLUMN package_row_id TEXT;

CREATE INDEX idx_product_import_rows_source_identity
  ON product_import_rows(batch_id, source_row_key, source_row_number);

CREATE TABLE product_package_rows (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'company_product_center',
  source_row_key TEXT NOT NULL,
  product_key TEXT NOT NULL,
  country_normalized TEXT NOT NULL,
  sku_normalized TEXT NOT NULL,
  warehouse_normalized TEXT NOT NULL,
  row_occurrence INTEGER NOT NULL CHECK (row_occurrence >= 1),
  source_row_sha256 TEXT NOT NULL,
  semantic_row_sha256 TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  raw_types_json TEXT NOT NULL,
  normalized_payload_json TEXT NOT NULL,
  raw_source_period_json TEXT,
  raw_sku_code_json TEXT,
  raw_product_name_json TEXT,
  raw_main_sku_code_json TEXT,
  raw_country_raw_json TEXT,
  raw_category_l1_json TEXT,
  raw_category_l2_json TEXT,
  raw_source_created_date_json TEXT,
  raw_new_product_month_json TEXT,
  raw_new_product_age_months_json TEXT,
  raw_gift_raw_json TEXT,
  raw_source_status_json TEXT,
  raw_style_code_json TEXT,
  raw_style_name_json TEXT,
  raw_sales_spec_json TEXT,
  raw_item_dimensions_raw_json TEXT,
  raw_item_net_weight_g_json TEXT,
  raw_item_gross_weight_g_json TEXT,
  raw_carton_length_cm_json TEXT,
  raw_carton_width_cm_json TEXT,
  raw_carton_height_cm_json TEXT,
  raw_carton_quantity_json TEXT,
  raw_shipping_method_json TEXT,
  raw_warehouse_raw_json TEXT,
  raw_warehouse_stock_json TEXT,
  raw_planned_warehouse_raw_json TEXT,
  raw_cost_cny_json TEXT,
  raw_exchange_rate_json TEXT,
  raw_cost_local_json TEXT,
  raw_price_tier_20_json TEXT,
  raw_price_tier_25_json TEXT,
  raw_price_tier_35_json TEXT,
  raw_price_tier_45_json TEXT,
  raw_attach_rate_json TEXT,
  raw_forecast_daily_sales_json TEXT,
  import_batch_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  first_seen_batch_id TEXT NOT NULL,
  latest_batch_id TEXT NOT NULL,
  latest_import_row_id TEXT NOT NULL,
  latest_source_row_number INTEGER NOT NULL CHECK (latest_source_row_number >= 2),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (first_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (import_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (latest_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (latest_import_row_id) REFERENCES product_import_rows(id) ON DELETE RESTRICT,
  UNIQUE (source_system, source_row_key)
);

CREATE INDEX idx_product_package_rows_product
  ON product_package_rows(country_normalized, sku_normalized, warehouse_normalized, row_occurrence);
CREATE INDEX idx_product_package_rows_latest_batch
  ON product_package_rows(latest_batch_id, latest_source_row_number);

CREATE TABLE product_import_field_changes (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL,
  import_row_id TEXT NOT NULL,
  product_package_row_id TEXT,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  country_raw TEXT,
  sku_code TEXT,
  warehouse_raw TEXT,
  chinese_name TEXT,
  source_header TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value_json TEXT,
  new_value_json TEXT,
  old_type TEXT,
  new_type TEXT,
  has_manual_override INTEGER NOT NULL DEFAULT 0 CHECK (has_manual_override IN (0, 1)),
  changed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (import_row_id) REFERENCES product_import_rows(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_package_row_id) REFERENCES product_package_rows(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_import_field_changes_batch
  ON product_import_field_changes(import_batch_id, source_row_number, field_name);
CREATE INDEX idx_product_import_field_changes_filter
  ON product_import_field_changes(import_batch_id, country_raw, sku_code, field_name);
