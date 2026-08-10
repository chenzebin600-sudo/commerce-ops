-- Human-confirmed repricing workflow. Preview tokens remain server-side and
-- execution cannot be claimed before a persisted PREVIEW_READY state exists.

CREATE TABLE price_control_repricing_plans (
  id TEXT PRIMARY KEY,
  source_round_id TEXT NOT NULL REFERENCES price_control_sync_runs(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES foundation_integration_accounts(id) ON DELETE RESTRICT,
  execution_provider TEXT NOT NULL
    CHECK (execution_provider IN ('MABANG_LISTING','PLATFORM_GATEWAY')),
  status TEXT NOT NULL CHECK (status IN (
    'PREVIEW_READY','CONFIRMING','EXECUTING','EXECUTION_UNKNOWN',
    'SUCCEEDED','PARTIAL','FAILED','EXPIRED','CANCELLED'
  )),
  instruction_text TEXT NOT NULL,
  source_assignments_json TEXT NOT NULL DEFAULT '[]',
  ai_provider_json TEXT NOT NULL DEFAULT '{}',
  parsed_commands_json TEXT NOT NULL DEFAULT '[]',
  preview_token TEXT NOT NULL,
  preview_fingerprint TEXT NOT NULL,
  preview_created_at TEXT NOT NULL,
  preview_expires_at TEXT NOT NULL,
  target_shop_count INTEGER NOT NULL DEFAULT 0 CHECK (target_shop_count>=0),
  listing_change_count INTEGER NOT NULL DEFAULT 0 CHECK (listing_change_count>=0),
  warnings_json TEXT NOT NULL DEFAULT '[]',
  selected_item_ids_json TEXT NOT NULL DEFAULT '[]',
  confirmed_by TEXT,
  confirmed_at TEXT,
  confirmation_fingerprint TEXT,
  execution_job_id TEXT,
  execution_state TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_price_control_repricing_plans_round
  ON price_control_repricing_plans(source_round_id,created_at DESC);

CREATE INDEX idx_price_control_repricing_plans_status
  ON price_control_repricing_plans(status,preview_expires_at,updated_at DESC);

CREATE TABLE price_control_repricing_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES price_control_repricing_plans(id) ON DELETE RESTRICT,
  source_change_id TEXT NOT NULL REFERENCES product_price_change_events(id) ON DELETE RESTRICT,
  source_command_index INTEGER NOT NULL CHECK (source_command_index>=1),
  registry_shop_id TEXT NOT NULL REFERENCES commerce_shop_registry(id) ON DELETE RESTRICT,
  provider_change_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  country_code TEXT NOT NULL,
  sku TEXT NOT NULL,
  control_shop_type TEXT NOT NULL,
  price_type TEXT NOT NULL,
  target_field TEXT NOT NULL CHECK (target_field IN ('price','special_price')),
  provider_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  internal_listing_id TEXT NOT NULL,
  variation_key TEXT NOT NULL,
  old_value_json TEXT NOT NULL,
  new_value_json TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  status TEXT NOT NULL DEFAULT 'PREVIEWED' CHECK (status IN (
    'PREVIEWED','SUBMITTED','SUCCEEDED','FAILED','SKIPPED','EXECUTION_UNKNOWN'
  )),
  result_json TEXT NOT NULL DEFAULT '{}',
  raw_preview_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id,provider_change_id)
);

CREATE INDEX idx_price_control_repricing_items_plan
  ON price_control_repricing_items(plan_id,selected,status,source_command_index,id);

CREATE INDEX idx_price_control_repricing_items_source
  ON price_control_repricing_items(source_change_id,status,updated_at DESC);
