CREATE TABLE foundation_source_systems (
  code TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('erp', 'marketplace', 'internal', 'ai_provider')
  ),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled')
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE foundation_integration_accounts (
  id TEXT PRIMARY KEY,
  source_system_code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  credential_ref_type TEXT NOT NULL CHECK (
    credential_ref_type IN (
      'mabang_account_profile',
      'sidecar_managed',
      'environment',
      'none'
    )
  ),
  credential_ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled', 'verification_required')
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_system_code)
    REFERENCES foundation_source_systems(code) ON DELETE RESTRICT,
  UNIQUE (source_system_code, credential_ref_type, credential_ref_id),
  CHECK (
    credential_ref_type = 'none'
    OR (credential_ref_id IS NOT NULL AND credential_ref_id <> '')
  )
);

CREATE INDEX idx_foundation_accounts_source_status
  ON foundation_integration_accounts(source_system_code, status, display_name);

CREATE TABLE foundation_account_capabilities (
  account_id TEXT NOT NULL,
  capability_code TEXT NOT NULL CHECK (
    capability_code IN (
      'orders.read',
      'inventory.read',
      'images.read',
      'listing.read',
      'listing.write'
    )
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'disabled', 'requires_binding')
  ),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, capability_code),
  FOREIGN KEY (account_id)
    REFERENCES foundation_integration_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_foundation_capabilities_lookup
  ON foundation_account_capabilities(capability_code, status, account_id);

CREATE TABLE foundation_owners (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_system_code TEXT,
  external_key TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'inactive', 'unassigned')
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_system_code)
    REFERENCES foundation_source_systems(code) ON DELETE RESTRICT,
  UNIQUE (source_system_code, external_key)
);

CREATE INDEX idx_foundation_owners_status_name
  ON foundation_owners(status, display_name);

CREATE TABLE foundation_warehouses (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  country_code TEXT,
  country_name TEXT,
  identity_status TEXT NOT NULL DEFAULT 'review_required' CHECK (
    identity_status IN ('confirmed', 'review_required', 'excluded')
  ),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (identity_status = 'confirmed' AND country_code IS NOT NULL AND country_code <> '')
    OR identity_status <> 'confirmed'
  )
);

CREATE INDEX idx_foundation_warehouses_country_status
  ON foundation_warehouses(country_code, identity_status, display_name);

CREATE TABLE foundation_identity_links (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('product', 'sku', 'store', 'warehouse', 'owner')
  ),
  entity_id TEXT NOT NULL,
  source_system_code TEXT NOT NULL,
  source_entity_type TEXT NOT NULL,
  external_key TEXT NOT NULL,
  normalized_external_key TEXT NOT NULL,
  match_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (
    match_status IN ('confirmed', 'suggested', 'rejected', 'unresolved')
  ),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  confirmed_by TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_system_code)
    REFERENCES foundation_source_systems(code) ON DELETE RESTRICT,
  UNIQUE (
    source_system_code,
    source_entity_type,
    normalized_external_key
  )
);

CREATE INDEX idx_foundation_identity_entity
  ON foundation_identity_links(entity_type, entity_id, match_status);

CREATE TABLE foundation_source_runs (
  id TEXT PRIMARY KEY,
  source_system_code TEXT NOT NULL,
  account_id TEXT,
  domain TEXT NOT NULL CHECK (
    domain IN ('mabang_data', 'growth', 'images', 'listing', 'product')
  ),
  source_ref_type TEXT NOT NULL,
  source_ref_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING',
      'RUNNING',
      'SUCCEEDED',
      'PARTIAL_SUCCESS',
      'FAILED',
      'CANCELLED'
    )
  ),
  watermark_at TEXT,
  input_fingerprint TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_system_code)
    REFERENCES foundation_source_systems(code) ON DELETE RESTRICT,
  FOREIGN KEY (account_id)
    REFERENCES foundation_integration_accounts(id) ON DELETE SET NULL,
  UNIQUE (domain, source_ref_type, source_ref_id)
);

CREATE INDEX idx_foundation_source_runs_status
  ON foundation_source_runs(domain, status, created_at DESC);

