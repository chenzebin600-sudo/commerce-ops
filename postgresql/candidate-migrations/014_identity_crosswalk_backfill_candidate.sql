-- Candidate only. This migration is deliberately governance-only:
-- it does not alter fact tables, backfill identities, publish V2 views, or
-- change module bindings. Production use requires a separately approved
-- backup, write window, exact script fingerprint, and rollback decision.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS app.data_candidate_migration_history (
  migration_id text PRIMARY KEY,
  definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by text NOT NULL DEFAULT CURRENT_USER
);

DO $$
DECLARE
  relation_name text;
  required_dataset_count integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.data_candidate_migration_history
    WHERE migration_id = '014_identity_crosswalk_catalog_v2'
  ) THEN
    RAISE EXCEPTION 'candidate migration 014 has already been applied; replay is forbidden';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY[
    'app.data_source_registry',
    'app.data_dataset_registry',
    'app.data_dataset_columns',
    'app.data_quality_runs',
    'app.product_skus',
    'app.commerce_shop_registry',
    'app.foundation_warehouses',
    'app.platform_api_application_profiles'
  ] LOOP
    IF to_regclass(relation_name) IS NULL THEN
      RAISE EXCEPTION 'candidate migration 014 requires relation %', relation_name;
    END IF;
  END LOOP;

  SELECT count(*) INTO required_dataset_count
  FROM app.data_dataset_registry
  WHERE dataset_code IN (
    'MABANG_ORDER_FACTS','MABANG_INVENTORY_CURRENT','PRODUCT_PACKAGE_CURRENT','PRODUCT_MASTER_CURRENT',
    'PRICE_CONTROL_CURRENT','SHOP_MASTER_CURRENT','PRICE_CONTROL_SHOP_SCOPE','PLATFORM_API_CONTROL'
  );
  IF required_dataset_count <> 8 THEN
    RAISE EXCEPTION 'candidate migration 014 requires exactly eight V1 dataset registrations; found %', required_dataset_count;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.data_dataset_registry
    WHERE dataset_code IN (
      'MABANG_ORDER_FACTS','MABANG_INVENTORY_CURRENT','PRODUCT_PACKAGE_CURRENT','PRODUCT_MASTER_CURRENT',
      'PRICE_CONTROL_CURRENT','SHOP_MASTER_CURRENT','PRICE_CONTROL_SHOP_SCOPE','PLATFORM_API_CONTROL'
    ) AND current_contract_version = '2.0.0'
  ) THEN
    RAISE EXCEPTION 'candidate migration 014 refuses a self-replacing 2.0.0 contract';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'app.commerce_shop_registry'::regclass
      AND attname = 'platform_shop_id' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'candidate migration 014 requires commerce shop directory columns';
  END IF;
END;
$$;

CREATE TABLE app.data_contract_versions (
  dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  contract_version text NOT NULL,
  relation_name text,
  status text NOT NULL CHECK (status IN ('LEGACY_IMPORTED','DRAFT','VALIDATED','PUBLISHED','RETIRED')),
  replaces_version text,
  schema_fingerprint text,
  quality_run_id text REFERENCES app.data_quality_runs(id) ON DELETE RESTRICT,
  validated_at timestamptz,
  validated_by text,
  published_at timestamptz,
  published_by text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (dataset_code, contract_version),
  FOREIGN KEY (dataset_code, replaces_version)
    REFERENCES app.data_contract_versions(dataset_code, contract_version) ON DELETE RESTRICT,
  CHECK (replaces_version IS NULL OR replaces_version <> contract_version),
  CHECK (status NOT IN ('VALIDATED','PUBLISHED')
    OR (quality_run_id IS NOT NULL AND validated_at IS NOT NULL AND validated_by IS NOT NULL)),
  CHECK (status <> 'PUBLISHED'
    OR (relation_name IS NOT NULL AND published_at IS NOT NULL AND published_by IS NOT NULL))
);

CREATE OR REPLACE FUNCTION app.validate_data_contract_quality_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  quality_dataset text;
  quality_version text;
  quality_status text;
