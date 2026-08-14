ALTER TABLE "app"."shopee_discount_settings"
  ADD COLUMN IF NOT EXISTS "credential_generation" BIGINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_shopee_discount_intents_unknown_page"
  ON "app"."shopee_discount_dispatch_intents" ("status", "dispatched_at", "id");
