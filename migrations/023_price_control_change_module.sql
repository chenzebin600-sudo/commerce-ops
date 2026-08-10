-- Approved for activation with the first read-only price-control baseline.

INSERT OR IGNORE INTO foundation_source_systems (
  code,source_type,display_name,status,metadata_json,created_at,updated_at
) VALUES (
  'ai_project_a','internal','AI Project A','active',
  '{"connectionMode":"environment","readOnlyRequired":true}',
  CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO foundation_integration_accounts (
  id,source_system_code,display_name,credential_ref_type,credential_ref_id,
  status,metadata_json,last_verified_at,created_at,updated_at
) VALUES (
  'foundation:account:ai_project_a:environment',
  'ai_project_a','AI Project A read-only source','environment',
  'PRICE_CONTROL_MYSQL_*','verification_required',
  '{"readOnlyRequired":true,"secretStored":false}',NULL,
  CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
);

CREATE TABLE price_control_sync_runs (
  id TEXT PRIMARY KEY,
  foundation_source_run_id TEXT UNIQUE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled','rehearsal')),
  sync_mode TEXT NOT NULL CHECK (sync_mode IN ('baseline','incremental')),
  status TEXT NOT NULL CHECK (
    status IN ('PENDING','RUNNING','SUCCEEDED','PARTIAL_SUCCESS','FAILED','CANCELLED')
  ),
  source_version TEXT,
  source_checked_at TEXT,
  source_table_updated_at TEXT,
  source_business_updated_at TEXT,
  fetched_at TEXT,
  watermark_at TEXT,
  batches_seen INTEGER NOT NULL DEFAULT 0 CHECK (batches_seen >= 0),
  batches_applied INTEGER NOT NULL DEFAULT 0 CHECK (batches_applied >= 0),
  source_rows_seen INTEGER NOT NULL DEFAULT 0 CHECK (source_rows_seen >= 0),
  price_points_seen INTEGER NOT NULL DEFAULT 0 CHECK (price_points_seen >= 0),
  change_count INTEGER NOT NULL DEFAULT 0 CHECK (change_count >= 0),
  input_fingerprint TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (foundation_source_run_id)
    REFERENCES foundation_source_runs(id) ON DELETE SET NULL
);

CREATE INDEX idx_price_control_sync_runs_status
  ON price_control_sync_runs(status,created_at DESC);

CREATE UNIQUE INDEX uq_price_control_one_running_sync
  ON price_control_sync_runs((1)) WHERE status='RUNNING';

CREATE TABLE price_control_source_batches (
  apply_no TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  approval_status TEXT NOT NULL,
  source_row_count INTEGER NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  batch_fingerprint TEXT NOT NULL,
  apply_created_at TEXT,
  submitted_at TEXT,
  approved_at TEXT,
  effective_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_sync_run_id TEXT NOT NULL,
  FOREIGN KEY (last_sync_run_id)
    REFERENCES price_control_sync_runs(id) ON DELETE RESTRICT
);

CREATE INDEX idx_price_control_batches_effective
  ON price_control_source_batches(country_code,effective_at DESC,apply_no);

CREATE TABLE price_control_price_snapshots (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL,
  apply_no TEXT NOT NULL,
  source_row_key TEXT NOT NULL,
  price_key TEXT NOT NULL,
  country_code TEXT NOT NULL,
  category_name TEXT,
  sku TEXT NOT NULL,
  product_name_cn TEXT,
  sku_status TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  shop_type TEXT NOT NULL CHECK (shop_type IN ('STANDARD','MALL')),
  price_type TEXT NOT NULL CHECK (price_type IN ('REGULAR','CAMPAIGN','MEGA_CAMPAIGN')),
  price_value TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  row_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sync_run_id)
    REFERENCES price_control_sync_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (apply_no)
    REFERENCES price_control_source_batches(apply_no) ON DELETE RESTRICT,
  UNIQUE (apply_no,price_key)
);

CREATE INDEX idx_price_control_snapshots_lookup
  ON price_control_price_snapshots(country_code,sku,effective_at DESC);

CREATE TABLE product_sku_current_prices (
  price_key TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  category_name TEXT,
  sku TEXT NOT NULL,
  product_name_cn TEXT,
  sku_status TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  shop_type TEXT NOT NULL CHECK (shop_type IN ('STANDARD','MALL')),
  price_type TEXT NOT NULL CHECK (price_type IN ('REGULAR','CAMPAIGN','MEGA_CAMPAIGN')),
  price_value TEXT NOT NULL,
  source_apply_no TEXT NOT NULL,
  source_snapshot_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_apply_no)
    REFERENCES price_control_source_batches(apply_no) ON DELETE RESTRICT,
  FOREIGN KEY (source_snapshot_id)
    REFERENCES price_control_price_snapshots(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_sku_current_prices_scope
  ON product_sku_current_prices(country_code,sku,platform,shop_type,price_type);

CREATE TABLE product_price_change_events (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL,
  source_apply_no TEXT NOT NULL,
  price_key TEXT NOT NULL,
  country_code TEXT NOT NULL,
  category_name TEXT,
  sku TEXT NOT NULL,
  product_name_cn TEXT,
  platform TEXT NOT NULL CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  shop_type TEXT NOT NULL CHECK (shop_type IN ('STANDARD','MALL')),
  price_type TEXT NOT NULL CHECK (price_type IN ('REGULAR','CAMPAIGN','MEGA_CAMPAIGN')),
  old_price TEXT,
  new_price TEXT,
  delta_value TEXT,
  delta_percent REAL,
  direction TEXT NOT NULL CHECK (direction IN ('UP','DOWN','NEW','REMOVED')),
  change_text TEXT NOT NULL,
  change_fingerprint TEXT NOT NULL UNIQUE,
  foundation_task_id TEXT,
  detected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (sync_run_id)
    REFERENCES price_control_sync_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_apply_no)
    REFERENCES price_control_source_batches(apply_no) ON DELETE RESTRICT,
  FOREIGN KEY (foundation_task_id)
    REFERENCES foundation_tasks(id) ON DELETE SET NULL
);

CREATE INDEX idx_product_price_changes_detected
  ON product_price_change_events(detected_at DESC,id);
CREATE INDEX idx_product_price_changes_scope
  ON product_price_change_events(country_code,category_name,sku,direction,detected_at DESC);
CREATE INDEX idx_product_price_changes_batch
  ON product_price_change_events(source_apply_no,detected_at DESC);
