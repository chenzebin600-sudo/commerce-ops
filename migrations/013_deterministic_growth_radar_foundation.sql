CREATE TABLE growth_source_batches (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('mabang_order', 'mabang_inventory', 'shop_listing_import')),
  source_module TEXT NOT NULL,
  source_file_id TEXT,
  source_filename TEXT,
  source_sha256 TEXT NOT NULL,
  source_account_id TEXT,
  idempotency_key TEXT NOT NULL,
  query_started_at TEXT,
  query_ended_at TEXT,
  collected_at TEXT,
  imported_at TEXT,
  source_scope_json TEXT NOT NULL DEFAULT '{}',
  source_headers_json TEXT NOT NULL DEFAULT '[]',
  redacted_headers_json TEXT NOT NULL DEFAULT '[]',
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'failed')),
  error_code TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_file_id) REFERENCES export_files(id) ON DELETE RESTRICT,
  UNIQUE (source_type, idempotency_key)
);

CREATE INDEX idx_growth_source_batches_type_created
  ON growth_source_batches(source_type, created_at DESC);
CREATE INDEX idx_growth_source_batches_hash
  ON growth_source_batches(source_type, source_sha256);

CREATE TABLE growth_shops (
  id TEXT PRIMARY KEY,
  internal_shop_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  country_name TEXT NOT NULL,
  owner_user_id TEXT,
  primary_category_scope_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  identity_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (identity_status IN ('confirmed', 'review_required')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (internal_shop_code)
);

CREATE INDEX idx_growth_shops_platform_country
  ON growth_shops(platform, country_code, status);

CREATE TABLE growth_shop_source_mappings (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_shop_name TEXT NOT NULL,
  normalized_source_shop_name TEXT NOT NULL,
  internal_shop_id TEXT,
  platform TEXT NOT NULL,
  country_code TEXT,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('matched', 'manually_confirmed', 'ambiguous', 'unmatched', 'revoked')),
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('exact', 'manual', 'unresolved', 'revoked')),
  first_source_batch_id TEXT,
  last_source_batch_id TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  UNIQUE (source_system, platform, normalized_source_shop_name)
);

CREATE INDEX idx_growth_shop_mappings_status
  ON growth_shop_source_mappings(mapping_status, platform, updated_at DESC);

CREATE TABLE growth_order_headers (
  id TEXT PRIMARY KEY,
  business_key TEXT NOT NULL,
  business_key_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  source_shop_name TEXT NOT NULL,
  normalized_source_shop_name TEXT NOT NULL,
  internal_shop_id TEXT,
  mapped_country TEXT,
  source_order_id TEXT NOT NULL,
  order_status TEXT NOT NULL,
  paid_at TEXT,
  cancelled_at TEXT,
  order_currency TEXT,
  order_amount NUMERIC,
  order_amount_source_field TEXT,
  effective_status TEXT NOT NULL CHECK (effective_status IN ('valid', 'pending', 'invalid_cancelled', 'unconfirmed')),
  first_source_batch_id TEXT NOT NULL,
  source_batch_id TEXT NOT NULL,
  source_quality_status TEXT NOT NULL CHECK (source_quality_status IN ('confirmed', 'review_required', 'invalid')),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  UNIQUE (business_key_version, business_key)
);

CREATE INDEX idx_growth_order_headers_batch
  ON growth_order_headers(source_batch_id, effective_status);
CREATE INDEX idx_growth_order_headers_shop
  ON growth_order_headers(platform, normalized_source_shop_name, paid_at);

CREATE TABLE growth_order_raw_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  raw_values_json TEXT NOT NULL,
  raw_types_json TEXT NOT NULL,
  redacted_fields_json TEXT NOT NULL DEFAULT '[]',
  row_hash TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'review_required', 'rejected')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  UNIQUE (batch_id, source_row_number)
);

CREATE INDEX idx_growth_order_raw_rows_hash
  ON growth_order_raw_rows(row_hash);

CREATE TABLE product_identity_mappings (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  internal_product_id TEXT,
  internal_sku TEXT,
  main_sku TEXT,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('matched', 'manually_confirmed', 'ambiguous', 'unmatched', 'revoked')),
  mapping_source TEXT NOT NULL CHECK (mapping_source IN ('exact_country_sku', 'manual', 'unresolved', 'revoked')),
  confidence NUMERIC,
  first_source_batch_id TEXT,
  last_source_batch_id TEXT,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  UNIQUE (source_system, platform, country_code, normalized_source_sku)
);

CREATE INDEX idx_product_identity_mappings_status
  ON product_identity_mappings(mapping_status, platform, country_code, updated_at DESC);

