ALTER TABLE "app"."shopee_discount_notifications"
  ADD COLUMN "delivery_lease_until" timestamptz,
  ADD COLUMN "coordination_state" text CHECK ("coordination_state" IS NULL OR "coordination_state"='UNKNOWN'),
  ADD COLUMN "coordination_evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE "app"."shopee_discount_notifications"
SET "delivery_status"='FAILED', "coordination_state"='UNKNOWN',
    "last_error_code"='DINGTALK_DELIVERY_UPGRADE_UNKNOWN',
    "coordination_evidence_json"='{"source":"migration-039","reason":"legacy-sending-outcome-unknown"}'::jsonb,
    "delivery_lease_until"=NULL
WHERE "delivery_status"='SENDING' AND "delivery_lease_until" IS NULL;

CREATE INDEX "idx_shopee_discount_notifications_sending_lease"
  ON "app"."shopee_discount_notifications" ("delivery_status","delivery_lease_until","id");