CREATE TABLE foundation_tasks (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL CHECK (
    domain IN (
      'growth',
      'mabang_data',
      'mabang_images',
      'listing',
      'product',
      'files'
    )
  ),
  task_kind TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (
    execution_mode IN ('human', 'system')
  ),
  authority_mode TEXT NOT NULL DEFAULT 'projection' CHECK (
    authority_mode IN ('projection', 'foundation')
  ),
  domain_ref_type TEXT NOT NULL,
  domain_ref_id TEXT NOT NULL,
  source_state TEXT,
  state TEXT NOT NULL CHECK (
    state IN (
      'PENDING',
      'READY',
      'RUNNING',
      'PAUSE_REQUESTED',
      'PAUSED',
      'BLOCKED',
      'RETRY_WAIT',
      'SUCCEEDED',
      'PARTIAL_SUCCESS',
      'FAILED',
      'CANCELLED',
      'DISMISSED'
    )
  ),
  priority TEXT NOT NULL DEFAULT 'P2' CHECK (
    priority IN ('P0', 'P1', 'P2', 'P3')
  ),
  account_id TEXT,
  source_run_id TEXT,
  owner_id TEXT,
  store_id TEXT,
  warehouse_id TEXT,
  sku_id TEXT,
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  available_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  last_error_message TEXT,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id)
    REFERENCES foundation_integration_accounts(id) ON DELETE SET NULL,
  FOREIGN KEY (source_run_id)
    REFERENCES foundation_source_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (owner_id)
    REFERENCES foundation_owners(id) ON DELETE SET NULL,
  FOREIGN KEY (store_id)
    REFERENCES growth_shops(id) ON DELETE SET NULL,
  FOREIGN KEY (warehouse_id)
    REFERENCES foundation_warehouses(id) ON DELETE SET NULL,
  FOREIGN KEY (sku_id)
    REFERENCES product_skus(id) ON DELETE SET NULL,
  UNIQUE (domain, domain_ref_type, domain_ref_id),
  UNIQUE (domain, idempotency_key)
);

CREATE INDEX idx_foundation_tasks_queue
  ON foundation_tasks(state, priority, available_at, created_at);
CREATE INDEX idx_foundation_tasks_domain
  ON foundation_tasks(domain, task_kind, state, updated_at DESC);
CREATE INDEX idx_foundation_tasks_owner
  ON foundation_tasks(owner_id, state, priority, updated_at DESC);

CREATE TABLE foundation_task_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  source_state TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id TEXT NOT NULL,
  reason_code TEXT,
  message TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  task_version INTEGER NOT NULL CHECK (task_version >= 1),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES foundation_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, idempotency_key),
  UNIQUE (task_id, task_version)
);

CREATE INDEX idx_foundation_task_events_history
  ON foundation_task_events(task_id, task_version DESC);

CREATE TABLE foundation_task_leases (
  task_id TEXT PRIMARY KEY,
  lease_owner TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES foundation_tasks(id) ON DELETE CASCADE,
  CHECK (expires_at > renewed_at)
);

CREATE INDEX idx_foundation_task_leases_expiry
  ON foundation_task_leases(expires_at);

CREATE VIEW foundation_product_master_v AS
SELECT
  id,
  source_system,
  source_main_sku,
  canonical_name,
  category_id,
  identity_status,
  revision,
  created_at,
  updated_at,
  inactive_at
FROM product_models;

CREATE VIEW foundation_sku_master_v AS
SELECT
  id,
  source_system,
  source_sku,
  normalized_sku,
  source_product_name,
  model_id,
  category_id,
  source_main_sku,
  source_style_code,
  source_style_name,
  source_sales_spec,
  source_status_raw,
  CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS lifecycle_status,
  revision,
  created_at,
  updated_at,
  archived_at
FROM product_skus;

CREATE VIEW foundation_store_master_v AS
SELECT
  id,
  internal_shop_code,
  display_name,
  platform,
  country_code,
  country_name,
  owner_user_id,
  status,
  identity_status,
  revision,
  created_at,
  updated_at
FROM growth_shops;

CREATE VIEW foundation_owner_master_v AS
SELECT
  id,
  display_name,
  source_system_code,
  external_key,
  status,
  metadata_json,
  created_at,
  updated_at
FROM foundation_owners;

