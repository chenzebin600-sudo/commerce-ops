ALTER TABLE "app"."shopee_discount_notifications"
  ADD COLUMN "dedupe_key" text,
  ADD COLUMN "channel" text NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "delivery_status" text NOT NULL DEFAULT 'PENDING'
    CHECK ("delivery_status" IN ('PENDING','SENDING','RETRY_WAIT','DELIVERED','FAILED')),
  ADD COLUMN "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  ADD COLUMN "last_error_code" text,
  ADD COLUMN "delivered_at" timestamptz,
  ADD COLUMN "updated_at" timestamptz;

UPDATE "app"."shopee_discount_notifications"
SET "updated_at"="created_at"
WHERE "updated_at" IS NULL;

ALTER TABLE "app"."shopee_discount_notifications" ALTER COLUMN "updated_at" SET NOT NULL;

CREATE UNIQUE INDEX "uq_shopee_discount_notifications_dedupe"
  ON "app"."shopee_discount_notifications" ("dedupe_key")
  WHERE "dedupe_key" IS NOT NULL;

CREATE INDEX "idx_shopee_discount_notifications_delivery"
  ON "app"."shopee_discount_notifications" ("delivery_status","created_at","id");
