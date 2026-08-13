ALTER TABLE foundation_account_capabilities RENAME TO foundation_account_capabilities_legacy;

CREATE TABLE foundation_account_capabilities (
  account_id TEXT NOT NULL,
  capability_code TEXT NOT NULL CHECK (
    capability_code IN (
      'orders.read', 'inventory.read', 'images.read', 'listing.read', 'listing.write',
      'discount.read', 'discount.write'
    )
  ),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'requires_binding')),
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, capability_code),
  FOREIGN KEY (account_id) REFERENCES foundation_integration_accounts(id) ON DELETE CASCADE
);

INSERT INTO foundation_account_capabilities (
  account_id, capability_code, status, config_json, created_at, updated_at
)
SELECT account_id, capability_code, status, config_json, created_at, updated_at
FROM foundation_account_capabilities_legacy;

DROP TABLE foundation_account_capabilities_legacy;

CREATE INDEX idx_foundation_capabilities_lookup
  ON foundation_account_capabilities(capability_code, status, account_id);

CREATE TABLE shopee_discount_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  encrypted_warehouse_key_ciphertext TEXT,
  warehouse_key_reference TEXT,
  warehouse_key_hint TEXT,
  warehouse_key_updated_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    encrypted_warehouse_key_ciphertext IS NOT NULL
    OR warehouse_key_reference IS NOT NULL
    OR warehouse_key_hint IS NULL
  )
);

CREATE TABLE shopee_discount_plans (
  id TEXT PRIMARY KEY,
  foundation_plan_id TEXT,
  country TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'PREVIEWING' CHECK (
    state IN ('PREVIEWING','PREVIEWED','APPROVED','EXECUTING','PARTIAL_SUCCESS','SUCCEEDED','FAILED','BLOCKED','EXPIRED','CANCELLED')
  ),
  target_starts_at TEXT NOT NULL,
  target_ends_at TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  merkle_root TEXT,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  shard_count INTEGER NOT NULL DEFAULT 0 CHECK (shard_count >= 0),
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  reason_code TEXT,
  expires_at TEXT,
  sealed_at TEXT,
  approved_at TEXT,
  created_by TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (foundation_plan_id) REFERENCES foundation_operation_plans(id) ON DELETE RESTRICT,
  CHECK (target_ends_at > target_starts_at),
  CHECK (expires_at IS NULL OR expires_at > created_at),
  CHECK (
    state NOT IN ('PREVIEWED','APPROVED','EXECUTING','PARTIAL_SUCCESS','SUCCEEDED')
    OR (merkle_root IS NOT NULL AND length(trim(merkle_root)) > 0)
  )
);

CREATE INDEX idx_shopee_discount_plans_country_state_created
  ON shopee_discount_plans(country, state, created_at DESC, id);

CREATE TABLE shopee_discount_activities (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  activity_type TEXT NOT NULL DEFAULT 'TARGET_PRICE',
  platform_activity_id TEXT,
  target_starts_at TEXT NOT NULL,
  target_ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','ACTIVE','ENDED','CANCELLED')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT,
  UNIQUE (plan_id, shop_id),
  CHECK (target_ends_at > target_starts_at)
);

CREATE INDEX idx_shopee_discount_activities_shop_time
  ON shopee_discount_activities(shop_id, target_starts_at, target_ends_at, status, plan_id);

CREATE TABLE shopee_discount_plan_shards (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL CHECK (shard_index >= 0),
  shard_hash TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT,
  UNIQUE (plan_id, shard_index),
  UNIQUE (plan_id, shard_hash)
);

CREATE TABLE shopee_discount_plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  shard_index INTEGER NOT NULL CHECK (shard_index >= 0),
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
  shop_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  sku TEXT NOT NULL,
  currency TEXT NOT NULL,
  scale INTEGER NOT NULL CHECK (scale >= 0 AND scale <= 9),
  current_price_minor TEXT NOT NULL CHECK (
    current_price_minor = '0'
    OR (current_price_minor NOT GLOB '*[^0-9]*' AND substr(current_price_minor, 1, 1) BETWEEN '1' AND '9')
  ),
  control_price_minor TEXT CHECK (
    control_price_minor IS NULL OR control_price_minor = '0'
    OR (control_price_minor NOT GLOB '*[^0-9]*' AND substr(control_price_minor, 1, 1) BETWEEN '1' AND '9')
  ),
  target_price_minor TEXT NOT NULL CHECK (
    target_price_minor = '0'
    OR (target_price_minor NOT GLOB '*[^0-9]*' AND substr(target_price_minor, 1, 1) BETWEEN '1' AND '9')
  ),
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  execution_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    execution_status IN ('PENDING','SKIPPED_SAFETY','DISPATCHED','SUCCEEDED','UNKNOWN','FAILED','ABANDONED')
  ),
  execution_reason_code TEXT,
  retention_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (shard_id) REFERENCES shopee_discount_plan_shards(id) ON DELETE RESTRICT,
  UNIQUE (plan_id, item_key),
  UNIQUE (plan_id, sequence_no),
  CHECK (item_key = shop_id || char(31) || item_id || char(31) || model_id)
);

