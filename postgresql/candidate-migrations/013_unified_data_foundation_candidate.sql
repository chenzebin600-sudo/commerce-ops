-- Candidate only. Do not apply to commerce_ops without a separately approved
-- migration rehearsal, backup, write window, and rollback decision.
--
-- Purpose:
--   1. Separate source-system identity from dataset identity.
--   2. Publish one versioned contract per business grain instead of a wide table.
--   3. Make commerce_shop_registry the canonical shop master.
--   4. Relate non-secret platform API application profiles to canonical shops.
--   5. Support future GLOBAL and MODULE_LOCAL datasets without module SQL drift.

BEGIN;

INSERT INTO app.foundation_source_systems (
  code, source_type, display_name, status, metadata_json, created_at, updated_at
) VALUES (
  'ai_project_a_product_package',
  'internal',
  'AI Project A Product Package',
  'active',
  '{"authoritative_object":"product_package"}'::jsonb,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT (code) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status,
  metadata_json = app.foundation_source_systems.metadata_json || EXCLUDED.metadata_json,
  updated_at = CURRENT_TIMESTAMP;

CREATE TABLE app.data_source_registry (
  source_code text PRIMARY KEY,
  foundation_source_system_code text REFERENCES app.foundation_source_systems(code) ON DELETE RESTRICT,
  display_name text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('ERP_SYNC','DATABASE_SYNC','CONNECTOR','INTERNAL','DERIVED')),
  source_locator text NOT NULL,
  secret_boundary text NOT NULL DEFAULT 'NO_SECRETS' CHECK (secret_boundary IN ('NO_SECRETS','REFERENCE_ONLY')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','RETIRED')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE app.data_dataset_registry (
  dataset_code text PRIMARY KEY,
  source_code text NOT NULL REFERENCES app.data_source_registry(source_code) ON DELETE RESTRICT,
  display_name text NOT NULL,
  physical_relation text NOT NULL,
  canonical_relation text NOT NULL,
  source_filter_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_layer text NOT NULL DEFAULT 'CANONICAL' CHECK (data_layer IN ('SOURCE','CANONICAL','SEMANTIC')),
  publish_scope text NOT NULL CHECK (publish_scope IN ('GLOBAL','MODULE_LOCAL')),
  owner_module_code text NOT NULL,
  grain_json jsonb NOT NULL,
  business_key_json jsonb NOT NULL,
  history_mode text NOT NULL CHECK (history_mode IN ('APPEND','SNAPSHOT','LATEST','SCD2','REFERENCE')),
  current_contract_version text NOT NULL,
  freshness_sla_minutes integer NOT NULL CHECK (freshness_sla_minutes >= 0),
  quality_gate_mode text NOT NULL DEFAULT 'BLOCK_ON_ERROR' CHECK (quality_gate_mode IN ('BLOCK_ON_ERROR','WARN_ONLY')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','DEPRECATED','RETIRED')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (publish_scope <> 'MODULE_LOCAL' OR btrim(owner_module_code) <> '')
);

CREATE TABLE app.data_dataset_columns (
  dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  contract_version text NOT NULL,
  column_name text NOT NULL,
  data_type text NOT NULL,
  required_level text NOT NULL CHECK (required_level IN ('REQUIRED','CONDITIONAL','OPTIONAL')),
  null_semantics text NOT NULL CHECK (null_semantics IN ('FORBIDDEN','UNKNOWN','NOT_APPLICABLE','CARRY_FORWARD')),
  identity_role text NOT NULL DEFAULT 'NONE' CHECK (identity_role IN ('NONE','BUSINESS_KEY','FOREIGN_KEY','CANONICAL_ID')),
  sensitivity text NOT NULL DEFAULT 'INTERNAL' CHECK (sensitivity IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_code, contract_version, column_name)
);

CREATE TABLE app.data_dataset_module_bindings (
  dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  module_code text NOT NULL,
  contract_version text NOT NULL,
  access_mode text NOT NULL DEFAULT 'READ' CHECK (access_mode IN ('READ','WRITE','ADMIN')),
  usage_role text NOT NULL CHECK (usage_role IN ('FACT','DIMENSION','REFERENCE','ENRICHMENT')),
  dependency_level text NOT NULL DEFAULT 'REQUIRED' CHECK (dependency_level IN ('REQUIRED','OPTIONAL')),
  join_contract_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_code, module_code)
);

CREATE OR REPLACE FUNCTION app.validate_dataset_module_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  dataset_scope text;
  dataset_owner text;
BEGIN
  SELECT publish_scope, owner_module_code
    INTO dataset_scope, dataset_owner
    FROM app.data_dataset_registry
   WHERE dataset_code = NEW.dataset_code;
  IF dataset_scope = 'MODULE_LOCAL' AND NEW.module_code <> dataset_owner THEN
    RAISE EXCEPTION 'dataset % is local to module %', NEW.dataset_code, dataset_owner;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_dataset_module_binding
BEFORE INSERT OR UPDATE OF dataset_code, module_code
ON app.data_dataset_module_bindings
FOR EACH ROW
EXECUTE FUNCTION app.validate_dataset_module_binding();

CREATE TABLE app.data_dataset_runs (
  id text PRIMARY KEY,
  dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  source_run_type text NOT NULL,
  source_run_id text,
  contract_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','PASSED','REJECTED','FAILED')),
  watermark_at timestamptz,
  input_fingerprint text,
  source_row_count bigint NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  published_row_count bigint NOT NULL DEFAULT 0 CHECK (published_row_count >= 0),
  rejected_row_count bigint NOT NULL DEFAULT 0 CHECK (rejected_row_count >= 0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (dataset_code, source_run_type, source_run_id)
);

CREATE INDEX idx_data_dataset_runs_dataset_time
  ON app.data_dataset_runs(dataset_code, started_at DESC, id DESC);

CREATE TABLE app.data_lineage_edges (
  upstream_dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  downstream_dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  transform_code text NOT NULL,
  transform_version text NOT NULL,
  output_relation text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RETIRED')),
  active_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active_to timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (upstream_dataset_code, downstream_dataset_code, transform_code, transform_version),
  CHECK (upstream_dataset_code <> downstream_dataset_code),
  CHECK (active_to IS NULL OR active_to >= active_from)
);

CREATE TABLE app.data_quality_runs (
  id text PRIMARY KEY,
  dataset_run_id text REFERENCES app.data_dataset_runs(id) ON DELETE RESTRICT,
  dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  contract_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING','PASSED','WARNING','FAILED')),
  blocker_count integer NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  warning_count integer NOT NULL DEFAULT 0 CHECK (warning_count >= 0),
  checked_at timestamptz NOT NULL,
  finished_at timestamptz,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_data_quality_runs_dataset_time
  ON app.data_quality_runs(dataset_code, checked_at DESC, id DESC);

CREATE TABLE app.data_quality_issues (
  id text PRIMARY KEY,
  quality_run_id text NOT NULL REFERENCES app.data_quality_runs(id) ON DELETE RESTRICT,
  rule_code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('BLOCKER','ERROR','WARNING','INFO')),
  result_status text NOT NULL CHECK (result_status IN ('FAIL','UNKNOWN')),
  relation_name text,
  entity_key_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  failing_row_count bigint NOT NULL DEFAULT 0 CHECK (failing_row_count >= 0),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (quality_run_id, rule_code, entity_key_json)
);

-- Cross-store identity bridge. Candidate matches are recorded here, but only
-- CONFIRMED rows may be used by an API binding.
CREATE TABLE app.shop_external_identities (
  id text PRIMARY KEY,
  shop_id text REFERENCES app.commerce_shop_registry(id) ON DELETE RESTRICT,
  source_system_code text NOT NULL REFERENCES app.foundation_source_systems(code) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  external_shop_id text NOT NULL,
  external_seller_id text,
  external_country_code text NOT NULL CHECK (length(external_country_code) = 2),
  external_shop_name text NOT NULL,
  normalized_external_shop_name text NOT NULL,
  match_status text NOT NULL CHECK (match_status IN ('UNMATCHED','REVIEW_REQUIRED','CONFIRMED','REVOKED')),
  match_method text NOT NULL CHECK (match_method IN ('EXTERNAL_ID','PLATFORM_COUNTRY_NAME','MANUAL','UNRESOLVED')),
  confidence numeric,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_system_code, external_shop_id),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (match_status <> 'CONFIRMED' OR (shop_id IS NOT NULL AND confirmed_at IS NOT NULL))
);

CREATE INDEX idx_shop_external_identities_review
  ON app.shop_external_identities(match_status, platform, external_country_code, updated_at DESC);

-- Typed, non-secret API application configuration. Tokens and client secrets
-- remain in the Connector control plane; only references and health metadata
-- are allowed here.
CREATE TABLE app.platform_api_application_profiles (
  account_id text PRIMARY KEY REFERENCES app.foundation_integration_accounts(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('LAZADA','SHOPEE','TIKTOK')),
  connector_application_id text NOT NULL,
  environment text NOT NULL DEFAULT 'PRODUCTION' CHECK (environment IN ('PRODUCTION','SANDBOX')),
  authorization_mode text NOT NULL CHECK (authorization_mode IN ('LOCAL_ENCRYPTED','DELEGATED')),
  api_version text,
  capacity_limit integer CHECK (capacity_limit IS NULL OR capacity_limit > 0),
  credential_reference text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INCOMPLETE','DISABLED','REVIEW_REQUIRED')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (platform, connector_application_id, environment)
);

ALTER TABLE app.commerce_shop_account_bindings
  ADD COLUMN shop_external_identity_id text REFERENCES app.shop_external_identities(id) ON DELETE RESTRICT,
  ADD COLUMN binding_role text NOT NULL DEFAULT 'PRIMARY' CHECK (binding_role IN ('PRIMARY','SECONDARY')),
  ADD COLUMN external_authorization_ref text,
  ADD COLUMN authorization_status text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (authorization_status IN ('ACTIVE','EXPIRING','EXPIRED','REVOKED','DELEGATED','UNKNOWN')),
  ADD COLUMN mapping_status text NOT NULL DEFAULT 'REVIEW_REQUIRED'
    CHECK (mapping_status IN ('CONFIRMED','REVIEW_REQUIRED','REVOKED')),
  ADD COLUMN last_verified_at timestamptz,
  ADD COLUMN binding_evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX uq_shop_primary_platform_gateway_binding
  ON app.commerce_shop_account_bindings(shop_id, source_system)
  WHERE source_system = 'platform_gateway' AND status = 'ACTIVE' AND binding_role = 'PRIMARY';

CREATE OR REPLACE FUNCTION app.validate_platform_gateway_shop_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  profile_platform text;
  shop_platform text;
  identity_shop_id text;
  identity_platform text;
  identity_status text;
BEGIN
  IF NEW.source_system <> 'platform_gateway' THEN
    RETURN NEW;
  END IF;

  SELECT profile.platform
    INTO profile_platform
    FROM app.platform_api_application_profiles profile
   WHERE profile.account_id = NEW.account_id;
  IF profile_platform IS NULL THEN
    RAISE EXCEPTION 'platform_gateway binding requires an API application profile for account %', NEW.account_id;
  END IF;

  SELECT shop.platform
    INTO shop_platform
    FROM app.commerce_shop_registry shop
   WHERE shop.id = NEW.shop_id;
  IF shop_platform IS DISTINCT FROM profile_platform THEN
    RAISE EXCEPTION 'shop platform % does not match API profile platform %', shop_platform, profile_platform;
  END IF;

  IF NEW.shop_external_identity_id IS NULL THEN
    RAISE EXCEPTION 'platform_gateway binding requires a confirmed external shop identity';
  END IF;

  SELECT identity.shop_id, identity.platform, identity.match_status
    INTO identity_shop_id, identity_platform, identity_status
    FROM app.shop_external_identities identity
   WHERE identity.id = NEW.shop_external_identity_id;
  IF identity_shop_id IS DISTINCT FROM NEW.shop_id
     OR identity_platform IS DISTINCT FROM shop_platform
     OR identity_status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'external shop identity is not confirmed for canonical shop %', NEW.shop_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_platform_gateway_shop_binding
BEFORE INSERT OR UPDATE OF shop_id, account_id, source_system, shop_external_identity_id
ON app.commerce_shop_account_bindings
FOR EACH ROW
EXECUTE FUNCTION app.validate_platform_gateway_shop_binding();

INSERT INTO app.data_source_registry (
  source_code, foundation_source_system_code, display_name, source_kind, source_locator, secret_boundary, metadata_json
) VALUES
  ('MABANG_ORDERS', 'mabang', '马帮订单', 'ERP_SYNC', 'app.growth_source_batches[source_type=mabang_order]', 'NO_SECRETS', '{"system_of_record":true}'::jsonb),
  ('MABANG_INVENTORY', 'mabang', '马帮库存', 'ERP_SYNC', 'app.growth_source_batches[source_type=mabang_inventory]', 'NO_SECRETS', '{"system_of_record":true}'::jsonb),
  ('PRODUCT_PACKAGE_DB', 'ai_project_a_product_package', '产品包数据库同步', 'DATABASE_SYNC', 'ai_project_a.product_package', 'NO_SECRETS', '{"system_of_record":true}'::jsonb),
  ('PRICE_CONTROL_DB', 'ai_project_a', '控价数据库同步', 'DATABASE_SYNC', 'ai_project_a.price_control', 'NO_SECRETS', '{"approval_status":"CA","system_of_record":true}'::jsonb),
  ('SHOP_MASTER', 'commerce_ops', '店铺明细主数据', 'INTERNAL', 'app.commerce_shop_registry', 'NO_SECRETS', '{"system_of_record":true}'::jsonb),
  ('PLATFORM_CONNECTOR', 'commerce_ops', '平台连接器控制面', 'CONNECTOR', 'connector control plane', 'REFERENCE_ONLY', '{"tokens_in_business_db":false}'::jsonb)
ON CONFLICT (source_code) DO UPDATE SET
  foundation_source_system_code = EXCLUDED.foundation_source_system_code,
  display_name = EXCLUDED.display_name,
  source_kind = EXCLUDED.source_kind,
  source_locator = EXCLUDED.source_locator,
  secret_boundary = EXCLUDED.secret_boundary,
  metadata_json = app.data_source_registry.metadata_json || EXCLUDED.metadata_json,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO app.data_dataset_registry (
  dataset_code, source_code, display_name, physical_relation, canonical_relation, source_filter_json,
  publish_scope, owner_module_code, grain_json, business_key_json, history_mode,
  current_contract_version, freshness_sla_minutes, metadata_json
) VALUES
  ('MABANG_ORDER_FACTS', 'MABANG_ORDERS', '马帮订单事实', 'app.growth_order_headers + app.growth_order_lines', 'app.canonical_mabang_order_lines_v', '{"source_type":"mabang_order"}'::jsonb, 'GLOBAL', 'sales_assortment', '{"grain":"current order line"}'::jsonb, '["source_order_id","source_line_key"]'::jsonb, 'SCD2', '1.0.0', 1440, '{"valid_rule_version":"order_valid_v1"}'::jsonb),
  ('MABANG_INVENTORY_CURRENT', 'MABANG_INVENTORY', '马帮当前库存', 'app.growth_inventory_snapshots', 'app.canonical_mabang_inventory_current_v', '{"source_type":"mabang_inventory"}'::jsonb, 'GLOBAL', 'sales_assortment', '{"grain":"latest snapshot x SKU x warehouse"}'::jsonb, '["snapshot_at","normalized_source_sku","normalized_warehouse_name"]'::jsonb, 'LATEST', '1.0.0', 1440, '{}'::jsonb),
  ('PRODUCT_PACKAGE_CURRENT', 'PRODUCT_PACKAGE_DB', '当前产品包原始语义行', 'app.product_package_rows', 'app.canonical_product_package_current_v', '{"source_system":"ai_project_a_product_package"}'::jsonb, 'GLOBAL', 'product_center', '{"grain":"country x SKU x warehouse x occurrence"}'::jsonb, '["source_row_key"]'::jsonb, 'LATEST', '1.0.0', 1440, '{}'::jsonb),
  ('PRODUCT_MASTER_CURRENT', 'PRODUCT_PACKAGE_DB', '当前产品主数据', 'app.product_skus', 'app.canonical_product_sku_v', '{"source_system":"ai_project_a_product_package"}'::jsonb, 'GLOBAL', 'product_center', '{"grain":"country x stock SKU"}'::jsonb, '["id"]'::jsonb, 'LATEST', '1.0.0', 1440, '{}'::jsonb),
  ('PRICE_CONTROL_CURRENT', 'PRICE_CONTROL_DB', '当前控价', 'app.product_sku_current_prices', 'app.canonical_price_control_current_v', '{"approval_status":"CA"}'::jsonb, 'GLOBAL', 'price_control', '{"grain":"country x SKU x platform x shop_type x price_type"}'::jsonb, '["price_key"]'::jsonb, 'LATEST', '1.0.0', 120, '{"source_null_semantics":"carry_forward"}'::jsonb),
  ('SHOP_MASTER_CURRENT', 'SHOP_MASTER', '当前店铺主数据', 'app.commerce_shop_registry', 'app.canonical_shop_master_v', '{}'::jsonb, 'GLOBAL', 'platform_connections', '{"grain":"platform seller shop"}'::jsonb, '["platform","provider_shop_id"]'::jsonb, 'SCD2', '1.0.0', 1440, '{}'::jsonb),
  ('PRICE_CONTROL_SHOP_SCOPE', 'PRICE_CONTROL_DB', '控价店铺适用范围', 'app.product_sku_current_prices + app.commerce_shop_registry', 'app.canonical_price_control_shop_v', '{}'::jsonb, 'GLOBAL', 'price_control', '{"grain":"price_key x canonical shop"}'::jsonb, '["price_key","shop_id"]'::jsonb, 'LATEST', '1.0.0', 120, '{}'::jsonb),
  ('PLATFORM_API_CONTROL', 'PLATFORM_CONNECTOR', '平台 API 控制面', 'app.platform_api_application_profiles + app.commerce_shop_account_bindings', 'app.canonical_shop_platform_api_v', '{}'::jsonb, 'MODULE_LOCAL', 'platform_connections', '{"grain":"shop x API application"}'::jsonb, '["shop_id","account_id"]'::jsonb, 'REFERENCE', '1.0.0', 15, '{"secrets":"connector_only"}'::jsonb)
ON CONFLICT (dataset_code) DO UPDATE SET
  source_code = EXCLUDED.source_code,
  display_name = EXCLUDED.display_name,
  physical_relation = EXCLUDED.physical_relation,
  canonical_relation = EXCLUDED.canonical_relation,
  source_filter_json = EXCLUDED.source_filter_json,
  publish_scope = EXCLUDED.publish_scope,
  owner_module_code = EXCLUDED.owner_module_code,
  grain_json = EXCLUDED.grain_json,
  business_key_json = EXCLUDED.business_key_json,
  history_mode = EXCLUDED.history_mode,
  current_contract_version = EXCLUDED.current_contract_version,
  freshness_sla_minutes = EXCLUDED.freshness_sla_minutes,
  metadata_json = app.data_dataset_registry.metadata_json || EXCLUDED.metadata_json,
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO app.data_dataset_module_bindings (
  dataset_code, module_code, contract_version, access_mode, usage_role, dependency_level, join_contract_json
) VALUES
  ('MABANG_ORDER_FACTS', 'sales_assortment', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('MABANG_INVENTORY_CURRENT', 'sales_assortment', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('PRODUCT_PACKAGE_CURRENT', 'sales_assortment', '1.0.0', 'READ', 'ENRICHMENT', 'REQUIRED', '{"keys":["country","sku","warehouse"],"missing":"UNKNOWN"}'::jsonb),
  ('PRODUCT_PACKAGE_CURRENT', 'product_center', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('PRODUCT_MASTER_CURRENT', 'product_center', '1.0.0', 'READ', 'DIMENSION', 'REQUIRED', '{}'::jsonb),
  ('PRODUCT_MASTER_CURRENT', 'sales_assortment', '1.0.0', 'READ', 'DIMENSION', 'REQUIRED', '{"key":"canonical_product_id"}'::jsonb),
  ('MABANG_ORDER_FACTS', 'growth_radar', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('MABANG_INVENTORY_CURRENT', 'growth_radar', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('PRODUCT_MASTER_CURRENT', 'growth_radar', '1.0.0', 'READ', 'DIMENSION', 'REQUIRED', '{}'::jsonb),
  ('PRICE_CONTROL_CURRENT', 'price_control', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('SHOP_MASTER_CURRENT', 'price_control', '1.0.0', 'READ', 'DIMENSION', 'REQUIRED', '{"keys":["platform","country","control_shop_type"]}'::jsonb),
  ('PRICE_CONTROL_SHOP_SCOPE', 'price_control', '1.0.0', 'READ', 'FACT', 'REQUIRED', '{}'::jsonb),
  ('SHOP_MASTER_CURRENT', 'platform_connections', '1.0.0', 'READ', 'DIMENSION', 'REQUIRED', '{}'::jsonb),
  ('PLATFORM_API_CONTROL', 'platform_connections', '1.0.0', 'ADMIN', 'REFERENCE', 'REQUIRED', '{}'::jsonb)
ON CONFLICT (dataset_code, module_code) DO UPDATE SET
  contract_version = EXCLUDED.contract_version,
  access_mode = EXCLUDED.access_mode,
  usage_role = EXCLUDED.usage_role,
  dependency_level = EXCLUDED.dependency_level,
  join_contract_json = EXCLUDED.join_contract_json,
  status = 'ACTIVE',
  updated_at = CURRENT_TIMESTAMP;

INSERT INTO app.data_lineage_edges (
  upstream_dataset_code, downstream_dataset_code, transform_code, transform_version, output_relation
) VALUES
  ('PRODUCT_PACKAGE_CURRENT', 'PRODUCT_MASTER_CURRENT', 'product_package_projection', '1.0.0', 'app.canonical_product_sku_v'),
  ('PRICE_CONTROL_CURRENT', 'PRICE_CONTROL_SHOP_SCOPE', 'price_to_shop_scope', '1.0.0', 'app.canonical_price_control_shop_v'),
  ('SHOP_MASTER_CURRENT', 'PRICE_CONTROL_SHOP_SCOPE', 'price_to_shop_scope', '1.0.0', 'app.canonical_price_control_shop_v')
ON CONFLICT DO NOTHING;

CREATE VIEW app.canonical_product_package_current_v AS
SELECT
  package.id,
  package.source_system,
  package.source_row_key,
  package.product_key,
  package.country_normalized,
  package.sku_normalized,
  package.warehouse_normalized,
  package.row_occurrence,
  package.raw_payload_json,
  package.raw_types_json,
  package.normalized_payload_json,
  package.latest_batch_id,
  package.latest_source_row_number,
  package.revision,
  package.created_at,
  package.updated_at
FROM app.product_package_rows package
JOIN app.data_dataset_registry dataset
  ON dataset.dataset_code = 'PRODUCT_PACKAGE_CURRENT'
 AND dataset.status = 'ACTIVE'
 AND package.source_system = dataset.source_filter_json->>'source_system';

CREATE VIEW app.canonical_product_sku_v AS
SELECT
  sku.id AS canonical_product_id,
  sku.source_system,
  sku.source_sku,
  sku.normalized_sku,
  sku.country_raw AS country_code,
  sku.sku_code_normalized,
  sku.source_product_name,
  sku.source_main_sku,
  sku.category_id,
  sku.model_id,
  sku.revision,
  sku.created_at,
  sku.updated_at,
  sku.archived_at,
  sku.deleted_at
FROM app.product_skus sku
JOIN app.data_dataset_registry dataset
  ON dataset.dataset_code = 'PRODUCT_MASTER_CURRENT'
 AND dataset.status = 'ACTIVE'
 AND sku.source_system = dataset.source_filter_json->>'source_system'
WHERE sku.deleted_at IS NULL;

CREATE VIEW app.canonical_shop_master_v AS
SELECT
  shop.id AS shop_id,
  shop.platform,
  shop.provider_shop_id,
  shop.shop_name,
  shop.normalized_shop_name,
  shop.source_country_code AS country_code,
  shop.site_code,
  shop.currency,
  shop.provider_shop_type,
  shop.control_shop_type,
  shop.identity_status,
  shop.execution_provider,
  shop.status,
  shop.first_seen_at,
  shop.last_seen_at,
  shop.created_at,
  shop.updated_at,
  CASE
    WHEN shop.identity_status <> 'CONFIRMED' THEN 'REVIEW_REQUIRED'
    WHEN shop.currency IS NULL OR btrim(shop.currency) = '' THEN 'INCOMPLETE'
    WHEN shop.control_shop_type = 'UNKNOWN' THEN 'INCOMPLETE'
    ELSE 'READY'
  END AS data_readiness_status
FROM app.commerce_shop_registry shop;

CREATE VIEW app.canonical_mabang_order_lines_v AS
SELECT
  header.id AS order_header_id,
  line.id AS order_line_id,
  header.source_order_id,
  line.source_line_key,
  header.platform,
  header.source_shop_name,
  shop.shop_id AS canonical_shop_id,
  COALESCE(header.mapped_country, shop.country_code) AS country_code,
  line.source_sku,
  line.normalized_source_sku,
  line.mapped_product_id AS canonical_product_id,
  line.quantity,
  line.line_amount,
  line.line_amount_status,
  header.order_currency,
  header.order_amount,
  header.order_status,
  header.paid_at,
  line.source_warehouse_name,
  line.normalized_source_warehouse_name,
  header.source_batch_id,
  header.source_quality_status,
  line.mapping_status AS product_mapping_status,
  CASE
    WHEN header.internal_shop_id IS NULL THEN 'UNRESOLVED'
    WHEN shop.shop_id IS NULL THEN 'UNRESOLVED'
    WHEN header.mapped_country IS NOT NULL AND header.mapped_country <> shop.country_code THEN 'COUNTRY_CONFLICT'
    ELSE 'CONFIRMED'
  END AS shop_mapping_status,
  'order_valid_v1'::text AS valid_order_rule_version
FROM app.growth_order_lines line
JOIN app.growth_order_headers header ON header.id = line.order_header_id
LEFT JOIN app.canonical_shop_master_v shop ON shop.shop_id IN (
  SELECT registry.id
  FROM app.commerce_shop_registry registry
  WHERE registry.growth_shop_id = header.internal_shop_id
)
WHERE line.is_current = 1
  AND header.effective_status = 'valid'
  AND line.effective_status = 'valid'
  AND line.quantity > 0;

CREATE VIEW app.canonical_mabang_inventory_current_v AS
WITH latest_batch AS (
  SELECT batch.id, batch.collected_at, batch.imported_at
  FROM app.growth_source_batches batch
  WHERE batch.source_type = 'mabang_inventory' AND batch.status = 'applied'
  ORDER BY COALESCE(batch.collected_at, batch.imported_at, batch.created_at) DESC, batch.id DESC
  LIMIT 1
)
SELECT
  inventory.id AS inventory_snapshot_id,
  inventory.batch_id,
  latest_batch.collected_at,
  latest_batch.imported_at,
  inventory.snapshot_at,
  inventory.source_sku,
  inventory.normalized_source_sku,
  inventory.warehouse_name,
  inventory.normalized_warehouse_name,
  inventory.mapped_product_id AS canonical_product_id,
  product.country_code,
  inventory.available_quantity,
  inventory.physical_quantity,
  inventory.locked_quantity,
  inventory.in_transit_quantity,
  inventory.pending_shipment_quantity,
  inventory.sellable_quantity,
  inventory.source_predicted_daily_sales,
  inventory.days_of_supply,
  inventory.mapping_status,
  inventory.quality_status,
  inventory.sellable_quantity_status,
  inventory.days_of_supply_status
FROM latest_batch
JOIN app.growth_inventory_snapshots inventory ON inventory.batch_id = latest_batch.id
LEFT JOIN app.canonical_product_sku_v product ON product.canonical_product_id = inventory.mapped_product_id;

CREATE VIEW app.canonical_price_control_current_v AS
SELECT
  price.price_key,
  price.country_code,
  price.sku,
  product.canonical_product_id,
  COALESCE(price.product_name_cn, product.source_product_name) AS product_name_cn,
  price.category_name,
  price.sku_status,
  price.platform,
  price.shop_type,
  price.price_type,
  price.price_value,
  CASE
    WHEN btrim(price.price_value) ~ '^-?[0-9]+([.][0-9]+)?$' THEN price.price_value::numeric
    ELSE NULL
  END AS price_value_numeric,
  price.source_apply_no,
  price.source_snapshot_id,
  price.effective_at,
  price.revision,
  price.created_at,
  price.updated_at,
  CASE WHEN product.canonical_product_id IS NULL THEN 'UNRESOLVED' ELSE 'CONFIRMED' END AS product_mapping_status
FROM app.product_sku_current_prices price
LEFT JOIN LATERAL (
  SELECT product.*
  FROM app.canonical_product_sku_v product
  WHERE product.country_code = price.country_code
    AND upper(btrim(product.source_sku)) = upper(btrim(price.sku))
  ORDER BY product.updated_at DESC, product.canonical_product_id
  LIMIT 1
) product ON TRUE;

CREATE VIEW app.canonical_price_control_shop_v AS
SELECT
  price.*,
  shop.shop_id,
  shop.shop_name,
  shop.currency AS shop_currency,
  shop.control_shop_type,
  CASE WHEN shop.shop_id IS NULL THEN 'UNRESOLVED' ELSE 'CONFIRMED' END AS shop_scope_status
FROM app.canonical_price_control_current_v price
LEFT JOIN app.canonical_shop_master_v shop
  ON shop.status = 'ACTIVE'
 AND shop.platform = price.platform
 AND shop.country_code = price.country_code
 AND shop.control_shop_type IN (price.shop_type, 'ALL');

CREATE VIEW app.canonical_shop_platform_api_v AS
SELECT
  binding.shop_id,
  shop.platform,
  shop.provider_shop_id,
  shop.shop_name,
  shop.country_code,
  binding.account_id,
  profile.connector_application_id,
  profile.environment,
  profile.authorization_mode,
  profile.api_version,
  identity.external_shop_id AS connector_shop_id,
  identity.external_seller_id AS connector_seller_id,
  binding.external_authorization_ref,
  binding.authorization_status,
  binding.mapping_status,
  binding.binding_role,
  binding.status,
  binding.last_verified_at,
  profile.last_verified_at AS application_last_verified_at
FROM app.commerce_shop_account_bindings binding
JOIN app.canonical_shop_master_v shop ON shop.shop_id = binding.shop_id
JOIN app.platform_api_application_profiles profile ON profile.account_id = binding.account_id
JOIN app.shop_external_identities identity ON identity.id = binding.shop_external_identity_id
WHERE binding.source_system = 'platform_gateway';

COMMENT ON TABLE app.product_inventory_snapshots IS
  'Product-package inventory reference only. The authoritative global inventory fact is growth_inventory_snapshots via canonical_mabang_inventory_current_v.';

COMMENT ON COLUMN app.commerce_shop_registry.platform_connector_shop_id IS
  'Deprecated candidate field. Connector identities belong in shop_external_identities and API account bindings.';

COMMIT;
