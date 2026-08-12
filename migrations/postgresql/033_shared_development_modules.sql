-- Additive bridge for the established Commerce Ops database on host C.
-- This migration creates only modules absent from the legacy PostgreSQL history.

CREATE TABLE "app"."advertising_source_batches" (
  "id" uuid PRIMARY KEY,
  "platform" text NOT NULL CHECK (platform = 'shopee'),
  "report_type" text NOT NULL CHECK (report_type = 'overall'),
  "shop_id" text NOT NULL,
  "shop_name" text NOT NULL,
  "account_name" text,
  "original_filename" text NOT NULL,
  "report_created_at" timestamptz,
  "period_from" text NOT NULL,
  "period_to" text NOT NULL,
  "period_days" integer NOT NULL CHECK (period_days >= 1),
  "row_count" integer NOT NULL CHECK (row_count >= 0),
  "raw_sha256" text NOT NULL UNIQUE,
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "imported_by" text NOT NULL,
  "imported_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL
);

CREATE TABLE "app"."advertising_performance_facts" (
  "id" uuid PRIMARY KEY,
  "batch_id" uuid NOT NULL REFERENCES "app"."advertising_source_batches" ("id") ON DELETE CASCADE,
  "sequence_no" integer NOT NULL,
  "shop_id" text NOT NULL,
  "ad_key" text NOT NULL,
  "ad_name" text NOT NULL,
  "ad_status" text NOT NULL,
  "ad_type" text,
  "product_id" uuid,
  "bidding_method" text,
  "placement" text,
  "impression" double precision NOT NULL DEFAULT 0,
  "clicks" double precision NOT NULL DEFAULT 0,
  "add_to_cart" double precision NOT NULL DEFAULT 0,
  "conversions" double precision NOT NULL DEFAULT 0,
  "items_sold" double precision NOT NULL DEFAULT 0,
  "gmv" double precision NOT NULL DEFAULT 0,
  "expense" double precision NOT NULL DEFAULT 0,
  "roas" double precision NOT NULL DEFAULT 0,
  "direct_roas" double precision NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL,
  "start_date" date,
  UNIQUE ("batch_id", "sequence_no")
);

