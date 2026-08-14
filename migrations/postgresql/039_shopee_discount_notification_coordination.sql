ALTER TABLE "app"."shopee_discount_notifications"
  ADD COLUMN "delivery_lease_until" timestamptz,
  ADD COLUMN "coordination_state" text CHECK ("coordination_state" IS NULL OR "coordination_state"='UNKNOWN'),
  ADD COLUMN "coordination_evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX "idx_shopee_discount_notifications_sending_lease"
  ON "app"."shopee_discount_notifications" ("delivery_status","delivery_lease_until","id");
