CREATE TABLE IF NOT EXISTS profit_runs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  status TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  total_shop_count INTEGER NOT NULL DEFAULT 0,
  finance_success_count INTEGER NOT NULL DEFAULT 0,
  complete_shop_count INTEGER NOT NULL DEFAULT 0,
  partial_shop_count INTEGER NOT NULL DEFAULT 0,
  failed_shop_count INTEGER NOT NULL DEFAULT 0,
  selected_order_count INTEGER NOT NULL DEFAULT 0,
  mabang_sync_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (status IN ('RUNNING','COMPLETE','PARTIAL','FAILED')),
  CHECK (mabang_sync_status IN ('NOT_REQUIRED','RUNNING','COMPLETE','PARTIAL','FAILED','NOT_CONFIGURED'))
);

CREATE INDEX IF NOT EXISTS idx_profit_runs_scope
  ON profit_runs(platform, date_from, date_to, created_at DESC);

CREATE TABLE IF NOT EXISTS profit_finance_transactions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  canonical_shop_id TEXT,
  connector_shop_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  transaction_time TEXT,
  transaction_type TEXT,
  fee_name_raw TEXT NOT NULL,
  fee_name_normalized TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  statement_number TEXT,
  transaction_number TEXT,
  order_no TEXT,
  order_item_no TEXT,
  seller_sku TEXT,
  lazada_sku TEXT,
  paid_status TEXT,
  order_status TEXT,
  source_key TEXT NOT NULL,
  provider_request_id TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (canonical_shop_id) REFERENCES commerce_shop_registry(id) ON DELETE SET NULL,
  UNIQUE (platform, connector_shop_id, source_key),
  CHECK (platform IN ('LAZADA','SHOPEE'))
);

CREATE INDEX IF NOT EXISTS idx_profit_finance_shop_date
  ON profit_finance_transactions(platform, connector_shop_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_profit_finance_order
  ON profit_finance_transactions(platform, connector_shop_id, order_no);
CREATE INDEX IF NOT EXISTS idx_profit_finance_country_date
  ON profit_finance_transactions(platform, country_code, transaction_date);

CREATE TABLE IF NOT EXISTS profit_shop_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  canonical_shop_id TEXT,
  connector_shop_id TEXT NOT NULL,
  shop_code TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  data_status TEXT NOT NULL,
  list_revenue NUMERIC,
  received_revenue NUMERIC,
  total_cost NUMERIC,
  known_total_cost NUMERIC NOT NULL DEFAULT 0,
  list_profit_margin NUMERIC,
  received_profit_margin NUMERIC,
  list_to_received_profit_margin NUMERIC,
  finance_row_count INTEGER NOT NULL DEFAULT 0,
  selected_order_count INTEGER NOT NULL DEFAULT 0,
  linked_order_count INTEGER NOT NULL DEFAULT 0,
  evaluation_order_count INTEGER NOT NULL DEFAULT 0,
  cost_line_count INTEGER NOT NULL DEFAULT 0,
  matched_cost_line_count INTEGER NOT NULL DEFAULT 0,
  missing_order_count INTEGER NOT NULL DEFAULT 0,
  missing_cost_line_count INTEGER NOT NULL DEFAULT 0,
  ambiguous_cost_line_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  calculated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES profit_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (canonical_shop_id) REFERENCES commerce_shop_registry(id) ON DELETE SET NULL,
  UNIQUE (run_id, connector_shop_id),
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (data_status IN ('COMPLETE','PARTIAL','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_profit_results_run_country
  ON profit_shop_results(run_id, country_code, shop_code);
CREATE INDEX IF NOT EXISTS idx_profit_results_shop
  ON profit_shop_results(platform, connector_shop_id, calculated_at DESC);
