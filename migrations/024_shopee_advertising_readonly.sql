CREATE TABLE advertising_source_batches (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform = 'shopee'),
  report_type TEXT NOT NULL CHECK (report_type = 'overall'),
  shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  account_name TEXT,
  original_filename TEXT NOT NULL,
  report_created_at TEXT,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  period_days INTEGER NOT NULL CHECK (period_days >= 1),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  raw_sha256 TEXT NOT NULL UNIQUE,
  summary_json TEXT NOT NULL DEFAULT '{}',
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_advertising_source_batches_shop_period
  ON advertising_source_batches(shop_id, period_to DESC, period_days, imported_at DESC);

CREATE TABLE advertising_performance_facts (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  shop_id TEXT NOT NULL,
  ad_key TEXT NOT NULL,
  ad_name TEXT NOT NULL,
  ad_status TEXT NOT NULL,
  ad_type TEXT,
  product_id TEXT,
  bidding_method TEXT,
  placement TEXT,
  impression REAL NOT NULL DEFAULT 0,
  clicks REAL NOT NULL DEFAULT 0,
  add_to_cart REAL NOT NULL DEFAULT 0,
  conversions REAL NOT NULL DEFAULT 0,
  items_sold REAL NOT NULL DEFAULT 0,
  gmv REAL NOT NULL DEFAULT 0,
  expense REAL NOT NULL DEFAULT 0,
  roas REAL NOT NULL DEFAULT 0,
  direct_roas REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES advertising_source_batches(id) ON DELETE CASCADE,
  UNIQUE (batch_id, sequence_no)
);

CREATE INDEX idx_advertising_performance_facts_batch
  ON advertising_performance_facts(batch_id, expense DESC);
CREATE INDEX idx_advertising_performance_facts_identity
  ON advertising_performance_facts(shop_id, product_id, ad_name);

CREATE TABLE advertising_target_policies (
  id TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  product_id TEXT,
  ad_name TEXT NOT NULL,
  target_roas REAL NOT NULL CHECK (target_roas > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('manual', 'screenshot', 'import')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (shop_id, target_key, effective_from)
);

CREATE INDEX idx_advertising_target_policies_active
  ON advertising_target_policies(shop_id, target_key, effective_from DESC, effective_to);
