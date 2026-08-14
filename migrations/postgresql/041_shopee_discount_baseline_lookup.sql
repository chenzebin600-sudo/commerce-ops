ALTER TABLE "app"."shopee_discount_events" ADD COLUMN "baseline_country" text;
ALTER TABLE "app"."shopee_discount_events" ADD COLUMN "baseline_category" text;
ALTER TABLE "app"."shopee_discount_events" ADD COLUMN "baseline_shop_id" text;
ALTER TABLE "app"."shopee_discount_events" ADD COLUMN "baseline_tier" text;

UPDATE "app"."shopee_discount_events"
SET "baseline_country"="evidence_json"->'scope'->>'country',
    "baseline_category"="evidence_json"->'scope'->>'category',
    "baseline_shop_id"="evidence_json"->'scope'->>'shopId',
    "baseline_tier"="evidence_json"->'scope'->>'tier'
WHERE "event_type"='WAREHOUSE_BASELINE';

CREATE INDEX "idx_shopee_discount_events_baseline_scope"
  ON "app"."shopee_discount_events" ("event_type","baseline_country","baseline_category","baseline_shop_id","baseline_tier","occurred_at" DESC,"id" DESC)
  WHERE "event_type"='WAREHOUSE_BASELINE';
