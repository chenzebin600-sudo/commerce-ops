CREATE TABLE app.commerce_shop_account_bindings (
  shop_id text,
  account_id text,
  source_system text,
  status text NOT NULL DEFAULT 'ACTIVE',
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (shop_id,account_id,source_system),
  CHECK (source_system IN ('mabang','platform_gateway')),
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

CREATE TABLE app.commerce_shop_registry (
  id text,
  platform text NOT NULL,
  provider_shop_id text NOT NULL,
  shop_name text NOT NULL,
  normalized_shop_name text NOT NULL,
  source_country_code text NOT NULL,
  site_code text NOT NULL,
  currency text,
  provider_shop_type text,
  control_shop_type text NOT NULL DEFAULT 'UNKNOWN',
  growth_shop_id text,
  execution_provider text NOT NULL DEFAULT 'MABANG_LISTING',
  platform_connector_shop_id text,
  identity_status text NOT NULL DEFAULT 'CONFIRMED',
  status text NOT NULL DEFAULT 'ACTIVE',
  source_metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (platform,provider_shop_id),
  CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  CHECK (length(source_country_code)=2 AND source_country_code NOT IN ('ZZ','XX')),
  CHECK (control_shop_type IN ('STANDARD','MALL','ALL','UNKNOWN')),
  CHECK (execution_provider IN ('MABANG_LISTING','PLATFORM_GATEWAY')),
  CHECK (identity_status IN ('CONFIRMED','REVIEW_REQUIRED')),
  CHECK (status IN ('ACTIVE','INACTIVE'))
);

ALTER TABLE app.commerce_shop_account_bindings
  ADD CONSTRAINT fk_commerce_shop_account_bindings_1
  FOREIGN KEY (account_id) REFERENCES app.foundation_integration_accounts(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE app.commerce_shop_account_bindings
  ADD CONSTRAINT fk_commerce_shop_account_bindings_2
  FOREIGN KEY (shop_id) REFERENCES app.commerce_shop_registry(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE app.commerce_shop_registry
  ADD CONSTRAINT fk_commerce_shop_registry_1
  FOREIGN KEY (growth_shop_id) REFERENCES app.growth_shops(id)
  ON UPDATE NO ACTION ON DELETE SET NULL;

CREATE INDEX idx_commerce_shop_bindings_account
  ON app.commerce_shop_account_bindings(account_id,source_system,status,last_seen_at DESC);

CREATE INDEX idx_commerce_shop_registry_growth
  ON app.commerce_shop_registry(growth_shop_id);

CREATE INDEX idx_commerce_shop_registry_scope
  ON app.commerce_shop_registry(platform,source_country_code,status,control_shop_type);
