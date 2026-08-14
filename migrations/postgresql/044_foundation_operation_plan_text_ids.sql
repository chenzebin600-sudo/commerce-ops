-- Foundation operation plans are addressed by stable domain identifiers
-- (for example shopee-discount-<hash>) rather than only UUIDs.  Earlier
-- PostgreSQL bootstrap migrations used uuid for operation plan IDs and event
-- actors, which works for UUID-shaped legacy rows but blocks production
-- Shopee Discount previews from binding human approval plans.  Widen these
-- columns to text while preserving existing UUID values as their canonical
-- string representation.

ALTER TABLE "app"."shopee_discount_plans"
  DROP CONSTRAINT IF EXISTS "shopee_discount_plans_foundation_plan_fk";

ALTER TABLE "app"."foundation_operation_plan_events"
  DROP CONSTRAINT IF EXISTS "foundation_operation_plan_events_plan_id_fkey";

ALTER TABLE "app"."foundation_operation_plan_events"
  DROP CONSTRAINT IF EXISTS "foundation_operation_plan_events_plan_id_plan_version_key";

ALTER TABLE "app"."foundation_operation_plan_events"
  DROP CONSTRAINT IF EXISTS "foundation_operation_plan_events_plan_id_idempotency_key_key";

ALTER TABLE "app"."foundation_operation_plans"
  ALTER COLUMN "id" TYPE text USING "id"::text;

ALTER TABLE "app"."foundation_operation_plan_events"
  ALTER COLUMN "plan_id" TYPE text USING "plan_id"::text,
  ALTER COLUMN "actor_id" TYPE text USING "actor_id"::text;

ALTER TABLE "app"."shopee_discount_plans"
  ALTER COLUMN "foundation_plan_id" TYPE text USING "foundation_plan_id"::text;

ALTER TABLE "app"."foundation_operation_plan_events"
  ADD CONSTRAINT "foundation_operation_plan_events_plan_id_fkey"
  FOREIGN KEY ("plan_id")
  REFERENCES "app"."foundation_operation_plans" ("id")
  ON DELETE CASCADE;

ALTER TABLE "app"."foundation_operation_plan_events"
  ADD CONSTRAINT "foundation_operation_plan_events_plan_id_plan_version_key"
  UNIQUE ("plan_id", "plan_version");

ALTER TABLE "app"."foundation_operation_plan_events"
  ADD CONSTRAINT "foundation_operation_plan_events_plan_id_idempotency_key_key"
  UNIQUE ("plan_id", "idempotency_key");

ALTER TABLE "app"."shopee_discount_plans"
  ADD CONSTRAINT "shopee_discount_plans_foundation_plan_fk"
  FOREIGN KEY ("foundation_plan_id")
  REFERENCES "app"."foundation_operation_plans" ("id")
  ON DELETE RESTRICT
  NOT VALID;