BEGIN
  IF NEW.quality_run_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT dataset_code, contract_version, status
    INTO quality_dataset, quality_version, quality_status
    FROM app.data_quality_runs WHERE id = NEW.quality_run_id;
  IF quality_dataset IS DISTINCT FROM NEW.dataset_code
     OR quality_version IS DISTINCT FROM NEW.contract_version
     OR quality_status NOT IN ('PASSED','WARNING') THEN
    RAISE EXCEPTION 'contract quality run does not validate dataset % version %', NEW.dataset_code, NEW.contract_version;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_data_contract_quality_run
BEFORE INSERT OR UPDATE OF dataset_code, contract_version, quality_run_id, status
ON app.data_contract_versions
FOR EACH ROW EXECUTE FUNCTION app.validate_data_contract_quality_run();

INSERT INTO app.data_contract_versions (
  dataset_code, contract_version, relation_name, status, metadata_json
)
SELECT dataset_code, current_contract_version, canonical_relation, 'LEGACY_IMPORTED',
       jsonb_build_object('origin','013_unified_data_foundation_candidate','validation_state','not_reconstructed')
FROM app.data_dataset_registry;

INSERT INTO app.data_contract_versions (
  dataset_code, contract_version, relation_name, status, replaces_version, metadata_json
)
SELECT registry.dataset_code, '2.0.0', NULL, 'DRAFT', registry.current_contract_version,
       jsonb_build_object('module_cutover',false,'facts_backfilled',false,'relation_materialized',false)
FROM app.data_dataset_registry registry
WHERE registry.dataset_code IN (
  'MABANG_ORDER_FACTS','MABANG_INVENTORY_CURRENT','PRODUCT_PACKAGE_CURRENT','PRODUCT_MASTER_CURRENT',
  'PRICE_CONTROL_CURRENT','SHOP_MASTER_CURRENT','PRICE_CONTROL_SHOP_SCOPE','PLATFORM_API_CONTROL'
);

ALTER TABLE app.data_dataset_columns
  ADD CONSTRAINT fk_data_dataset_columns_contract
  FOREIGN KEY (dataset_code, contract_version)
  REFERENCES app.data_contract_versions(dataset_code, contract_version) ON DELETE RESTRICT;

