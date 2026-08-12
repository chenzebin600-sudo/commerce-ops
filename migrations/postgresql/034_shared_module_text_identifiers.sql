-- Preserve opaque business and platform identifiers as text.
-- The shared module tables are still empty when this compatibility migration runs.

ALTER TABLE "app"."advertising_performance_facts" ALTER COLUMN "product_id" TYPE text USING "product_id"::text;
ALTER TABLE "app"."advertising_target_policies" ALTER COLUMN "product_id" TYPE text USING "product_id"::text;
ALTER TABLE "app"."foundation_operation_plan_events" ALTER COLUMN "actor_id" TYPE text USING "actor_id"::text;
ALTER TABLE "app"."shopee_health_issues" ALTER COLUMN "reference_id" TYPE text USING "reference_id"::text;
ALTER TABLE "app"."shopee_health_appeals" ALTER COLUMN "assignee_user_id" TYPE text USING "assignee_user_id"::text;
ALTER TABLE "app"."shopee_health_appeal_events" ALTER COLUMN "actor_user_id" TYPE text USING "actor_user_id"::text;