CREATE TABLE "app"."advertising_target_policies" (
  "id" uuid PRIMARY KEY,
  "shop_id" text NOT NULL,
  "target_key" text NOT NULL,
  "product_id" uuid,
  "ad_name" text NOT NULL,
  "target_roas" double precision NOT NULL CHECK (target_roas > 0),
  "source_type" text NOT NULL CHECK (source_type IN ('manual', 'screenshot', 'import')),
  "effective_from" text NOT NULL,
  "effective_to" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("shop_id", "target_key", "effective_from"),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE "app"."foundation_operation_plans" (
  "id" uuid PRIMARY KEY,
  "task_id" text REFERENCES "app"."foundation_tasks" ("id") ON DELETE SET NULL,
  "operation_type" text NOT NULL,
  "state" text NOT NULL CHECK (state IN ('PREVIEWED','APPROVED','IN_FLIGHT','SUCCEEDED','FAILED','UNKNOWN','EXPIRED','BLOCKED','CANCELLED')),
  "approval_mode" text NOT NULL CHECK (approval_mode IN ('human', 'system')),
  "scope_hash" text NOT NULL,
  "source_snapshot_hash" text NOT NULL,
  "policy_hash" text NOT NULL,
  "items_hash" text NOT NULL,
  "approval_text_hash" text,
  "plan_hash" text NOT NULL UNIQUE,
  "scope_json" jsonb NOT NULL,
  "source_snapshot_json" jsonb NOT NULL,
  "policy_json" jsonb NOT NULL,
  "items_json" jsonb NOT NULL,
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "approved_by" text,
  "approved_at" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error_code" text,
  "last_error_message" text,
  "state_version" integer NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE "app"."foundation_operation_plan_events" (
  "id" uuid PRIMARY KEY,
  "plan_id" uuid NOT NULL REFERENCES "app"."foundation_operation_plans" ("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "actor_type" text NOT NULL CHECK (actor_type IN ('user', 'system')),
  "actor_id" uuid NOT NULL,
  "reason_code" text,
  "message" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key" text NOT NULL,
  "plan_version" integer NOT NULL CHECK (plan_version >= 1),
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  UNIQUE ("plan_id", "plan_version"),
  UNIQUE ("plan_id", "idempotency_key")
);

CREATE TABLE "app"."shopee_health_runs" (
  "id" uuid PRIMARY KEY,
  "trigger_type" text NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
  "scheduled_for" text,
  "status" text NOT NULL CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed')),
  "attempt_count" integer NOT NULL DEFAULT 0,
  "shop_total" integer NOT NULL DEFAULT 0,
  "shop_success" integer NOT NULL DEFAULT 0,
  "shop_failed" integer NOT NULL DEFAULT 0,
  "warning_count" integer NOT NULL DEFAULT 0,
  "critical_count" integer NOT NULL DEFAULT 0,
  "error_message" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE TABLE "app"."shopee_health_issues" (
  "id" uuid PRIMARY KEY,
  "fingerprint" text NOT NULL UNIQUE,
  "shop_id" text NOT NULL,
  "shop_code" text NOT NULL,
  "shop_name" text NOT NULL,
  "country" text NOT NULL,
  "issue_type" text NOT NULL,
  "severity" text NOT NULL CHECK (severity IN ('warning', 'critical')),
  "title" text NOT NULL,
  "reason" text,
  "reference_id" uuid,
  "metric_id" integer,
  "current_value" double precision,
  "target_value" double precision,
  "comparator" text,
  "details_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_seen_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  "resolved_at" timestamptz,
  "status" text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_appeal', 'resolved')),
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE TABLE "app"."shopee_health_appeals" (
  "id" uuid PRIMARY KEY,
  "issue_id" uuid NOT NULL UNIQUE REFERENCES "app"."shopee_health_issues" ("id") ON DELETE RESTRICT,
  "shop_id" text NOT NULL,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','preparing','submitted','waiting_result','approved','rejected','closed')),
  "assignee_user_id" uuid,
  "assignee_name" text,
  "due_date" date,
  "seller_center_reference" text,
  "evidence_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "notes" text,
  "resolution" text,
  "created_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "submitted_at" timestamptz,
  "resolved_at" timestamptz
);

CREATE TABLE "app"."shopee_health_appeal_events" (
  "id" uuid PRIMARY KEY,
  "appeal_id" uuid NOT NULL REFERENCES "app"."shopee_health_appeals" ("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "note" text,
  "actor_user_id" uuid,
  "actor_name" text,
  "created_at" timestamptz NOT NULL
);

CREATE TABLE "app"."shopee_health_notifications" (
  "id" uuid PRIMARY KEY,
  "notification_type" text NOT NULL,
  "severity" text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  "title" text NOT NULL,
  "message" text NOT NULL,
  "shop_id" text,
  "issue_id" uuid REFERENCES "app"."shopee_health_issues" ("id") ON DELETE SET NULL,
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL
);

CREATE TABLE "app"."shopee_health_settings" (
  "id" text PRIMARY KEY CHECK (id = 'default'),
  "encrypted_token_key" text,
  "token_hint" text,
  "token_verified_at" timestamptz,
  "token_shop_count" integer NOT NULL DEFAULT 0,
  "schedule_time" text NOT NULL DEFAULT '09:00',
  "timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
  "retry_count" integer NOT NULL DEFAULT 3 CHECK (retry_count BETWEEN 0 AND 5),
  "warning_ratio" double precision NOT NULL DEFAULT 0.10 CHECK (warning_ratio >= 0 AND warning_ratio <= 1),
  "dingtalk_config_id" text REFERENCES "app"."dingtalk_robot_configs" ("id") ON DELETE SET NULL,
  "site_notifications_enabled" boolean NOT NULL DEFAULT TRUE,
  "dingtalk_notifications_enabled" boolean NOT NULL DEFAULT FALSE,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "last_key_error" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE TABLE "app"."shopee_health_snapshots" (
  "id" uuid PRIMARY KEY,
  "run_id" uuid NOT NULL REFERENCES "app"."shopee_health_runs" ("id") ON DELETE CASCADE,
  "snapshot_date" date NOT NULL,
  "shop_id" text NOT NULL,
  "shop_code" text NOT NULL,
  "shop_name" text NOT NULL,
  "country" text NOT NULL,
  "status" text NOT NULL CHECK (status IN ('healthy', 'warning', 'critical', 'unavailable')),
  "overall_rating" integer,
  "fulfillment_failed" integer NOT NULL DEFAULT 0,
  "listing_failed" integer NOT NULL DEFAULT 0,
  "customer_service_failed" integer NOT NULL DEFAULT 0,
  "warning_count" integer NOT NULL DEFAULT 0,
  "critical_count" integer NOT NULL DEFAULT 0,
  "penalty_points" integer NOT NULL DEFAULT 0,
  "ongoing_punishments" integer NOT NULL DEFAULT 0,
  "issue_listing_count" integer NOT NULL DEFAULT 0,
  "late_order_count" integer NOT NULL DEFAULT 0,
  "metrics_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "collected_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("snapshot_date", "shop_id")
);

CREATE TABLE "app"."shopee_health_thresholds" (
  "metric_id" integer PRIMARY KEY,
  "metric_name" text NOT NULL,
  "warning_value" double precision,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "updated_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE INDEX "idx_advertising_performance_facts_start_date" ON "app"."advertising_performance_facts" ("shop_id", "start_date", "ad_key");
CREATE INDEX "idx_advertising_performance_facts_identity" ON "app"."advertising_performance_facts" ("shop_id", "product_id", "ad_name");
CREATE INDEX "idx_advertising_performance_facts_batch" ON "app"."advertising_performance_facts" ("batch_id", "expense" DESC);
CREATE INDEX "idx_advertising_source_batches_shop_period" ON "app"."advertising_source_batches" ("shop_id", "period_to" DESC, "period_days", "imported_at" DESC);
CREATE INDEX "idx_advertising_target_policies_active" ON "app"."advertising_target_policies" ("shop_id", "target_key", "effective_from" DESC, "effective_to");
CREATE INDEX "idx_foundation_operation_plan_events_history" ON "app"."foundation_operation_plan_events" ("plan_id", "plan_version" DESC);
CREATE INDEX "idx_foundation_operation_plans_type" ON "app"."foundation_operation_plans" ("operation_type", "state", "created_at" DESC);
CREATE INDEX "idx_foundation_operation_plans_task" ON "app"."foundation_operation_plans" ("task_id", "created_at" DESC);
CREATE INDEX "idx_foundation_operation_plans_state" ON "app"."foundation_operation_plans" ("state", "expires_at", "updated_at" DESC);
CREATE INDEX "idx_shopee_health_appeal_events" ON "app"."shopee_health_appeal_events" ("appeal_id", "created_at" DESC);
CREATE INDEX "idx_shopee_health_appeals_status_assignee" ON "app"."shopee_health_appeals" ("status", "assignee_user_id", "due_date");
CREATE INDEX "idx_shopee_health_issues_shop" ON "app"."shopee_health_issues" ("shop_id", "status", "last_seen_at" DESC);
CREATE INDEX "idx_shopee_health_issues_active" ON "app"."shopee_health_issues" ("status", "severity", "last_seen_at" DESC);
CREATE INDEX "idx_shopee_health_notifications_unread" ON "app"."shopee_health_notifications" ("read_at", "created_at" DESC);
CREATE INDEX "idx_shopee_health_runs_created" ON "app"."shopee_health_runs" ("created_at" DESC);
CREATE INDEX "idx_shopee_health_snapshots_date_status" ON "app"."shopee_health_snapshots" ("snapshot_date" DESC, "status");
CREATE INDEX "idx_shopee_health_snapshots_shop_date" ON "app"."shopee_health_snapshots" ("shop_id", "snapshot_date" DESC);
