CREATE TABLE IF NOT EXISTS profit_expense_transactions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  canonical_shop_id TEXT,
  connector_shop_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  transaction_time TEXT,
  source_type TEXT NOT NULL,
  transaction_type TEXT,
  transaction_subtype TEXT,
  transaction_tab_type TEXT,
  money_flow TEXT,
  amount NUMERIC NOT NULL,
  transaction_number TEXT,
  remarks TEXT,
  source_window TEXT NOT NULL,
  source_key TEXT NOT NULL,
  provider_request_id TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (canonical_shop_id) REFERENCES commerce_shop_registry(id) ON DELETE SET NULL,
  UNIQUE (platform, connector_shop_id, source_key),
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (source_type IN ('ADVERTISING'))
);

CREATE INDEX IF NOT EXISTS idx_profit_expense_transactions_shop_date
  ON profit_expense_transactions(platform, connector_shop_id, transaction_date);

CREATE TABLE IF NOT EXISTS profit_shop_daily_expenses (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  canonical_shop_id TEXT,
  connector_shop_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  currency TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  data_status TEXT NOT NULL,
  advertising_expense_signed NUMERIC NOT NULL DEFAULT 0,
  billing_expense_signed NUMERIC NOT NULL DEFAULT 0,
  affiliate_expense_signed NUMERIC,
  ads_escrow_expense_signed NUMERIC,
  source_signed_total NUMERIC,
  expense_value NUMERIC,
  classification TEXT,
  rule_version TEXT NOT NULL,
  advertising_row_count INTEGER NOT NULL DEFAULT 0,
  billing_row_count INTEGER NOT NULL DEFAULT 0,
  source_window_count INTEGER NOT NULL DEFAULT 0,
  duplicate_group_count INTEGER NOT NULL DEFAULT 0,
  duplicate_removed_count INTEGER NOT NULL DEFAULT 0,
  source_complete INTEGER NOT NULL DEFAULT 0,
  issues_json TEXT NOT NULL DEFAULT '[]',
  calculated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (canonical_shop_id) REFERENCES commerce_shop_registry(id) ON DELETE SET NULL,
  UNIQUE (platform, connector_shop_id, transaction_date),
  CHECK (platform IN ('LAZADA','SHOPEE')),
  CHECK (data_status IN ('COMPLETE','PARTIAL')),
  CHECK (classification IS NULL OR classification IN ('EXPENSE','NET_CREDIT')),
  CHECK (source_complete IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_profit_daily_expenses_country_date
  ON profit_shop_daily_expenses(platform, country_code, transaction_date);
