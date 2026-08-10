CREATE TABLE IF NOT EXISTS app.profit_runs (
  id text PRIMARY KEY,
  platform text NOT NULL,
  date_from date NOT NULL,
  date_to date NOT NULL,
  rule_version text NOT NULL,
  status text NOT NULL,
  current_stage text NOT NULL,
  total_shop_count integer NOT NULL DEFAULT 0,
  finance_success_count integer NOT NULL DEFAULT 0,
  complete_shop_count integer NOT NULL DEFAULT 0,
  partial_shop_count integer NOT NULL DEFAULT 0,
  failed_shop_count integer NOT NULL DEFAULT 0,
  selected_order_count integer NOT NULL DEFAULT 0,
  mabang_sync_status text NOT NULL DEFAULT 'NOT_REQUIRED',
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (status IN ('RUNNING','COMPLETE','PARTIAL','FAILED')),
  CHECK (mabang_sync_status IN ('NOT_REQUIRED','RUNNING','COMPLETE','PARTIAL','FAILED','NOT_CONFIGURED'))
);

CREATE INDEX IF NOT EXISTS idx_profit_runs_scope
  ON app.profit_runs(platform, date_from, date_to, created_at DESC);

CREATE TABLE IF NOT EXISTS app.profit_finance_transactions (
  id text PRIMARY KEY,
  platform text NOT NULL,
  canonical_shop_id text REFERENCES app.commerce_shop_registry(id) ON DELETE SET NULL,
  connector_shop_id text NOT NULL,
  country_code text NOT NULL,
  currency text NOT NULL,
  transaction_date date NOT NULL,
  transaction_time timestamptz,
  transaction_type text,
  fee_name_raw text NOT NULL,
  fee_name_normalized text NOT NULL,
  amount numeric(24,6) NOT NULL,
  statement_number text,
  transaction_number text,
  order_no text,
  order_item_no text,
  seller_sku text,
  lazada_sku text,
  paid_status text,
  order_status text,
  source_key text NOT NULL,
  provider_request_id text,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (platform, connector_shop_id, source_key),
  CHECK (platform IN ('LAZADA','SHOPEE'))
);

CREATE INDEX IF NOT EXISTS idx_profit_finance_shop_date
  ON app.profit_finance_transactions(platform, connector_shop_id, transaction_date);
CREATE INDEX IF NOT EXISTS idx_profit_finance_order
  ON app.profit_finance_transactions(platform, connector_shop_id, order_no);
CREATE INDEX IF NOT EXISTS idx_profit_finance_country_date
  ON app.profit_finance_transactions(platform, country_code, transaction_date);

CREATE TABLE IF NOT EXISTS app.profit_shop_results (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES app.profit_runs(id) ON DELETE CASCADE,
  platform text NOT NULL,
  canonical_shop_id text REFERENCES app.commerce_shop_registry(id) ON DELETE SET NULL,
  connector_shop_id text NOT NULL,
  shop_code text NOT NULL,
  shop_name text NOT NULL,
  country_code text NOT NULL,
  currency text NOT NULL,
  data_status text NOT NULL,
  list_revenue numeric(24,6),
  received_revenue numeric(24,6),
  total_cost numeric(24,6),
  known_total_cost numeric(24,6) NOT NULL DEFAULT 0,
  list_profit_margin numeric(18,8),
  received_profit_margin numeric(18,8),
  list_to_received_profit_margin numeric(18,8),
  finance_row_count integer NOT NULL DEFAULT 0,
  selected_order_count integer NOT NULL DEFAULT 0,
  linked_order_count integer NOT NULL DEFAULT 0,
  evaluation_order_count integer NOT NULL DEFAULT 0,
  cost_line_count integer NOT NULL DEFAULT 0,
  matched_cost_line_count integer NOT NULL DEFAULT 0,
  missing_order_count integer NOT NULL DEFAULT 0,
  missing_cost_line_count integer NOT NULL DEFAULT 0,
  ambiguous_cost_line_count integer NOT NULL DEFAULT 0,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (run_id, connector_shop_id),
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (data_status IN ('COMPLETE','PARTIAL','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_profit_results_run_country
  ON app.profit_shop_results(run_id, country_code, shop_code);
CREATE INDEX IF NOT EXISTS idx_profit_results_shop
  ON app.profit_shop_results(platform, connector_shop_id, calculated_at DESC);
