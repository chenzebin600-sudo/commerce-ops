-- migration: foreign_keys_off
PRAGMA foreign_keys = OFF;
PRAGMA legacy_alter_table = ON;

ALTER TABLE shopee_discount_dispatch_intents RENAME TO shopee_discount_dispatch_intents_legacy;

DROP INDEX uq_shopee_discount_intents_job_target;
DROP INDEX idx_shopee_discount_intents_operation_status_age;
DROP INDEX idx_shopee_discount_intents_unknown_age;

CREATE TABLE shopee_discount_dispatch_intents (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_item_id TEXT,
  operation_uuid TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL,
  target_key TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no >= 1),
  payload_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch >= 1),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DISPATCHED' CHECK (
    status IN ('DISPATCHED','SUCCEEDED','REJECTED','UNKNOWN','LINK_VERIFIED_OBJECT','CONFIRMED_NOT_SENT','ABANDONED')
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
  CHECK (length(operation_uuid)=36 AND substr(operation_uuid,9,1)='-' AND substr(operation_uuid,14,1)='-'
    AND substr(operation_uuid,19,1)='-' AND substr(operation_uuid,24,1)='-')
);

INSERT INTO shopee_discount_dispatch_intents (
 id,job_id,plan_id,plan_item_id,operation_uuid,target_type,target_key,attempt_no,payload_hash,epoch,owner_id,status,
 platform_object_id,readback_json,evidence_json,reconciled_by,dispatched_at,completed_at,reconciled_at,updated_at
) SELECT id,job_id,plan_id,plan_item_id,operation_uuid,target_type,target_key,1,payload_hash,epoch,owner_id,status,
 platform_object_id,readback_json,evidence_json,reconciled_by,dispatched_at,completed_at,reconciled_at,updated_at
 FROM shopee_discount_dispatch_intents_legacy;

DROP TABLE shopee_discount_dispatch_intents_legacy;

CREATE INDEX idx_shopee_discount_intents_operation_status_age
  ON shopee_discount_dispatch_intents(operation_uuid,status,dispatched_at);
CREATE INDEX idx_shopee_discount_intents_unknown_age
  ON shopee_discount_dispatch_intents(status,updated_at,id);
CREATE UNIQUE INDEX uq_shopee_discount_intents_job_target_attempt
  ON shopee_discount_dispatch_intents(job_id,target_type,target_key,attempt_no);
CREATE UNIQUE INDEX uq_shopee_discount_intents_active_target
  ON shopee_discount_dispatch_intents(job_id,target_type,target_key)
  WHERE status IN ('DISPATCHED','UNKNOWN');

PRAGMA legacy_alter_table = OFF;
PRAGMA foreign_keys = ON;
