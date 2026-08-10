CREATE TABLE IF NOT EXISTS app.profit_expense_transactions (
  id text PRIMARY KEY,
  platform text NOT NULL,
  canonical_shop_id text REFERENCES app.commerce_shop_registry(id) ON DELETE SET NULL,
  connector_shop_id text NOT NULL,
  country_code text NOT NULL,
  currency text NOT NULL,
  transaction_date date NOT NULL,
  transaction_time timestamptz,
  source_type text NOT NULL,
  transaction_type text,
  transaction_subtype text,
  transaction_tab_type text,
  money_flow text,
  amount numeric(24,6) NOT NULL,
  transaction_number text,
  remarks text,
  source_window text NOT NULL,
  source_key text NOT NULL,
  provider_request_id text,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (platform, connector_shop_id, source_key),
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (source_type IN ('ADVERTISING'))
);

CREATE INDEX IF NOT EXISTS idx_profit_expense_transactions_shop_date
  ON app.profit_expense_transactions(platform, connector_shop_id, transaction_date);

CREATE TABLE IF NOT EXISTS app.profit_shop_daily_expenses (
  id text PRIMARY KEY,
  platform text NOT NULL,
  canonical_shop_id text REFERENCES app.commerce_shop_registry(id) ON DELETE SET NULL,
  connector_shop_id text NOT NULL,
  country_code text NOT NULL,
  currency text NOT NULL,
  transaction_date date NOT NULL,
  data_status text NOT NULL,
  advertising_expense_signed numeric(24,6) NOT NULL DEFAULT 0,
  billing_expense_signed numeric(24,6) NOT NULL DEFAULT 0,
  affiliate_expense_signed numeric(24,6),
  ads_escrow_expense_signed numeric(24,6),
  source_signed_total numeric(24,6),
  expense_value numeric(24,6),
  classification text,
  rule_version text NOT NULL,
  advertising_row_count integer NOT NULL DEFAULT 0,
  billing_row_count integer NOT NULL DEFAULT 0,
  source_window_count integer NOT NULL DEFAULT 0,
  duplicate_group_count integer NOT NULL DEFAULT 0,
  duplicate_removed_count integer NOT NULL DEFAULT 0,
  source_complete boolean NOT NULL DEFAULT false,
  issues_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculated_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (platform, connector_shop_id, transaction_date),
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (data_status IN ('COMPLETE','PARTIAL')),
  CHECK (classification IS NULL OR classification IN ('EXPENSE','NET_CREDIT'))
);

CREATE INDEX IF NOT EXISTS idx_profit_daily_expenses_country_date
  ON app.profit_shop_daily_expenses(platform, country_code, transaction_date);
