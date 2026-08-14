ALTER TABLE "app"."shopee_discount_plans" ADD COLUMN "preview_owner_token" text;
ALTER TABLE "app"."shopee_discount_plans" ADD COLUMN "preview_owner_epoch" bigint NOT NULL DEFAULT 0 CHECK ("preview_owner_epoch" >= 0);
ALTER TABLE "app"."shopee_discount_plans" ADD COLUMN "preview_owner_lease_until" timestamptz;
ALTER TABLE "app"."shopee_discount_plan_shards" ADD COLUMN "content_hash" text;

UPDATE "app"."shopee_discount_plans" SET
  "preview_owner_token"="summary_json"->>'previewOwnerToken',
  "preview_owner_epoch"=COALESCE(("summary_json"->>'previewOwnerEpoch')::bigint,
    CASE WHEN "summary_json"->>'previewOwnerToken' IS NULL THEN 0 ELSE 1 END),
  "preview_owner_lease_until"=NULLIF("summary_json"->>'previewOwnerLeaseUntil','')::timestamptz;

CREATE INDEX "idx_shopee_discount_preview_owner_lease"
  ON "app"."shopee_discount_plans" ("state","preview_owner_lease_until","id")
  WHERE "state"='PREVIEWING';
