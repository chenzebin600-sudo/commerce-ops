CREATE TABLE "app"."shopee_discount_execution_items" (
  "job_id" text NOT NULL,
  "plan_item_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK (
    "status" IN ('PENDING','DISPATCHED','SUCCEEDED','REJECTED','CONFLICT','AUTH_BLOCKED','UNKNOWN','REQUIRES_REAPPROVAL','SKIPPED')
  ),
  "reason_code" text,
  "intent_id" text,
  "platform_object_id" text,
  "readback_json" jsonb,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("job_id", "plan_item_id"),
  FOREIGN KEY ("job_id") REFERENCES "app"."shopee_discount_jobs"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("plan_item_id") REFERENCES "app"."shopee_discount_plan_items"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("intent_id") REFERENCES "app"."shopee_discount_dispatch_intents"("id") ON DELETE RESTRICT
);

CREATE INDEX "idx_shopee_discount_execution_items_job_status"
  ON "app"."shopee_discount_execution_items" ("job_id", "status", "plan_item_id");

CREATE UNIQUE INDEX "uq_shopee_discount_intents_job_target"
  ON "app"."shopee_discount_dispatch_intents" ("job_id", "target_type", "target_key");