CREATE TABLE app.data_source_field_catalog (
  mapping_set_code text NOT NULL,
  mapping_version text NOT NULL,
  source_code text NOT NULL REFERENCES app.data_source_registry(source_code) ON DELETE RESTRICT,
  source_dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  source_relation text NOT NULL,
  source_field_path text NOT NULL,
  source_data_type text NOT NULL,
  required_level text NOT NULL CHECK (required_level IN ('REQUIRED','CONDITIONAL','OPTIONAL')),
  null_semantics text NOT NULL CHECK (null_semantics IN ('FORBIDDEN','UNKNOWN','NOT_APPLICABLE','CARRY_FORWARD')),
  identity_role text NOT NULL CHECK (identity_role IN ('NONE','BUSINESS_KEY','FOREIGN_KEY','CANONICAL_ID')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  publication_scope text NOT NULL CHECK (publication_scope IN ('GLOBAL','MODULE_LOCAL','NONE')),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (mapping_set_code,mapping_version,source_code,source_dataset_code,source_relation,source_field_path)
);

CREATE OR REPLACE FUNCTION app.validate_source_field_dataset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  registered_source text;
BEGIN
  SELECT source_code INTO registered_source
  FROM app.data_dataset_registry WHERE dataset_code = NEW.source_dataset_code;
  IF registered_source IS DISTINCT FROM NEW.source_code THEN
    RAISE EXCEPTION 'dataset % belongs to source %, not %', NEW.source_dataset_code, registered_source, NEW.source_code;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_source_field_dataset
BEFORE INSERT OR UPDATE OF source_code, source_dataset_code
ON app.data_source_field_catalog
FOR EACH ROW EXECUTE FUNCTION app.validate_source_field_dataset();

CREATE TABLE app.data_field_mappings (
  id text PRIMARY KEY,
  mapping_set_code text NOT NULL,
  mapping_version text NOT NULL,
  source_code text NOT NULL,
  source_dataset_code text NOT NULL,
  source_relation text NOT NULL,
  source_field_path text NOT NULL,
  raw_target_path text,
  target_dataset_code text NOT NULL,
  target_contract_version text NOT NULL,
  canonical_field_path text NOT NULL,
  target_relation text,
  target_column_name text,
  mapping_role text NOT NULL CHECK (mapping_role IN ('VALUE','IDENTITY_KEY','DISCRIMINATOR','LINEAGE','QUALITY_STATUS')),
  mapping_kind text NOT NULL CHECK (mapping_kind IN ('DIRECT','NORMALIZE','IDENTITY_LOOKUP','DERIVE','EXPAND','RETAIN','DROP')),
  transform_code text NOT NULL,
  transform_version text NOT NULL DEFAULT '1.0.0',
  transform_config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  required_level text NOT NULL CHECK (required_level IN ('REQUIRED','CONDITIONAL','OPTIONAL')),
  null_policy text NOT NULL CHECK (null_policy IN ('PRESERVE_NULL','REJECT','CARRY_FORWARD','NOT_APPLICABLE')),
  sensitivity text NOT NULL CHECK (sensitivity IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  publication_scope text NOT NULL CHECK (publication_scope IN ('GLOBAL','MODULE_LOCAL','NONE')),
  cardinality text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  valid_from timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (
    mapping_set_code,mapping_version,source_code,source_dataset_code,source_relation,source_field_path
  ) REFERENCES app.data_source_field_catalog(
    mapping_set_code,mapping_version,source_code,source_dataset_code,source_relation,source_field_path
  ) ON DELETE RESTRICT,
  FOREIGN KEY (target_dataset_code,target_contract_version,canonical_field_path)
    REFERENCES app.data_dataset_columns(dataset_code,contract_version,column_name) ON DELETE RESTRICT,
  UNIQUE (mapping_set_code,mapping_version,source_relation,source_field_path,canonical_field_path),
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CHECK ((status = 'RETIRED') = (valid_to IS NOT NULL)),
  CHECK ((target_relation IS NULL) = (target_column_name IS NULL)),
  CHECK (mapping_kind <> 'DROP'
    OR (publication_scope = 'NONE' AND target_relation IS NULL AND target_column_name IS NULL))
);

CREATE INDEX idx_data_field_mappings_source
  ON app.data_field_mappings(source_dataset_code,status,source_relation,source_field_path);
CREATE INDEX idx_data_field_mappings_target
  ON app.data_field_mappings(target_dataset_code,target_contract_version,status,canonical_field_path);

CREATE TABLE app.data_identity_rule_catalog (
  rule_code text NOT NULL,
  rule_version text NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('IDENTITY','RELATIONSHIP')),
  canonical_entity_type text NOT NULL CHECK (canonical_entity_type IN ('PRODUCT_SKU','SHOP','WAREHOUSE','API_APPLICATION')),
  source_dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  target_dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  source_key_version text NOT NULL,
  source_keys_json jsonb NOT NULL CHECK (jsonb_typeof(source_keys_json) = 'array'),
  target_keys_json jsonb NOT NULL CHECK (jsonb_typeof(target_keys_json) = 'array'),
  allowed_match_methods_json jsonb NOT NULL CHECK (jsonb_typeof(allowed_match_methods_json) = 'array'),
  cardinality text NOT NULL,
  acceptance_policy text NOT NULL,
  conflict_policy text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','RETIRED')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (rule_code,rule_version)
);

CREATE TABLE app.data_identity_mapping_runs (
  id text PRIMARY KEY,
  rule_code text NOT NULL,
  rule_version text NOT NULL,
  mapping_set_code text NOT NULL,
  mapping_version text NOT NULL,
  source_snapshot_fingerprint text NOT NULL,
  mapping_set_fingerprint text NOT NULL,
  input_fingerprint text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('PREVIEW','REPLAY','RECONCILE')),
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','PREVIEW_READY','FAILED','CANCELLED')),
  source_key_count bigint NOT NULL DEFAULT 0 CHECK (source_key_count >= 0),
  candidate_count bigint NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  review_required_count bigint NOT NULL DEFAULT 0 CHECK (review_required_count >= 0),
  unresolved_count bigint NOT NULL DEFAULT 0 CHECK (unresolved_count >= 0),
  requested_by text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  output_fingerprint text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (rule_code,rule_version)
    REFERENCES app.data_identity_rule_catalog(rule_code,rule_version) ON DELETE RESTRICT,
  UNIQUE (rule_code,rule_version,input_fingerprint,mode),
  CHECK (source_snapshot_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (mapping_set_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (output_fingerprint IS NULL OR output_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((status IN ('PENDING','RUNNING')) = (finished_at IS NULL)),
  CHECK (status <> 'PREVIEW_READY' OR output_fingerprint IS NOT NULL)
);

CREATE TABLE app.data_identity_candidates (
  id text PRIMARY KEY,
  mapping_run_id text NOT NULL REFERENCES app.data_identity_mapping_runs(id) ON DELETE RESTRICT,
  source_entity_key_json jsonb NOT NULL,
  source_entity_key_hash text GENERATED ALWAYS AS (md5(source_entity_key_json::text)) STORED,
  canonical_entity_type text NOT NULL CHECK (canonical_entity_type IN ('PRODUCT_SKU','SHOP','WAREHOUSE','API_APPLICATION')),
  canonical_entity_id text NOT NULL,
  match_method text NOT NULL,
  confidence numeric NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  candidate_rank integer NOT NULL CHECK (candidate_rank >= 1),
  eligibility text NOT NULL CHECK (eligibility IN ('AUTO_ELIGIBLE','HUMAN_REQUIRED','BLOCKED')),
  candidate_fingerprint text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (mapping_run_id,source_entity_key_hash,canonical_entity_type,canonical_entity_id),
  UNIQUE (mapping_run_id,source_entity_key_hash,candidate_rank),
  CHECK (jsonb_typeof(source_entity_key_json) = 'object' AND source_entity_key_json <> '{}'::jsonb),
  CHECK (candidate_fingerprint ~ '^[0-9a-f]{64}$'),
  CHECK (jsonb_typeof(evidence_json) = 'object'),
  CHECK (match_method NOT IN ('PLATFORM_COUNTRY_NAME','MANUAL') OR eligibility <> 'AUTO_ELIGIBLE')
);

CREATE OR REPLACE FUNCTION app.validate_identity_candidate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  expected_entity_type text;
  allowed_methods jsonb;
BEGIN
  SELECT run.status, rule.canonical_entity_type, rule.allowed_match_methods_json
    INTO run_status, expected_entity_type, allowed_methods
  FROM app.data_identity_mapping_runs run
  JOIN app.data_identity_rule_catalog rule
    ON rule.rule_code = run.rule_code AND rule.rule_version = run.rule_version
  WHERE run.id = NEW.mapping_run_id;
  IF EXISTS (
    SELECT 1
    FROM app.data_identity_mapping_runs run
    JOIN app.data_identity_rule_catalog rule
      ON rule.rule_code = run.rule_code AND rule.rule_version = run.rule_version
    WHERE run.id = NEW.mapping_run_id AND rule.rule_kind <> 'IDENTITY'
  ) THEN
    RAISE EXCEPTION 'relationship rules do not create canonical identity candidates';
  END IF;
  IF run_status <> 'RUNNING' THEN
    RAISE EXCEPTION 'identity candidates may only be appended to a RUNNING mapping run';
  END IF;
  IF NEW.canonical_entity_type IS DISTINCT FROM expected_entity_type THEN
    RAISE EXCEPTION 'candidate entity type does not match its identity rule';
  END IF;
  IF NOT (allowed_methods ? NEW.match_method) THEN
    RAISE EXCEPTION 'match method % is not allowed by the identity rule', NEW.match_method;
  END IF;
  IF NEW.canonical_entity_type = 'PRODUCT_SKU' AND NOT EXISTS (
    SELECT 1 FROM app.product_skus
    WHERE id = NEW.canonical_entity_id
      AND source_system = 'ai_project_a_product_package'
      AND archived_at IS NULL AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'active product-package target % does not exist', NEW.canonical_entity_id;
  ELSIF NEW.canonical_entity_type = 'SHOP' AND NOT EXISTS (
    SELECT 1 FROM app.commerce_shop_registry WHERE id = NEW.canonical_entity_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active shop target % does not exist', NEW.canonical_entity_id;
  ELSIF NEW.canonical_entity_type = 'WAREHOUSE' AND NOT EXISTS (
    SELECT 1 FROM app.foundation_warehouses
    WHERE id = NEW.canonical_entity_id AND identity_status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'confirmed warehouse target % does not exist', NEW.canonical_entity_id;
  ELSIF NEW.canonical_entity_type = 'API_APPLICATION' AND NOT EXISTS (
    SELECT 1 FROM app.platform_api_application_profiles WHERE account_id = NEW.canonical_entity_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active API application target % does not exist', NEW.canonical_entity_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_identity_candidate
BEFORE INSERT ON app.data_identity_candidates
FOR EACH ROW EXECUTE FUNCTION app.validate_identity_candidate();

CREATE OR REPLACE FUNCTION app.reject_identity_candidate_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'identity candidates are append-only';
END;
$$;
CREATE TRIGGER trg_identity_candidates_append_only
BEFORE UPDATE OR DELETE ON app.data_identity_candidates
FOR EACH ROW EXECUTE FUNCTION app.reject_identity_candidate_mutation();

CREATE TABLE app.data_identity_candidate_decisions (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES app.data_identity_candidates(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('APPROVE','REJECT')),
  actor_type text NOT NULL CHECK (actor_type IN ('HUMAN','POLICY')),
  actor_identifier text NOT NULL,
  reason_code text NOT NULL,
  reason text NOT NULL,
  expected_candidate_fingerprint text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (btrim(actor_identifier) <> ''),
  CHECK (btrim(reason_code) <> ''),
  CHECK (btrim(reason) <> ''),
  CHECK (expected_candidate_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX uq_identity_candidate_single_approval
  ON app.data_identity_candidate_decisions(candidate_id)
  WHERE decision = 'APPROVE';

CREATE OR REPLACE FUNCTION app.validate_identity_candidate_decision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  actual_fingerprint text;
  candidate_eligibility text;
  run_status text;
BEGIN
  SELECT candidate.candidate_fingerprint, candidate.eligibility, run.status
    INTO actual_fingerprint, candidate_eligibility, run_status
  FROM app.data_identity_candidates candidate
  JOIN app.data_identity_mapping_runs run ON run.id = candidate.mapping_run_id
  WHERE candidate.id = NEW.candidate_id;
  IF run_status <> 'PREVIEW_READY' THEN
    RAISE EXCEPTION 'candidate decisions require a PREVIEW_READY run';
  END IF;
  IF NEW.expected_candidate_fingerprint IS DISTINCT FROM actual_fingerprint THEN
    RAISE EXCEPTION 'candidate fingerprint drift';
  END IF;
  IF NEW.decision = 'APPROVE' AND candidate_eligibility = 'BLOCKED' THEN
    RAISE EXCEPTION 'blocked candidate cannot be approved';
  END IF;
  IF NEW.decision = 'APPROVE' AND candidate_eligibility = 'HUMAN_REQUIRED' AND NEW.actor_type <> 'HUMAN' THEN
    RAISE EXCEPTION 'human-required candidate cannot be policy-approved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_identity_candidate_decision
BEFORE INSERT ON app.data_identity_candidate_decisions
FOR EACH ROW EXECUTE FUNCTION app.validate_identity_candidate_decision();
CREATE TRIGGER trg_identity_decisions_append_only
BEFORE UPDATE OR DELETE ON app.data_identity_candidate_decisions
FOR EACH ROW EXECUTE FUNCTION app.reject_identity_candidate_mutation();

CREATE TABLE app.data_identity_resolutions (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES app.data_identity_candidates(id) ON DELETE RESTRICT,
  approval_decision_id text NOT NULL REFERENCES app.data_identity_candidate_decisions(id) ON DELETE RESTRICT,
  canonical_entity_type text NOT NULL CHECK (canonical_entity_type IN ('PRODUCT_SKU','SHOP','WAREHOUSE','API_APPLICATION')),
  canonical_entity_id text NOT NULL,
  source_dataset_code text NOT NULL REFERENCES app.data_dataset_registry(dataset_code) ON DELETE RESTRICT,
  source_key_version text NOT NULL,
  source_entity_key_json jsonb NOT NULL,
  source_entity_key_hash text GENERATED ALWAYS AS (md5(source_entity_key_json::text)) STORED,
  mapping_run_id text NOT NULL REFERENCES app.data_identity_mapping_runs(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  revision integer NOT NULL CHECK (revision >= 1),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (jsonb_typeof(source_entity_key_json) = 'object' AND source_entity_key_json <> '{}'::jsonb),
  CHECK (jsonb_typeof(evidence_json) = 'object'),
  CHECK (btrim(canonical_entity_id) <> ''),
  CHECK (btrim(confirmed_by) <> ''),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (status <> 'ACTIVE' OR effective_to IS NULL),
  CHECK (status <> 'REVOKED' OR effective_to IS NOT NULL),
  UNIQUE (canonical_entity_type,source_dataset_code,source_key_version,source_entity_key_hash,revision)
);

CREATE UNIQUE INDEX uq_data_identity_resolution_active
  ON app.data_identity_resolutions(canonical_entity_type,source_dataset_code,source_key_version,source_entity_key_hash)
  WHERE status = 'ACTIVE';

CREATE OR REPLACE FUNCTION app.validate_identity_resolution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_record record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED'
       OR NEW.effective_to IS NULL
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
       OR NEW.approval_decision_id IS DISTINCT FROM OLD.approval_decision_id
       OR NEW.canonical_entity_type IS DISTINCT FROM OLD.canonical_entity_type
       OR NEW.canonical_entity_id IS DISTINCT FROM OLD.canonical_entity_id
       OR NEW.source_dataset_code IS DISTINCT FROM OLD.source_dataset_code
       OR NEW.source_key_version IS DISTINCT FROM OLD.source_key_version
       OR NEW.source_entity_key_json IS DISTINCT FROM OLD.source_entity_key_json
       OR NEW.mapping_run_id IS DISTINCT FROM OLD.mapping_run_id
       OR NEW.revision IS DISTINCT FROM OLD.revision
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.evidence_json IS DISTINCT FROM OLD.evidence_json
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'resolution updates may only revoke an ACTIVE resolution';
    END IF;
    RETURN NEW;
  END IF;

  SELECT candidate.canonical_entity_type, candidate.canonical_entity_id,
         candidate.source_entity_key_json, candidate.mapping_run_id,
         rule.source_dataset_code, rule.source_key_version,
         decision.decision, decision.candidate_id AS decision_candidate_id
    INTO candidate_record
  FROM app.data_identity_candidates candidate
  JOIN app.data_identity_mapping_runs run ON run.id = candidate.mapping_run_id
  JOIN app.data_identity_rule_catalog rule
    ON rule.rule_code = run.rule_code AND rule.rule_version = run.rule_version
  JOIN app.data_identity_candidate_decisions decision ON decision.id = NEW.approval_decision_id
  WHERE candidate.id = NEW.candidate_id;

  IF candidate_record.decision <> 'APPROVE'
     OR candidate_record.decision_candidate_id IS DISTINCT FROM NEW.candidate_id
     OR NEW.canonical_entity_type IS DISTINCT FROM candidate_record.canonical_entity_type
     OR NEW.canonical_entity_id IS DISTINCT FROM candidate_record.canonical_entity_id
     OR NEW.source_dataset_code IS DISTINCT FROM candidate_record.source_dataset_code
     OR NEW.source_key_version IS DISTINCT FROM candidate_record.source_key_version
     OR NEW.source_entity_key_json IS DISTINCT FROM candidate_record.source_entity_key_json
     OR NEW.mapping_run_id IS DISTINCT FROM candidate_record.mapping_run_id THEN
    RAISE EXCEPTION 'resolution does not match its approved candidate';
  END IF;
  IF NEW.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'new resolution must start ACTIVE';
  END IF;
  IF NEW.canonical_entity_type = 'PRODUCT_SKU' AND NOT EXISTS (
    SELECT 1 FROM app.product_skus
    WHERE id = NEW.canonical_entity_id
      AND source_system = 'ai_project_a_product_package'
      AND archived_at IS NULL AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'approved product target % is no longer active', NEW.canonical_entity_id;
  ELSIF NEW.canonical_entity_type = 'SHOP' AND NOT EXISTS (
    SELECT 1 FROM app.commerce_shop_registry
    WHERE id = NEW.canonical_entity_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'approved shop target % is no longer active', NEW.canonical_entity_id;
  ELSIF NEW.canonical_entity_type = 'WAREHOUSE' AND NOT EXISTS (
    SELECT 1 FROM app.foundation_warehouses
    WHERE id = NEW.canonical_entity_id AND identity_status = 'confirmed'
  ) THEN
    RAISE EXCEPTION 'approved warehouse target % is no longer confirmed', NEW.canonical_entity_id;
  ELSIF NEW.canonical_entity_type = 'API_APPLICATION' AND NOT EXISTS (
    SELECT 1 FROM app.platform_api_application_profiles
    WHERE account_id = NEW.canonical_entity_id AND status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'approved API application target % is no longer active', NEW.canonical_entity_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_identity_resolution
BEFORE INSERT OR UPDATE ON app.data_identity_resolutions
FOR EACH ROW EXECUTE FUNCTION app.validate_identity_resolution();
CREATE TRIGGER trg_identity_resolution_delete_forbidden
BEFORE DELETE ON app.data_identity_resolutions
FOR EACH ROW EXECUTE FUNCTION app.reject_identity_candidate_mutation();

CREATE TABLE app.data_identity_mapping_issues (
  id text PRIMARY KEY,
  mapping_run_id text NOT NULL REFERENCES app.data_identity_mapping_runs(id) ON DELETE RESTRICT,
  source_entity_key_json jsonb NOT NULL,
  source_entity_key_hash text GENERATED ALWAYS AS (md5(source_entity_key_json::text)) STORED,
  issue_code text NOT NULL CHECK (issue_code IN (
    'NO_CANDIDATE','AMBIGUOUS_CANDIDATE','COUNTRY_UNRESOLVED','COUNTRY_CONFLICT','PLATFORM_CONFLICT',
    'DUPLICATE_SOURCE_KEY','TARGET_NOT_FOUND','TARGET_RETIRED','CARDINALITY_VIOLATION','SOURCE_DRIFT',
    'TARGET_DRIFT','AUTHORIZATION_EXPIRED'
  )),
  severity text NOT NULL CHECK (severity IN ('BLOCKER','ERROR','WARNING')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','WAIVED')),
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at timestamptz,
  UNIQUE (mapping_run_id,source_entity_key_hash,issue_code),
  CHECK (jsonb_typeof(source_entity_key_json) = 'object' AND source_entity_key_json <> '{}'::jsonb),
  CHECK (jsonb_typeof(evidence_json) = 'object'),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);

REVOKE ALL ON app.data_source_field_catalog,
  app.data_field_mappings,
  app.data_identity_rule_catalog,
  app.data_identity_mapping_runs,
  app.data_identity_candidates,
  app.data_identity_candidate_decisions,
  app.data_identity_resolutions,
  app.data_identity_mapping_issues
FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON app.data_identity_candidate_decisions,
      app.data_identity_resolutions FROM commerce_app;
  END IF;
END;
$$;

COMMENT ON TABLE app.data_field_mappings IS
  'Versioned source-to-canonical field crosswalk. DRAFT rows are not runtime contracts.';
COMMENT ON TABLE app.data_identity_candidates IS
  'Immutable identity candidates. A candidate never becomes a canonical ID without an approved resolution.';
COMMENT ON TABLE app.data_identity_resolutions IS
  'Approved identity resolutions only. Physical backfill is intentionally outside candidate migration 014.';

-- Normalized definition fingerprint: SHA-256 of this UTF-8 file after replacing
-- only the 64 hexadecimal characters below with 64 zeroes. The rehearsal
-- verifies it before connecting to PostgreSQL; the raw whole-file hash is
-- recorded separately in the rehearsal result.
INSERT INTO app.data_candidate_migration_history(migration_id,definition_sha256)
VALUES (
  '014_identity_crosswalk_catalog_v2',
  'a3e5a5f7efa5b15425d860019e1c815d031275cf888dc237707d9aa0d0facbad'
);

COMMIT;
