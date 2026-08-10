CREATE TABLE IF NOT EXISTS app.product_knowledge_import_batches (
  id text PRIMARY KEY,
  contract_version text NOT NULL,
  package_digest text NOT NULL UNIQUE,
  package_name text NOT NULL,
  status text NOT NULL DEFAULT 'IMPORTING',
  declared_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  imported_counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  CHECK (status IN ('IMPORTING','IMPORTED','FAILED','REJECTED'))
);

CREATE TABLE IF NOT EXISTS app.product_knowledge_candidates (
  id text PRIMARY KEY,
  import_batch_id text NOT NULL REFERENCES app.product_knowledge_import_batches(id) ON DELETE RESTRICT,
  asset_id text NOT NULL,
  asset_type text NOT NULL,
  target_domain text NOT NULL,
  candidate_status text NOT NULL,
  mapping_status text,
  risk_level text NOT NULL DEFAULT 'NORMAL',
  conflict_status text NOT NULL DEFAULT 'UNCHECKED',
  canonical_category_name text,
  product_model_id text REFERENCES app.product_models(id) ON DELETE RESTRICT,
  product_sku_id text REFERENCES app.product_skus(id) ON DELETE RESTRICT,
  source_sku text,
  language_code text,
  scope_type text NOT NULL DEFAULT 'UNVERIFIED',
  country_scope_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  consumer_scopes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  governance_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_id text,
  source_sha256 text,
  source_sheet text,
  source_location text,
  content_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (import_batch_id, asset_id),
  CHECK (target_domain IN (
    'PRODUCT_CORE','PRODUCT_KNOWLEDGE','PRODUCT_MEDIA','CUSTOMER_SERVICE_POLICY',
    'CUSTOMER_SERVICE_PLAYBOOK','CUSTOMER_SERVICE_OPERATIONS','GOVERNANCE'
  )),
  CHECK (candidate_status IN (
    'DRAFT','REVIEW_REQUIRED','MAPPING_REQUIRED','SOURCE_READ_REQUIRED','CONFLICT','APPROVED','REJECTED'
  )),
  CHECK (risk_level IN ('NORMAL','SENSITIVE','HIGH')),
  CHECK (scope_type IN ('COMMON','COUNTRY_OVERRIDE','UNVERIFIED'))
);

CREATE TABLE IF NOT EXISTS app.product_knowledge_reviews (
  id text PRIMARY KEY,
  candidate_id text NOT NULL REFERENCES app.product_knowledge_candidates(id) ON DELETE RESTRICT,
  action text NOT NULL,
  reviewer_id text NOT NULL,
  reviewer_roles_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason_code text,
  comment text,
  candidate_content_digest text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (action IN ('APPROVE','REJECT','RETURN_FOR_MAPPING','RETURN_FOR_SOURCE','RETURN_FOR_CONFLICT'))
);

