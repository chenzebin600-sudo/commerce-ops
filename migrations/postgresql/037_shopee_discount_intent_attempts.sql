ALTER TABLE "app"."shopee_discount_dispatch_intents"
  ADD COLUMN "attempt_no" bigint NOT NULL DEFAULT 1 CHECK ("attempt_no" >= 1);

ALTER TABLE "app"."shopee_discount_dispatch_intents"
  DROP CONSTRAINT IF EXISTS "shopee_discount_dispatch_intents_status_check";
ALTER TABLE "app"."shopee_discount_dispatch_intents"
  ADD CONSTRAINT "shopee_discount_dispatch_intents_status_check" CHECK (
    "status" IN ('DISPATCHED','SUCCEEDED','REJECTED','UNKNOWN','LINK_VERIFIED_OBJECT','CONFIRMED_NOT_SENT','ABANDONED')
  );

DROP INDEX IF EXISTS "app"."uq_shopee_discount_intents_job_target";
CREATE UNIQUE INDEX "uq_shopee_discount_intents_job_target_attempt"
  ON "app"."shopee_discount_dispatch_intents" ("job_id","target_type","target_key","attempt_no");
CREATE UNIQUE INDEX "uq_shopee_discount_intents_active_target"
  ON "app"."shopee_discount_dispatch_intents" ("job_id","target_type","target_key")
  WHERE "status" IN ('DISPATCHED','UNKNOWN');