CREATE VIEW foundation_warehouse_master_v AS
SELECT
  id,
  canonical_key,
  display_name,
  normalized_name,
  country_code,
  country_name,
  identity_status,
  metadata_json,
  created_at,
  updated_at
FROM foundation_warehouses;

CREATE VIEW foundation_open_tasks_v AS
SELECT *
FROM foundation_tasks
WHERE state IN (
  'PENDING',
  'READY',
  'RUNNING',
  'PAUSE_REQUESTED',
  'PAUSED',
  'BLOCKED',
  'RETRY_WAIT'
);

CREATE VIEW foundation_task_domain_summary_v AS
SELECT
  domain,
  state,
  COUNT(*) AS task_count,
  MIN(created_at) AS oldest_created_at,
  MAX(updated_at) AS latest_updated_at
FROM foundation_tasks
GROUP BY domain, state;

INSERT INTO foundation_source_systems (
  code,
  source_type,
  display_name,
  status,
  metadata_json,
  created_at,
  updated_at
) VALUES
  ('mabang', 'erp', 'Mabang ERP', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('shopee', 'marketplace', 'Shopee', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('lazada', 'marketplace', 'Lazada', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('tiktok_shop', 'marketplace', 'TikTok Shop', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('company_product_center', 'internal', 'Company Product Center', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('commerce_ops', 'internal', 'Commerce Ops', 'active', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO foundation_integration_accounts (
  id,
  source_system_code,
  display_name,
  credential_ref_type,
  credential_ref_id,
  status,
  metadata_json,
  last_verified_at,
  created_at,
  updated_at
)
SELECT
  'foundation:account:mabang:' || id,
  'mabang',
  name,
  'mabang_account_profile',
  id,
  CASE
    WHEN enabled = 0 THEN 'disabled'
    WHEN COALESCE(last_verify_status, '') IN ('failed', 'verification_required')
      THEN 'verification_required'
    ELSE 'active'
  END,
  json_object('usernameHint', substr(username, 1, 2) || '***'),
  last_verified_at,
  created_at,
  updated_at
FROM mabang_account_profiles;

INSERT INTO foundation_account_capabilities (
  account_id,
  capability_code,
  status,
  config_json,
  created_at,
  updated_at
)
SELECT
  account.id,
  capability.capability_code,
  CASE
    WHEN account.status = 'disabled' THEN 'disabled'
    ELSE capability.default_status
  END,
  '{}',
  account.created_at,
  account.updated_at
FROM foundation_integration_accounts account
CROSS JOIN (
  SELECT 'orders.read' AS capability_code, 'active' AS default_status
  UNION ALL SELECT 'inventory.read', 'active'
  UNION ALL SELECT 'images.read', 'active'
  UNION ALL SELECT 'listing.read', 'requires_binding'
  UNION ALL SELECT 'listing.write', 'requires_binding'
) capability
WHERE account.source_system_code = 'mabang';

INSERT INTO foundation_owners (
  id,
  display_name,
  status,
  metadata_json,
  created_at,
  updated_at
) VALUES (
  'foundation:owner:unassigned',
  'Unassigned',
  'unassigned',
  '{}',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);

INSERT INTO foundation_owners (
  id,
  display_name,
  source_system_code,
  external_key,
  status,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  'foundation:owner:growth:' || owner_user_id,
  owner_user_id,
  'commerce_ops',
  owner_user_id,
  'active',
  json_object('derivedFrom', 'growth_shops.owner_user_id'),
  MIN(created_at),
  MAX(updated_at)
FROM growth_shops
WHERE owner_user_id IS NOT NULL
  AND TRIM(owner_user_id) <> ''
GROUP BY owner_user_id;

INSERT INTO foundation_warehouses (
  id,
  canonical_key,
  display_name,
  normalized_name,
  identity_status,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  'foundation:warehouse:mabang:' || LOWER(TRIM(warehouse_name)),
  'mabang:' || LOWER(TRIM(warehouse_name)),
  MIN(TRIM(warehouse_name)),
  LOWER(TRIM(warehouse_name)),
  'review_required',
  json_object('sourceSystem', 'mabang', 'countryMappingRequired', 1),
  MIN(COALESCE(created_at, CURRENT_TIMESTAMP)),
  MAX(COALESCE(created_at, CURRENT_TIMESTAMP))
FROM growth_inventory_snapshots
WHERE warehouse_name IS NOT NULL
  AND TRIM(warehouse_name) <> ''
GROUP BY LOWER(TRIM(warehouse_name));

INSERT INTO foundation_identity_links (
  id,
  entity_type,
  entity_id,
  source_system_code,
  source_entity_type,
  external_key,
  normalized_external_key,
  match_status,
  evidence_json,
  first_seen_at,
  last_seen_at,
  confirmed_by,
  confirmed_at,
  created_at,
  updated_at
)
SELECT
  'foundation:identity:product:' || id,
  'product',
  id,
  CASE
    WHEN source_system IN (
      'mabang',
      'shopee',
      'lazada',
      'tiktok_shop',
      'company_product_center',
      'commerce_ops'
    ) THEN source_system
    ELSE 'company_product_center'
  END,
  'product',
  source_main_sku,
  LOWER(TRIM(source_main_sku)),
  CASE
    WHEN identity_status = 'confirmed' THEN 'confirmed'
    ELSE 'suggested'
  END,
  json_object('canonicalTable', 'product_models'),
  created_at,
  updated_at,
  CASE WHEN identity_status = 'confirmed' THEN 'migration:022' ELSE NULL END,
  CASE WHEN identity_status = 'confirmed' THEN created_at ELSE NULL END,
  created_at,
  updated_at
FROM product_models;

INSERT INTO foundation_identity_links (
  id,
  entity_type,
  entity_id,
  source_system_code,
  source_entity_type,
  external_key,
  normalized_external_key,
  match_status,
  evidence_json,
  first_seen_at,
  last_seen_at,
  confirmed_by,
  confirmed_at,
  created_at,
  updated_at
)
SELECT
  'foundation:identity:sku:' || id,
  'sku',
  id,
  CASE
    WHEN source_system IN (
      'mabang',
      'shopee',
      'lazada',
      'tiktok_shop',
      'company_product_center',
      'commerce_ops'
    ) THEN source_system
    ELSE 'company_product_center'
  END,
  'sku',
  source_sku,
  normalized_sku,
  'confirmed',
  json_object('canonicalTable', 'product_skus'),
  created_at,
  updated_at,
  'migration:022',
  created_at,
  created_at,
  updated_at
FROM product_skus;

INSERT INTO foundation_identity_links (
  id,
  entity_type,
  entity_id,
  source_system_code,
  source_entity_type,
  external_key,
  normalized_external_key,
  match_status,
  evidence_json,
  first_seen_at,
  last_seen_at,
  confirmed_by,
  confirmed_at,
  created_at,
  updated_at
)
SELECT
  'foundation:identity:store:' || id,
  'store',
  id,
  CASE
    WHEN LOWER(platform) LIKE '%shopee%' THEN 'shopee'
    WHEN LOWER(platform) LIKE '%lazada%' THEN 'lazada'
    WHEN LOWER(platform) LIKE '%tiktok%' THEN 'tiktok_shop'
    ELSE 'mabang'
  END,
  'shop',
  internal_shop_code,
  LOWER(TRIM(internal_shop_code)),
  CASE
    WHEN identity_status = 'confirmed' THEN 'confirmed'
    ELSE 'suggested'
  END,
  json_object('canonicalTable', 'growth_shops', 'displayName', display_name),
  created_at,
  updated_at,
  CASE WHEN identity_status = 'confirmed' THEN 'migration:022' ELSE NULL END,
  CASE WHEN identity_status = 'confirmed' THEN created_at ELSE NULL END,
  created_at,
  updated_at
FROM growth_shops;

INSERT INTO foundation_identity_links (
  id,
  entity_type,
  entity_id,
  source_system_code,
  source_entity_type,
  external_key,
  normalized_external_key,
  match_status,
  evidence_json,
  first_seen_at,
  last_seen_at,
  created_at,
  updated_at
)
SELECT
  'foundation:identity:warehouse:' || id,
  'warehouse',
  id,
  'mabang',
  'warehouse',
  display_name,
  normalized_name,
  'unresolved',
  json_object('countryMappingRequired', 1),
  created_at,
  updated_at,
  created_at,
  updated_at
FROM foundation_warehouses;