CREATE TABLE IF NOT EXISTS app.product_knowledge_claims (
  id text PRIMARY KEY,
  claim_key text NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  claim_type text NOT NULL,
  title text,
  text_content text NOT NULL,
  structured_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  product_model_id text REFERENCES app.product_models(id) ON DELETE RESTRICT,
  product_sku_id text REFERENCES app.product_skus(id) ON DELETE RESTRICT,
  category_id text REFERENCES app.product_categories(id) ON DELETE RESTRICT,
  source_candidate_id text NOT NULL UNIQUE REFERENCES app.product_knowledge_candidates(id) ON DELETE RESTRICT,
  source_content_digest text NOT NULL,
  approval_status text NOT NULL DEFAULT 'APPROVED',
  risk_level text NOT NULL DEFAULT 'NORMAL',
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (claim_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN')),
  CHECK (risk_level IN ('NORMAL','SENSITIVE','HIGH'))
);

CREATE TABLE IF NOT EXISTS app.product_knowledge_claim_scopes (
  id text PRIMARY KEY,
  claim_id text NOT NULL REFERENCES app.product_knowledge_claims(id) ON DELETE RESTRICT,
  scope_type text NOT NULL,
  country_code text,
  language_code text NOT NULL,
  consumer_scope text NOT NULL,
  visibility text NOT NULL,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE NULLS NOT DISTINCT (claim_id, country_code, language_code, consumer_scope, visibility),
  CHECK (scope_type IN ('COMMON','COUNTRY_OVERRIDE')),
  CHECK (consumer_scope IN ('CUSTOMER_SERVICE','LISTING','MARKETING','INTERNAL')),
  CHECK (visibility IN ('CUSTOMER_VISIBLE','CUSTOMER_VISIBLE_AFTER_POLICY_VALIDATION','INTERNAL_ONLY')),
  CHECK (
    (scope_type='COMMON' AND country_code IS NULL)
    OR (scope_type='COUNTRY_OVERRIDE' AND country_code IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS app.product_accessory_relations (
  id text PRIMARY KEY,
  relation_key text NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  product_model_id text REFERENCES app.product_models(id) ON DELETE RESTRICT,
  product_sku_id text REFERENCES app.product_skus(id) ON DELETE RESTRICT,
  accessory_sku_code text NOT NULL,
  accessory_product_sku_id text REFERENCES app.product_skus(id) ON DELETE RESTRICT,
  country_code text,
  relation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_candidate_id text NOT NULL UNIQUE REFERENCES app.product_knowledge_candidates(id) ON DELETE RESTRICT,
  approval_status text NOT NULL DEFAULT 'APPROVED',
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (relation_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS app.customer_service_policy_versions (
  id text PRIMARY KEY,
  policy_key text NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  country_code text,
  category_name text,
  policy_json jsonb NOT NULL,
  source_candidate_id text NOT NULL UNIQUE REFERENCES app.product_knowledge_candidates(id) ON DELETE RESTRICT,
  approval_status text NOT NULL DEFAULT 'APPROVED',
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (policy_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS app.customer_service_playbook_versions (
  id text PRIMARY KEY,
  playbook_key text NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  intent_code text,
  country_code text,
  product_model_id text REFERENCES app.product_models(id) ON DELETE RESTRICT,
  playbook_json jsonb NOT NULL,
  source_candidate_id text NOT NULL UNIQUE REFERENCES app.product_knowledge_candidates(id) ON DELETE RESTRICT,
  approval_status text NOT NULL DEFAULT 'APPROVED',
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL,
  effective_from timestamptz,
  effective_until timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (playbook_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS app.product_knowledge_releases (
  id text PRIMARY KEY,
  release_key text NOT NULL,
  version_no integer NOT NULL CHECK (version_no >= 1),
  consumer_scope text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  content_digest text NOT NULL,
  notes text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  published_by text,
  published_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  retired_at timestamptz,
  UNIQUE (release_key, version_no),
  CHECK (consumer_scope IN ('CUSTOMER_SERVICE','LISTING','MARKETING','INTERNAL')),
  CHECK (status IN ('DRAFT','PUBLISHED','RETIRED'))
);

CREATE TABLE IF NOT EXISTS app.product_knowledge_release_items (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES app.product_knowledge_releases(id) ON DELETE RESTRICT,
  claim_id text NOT NULL REFERENCES app.product_knowledge_claims(id) ON DELETE RESTRICT,
  claim_content_digest text NOT NULL,
  rank_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  UNIQUE (release_id, claim_id)
);

CREATE TABLE IF NOT EXISTS app.product_accessory_release_items (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES app.product_knowledge_releases(id) ON DELETE RESTRICT,
  relation_id text NOT NULL REFERENCES app.product_accessory_relations(id) ON DELETE RESTRICT,
  relation_content_digest text NOT NULL,
  rank_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  UNIQUE (release_id, relation_id)
);

CREATE TABLE IF NOT EXISTS app.customer_service_policy_release_items (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES app.product_knowledge_releases(id) ON DELETE RESTRICT,
  policy_version_id text NOT NULL REFERENCES app.customer_service_policy_versions(id) ON DELETE RESTRICT,
  policy_content_digest text NOT NULL,
  rank_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  UNIQUE (release_id, policy_version_id)
);

CREATE TABLE IF NOT EXISTS app.customer_service_playbook_release_items (
  id text PRIMARY KEY,
  release_id text NOT NULL REFERENCES app.product_knowledge_releases(id) ON DELETE RESTRICT,
  playbook_version_id text NOT NULL REFERENCES app.customer_service_playbook_versions(id) ON DELETE RESTRICT,
  playbook_content_digest text NOT NULL,
  rank_no integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  UNIQUE (release_id, playbook_version_id)
);

CREATE INDEX IF NOT EXISTS idx_pk_import_candidates_review
  ON app.product_knowledge_candidates(candidate_status, target_domain, risk_level, created_at);
CREATE INDEX IF NOT EXISTS idx_pk_import_candidates_subject
  ON app.product_knowledge_candidates(product_model_id, product_sku_id, canonical_category_name);
CREATE INDEX IF NOT EXISTS idx_pk_claims_subject
  ON app.product_knowledge_claims(product_model_id, product_sku_id, category_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_pk_claim_scopes_resolver
  ON app.product_knowledge_claim_scopes(consumer_scope, country_code, language_code, visibility);
CREATE INDEX IF NOT EXISTS idx_pk_releases_resolver
  ON app.product_knowledge_releases(status, consumer_scope, effective_from, effective_until);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_claim
  ON app.product_knowledge_release_items(claim_id, release_id);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_accessory
  ON app.product_accessory_release_items(relation_id, release_id);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_policy
  ON app.customer_service_policy_release_items(policy_version_id, release_id);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_playbook
  ON app.customer_service_playbook_release_items(playbook_version_id, release_id);
