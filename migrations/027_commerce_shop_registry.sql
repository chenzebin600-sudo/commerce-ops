CREATE TABLE commerce_shop_registry (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  provider_shop_id TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  normalized_shop_name TEXT NOT NULL,
  source_country_code TEXT NOT NULL CHECK (
    length(source_country_code)=2 AND source_country_code NOT IN ('ZZ','XX')
  ),
  site_code TEXT NOT NULL,
  currency TEXT,
  provider_shop_type TEXT,
  control_shop_type TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (control_shop_type IN ('STANDARD','MALL','ALL','UNKNOWN')),
  growth_shop_id TEXT REFERENCES growth_shops(id) ON DELETE SET NULL,
  execution_provider TEXT NOT NULL DEFAULT 'MABANG_LISTING'
    CHECK (execution_provider IN ('MABANG_LISTING','PLATFORM_GATEWAY')),
  platform_connector_shop_id TEXT,
  identity_status TEXT NOT NULL DEFAULT 'CONFIRMED'
    CHECK (identity_status IN ('CONFIRMED','REVIEW_REQUIRED')),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','INACTIVE')),
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (platform, provider_shop_id)
);

CREATE INDEX idx_commerce_shop_registry_scope
  ON commerce_shop_registry(platform,source_country_code,status,control_shop_type);

CREATE INDEX idx_commerce_shop_registry_growth
  ON commerce_shop_registry(growth_shop_id);

CREATE TABLE commerce_shop_account_bindings (
  shop_id TEXT NOT NULL REFERENCES commerce_shop_registry(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES foundation_integration_accounts(id) ON DELETE RESTRICT,
  source_system TEXT NOT NULL CHECK (source_system IN ('mabang','platform_gateway')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_id,account_id,source_system)
);

CREATE INDEX idx_commerce_shop_bindings_account
  ON commerce_shop_account_bindings(account_id,source_system,status,last_seen_at DESC);

