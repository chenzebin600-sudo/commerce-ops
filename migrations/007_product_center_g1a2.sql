CREATE TABLE product_import_batches (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'company_product_center',
  source_period TEXT,
  source_country_raw TEXT,
  file_sha256 TEXT NOT NULL,
  header_fingerprint TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('uploaded', 'validating', 'preview_ready', 'applying', 'applied', 'validation_failed', 'apply_failed', 'cancelled')),
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  conflict_count INTEGER NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  exception_count INTEGER NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  reminder_count INTEGER NOT NULL DEFAULT 0 CHECK (reminder_count >= 0),
  information_count INTEGER NOT NULL DEFAULT 0 CHECK (information_count >= 0),
  mapping_json TEXT NOT NULL DEFAULT '[]',
  unknown_fields_json TEXT NOT NULL DEFAULT '[]',
  validation_summary_json TEXT NOT NULL DEFAULT '{}',
  operator_label TEXT NOT NULL,
  request_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  error_code TEXT,
  error_summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  applied_at TEXT,
  cancelled_at TEXT
);

CREATE UNIQUE INDEX idx_product_import_batches_file
  ON product_import_batches(source_system, file_sha256);
CREATE INDEX idx_product_import_batches_status_created
  ON product_import_batches(status, created_at DESC);

CREATE TABLE product_import_files (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  export_file_id TEXT NOT NULL,
  file_role TEXT NOT NULL DEFAULT 'source'
    CHECK (file_role IN ('source', 'error_report', 'diff_export')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (export_file_id) REFERENCES export_files(id) ON DELETE RESTRICT,
  UNIQUE (batch_id, file_role),
  UNIQUE (export_file_id)
);

CREATE TABLE product_import_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  source_sku TEXT,
  row_sha256 TEXT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  normalized_payload_json TEXT NOT NULL,
  validation_codes_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL
    CHECK (outcome IN ('new', 'updated', 'unchanged', 'conflict', 'exception')),
  target_sku_id TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (batch_id, source_row_number)
);

CREATE INDEX idx_product_import_rows_batch_outcome
  ON product_import_rows(batch_id, outcome, source_row_number);
CREATE INDEX idx_product_import_rows_source_sku
  ON product_import_rows(source_sku);

CREATE TABLE product_categories (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  parent_key TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level IN (1, 2)),
  source_system TEXT NOT NULL,
  source_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive', 'review_required')),
  first_seen_batch_id TEXT NOT NULL,
  last_seen_batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  inactive_at TEXT,
  FOREIGN KEY (parent_id) REFERENCES product_categories(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (source_system, level, parent_key, normalized_name)
);

CREATE INDEX idx_product_categories_parent
  ON product_categories(parent_id, status, normalized_name);

CREATE TABLE product_models (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_main_sku TEXT NOT NULL,
  category_id TEXT NOT NULL,
  canonical_name TEXT,
  identity_status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (identity_status IN ('confirmed', 'review_required', 'inactive')),
  first_seen_batch_id TEXT NOT NULL,
  last_seen_batch_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  inactive_at TEXT,
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (source_system, source_main_sku)
);

CREATE TABLE product_skus (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  normalized_sku TEXT NOT NULL,
  category_id TEXT NOT NULL,
  model_id TEXT,
  source_product_name TEXT NOT NULL,
  source_main_sku TEXT,
  source_style_code TEXT,
  source_style_name TEXT,
  source_sales_spec TEXT,
  source_status_raw TEXT NOT NULL,
  current_source_row_id TEXT NOT NULL,
  first_seen_batch_id TEXT NOT NULL,
  last_seen_batch_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE RESTRICT,
  FOREIGN KEY (model_id) REFERENCES product_models(id) ON DELETE SET NULL,
  FOREIGN KEY (current_source_row_id) REFERENCES product_import_rows(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_seen_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (source_system, normalized_sku)
);

CREATE INDEX idx_product_skus_model
  ON product_skus(model_id, archived_at);
CREATE INDEX idx_product_skus_category
  ON product_skus(category_id, archived_at);
CREATE INDEX idx_product_skus_name
  ON product_skus(source_product_name);

CREATE TABLE product_sku_lifecycle (
  sku_id TEXT PRIMARY KEY,
  status_code TEXT NOT NULL
    CHECK (status_code IN ('ACTIVE', 'NEW', 'CLEARANCE', 'DISCONTINUED', 'ARCHIVED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  decision_source TEXT NOT NULL
    CHECK (decision_source IN ('central', 'manual', 'rule')),
  source_status_raw TEXT,
  source_batch_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  operator_label TEXT NOT NULL,
  request_id TEXT,
  effective_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_sku_lifecycle_status
  ON product_sku_lifecycle(status_code, updated_at DESC);

CREATE TABLE product_sku_lifecycle_events (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  from_status_code TEXT,
  to_status_code TEXT NOT NULL
    CHECK (to_status_code IN ('ACTIVE', 'NEW', 'CLEARANCE', 'DISCONTINUED', 'ARCHIVED')),
  decision_source TEXT NOT NULL
    CHECK (decision_source IN ('central', 'manual', 'rule')),
  source_batch_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  operator_label TEXT NOT NULL,
  request_id TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_lifecycle_events_sku
  ON product_sku_lifecycle_events(sku_id, occurred_at DESC);

CREATE TABLE product_packaging_profiles (
  sku_id TEXT PRIMARY KEY,
  source_row_id TEXT NOT NULL,
  item_dimensions_raw TEXT,
  item_net_weight_g NUMERIC,
  item_gross_weight_g NUMERIC,
  carton_length_cm NUMERIC,
  carton_width_cm NUMERIC,
  carton_height_cm NUMERIC,
  carton_quantity INTEGER,
  shipping_method TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_row_id) REFERENCES product_import_rows(id) ON DELETE RESTRICT
);

CREATE TABLE product_cost_snapshots (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  country_raw TEXT,
  cost_cny NUMERIC NOT NULL,
  exchange_rate NUMERIC NOT NULL,
  exchange_direction TEXT NOT NULL
    CHECK (exchange_direction IN ('local_per_cny', 'cny_per_local', 'equivalent')),
  cost_local NUMERIC NOT NULL,
  price_tier_20 NUMERIC,
  price_tier_25 NUMERIC,
  price_tier_35 NUMERIC,
  price_tier_45 NUMERIC,
  attach_rate NUMERIC,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (sku_id, batch_id)
);

CREATE INDEX idx_product_cost_snapshots_sku
  ON product_cost_snapshots(sku_id, created_at DESC);

CREATE TABLE product_inventory_snapshots (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  warehouse_raw TEXT NOT NULL,
  warehouse_stock NUMERIC,
  planned_warehouse_raw TEXT,
  captured_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (sku_id, batch_id, warehouse_raw)
);

CREATE INDEX idx_product_inventory_snapshots_sku
  ON product_inventory_snapshots(sku_id, captured_at DESC);

CREATE TABLE product_import_issues (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  row_id TEXT,
  source_row_number INTEGER,
  issue_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker', 'reminder', 'information')),
  field_code TEXT,
  current_value_json TEXT,
  suggested_value_json TEXT,
  message TEXT NOT NULL,
  suggestion TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'ignored')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (row_id) REFERENCES product_import_rows(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_import_issues_batch
  ON product_import_issues(batch_id, severity, status, source_row_number);