CREATE INDEX idx_shopee_discount_items_plan_shop_key
  ON shopee_discount_plan_items(plan_id, shop_id, item_key, sequence_no);
CREATE INDEX idx_shopee_discount_items_retention
  ON shopee_discount_plan_items(retention_until, plan_id);

CREATE TRIGGER shopee_discount_plan_shards_immutable_update
BEFORE UPDATE ON shopee_discount_plan_shards
BEGIN SELECT RAISE(ABORT, 'Shopee Discount plan shards are immutable'); END;

CREATE TRIGGER shopee_discount_plan_shards_immutable_delete
BEFORE DELETE ON shopee_discount_plan_shards
BEGIN SELECT RAISE(ABORT, 'Shopee Discount plan shards are immutable'); END;

CREATE TRIGGER shopee_discount_plan_items_payload_immutable
BEFORE UPDATE OF plan_id, shard_id, shard_index, sequence_no, shop_id, item_id, model_id, item_key,
  sku, currency, scale, current_price_minor, control_price_minor, target_price_minor, payload_hash, payload_json
ON shopee_discount_plan_items
BEGIN SELECT RAISE(ABORT, 'Shopee Discount plan item payload is immutable'); END;

CREATE TRIGGER shopee_discount_plan_items_immutable_delete
BEFORE DELETE ON shopee_discount_plan_items
BEGIN SELECT RAISE(ABORT, 'Shopee Discount plan items are immutable'); END;

CREATE TABLE shopee_discount_approvals (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL UNIQUE,
  merkle_root TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('human','system')),
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  approved_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT
);

CREATE TABLE shopee_discount_jobs (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  foundation_task_id TEXT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING','RUNNING','PARTIAL_SUCCESS','SUCCEEDED','FAILED','BLOCKED','CANCELLED')
  ),
  owner_id TEXT,
  fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
  lease_until TEXT,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  counters_json TEXT NOT NULL DEFAULT '{}',
  input_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  created_by TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (foundation_task_id) REFERENCES foundation_tasks(id) ON DELETE SET NULL
);

CREATE INDEX idx_shopee_discount_jobs_runnable_lease
  ON shopee_discount_jobs(status, lease_until, created_at, id);

CREATE TABLE shopee_discount_dispatch_intents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_item_id TEXT,
  operation_uuid TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK (
    status IN ('DISPATCHED','SUCCEEDED','UNKNOWN','LINK_VERIFIED_OBJECT','CONFIRMED_NOT_SENT','ABANDONED')
  ),
  platform_object_id TEXT,
  readback_json TEXT,
  evidence_json TEXT,
  reconciled_by TEXT,
  dispatched_at TEXT NOT NULL,
  completed_at TEXT,
  reconciled_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES shopee_discount_jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_item_id) REFERENCES shopee_discount_plan_items(id) ON DELETE RESTRICT,
  CHECK (
    length(operation_uuid) = 36
    AND substr(operation_uuid, 9, 1) = '-'
    AND substr(operation_uuid, 14, 1) = '-'
    AND substr(operation_uuid, 19, 1) = '-'
    AND substr(operation_uuid, 24, 1) = '-'
  )
);

CREATE INDEX idx_shopee_discount_intents_operation_status_age
  ON shopee_discount_dispatch_intents(operation_uuid, status, dispatched_at);
CREATE INDEX idx_shopee_discount_intents_unknown_age
  ON shopee_discount_dispatch_intents(status, updated_at, id);

CREATE TABLE shopee_discount_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  job_id TEXT,
  intent_id TEXT,
  event_type TEXT NOT NULL,
  actor_id TEXT,
  reason_code TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  retention_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (job_id) REFERENCES shopee_discount_jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES shopee_discount_dispatch_intents(id) ON DELETE RESTRICT
);

CREATE INDEX idx_shopee_discount_events_plan_time
  ON shopee_discount_events(plan_id, occurred_at DESC, id);
CREATE INDEX idx_shopee_discount_events_retention
  ON shopee_discount_events(retention_until, occurred_at);

CREATE TABLE shopee_discount_due_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CLAIMED','SUCCEEDED','FAILED','CANCELLED')),
  owner_id TEXT,
  fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
  lease_until TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_shopee_discount_due_jobs_claim
  ON shopee_discount_due_jobs(status, due_at, lease_until, id);

CREATE TABLE shopee_discount_notifications (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  notification_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  read_at TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES shopee_discount_plans(id) ON DELETE SET NULL
);

CREATE INDEX idx_shopee_discount_notifications_unread
  ON shopee_discount_notifications(read_at, created_at DESC, id);

INSERT INTO shopee_discount_settings (
  id, timezone, enabled, created_at, updated_at
)
VALUES (
  'default', 'Asia/Shanghai', 0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