CREATE TABLE growth_order_lines (
  id TEXT PRIMARY KEY,
  order_header_id TEXT NOT NULL,
  first_source_batch_id TEXT NOT NULL,
  source_batch_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  source_line_key TEXT NOT NULL,
  source_line_key_version TEXT NOT NULL,
  line_occurrence INTEGER NOT NULL CHECK (line_occurrence >= 1),
  dedupe_confidence TEXT NOT NULL CHECK (dedupe_confidence IN ('technical_occurrence', 'source_identifier')),
  source_sku TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  platform_sku TEXT,
  mapped_product_id TEXT,
  mapped_country TEXT,
  quantity NUMERIC NOT NULL,
  line_amount NUMERIC,
  line_amount_status TEXT NOT NULL CHECK (line_amount_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  product_name TEXT,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('matched', 'manually_confirmed', 'country_unresolved', 'ambiguous', 'unmatched', 'revoked')),
  effective_status TEXT NOT NULL CHECK (effective_status IN ('valid', 'pending', 'invalid_cancelled', 'unconfirmed')),
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (order_header_id) REFERENCES growth_order_headers(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (mapped_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (source_line_key_version, source_line_key)
);

CREATE INDEX idx_growth_order_lines_order
  ON growth_order_lines(order_header_id, is_current, source_row_number);
CREATE INDEX idx_growth_order_lines_sku
  ON growth_order_lines(normalized_source_sku, mapped_country, mapping_status);

CREATE TABLE growth_mapping_issues (
  id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL UNIQUE,
  issue_type TEXT NOT NULL CHECK (issue_type IN (
    'shop_unmatched', 'shop_ambiguous', 'country_unresolved', 'sku_unmatched',
    'sku_ambiguous', 'product_country_conflict', 'duplicate_order_key', 'duplicate_line_key'
  )),
  source_batch_id TEXT NOT NULL,
  source_row_id TEXT,
  source_value TEXT NOT NULL,
  candidate_values_json TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'revoked', 'ignored')),
  resolved_value TEXT,
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_row_id) REFERENCES growth_order_raw_rows(id) ON DELETE RESTRICT
);

CREATE INDEX idx_growth_mapping_issues_status
  ON growth_mapping_issues(issue_type, status, created_at DESC);

CREATE TABLE growth_inventory_raw_rows (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  raw_values_json TEXT NOT NULL,
  raw_types_json TEXT NOT NULL,
  redacted_fields_json TEXT NOT NULL DEFAULT '[]',
  row_hash TEXT NOT NULL,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('parsed', 'review_required', 'rejected')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  UNIQUE (batch_id, source_row_number)
);

CREATE INDEX idx_growth_inventory_raw_rows_hash
  ON growth_inventory_raw_rows(row_hash);

CREATE TABLE growth_inventory_snapshots (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 2),
  source_sku TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  mapped_product_id TEXT,
  warehouse_name TEXT,
  available_quantity NUMERIC,
  physical_quantity NUMERIC,
  locked_quantity NUMERIC,
  in_transit_quantity NUMERIC,
  pending_shipment_quantity NUMERIC,
  sellable_quantity NUMERIC,
  sellable_quantity_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (sellable_quantity_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  source_predicted_daily_sales NUMERIC,
  predicted_daily_sales_semantic_status TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (predicted_daily_sales_semantic_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  days_of_supply NUMERIC,
  days_of_supply_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (days_of_supply_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  snapshot_at TEXT,
  mapping_status TEXT NOT NULL CHECK (mapping_status IN ('matched', 'country_unresolved', 'ambiguous', 'unmatched')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('confirmed', 'review_required', 'unconfirmed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (mapped_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (batch_id, source_row_number)
);

CREATE INDEX idx_growth_inventory_snapshots_sku
  ON growth_inventory_snapshots(normalized_source_sku, snapshot_at);

CREATE TABLE growth_data_quality_issues (
  id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL UNIQUE,
  batch_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('batch', 'order_raw_row', 'order_header', 'order_line', 'inventory_raw_row', 'inventory_snapshot', 'mapping')),
  entity_id TEXT,
  issue_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker', 'warning', 'information')),
  message TEXT NOT NULL,
  source_context_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_growth_data_quality_status
  ON growth_data_quality_issues(status, severity, created_at DESC);

CREATE TABLE growth_mapping_events (
  id TEXT PRIMARY KEY,
  mapping_type TEXT NOT NULL CHECK (mapping_type IN ('shop', 'product')),
  mapping_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirmed', 'revoked')),
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  actor_label TEXT NOT NULL,
  request_id TEXT,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_growth_mapping_events_mapping
  ON growth_mapping_events(mapping_type, mapping_id, occurred_at DESC);

CREATE TABLE growth_shop_sku_observations (
  id TEXT PRIMARY KEY,
  observation_key TEXT NOT NULL UNIQUE,
  coverage_semantic TEXT NOT NULL DEFAULT 'historical_observed' CHECK (coverage_semantic = 'historical_observed'),
  platform TEXT NOT NULL,
  source_shop_name TEXT NOT NULL,
  normalized_source_shop_name TEXT NOT NULL,
  internal_shop_id TEXT,
  source_sku TEXT NOT NULL,
  normalized_source_sku TEXT NOT NULL,
  mapped_product_id TEXT,
  first_observed_at TEXT,
  last_observed_at TEXT,
  observed_order_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_order_count >= 0),
  observed_line_count INTEGER NOT NULL DEFAULT 0 CHECK (observed_line_count >= 0),
  observed_quantity NUMERIC NOT NULL DEFAULT 0,
  first_source_batch_id TEXT NOT NULL,
  last_source_batch_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  FOREIGN KEY (mapped_product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_source_batch_id) REFERENCES growth_source_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_growth_shop_sku_observations_shop
  ON growth_shop_sku_observations(internal_shop_id, normalized_source_sku, last_observed_at DESC);

CREATE TABLE growth_shop_sku_coverage_snapshots (
  id TEXT PRIMARY KEY,
  internal_shop_id TEXT NOT NULL,
  product_sku_id TEXT NOT NULL,
  coverage_semantic TEXT NOT NULL CHECK (coverage_semantic = 'current_online'),
  source_system TEXT NOT NULL,
  source_evidence_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (internal_shop_id, product_sku_id, source_system, observed_at)
);

CREATE INDEX idx_growth_shop_sku_coverage_current
  ON growth_shop_sku_coverage_snapshots(internal_shop_id, expires_at DESC);
