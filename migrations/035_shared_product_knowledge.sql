PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS product_knowledge_import_batches (
  id TEXT PRIMARY KEY,
  contract_version TEXT NOT NULL,
  package_digest TEXT NOT NULL UNIQUE,
  package_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'IMPORTING',
  declared_counts_json TEXT NOT NULL DEFAULT '{}',
  imported_counts_json TEXT NOT NULL DEFAULT '{}',
  source_manifest_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (status IN ('IMPORTING','IMPORTED','FAILED','REJECTED'))
);

CREATE TABLE IF NOT EXISTS product_knowledge_candidates (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  candidate_status TEXT NOT NULL,
  mapping_status TEXT,
  risk_level TEXT NOT NULL DEFAULT 'NORMAL',
  conflict_status TEXT NOT NULL DEFAULT 'UNCHECKED',
  canonical_category_name TEXT,
  product_model_id TEXT,
  product_sku_id TEXT,
  source_sku TEXT,
  language_code TEXT,
  scope_type TEXT NOT NULL DEFAULT 'UNVERIFIED',
  country_scope_json TEXT NOT NULL DEFAULT '[]',
  consumer_scopes_json TEXT NOT NULL DEFAULT '[]',
  subject_json TEXT NOT NULL DEFAULT '{}',
  content_json TEXT NOT NULL DEFAULT '{}',
  scope_json TEXT NOT NULL DEFAULT '{}',
  governance_json TEXT NOT NULL DEFAULT '{}',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  source_id TEXT,
  source_sha256 TEXT,
  source_sheet TEXT,
  source_location TEXT,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (import_batch_id) REFERENCES product_knowledge_import_batches(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_model_id) REFERENCES product_models(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
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

CREATE TABLE IF NOT EXISTS product_knowledge_reviews (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_roles_json TEXT NOT NULL DEFAULT '[]',
  reason_code TEXT,
  comment TEXT,
  candidate_content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (candidate_id) REFERENCES product_knowledge_candidates(id) ON DELETE RESTRICT,
  CHECK (action IN ('APPROVE','REJECT','RETURN_FOR_MAPPING','RETURN_FOR_SOURCE','RETURN_FOR_CONFLICT'))
);

CREATE TABLE IF NOT EXISTS product_knowledge_claims (
  id TEXT PRIMARY KEY,
  claim_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  claim_type TEXT NOT NULL,
  title TEXT,
  text_content TEXT NOT NULL,
  structured_json TEXT NOT NULL DEFAULT '{}',
  product_model_id TEXT,
  product_sku_id TEXT,
  category_id TEXT,
  source_candidate_id TEXT NOT NULL UNIQUE,
  source_content_digest TEXT NOT NULL,
  approval_status TEXT NOT NULL DEFAULT 'APPROVED',
  risk_level TEXT NOT NULL DEFAULT 'NORMAL',
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_model_id) REFERENCES product_models(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id) REFERENCES product_categories(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_candidate_id) REFERENCES product_knowledge_candidates(id) ON DELETE RESTRICT,
  UNIQUE (claim_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN')),
  CHECK (risk_level IN ('NORMAL','SENSITIVE','HIGH'))
);

CREATE TABLE IF NOT EXISTS product_knowledge_claim_scopes (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  country_code TEXT,
  language_code TEXT NOT NULL,
  consumer_scope TEXT NOT NULL,
  visibility TEXT NOT NULL,
  effective_from TEXT,
  effective_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (claim_id) REFERENCES product_knowledge_claims(id) ON DELETE RESTRICT,
  UNIQUE (claim_id, country_code, language_code, consumer_scope, visibility),
  CHECK (scope_type IN ('COMMON','COUNTRY_OVERRIDE')),
  CHECK (consumer_scope IN ('CUSTOMER_SERVICE','LISTING','MARKETING','INTERNAL')),
  CHECK (visibility IN ('CUSTOMER_VISIBLE','CUSTOMER_VISIBLE_AFTER_POLICY_VALIDATION','INTERNAL_ONLY')),
  CHECK (
    (scope_type='COMMON' AND country_code IS NULL)
    OR (scope_type='COUNTRY_OVERRIDE' AND country_code IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS product_accessory_relations (
  id TEXT PRIMARY KEY,
  relation_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  product_model_id TEXT,
  product_sku_id TEXT,
  accessory_sku_code TEXT NOT NULL,
  accessory_product_sku_id TEXT,
  country_code TEXT,
  relation_json TEXT NOT NULL DEFAULT '{}',
  source_candidate_id TEXT NOT NULL UNIQUE,
  approval_status TEXT NOT NULL DEFAULT 'APPROVED',
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_model_id) REFERENCES product_models(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (accessory_product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_candidate_id) REFERENCES product_knowledge_candidates(id) ON DELETE RESTRICT,
  UNIQUE (relation_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS customer_service_policy_versions (
  id TEXT PRIMARY KEY,
  policy_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  country_code TEXT,
  category_name TEXT,
  policy_json TEXT NOT NULL,
  source_candidate_id TEXT NOT NULL UNIQUE,
  approval_status TEXT NOT NULL DEFAULT 'APPROVED',
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  effective_from TEXT,
  effective_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_candidate_id) REFERENCES product_knowledge_candidates(id) ON DELETE RESTRICT,
  UNIQUE (policy_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS customer_service_playbook_versions (
  id TEXT PRIMARY KEY,
  playbook_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  intent_code TEXT,
  country_code TEXT,
  product_model_id TEXT,
  playbook_json TEXT NOT NULL,
  source_candidate_id TEXT NOT NULL UNIQUE,
  approval_status TEXT NOT NULL DEFAULT 'APPROVED',
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  effective_from TEXT,
  effective_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (product_model_id) REFERENCES product_models(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_candidate_id) REFERENCES product_knowledge_candidates(id) ON DELETE RESTRICT,
  UNIQUE (playbook_key, version_no),
  CHECK (approval_status IN ('APPROVED','WITHDRAWN'))
);

CREATE TABLE IF NOT EXISTS product_knowledge_releases (
  id TEXT PRIMARY KEY,
  release_key TEXT NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  consumer_scope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  content_digest TEXT NOT NULL,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT,
  effective_from TEXT,
  effective_until TEXT,
  retired_at TEXT,
  UNIQUE (release_key, version_no),
  CHECK (consumer_scope IN ('CUSTOMER_SERVICE','LISTING','MARKETING','INTERNAL')),
  CHECK (status IN ('DRAFT','PUBLISHED','RETIRED'))
);

CREATE TABLE IF NOT EXISTS product_knowledge_release_items (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claim_content_digest TEXT NOT NULL,
  rank_no INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (release_id) REFERENCES product_knowledge_releases(id) ON DELETE RESTRICT,
  FOREIGN KEY (claim_id) REFERENCES product_knowledge_claims(id) ON DELETE RESTRICT,
  UNIQUE (release_id, claim_id)
);

CREATE TABLE IF NOT EXISTS product_accessory_release_items (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  relation_content_digest TEXT NOT NULL,
  rank_no INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (release_id) REFERENCES product_knowledge_releases(id) ON DELETE RESTRICT,
  FOREIGN KEY (relation_id) REFERENCES product_accessory_relations(id) ON DELETE RESTRICT,
  UNIQUE (release_id, relation_id)
);

CREATE TABLE IF NOT EXISTS customer_service_policy_release_items (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  policy_content_digest TEXT NOT NULL,
  rank_no INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (release_id) REFERENCES product_knowledge_releases(id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_version_id) REFERENCES customer_service_policy_versions(id) ON DELETE RESTRICT,
  UNIQUE (release_id, policy_version_id)
);

CREATE TABLE IF NOT EXISTS customer_service_playbook_release_items (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  playbook_version_id TEXT NOT NULL,
  playbook_content_digest TEXT NOT NULL,
  rank_no INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (release_id) REFERENCES product_knowledge_releases(id) ON DELETE RESTRICT,
  FOREIGN KEY (playbook_version_id) REFERENCES customer_service_playbook_versions(id) ON DELETE RESTRICT,
  UNIQUE (release_id, playbook_version_id)
);

CREATE INDEX IF NOT EXISTS idx_pk_import_candidates_review
  ON product_knowledge_candidates(candidate_status, target_domain, risk_level, created_at);
CREATE INDEX IF NOT EXISTS idx_pk_import_candidates_subject
  ON product_knowledge_candidates(product_model_id, product_sku_id, canonical_category_name);
CREATE INDEX IF NOT EXISTS idx_pk_claims_subject
  ON product_knowledge_claims(product_model_id, product_sku_id, category_id, approval_status);
CREATE INDEX IF NOT EXISTS idx_pk_claim_scopes_resolver
  ON product_knowledge_claim_scopes(consumer_scope, country_code, language_code, visibility);
CREATE INDEX IF NOT EXISTS idx_pk_releases_resolver
  ON product_knowledge_releases(status, consumer_scope, effective_from, effective_until);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_claim
  ON product_knowledge_release_items(claim_id, release_id);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_accessory
  ON product_accessory_release_items(relation_id, release_id);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_policy
  ON customer_service_policy_release_items(policy_version_id, release_id);
CREATE INDEX IF NOT EXISTS idx_pk_release_items_playbook
  ON customer_service_playbook_release_items(playbook_version_id, release_id);
