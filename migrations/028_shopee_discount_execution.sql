CREATE TABLE shopee_discount_execution_items (
  job_id TEXT NOT NULL,
  plan_item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING','DISPATCHED','SUCCEEDED','REJECTED','CONFLICT','AUTH_BLOCKED','UNKNOWN','REQUIRES_REAPPROVAL','SKIPPED')
  ),
  reason_code TEXT,
  intent_id TEXT,
  platform_object_id TEXT,
  readback_json TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, plan_item_id),
  FOREIGN KEY (job_id) REFERENCES shopee_discount_jobs(id) ON DELETE RESTRICT,
  FOREIGN KEY (plan_item_id) REFERENCES shopee_discount_plan_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES shopee_discount_dispatch_intents(id) ON DELETE RESTRICT
);

CREATE INDEX idx_shopee_discount_execution_items_job_status
  ON shopee_discount_execution_items(job_id, status, plan_item_id);

CREATE UNIQUE INDEX uq_shopee_discount_intents_job_target
  ON shopee_discount_dispatch_intents(job_id, target_type, target_key);
