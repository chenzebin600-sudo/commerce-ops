-- Generated from a consistent SQLite snapshot. Schema only; no business rows.
-- The PostgreSQL migration runner owns app.schema_migrations.
-- Tables: 94; columns: 1629; source rows inspected: 1791.
CREATE TABLE "app"."advertising_performance_facts" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
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
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "sequence_no")
);

CREATE TABLE "app"."advertising_source_batches" (
  "id" uuid,
  "platform" text NOT NULL,
  "report_type" text NOT NULL,
  "shop_id" text NOT NULL,
  "shop_name" text NOT NULL,
  "account_name" text,
  "original_filename" text NOT NULL,
  "report_created_at" timestamptz,
  "period_from" text NOT NULL,
  "period_to" text NOT NULL,
  "period_days" integer NOT NULL,
  "row_count" integer NOT NULL,
  "raw_sha256" text NOT NULL,
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "imported_by" text NOT NULL,
  "imported_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("raw_sha256"),
  CHECK (platform = 'shopee'),
  CHECK (report_type = 'overall'),
  CHECK (period_days >= 1),
  CHECK (row_count >= 0)
);

CREATE TABLE "app"."advertising_target_policies" (
  "id" uuid,
  "shop_id" text NOT NULL,
  "target_key" text NOT NULL,
  "product_id" uuid,
  "ad_name" text NOT NULL,
  "target_roas" double precision NOT NULL,
  "source_type" text NOT NULL,
  "effective_from" text NOT NULL,
  "effective_to" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("shop_id", "target_key", "effective_from"),
  CHECK (target_roas > 0),
  CHECK (source_type IN ('manual', 'screenshot', 'import')),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE "app"."dingtalk_robot_configs" (
  "id" uuid,
  "name" text NOT NULL,
  "encrypted_webhook_url" text NOT NULL,
  "encrypted_secret" text,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "notify_on_success" boolean NOT NULL DEFAULT TRUE,
  "notify_on_failure" boolean NOT NULL DEFAULT TRUE,
  "notify_on_empty" boolean NOT NULL DEFAULT TRUE,
  "at_all" boolean NOT NULL DEFAULT FALSE,
  "at_mobiles_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "app"."export_files" (
  "id" uuid,
  "file_type" text NOT NULL DEFAULT 'excel',
  "source_type" text NOT NULL,
  "task_id" uuid,
  "run_id" uuid,
  "request_key" text,
  "original_filename" text NOT NULL,
  "storage_filename" text NOT NULL,
  "relative_path" text NOT NULL,
  "mime_type" text NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  "file_size" bigint NOT NULL DEFAULT 0,
  "file_hash" text,
  "status" text NOT NULL DEFAULT 'available',
  "expires_at" timestamptz,
  "missing_at" timestamptz,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("relative_path"),
  UNIQUE ("run_id"),
  CHECK (file_type IN ('excel')),
  CHECK (source_type IN (
      'mabang_manual_order',
      'mabang_manual_inventory',
      'mabang_scheduled_order',
      'mabang_scheduled_inventory'
    )),
  CHECK (file_size >= 0),
  CHECK (status IN ('available', 'missing', 'expired', 'deleted', 'generation_failed', 'integrity_failed'))
);

CREATE TABLE "app"."file_lifecycle_items" (
  "id" uuid,
  "scan_id" uuid NOT NULL,
  "classification" text NOT NULL,
  "categories_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "scope" text NOT NULL,
  "source_type" text,
  "file_id" uuid,
  "task_id" uuid,
  "run_id" uuid,
  "masked_filename" text NOT NULL,
  "file_size" bigint NOT NULL DEFAULT 0,
  "file_created_at" timestamptz,
  "file_modified_at" timestamptz,
  "database_status" text,
  "physical_status" text NOT NULL,
  "suggest_quarantine" boolean NOT NULL DEFAULT FALSE,
  "suggest_cleanup" boolean NOT NULL DEFAULT FALSE,
  "reason_code" text NOT NULL,
  "short_hash" text,
  "error_code" text,
  "created_at" timestamptz NOT NULL,
  "detected_file_type" text,
  "review_status" text NOT NULL DEFAULT 'pending_review',
  "reviewed_at" timestamptz,
  "reviewed_by" text,
  "review_reason" text,
  "root_key" text,
  "relative_path" text,
  "full_hash" text,
  "job_id" uuid,
  "mime_type" text,
  "signature_code" text,
  "detection_reason_code" text,
  "managed_file_id" uuid,
  "original_relative_path" text,
  "quarantine_relative_path" text,
  "quarantined_at" timestamptz,
  "restored_at" timestamptz,
  "deleted_at" timestamptz,
  PRIMARY KEY ("id"),
  CHECK (file_size >= 0),
  CHECK ("suggest_quarantine" IN (FALSE, TRUE)),
  CHECK ("suggest_cleanup" IN (FALSE, TRUE)),
  CHECK (detected_file_type IS NULL OR detected_file_type IN (
    'advertising_source',
    'advertising_output',
    'advertising_report',
    'advertising_temp',
    'advertising_unknown'
  )),
  CHECK (review_status IN (
    'pending_review',
    'approved_for_registration',
    'registered',
    'approved_for_quarantine',
    'quarantined',
    'restored',
    'rejected',
    'protected'
  ))
);

CREATE TABLE "app"."file_lifecycle_protected_files" (
  "file_id" uuid,
  "reason" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("file_id")
);

CREATE TABLE "app"."file_lifecycle_scans" (
  "id" uuid,
  "status" text NOT NULL,
  "scopes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "scope_errors_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "total_files" integer NOT NULL DEFAULT 0,
  "total_bytes" bigint NOT NULL DEFAULT 0,
  "truncated" boolean NOT NULL DEFAULT FALSE,
  "report_file_id" uuid,
  "error_code" text,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (status IN ('running', 'completed', 'failed')),
  CHECK (total_files >= 0),
  CHECK (total_bytes >= 0),
  CHECK ("truncated" IN (FALSE, TRUE))
);

CREATE TABLE "app"."file_quarantine_records" (
  "id" uuid,
  "lifecycle_item_id" uuid NOT NULL,
  "managed_file_id" uuid,
  "root_key" text NOT NULL,
  "original_relative_path" text NOT NULL,
  "quarantine_relative_path" text NOT NULL,
  "file_size" bigint NOT NULL,
  "file_hash" text NOT NULL,
  "status" text NOT NULL,
  "quarantined_at" timestamptz NOT NULL,
  "quarantined_by" text NOT NULL,
  "quarantine_reason" text NOT NULL,
  "restored_at" timestamptz,
  "restored_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("quarantine_relative_path"),
  CHECK (file_size >= 0),
  CHECK (length(file_hash) = 64),
  CHECK (status IN ('quarantined', 'restored'))
);

CREATE TABLE "app"."foundation_account_capabilities" (
  "account_id" uuid,
  "capability_code" text,
  "status" text NOT NULL DEFAULT 'active',
  "config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("account_id", "capability_code"),
  CHECK (capability_code IN (
      'orders.read',
      'inventory.read',
      'images.read',
      'listing.read',
      'listing.write'
    )),
  CHECK (status IN ('active', 'disabled', 'requires_binding'))
);

CREATE TABLE "app"."foundation_identity_links" (
  "id" uuid,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "source_system_code" text NOT NULL,
  "source_entity_type" text NOT NULL,
  "external_key" text NOT NULL,
  "normalized_external_key" text NOT NULL,
  "match_status" text NOT NULL DEFAULT 'confirmed',
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "first_seen_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  "confirmed_by" text,
  "confirmed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system_code", "source_entity_type", "normalized_external_key"),
  CHECK (entity_type IN ('product', 'sku', 'store', 'warehouse', 'owner')),
  CHECK (match_status IN ('confirmed', 'suggested', 'rejected', 'unresolved'))
);

CREATE TABLE "app"."foundation_integration_accounts" (
  "id" uuid,
  "source_system_code" text NOT NULL,
  "display_name" text NOT NULL,
  "credential_ref_type" text NOT NULL,
  "credential_ref_id" uuid,
  "status" text NOT NULL DEFAULT 'active',
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_verified_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system_code", "credential_ref_type", "credential_ref_id"),
  CHECK (credential_ref_type IN (
      'mabang_account_profile',
      'sidecar_managed',
      'environment',
      'none'
    )),
  CHECK (status IN ('active', 'disabled', 'verification_required')),
  CHECK (credential_ref_type = 'none'
    OR (credential_ref_id IS NOT NULL AND credential_ref_id <> ''))
);

CREATE TABLE "app"."foundation_operation_plan_events" (
  "id" uuid,
  "plan_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" uuid NOT NULL,
  "reason_code" text,
  "message" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key" text NOT NULL,
  "plan_version" integer NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("plan_id", "plan_version"),
  UNIQUE ("plan_id", "idempotency_key"),
  CHECK (actor_type IN ('user', 'system')),
  CHECK (plan_version >= 1)
);

CREATE TABLE "app"."foundation_operation_plans" (
  "id" uuid,
  "task_id" uuid,
  "operation_type" text NOT NULL,
  "state" text NOT NULL,
  "approval_mode" text NOT NULL,
  "scope_hash" text NOT NULL,
  "source_snapshot_hash" text NOT NULL,
  "policy_hash" text NOT NULL,
  "items_hash" text NOT NULL,
  "approval_text_hash" text,
  "plan_hash" text NOT NULL,
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
  "state_version" integer NOT NULL DEFAULT 1,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("plan_hash"),
  CHECK (state IN (
      'PREVIEWED',
      'APPROVED',
      'IN_FLIGHT',
      'SUCCEEDED',
      'FAILED',
      'UNKNOWN',
      'EXPIRED',
      'BLOCKED',
      'CANCELLED'
    )),
  CHECK (approval_mode IN ('human', 'system')),
  CHECK (state_version >= 1),
  CHECK (expires_at > created_at)
);

CREATE TABLE "app"."foundation_owners" (
  "id" uuid,
  "display_name" text NOT NULL,
  "source_system_code" text,
  "external_key" text,
  "status" text NOT NULL DEFAULT 'active',
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system_code", "external_key"),
  CHECK (status IN ('active', 'inactive', 'unassigned'))
);

CREATE TABLE "app"."foundation_source_runs" (
  "id" uuid,
  "source_system_code" text NOT NULL,
  "account_id" uuid,
  "domain" text NOT NULL,
  "source_ref_type" text NOT NULL,
  "source_ref_id" uuid NOT NULL,
  "status" text NOT NULL,
  "watermark_at" timestamptz,
  "input_fingerprint" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("domain", "source_ref_type", "source_ref_id"),
  CHECK (domain IN ('mabang_data', 'growth', 'images', 'listing', 'product')),
  CHECK (status IN (
      'PENDING',
      'RUNNING',
      'SUCCEEDED',
      'PARTIAL_SUCCESS',
      'FAILED',
      'CANCELLED'
    ))
);

CREATE TABLE "app"."foundation_source_systems" (
  "code" text,
  "source_type" text NOT NULL,
  "display_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("code"),
  CHECK (source_type IN ('erp', 'marketplace', 'internal', 'ai_provider')),
  CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE "app"."foundation_task_events" (
  "id" uuid,
  "task_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "from_state" text,
  "to_state" text NOT NULL,
  "source_state" text,
  "actor_type" text NOT NULL,
  "actor_id" uuid NOT NULL,
  "reason_code" text,
  "message" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key" text NOT NULL,
  "task_version" integer NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("task_id", "task_version"),
  UNIQUE ("task_id", "idempotency_key"),
  CHECK (actor_type IN ('user', 'system')),
  CHECK (task_version >= 1)
);

CREATE TABLE "app"."foundation_task_leases" (
  "task_id" uuid,
  "lease_owner" text NOT NULL,
  "lease_token" text NOT NULL,
  "acquired_at" timestamptz NOT NULL,
  "renewed_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  PRIMARY KEY ("task_id"),
  UNIQUE ("lease_token"),
  CHECK (expires_at > renewed_at)
);

CREATE TABLE "app"."foundation_tasks" (
  "id" uuid,
  "domain" text NOT NULL,
  "task_kind" text NOT NULL,
  "execution_mode" text NOT NULL,
  "authority_mode" text NOT NULL DEFAULT 'projection',
  "domain_ref_type" text NOT NULL,
  "domain_ref_id" uuid NOT NULL,
  "source_state" text,
  "state" text NOT NULL,
  "priority" text NOT NULL DEFAULT 'P2',
  "account_id" uuid,
  "source_run_id" uuid,
  "owner_id" uuid,
  "store_id" uuid,
  "warehouse_id" uuid,
  "sku_id" uuid,
  "idempotency_key" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "available_at" timestamptz,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "input_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error_code" text,
  "last_error_message" text,
  "state_version" integer NOT NULL DEFAULT 1,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("domain", "idempotency_key"),
  UNIQUE ("domain", "domain_ref_type", "domain_ref_id"),
  CHECK (domain IN (
      'growth',
      'mabang_data',
      'mabang_images',
      'listing',
      'product',
      'files'
    )),
  CHECK (execution_mode IN ('human', 'system')),
  CHECK (authority_mode IN ('projection', 'foundation')),
  CHECK (state IN (
      'PENDING',
      'READY',
      'RUNNING',
      'PAUSE_REQUESTED',
      'PAUSED',
      'BLOCKED',
      'RETRY_WAIT',
      'SUCCEEDED',
      'PARTIAL_SUCCESS',
      'FAILED',
      'CANCELLED',
      'DISMISSED'
    )),
  CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  CHECK (attempt_count >= 0),
  CHECK (max_attempts >= 1),
  CHECK (state_version >= 1)
);

CREATE TABLE "app"."foundation_warehouses" (
  "id" uuid,
  "canonical_key" text NOT NULL,
  "display_name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "country_code" text,
  "country_name" text,
  "identity_status" text NOT NULL DEFAULT 'review_required',
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("canonical_key"),
  CHECK (identity_status IN ('confirmed', 'review_required', 'excluded')),
  CHECK ((identity_status = 'confirmed' AND country_code IS NOT NULL AND country_code <> '')
    OR identity_status <> 'confirmed')
);

CREATE TABLE "app"."growth_analysis_runs" (
  "id" uuid,
  "analysis_date" date NOT NULL,
  "inventory_batch_id" uuid NOT NULL,
  "order_watermark_at" timestamptz NOT NULL,
  "rule_set_id" uuid NOT NULL,
  "country_mapping_set_id" uuid NOT NULL,
  "shop_scope_fingerprint" text NOT NULL,
  "input_fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "quality_status" text NOT NULL,
  "quality_summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "global_sku_count" integer NOT NULL DEFAULT 0,
  "country_sku_count" integer NOT NULL DEFAULT 0,
  "shop_count" integer NOT NULL DEFAULT 0,
  "shop_sku_count" integer NOT NULL DEFAULT 0,
  "signal_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamptz,
  "validated_at" timestamptz,
  "published_at" timestamptz,
  "finished_at" timestamptz,
  "error_code" text,
  "error_summary" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("input_fingerprint"),
  CHECK (status IN ('pending', 'running', 'validating', 'published', 'failed', 'cancelled')),
  CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  CHECK (global_sku_count >= 0),
  CHECK (country_sku_count >= 0),
  CHECK (shop_count >= 0),
  CHECK (shop_sku_count >= 0),
  CHECK (signal_count >= 0)
);

CREATE TABLE "app"."growth_country_mapping_sets" (
  "id" uuid,
  "version" text NOT NULL,
  "status" text NOT NULL,
  "description" text NOT NULL,
  "content_sha256" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "activated_by" text,
  "activated_at" timestamptz,
  "retired_by" text,
  "retired_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("content_sha256"),
  UNIQUE ("version"),
  CHECK (status IN ('draft', 'active', 'retired'))
);

CREATE TABLE "app"."growth_data_quality_issues" (
  "id" uuid,
  "issue_key" text NOT NULL,
  "batch_id" uuid NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid,
  "issue_code" text NOT NULL,
  "severity" text NOT NULL,
  "message" text NOT NULL,
  "source_context_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL,
  "resolved_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("issue_key"),
  CHECK (entity_type IN ('batch', 'order_raw_row', 'order_header', 'order_line', 'inventory_raw_row', 'inventory_snapshot', 'mapping')),
  CHECK (severity IN ('blocker', 'warning', 'information')),
  CHECK (status IN ('open', 'resolved', 'ignored'))
);

CREATE TABLE "app"."growth_focus_item_events" (
  "id" uuid,
  "focus_item_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "task_revision" integer NOT NULL,
  "from_status" text,
  "to_status" text NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "actor_type" text NOT NULL,
  "reason_code" text,
  "note" text,
  "signal_id" uuid,
  "analysis_run_id" uuid,
  "evidence_snapshot_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotency_key" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("focus_item_id", "task_revision"),
  UNIQUE ("focus_item_id", "idempotency_key"),
  CHECK (event_type IN (
      'CREATED',
      'ASSIGNED',
      'ACKNOWLEDGED',
      'STARTED',
      'MONITORING_STARTED',
      'BLOCKED',
      'RESOLVED',
      'DISMISSED',
      'REOPENED',
      'SIGNAL_REFRESHED',
      'NOT_HIT_IN_LATEST_RUN',
      'SCHEDULED'
    )),
  CHECK (task_revision >= 1),
  CHECK (from_status IS NULL
    OR from_status IN (
      'NEW',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'MONITORING',
      'RESOLVED',
      'BLOCKED',
      'DISMISSED',
      'REOPENED'
    )),
  CHECK (to_status IN (
      'NEW',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'MONITORING',
      'RESOLVED',
      'BLOCKED',
      'DISMISSED',
      'REOPENED'
    )),
  CHECK (actor_type IN ('user', 'system')),
  CHECK (idempotency_key <> '')
);

CREATE TABLE "app"."growth_focus_items" (
  "id" uuid,
  "task_key" text NOT NULL,
  "task_type" text NOT NULL,
  "current_signal_id" uuid,
  "first_analysis_run_id" uuid NOT NULL,
  "last_analysis_run_id" uuid NOT NULL,
  "owner_user_id" uuid,
  "internal_shop_id" uuid,
  "country_code" text,
  "source_warehouse_name" text,
  "normalized_warehouse_name" text,
  "platform" text,
  "category_l1" text,
  "category_l2" text,
  "subject_type" text NOT NULL,
  "normalized_source_sku" text,
  "priority" text NOT NULL,
  "status" text NOT NULL DEFAULT 'NEW',
  "reason_code" text NOT NULL,
  "recommended_action_code" text NOT NULL,
  "evidence_snapshot_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "consecutive_hit_count" integer NOT NULL DEFAULT 1,
  "is_hit_in_latest_run" integer NOT NULL DEFAULT 1,
  "first_detected_at" timestamptz NOT NULL,
  "last_detected_at" timestamptz NOT NULL,
  "acknowledged_at" timestamptz,
  "started_at" timestamptz,
  "due_at" timestamptz,
  "snoozed_until" text,
  "blocked_reason_code" text,
  "resolution_code" text,
  "resolution_note" text,
  "resolved_at" timestamptz,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (task_type IN (
      'DATA_BLOCKED',
      'STORE_WATCH',
      'INVENTORY_RISK',
      'GROWTH_OPPORTUNITY',
      'BLUE_OCEAN',
      'CROSS_COUNTRY_CANDIDATE',
      'STORE_SALES_DECLINE',
      'STORE_ASSORTMENT_GAP',
      'SKU_SALES_GROWTH',
      'SKU_SALES_DECLINE',
      'NEW_PRODUCT_OPPORTUNITY'
    )),
  CHECK (subject_type IN (
      'shop',
      'shop_category',
      'shop_sku',
      'warehouse_sku',
      'country_category',
      'sku',
      'data_configuration'
    )),
  CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  CHECK (status IN (
      'NEW',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'MONITORING',
      'RESOLVED',
      'BLOCKED',
      'DISMISSED',
      'REOPENED'
    )),
  CHECK (consecutive_hit_count >= 1),
  CHECK (is_hit_in_latest_run IN (0, 1)),
  CHECK (revision >= 1),
  CHECK (task_key <> ''),
  CHECK (reason_code <> ''),
  CHECK (recommended_action_code <> ''),
  CHECK ((source_warehouse_name IS NULL AND normalized_warehouse_name IS NULL)
    OR (
      source_warehouse_name IS NOT NULL
      AND source_warehouse_name <> ''
      AND normalized_warehouse_name IS NOT NULL
      AND normalized_warehouse_name <> ''
    )),
  CHECK (subject_type <> 'warehouse_sku'
    OR normalized_warehouse_name IS NOT NULL),
  CHECK (status <> 'BLOCKED' OR (blocked_reason_code IS NOT NULL AND blocked_reason_code <> '')),
  CHECK (status <> 'MONITORING'
    OR due_at IS NOT NULL
    OR snoozed_until IS NOT NULL),
  CHECK (status NOT IN ('RESOLVED', 'DISMISSED')
    OR (
      resolution_code IS NOT NULL
      AND resolution_code <> ''
      AND resolved_at IS NOT NULL
    ))
);

CREATE TABLE "app"."growth_inventory_raw_rows" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "sheet_name" text NOT NULL,
  "source_row_number" integer NOT NULL,
  "raw_values_json" jsonb NOT NULL,
  "raw_types_json" jsonb NOT NULL,
  "redacted_fields_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "row_hash" text NOT NULL,
  "parse_status" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "source_row_number"),
  CHECK (source_row_number >= 2),
  CHECK (parse_status IN ('parsed', 'review_required', 'rejected'))
);

CREATE TABLE "app"."growth_inventory_snapshots" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "source_row_number" integer NOT NULL,
  "source_sku" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "mapped_product_id" uuid,
  "warehouse_name" text,
  "available_quantity" numeric,
  "physical_quantity" numeric,
  "locked_quantity" numeric,
  "in_transit_quantity" numeric,
  "pending_shipment_quantity" numeric,
  "sellable_quantity" numeric,
  "sellable_quantity_status" text NOT NULL DEFAULT 'unconfirmed',
  "source_predicted_daily_sales" numeric,
  "predicted_daily_sales_semantic_status" text NOT NULL DEFAULT 'unconfirmed',
  "days_of_supply" numeric,
  "days_of_supply_status" text NOT NULL DEFAULT 'unavailable',
  "snapshot_at" timestamptz,
  "mapping_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "normalized_warehouse_name" text NOT NULL DEFAULT '',
  "product_status" text,
  "category_level_1" text,
  "category_level_2" text,
  "category_level_3" text,
  "source_visible_sales_7d" numeric,
  "source_visible_sales_28d" numeric,
  "source_visible_sales_42d" numeric,
  "source_scope_status" text NOT NULL DEFAULT 'unconfirmed',
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "source_row_number"),
  CHECK (source_row_number >= 2),
  CHECK (sellable_quantity_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  CHECK (predicted_daily_sales_semantic_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  CHECK (days_of_supply_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  CHECK (mapping_status IN ('matched', 'country_unresolved', 'ambiguous', 'unmatched')),
  CHECK (quality_status IN ('confirmed', 'review_required', 'unconfirmed')),
  CHECK (source_scope_status IN ('unconfirmed', 'confirmed'))
);

CREATE TABLE "app"."growth_mapping_events" (
  "id" uuid,
  "mapping_type" text NOT NULL,
  "mapping_id" uuid NOT NULL,
  "action" text NOT NULL,
  "before_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "after_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "actor_label" text NOT NULL,
  "request_id" text,
  "occurred_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (mapping_type IN ('shop', 'product')),
  CHECK (action IN ('confirmed', 'revoked'))
);

CREATE TABLE "app"."growth_mapping_issues" (
  "id" uuid,
  "issue_key" text NOT NULL,
  "issue_type" text NOT NULL,
  "source_batch_id" uuid NOT NULL,
  "source_row_id" uuid,
  "source_value" text NOT NULL,
  "candidate_values_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "reason" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "resolved_value" text,
  "resolved_by" text,
  "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("issue_key"),
  CHECK (issue_type IN (
    'shop_unmatched', 'shop_ambiguous', 'country_unresolved', 'sku_unmatched',
    'sku_ambiguous', 'product_country_conflict', 'duplicate_order_key', 'duplicate_line_key'
  )),
  CHECK (status IN ('open', 'resolved', 'revoked', 'ignored'))
);

CREATE TABLE "app"."growth_order_headers" (
  "id" uuid,
  "business_key" text NOT NULL,
  "business_key_version" text NOT NULL,
  "platform" text NOT NULL,
  "source_shop_name" text NOT NULL,
  "normalized_source_shop_name" text NOT NULL,
  "internal_shop_id" uuid,
  "mapped_country" text,
  "source_order_id" uuid NOT NULL,
  "order_status" text NOT NULL,
  "paid_at" timestamptz,
  "cancelled_at" timestamptz,
  "order_currency" text,
  "order_amount" numeric,
  "order_amount_source_field" text,
  "effective_status" text NOT NULL,
  "first_source_batch_id" uuid NOT NULL,
  "source_batch_id" uuid NOT NULL,
  "source_quality_status" text NOT NULL,
  "first_seen_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("business_key_version", "business_key"),
  CHECK (effective_status IN ('valid', 'pending', 'invalid_cancelled', 'unconfirmed')),
  CHECK (source_quality_status IN ('confirmed', 'review_required', 'invalid')),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."growth_order_inventory_links" (
  "id" uuid,
  "order_line_id" uuid NOT NULL,
  "order_source_batch_id" uuid NOT NULL,
  "inventory_snapshot_id" uuid,
  "inventory_source_batch_id" uuid NOT NULL,
  "match_key_version" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "normalized_source_warehouse_name" text NOT NULL,
  "match_status" text NOT NULL,
  "unmatched_reason" text,
  "order_effective_status" text NOT NULL,
  "is_current" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("order_line_id", "inventory_source_batch_id"),
  CHECK (match_key_version = 'source_sku_warehouse_v1'),
  CHECK (match_status IN ('matched', 'unmatched')),
  CHECK (order_effective_status IN ('valid', 'pending', 'invalid_cancelled', 'unconfirmed')),
  CHECK (is_current IN (0, 1))
);

CREATE TABLE "app"."growth_order_lines" (
  "id" uuid,
  "order_header_id" uuid NOT NULL,
  "first_source_batch_id" uuid NOT NULL,
  "source_batch_id" uuid NOT NULL,
  "source_row_number" integer NOT NULL,
  "source_line_key" text NOT NULL,
  "source_line_key_version" text NOT NULL,
  "line_occurrence" integer NOT NULL,
  "dedupe_confidence" text NOT NULL,
  "source_sku" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "platform_sku" text,
  "mapped_product_id" uuid,
  "mapped_country" text,
  "quantity" numeric NOT NULL,
  "line_amount" numeric,
  "line_amount_status" text NOT NULL,
  "product_name" text,
  "mapping_status" text NOT NULL,
  "effective_status" text NOT NULL,
  "is_current" integer NOT NULL DEFAULT 1,
  "first_seen_at" timestamptz NOT NULL,
  "last_seen_at" timestamptz NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "source_warehouse_name" text,
  "normalized_source_warehouse_name" text,
  PRIMARY KEY ("id"),
  UNIQUE ("source_line_key_version", "source_line_key"),
  CHECK (source_row_number >= 2),
  CHECK (line_occurrence >= 1),
  CHECK (dedupe_confidence IN ('technical_occurrence', 'source_identifier')),
  CHECK (line_amount_status IN ('confirmed', 'unconfirmed', 'unavailable')),
  CHECK (mapping_status IN ('matched', 'manually_confirmed', 'country_unresolved', 'ambiguous', 'unmatched', 'revoked')),
  CHECK (effective_status IN ('valid', 'pending', 'invalid_cancelled', 'unconfirmed')),
  CHECK (is_current IN (0, 1)),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."growth_order_raw_rows" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "sheet_name" text NOT NULL,
  "source_row_number" integer NOT NULL,
  "raw_values_json" jsonb NOT NULL,
  "raw_types_json" jsonb NOT NULL,
  "redacted_fields_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "row_hash" text NOT NULL,
  "parse_status" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "source_row_number"),
  CHECK (source_row_number >= 2),
  CHECK (parse_status IN ('parsed', 'review_required', 'rejected'))
);

CREATE TABLE "app"."growth_rule_sets" (
  "id" uuid,
  "version" text NOT NULL,
  "status" text NOT NULL,
  "metrics_contract_version" text NOT NULL,
  "parameters_json" jsonb NOT NULL,
  "content_sha256" text NOT NULL,
  "effective_from" text NOT NULL,
  "effective_to" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "activated_by" text,
  "activated_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("content_sha256"),
  UNIQUE ("version"),
  CHECK (status IN ('draft', 'active', 'retired')),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE "app"."growth_shop_daily_metrics" (
  "id" uuid,
  "analysis_run_id" uuid NOT NULL,
  "analysis_date" date NOT NULL,
  "internal_shop_id" uuid NOT NULL,
  "display_name" text NOT NULL,
  "platform" text NOT NULL,
  "owner_user_id" uuid,
  "country_code" text NOT NULL,
  "own_sales_quantity_7d" numeric NOT NULL DEFAULT 0,
  "own_sales_quantity_28d" numeric NOT NULL DEFAULT 0,
  "valid_order_count_7d" integer NOT NULL DEFAULT 0,
  "valid_order_count_28d" integer NOT NULL DEFAULT 0,
  "eligible_saleable_sku_count" integer,
  "sold_eligible_sku_count_28d" integer,
  "saleable_coverage_rate_28d" numeric,
  "eligible_high_performance_sku_count" integer,
  "sold_high_performance_sku_count_28d" integer,
  "high_performance_coverage_rate_28d" numeric,
  "key_performer_count" integer NOT NULL DEFAULT 0,
  "growth_focus_count" integer NOT NULL DEFAULT 0,
  "new_opportunity_count" integer NOT NULL DEFAULT 0,
  "slow_risk_count" integer NOT NULL DEFAULT 0,
  "low_stock_risk_count" integer NOT NULL DEFAULT 0,
  "availability_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "reason_code" text NOT NULL,
  "metrics_version" text NOT NULL,
  "country_mapping_set_id" uuid NOT NULL,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "calculated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("analysis_run_id", "internal_shop_id"),
  CHECK (valid_order_count_7d >= 0),
  CHECK (valid_order_count_28d >= 0),
  CHECK (key_performer_count >= 0),
  CHECK (growth_focus_count >= 0),
  CHECK (new_opportunity_count >= 0),
  CHECK (slow_risk_count >= 0),
  CHECK (low_stock_risk_count >= 0),
  CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  CHECK (quality_status IN ('confirmed', 'degraded', 'blocked'))
);

CREATE TABLE "app"."growth_shop_sku_coverage_snapshots" (
  "id" uuid,
  "internal_shop_id" uuid NOT NULL,
  "product_sku_id" uuid NOT NULL,
  "coverage_semantic" text NOT NULL,
  "source_system" text NOT NULL,
  "source_evidence_id" uuid NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("internal_shop_id", "product_sku_id", "source_system", "observed_at"),
  CHECK (coverage_semantic = 'current_online')
);

CREATE TABLE "app"."growth_shop_sku_daily_metrics" (
  "id" uuid,
  "analysis_run_id" uuid NOT NULL,
  "analysis_date" date NOT NULL,
  "internal_shop_id" uuid NOT NULL,
  "country_code" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "source_sku" text NOT NULL,
  "product_name" text,
  "category_l1" text,
  "category_l2" text,
  "mapped_product_id" uuid,
  "own_sales_quantity_7d" numeric NOT NULL DEFAULT 0,
  "own_sales_quantity_28d" numeric NOT NULL DEFAULT 0,
  "valid_order_count_7d" integer NOT NULL DEFAULT 0,
  "valid_order_count_28d" integer NOT NULL DEFAULT 0,
  "last_sold_at" timestamptz,
  "source_visible_sales_7d" numeric,
  "source_visible_sales_28d" numeric,
  "source_visible_sales_42d" numeric,
  "shop_to_source_visible_ratio_28d" numeric,
  "shop_to_source_visible_ratio_percentile_28d" numeric,
  "shop_sales_percentile_28d" numeric,
  "eligible_saleable" integer NOT NULL DEFAULT 0,
  "eligible_high_performance" integer NOT NULL DEFAULT 0,
  "is_key_performer" integer NOT NULL DEFAULT 0,
  "is_growth_focus_candidate" integer NOT NULL DEFAULT 0,
  "available_quantity" numeric,
  "availability_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "reason_code" text NOT NULL,
  "metrics_version" text NOT NULL,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "calculated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("analysis_run_id", "internal_shop_id", "normalized_source_sku"),
  CHECK (valid_order_count_7d >= 0),
  CHECK (valid_order_count_28d >= 0),
  CHECK (eligible_saleable IN (0, 1)),
  CHECK (eligible_high_performance IN (0, 1)),
  CHECK (is_key_performer IN (0, 1)),
  CHECK (is_growth_focus_candidate IN (0, 1)),
  CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  CHECK (quality_status IN ('confirmed', 'degraded', 'blocked'))
);

CREATE TABLE "app"."growth_shop_sku_observations" (
  "id" uuid,
  "observation_key" text NOT NULL,
  "coverage_semantic" text NOT NULL DEFAULT 'historical_observed',
  "platform" text NOT NULL,
  "source_shop_name" text NOT NULL,
  "normalized_source_shop_name" text NOT NULL,
  "internal_shop_id" uuid,
  "source_sku" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "mapped_product_id" uuid,
  "first_observed_at" timestamptz,
  "last_observed_at" timestamptz,
  "observed_order_count" integer NOT NULL DEFAULT 0,
  "observed_line_count" integer NOT NULL DEFAULT 0,
  "observed_quantity" numeric NOT NULL DEFAULT 0,
  "first_source_batch_id" uuid NOT NULL,
  "last_source_batch_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("observation_key"),
  CHECK (coverage_semantic = 'historical_observed'),
  CHECK (observed_order_count >= 0),
  CHECK (observed_line_count >= 0)
);

CREATE TABLE "app"."growth_shop_source_mappings" (
  "id" uuid,
  "source_system" text NOT NULL,
  "source_shop_name" text NOT NULL,
  "normalized_source_shop_name" text NOT NULL,
  "internal_shop_id" uuid,
  "platform" text NOT NULL,
  "country_code" text,
  "mapping_status" text NOT NULL,
  "mapping_source" text NOT NULL,
  "first_source_batch_id" uuid,
  "last_source_batch_id" uuid,
  "confirmed_by" text,
  "confirmed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system", "platform", "normalized_source_shop_name"),
  CHECK (mapping_status IN ('matched', 'manually_confirmed', 'ambiguous', 'unmatched', 'revoked')),
  CHECK (mapping_source IN ('exact', 'manual', 'unresolved', 'revoked'))
);

CREATE TABLE "app"."growth_shops" (
  "id" uuid,
  "internal_shop_code" text NOT NULL,
  "display_name" text NOT NULL,
  "platform" text NOT NULL,
  "country_code" text NOT NULL,
  "country_name" text NOT NULL,
  "owner_user_id" uuid,
  "primary_category_scope_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" text NOT NULL DEFAULT 'active',
  "identity_status" text NOT NULL DEFAULT 'confirmed',
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("internal_shop_code"),
  CHECK (status IN ('active', 'inactive')),
  CHECK (identity_status IN ('confirmed', 'review_required')),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."growth_signals" (
  "id" uuid,
  "analysis_run_id" uuid NOT NULL,
  "dedupe_key" text NOT NULL,
  "signal_type" text NOT NULL,
  "rule_code" text NOT NULL,
  "rule_version" text NOT NULL,
  "subject_type" text NOT NULL,
  "country_code" text,
  "source_warehouse_name" text,
  "normalized_warehouse_name" text,
  "normalized_source_sku" text,
  "internal_shop_id" uuid,
  "severity" text NOT NULL,
  "reason_code" text NOT NULL,
  "recommended_action_code" text NOT NULL,
  "availability_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "detected_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("analysis_run_id", "dedupe_key"),
  CHECK (signal_type IN ('opportunity', 'risk', 'highlight', 'data_quality')),
  CHECK (subject_type IN ('sku', 'warehouse_sku', 'shop_sku', 'shop', 'run')),
  CHECK (severity IN ('information', 'warning', 'high', 'critical')),
  CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  CHECK ((source_warehouse_name IS NULL AND normalized_warehouse_name IS NULL)
    OR (
      source_warehouse_name IS NOT NULL
      AND source_warehouse_name <> ''
      AND normalized_warehouse_name IS NOT NULL
      AND normalized_warehouse_name <> ''
    )),
  CHECK (subject_type <> 'warehouse_sku'
    OR normalized_warehouse_name IS NOT NULL)
);

CREATE TABLE "app"."growth_sku_daily_metrics" (
  "id" uuid,
  "analysis_run_id" uuid NOT NULL,
  "analysis_date" date NOT NULL,
  "scope_type" text NOT NULL,
  "scope_key" text NOT NULL,
  "country_code" text,
  "normalized_source_sku" text NOT NULL,
  "source_sku" text NOT NULL,
  "product_name" text,
  "product_status" text NOT NULL,
  "category_l1" text,
  "category_l2" text,
  "mapped_product_id" uuid,
  "mapping_status" text NOT NULL,
  "warehouse_count" integer NOT NULL,
  "available_quantity" numeric,
  "in_transit_quantity" numeric,
  "source_predicted_daily_sales_country_sku" numeric,
  "source_visible_sales_7d" numeric,
  "source_visible_sales_28d" numeric,
  "source_visible_sales_42d" numeric,
  "effective_daily_sales_28d" numeric,
  "computed_days_of_supply" numeric,
  "days_of_supply_status" text NOT NULL,
  "demand_percentile_28d" numeric,
  "assortment_percentile" numeric,
  "inventory_percentile" numeric,
  "comparison_scope" text,
  "comparison_sample_size" bigint,
  "assortment_status" text,
  "warehouse_supply_summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "supply_risk_warehouse_count" integer NOT NULL DEFAULT 0,
  "supply_critical_warehouse_count" integer NOT NULL DEFAULT 0,
  "supply_warning_warehouse_count" integer NOT NULL DEFAULT 0,
  "supply_data_issue_warehouse_count" integer NOT NULL DEFAULT 0,
  "is_source_high_performance" integer NOT NULL DEFAULT 0,
  "is_new" integer NOT NULL DEFAULT 0,
  "new_age_days" integer,
  "availability_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "reason_code" text NOT NULL,
  "metrics_version" text NOT NULL,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "calculated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("analysis_run_id", "scope_type", "scope_key", "normalized_source_sku"),
  CHECK (scope_type IN ('global', 'country')),
  CHECK (warehouse_count >= 1),
  CHECK (assortment_status IS NULL
    OR assortment_status IN (
      'ASSORTMENT_VERIFIED_HIGH',
      'ASSORTMENT_VERIFIED_MID',
      'ASSORTMENT_LOW',
      'ASSORTMENT_DATA_INSUFFICIENT'
    )),
  CHECK (supply_risk_warehouse_count >= 0),
  CHECK (supply_critical_warehouse_count >= 0),
  CHECK (supply_warning_warehouse_count >= 0),
  CHECK (supply_data_issue_warehouse_count >= 0),
  CHECK (is_source_high_performance IN (0, 1)),
  CHECK (is_new IN (0, 1)),
  CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  CHECK ((scope_type = 'global' AND scope_key = 'GLOBAL' AND country_code IS NULL)
    OR (scope_type = 'country' AND scope_key = country_code AND country_code IS NOT NULL)),
  CHECK (metrics_version <> 'GRV2-METRICS-1.2.0'
    OR (
      computed_days_of_supply IS NULL
      AND days_of_supply_status = 'warehouse_aggregate_only'
      AND assortment_status IS NOT NULL
    ))
);

CREATE TABLE "app"."growth_sku_warehouse_daily_metrics" (
  "id" uuid,
  "analysis_run_id" uuid NOT NULL,
  "analysis_date" date NOT NULL,
  "country_code" text NOT NULL,
  "source_warehouse_name" text NOT NULL,
  "normalized_warehouse_name" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "source_sku" text NOT NULL,
  "product_name" text,
  "product_status" text NOT NULL,
  "category_l1" text,
  "category_l2" text,
  "mapped_product_id" uuid,
  "mapping_status" text NOT NULL,
  "available_quantity" numeric,
  "in_transit_quantity" numeric,
  "source_current_sellable_days" numeric,
  "source_predicted_daily_sales" numeric,
  "source_visible_sales_7d" numeric,
  "source_visible_sales_28d" numeric,
  "source_visible_sales_42d" numeric,
  "supply_status" text NOT NULL,
  "slow_moving_status" text NOT NULL,
  "availability_status" text NOT NULL,
  "quality_status" text NOT NULL,
  "reason_code" text NOT NULL,
  "metrics_version" text NOT NULL,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "calculated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("analysis_run_id", "country_code", "normalized_warehouse_name", "normalized_source_sku"),
  CHECK (source_current_sellable_days IS NULL OR source_current_sellable_days >= 0),
  CHECK (supply_status IN (
      'SUPPLY_DATA_INSUFFICIENT',
      'SUPPLY_DATA_CONFLICT',
      'OUT_OF_STOCK',
      'IN_TRANSIT_ONLY',
      'SUPPLY_CRITICAL',
      'SUPPLY_WARNING',
      'SUPPLY_HEALTHY'
    )),
  CHECK (slow_moving_status IN (
      'NOT_APPLICABLE',
      'NORMAL',
      'SLOW_MOVING_WATCH',
      'SLOW_MOVING_RISK',
      'SLOW_MOVING_SEVERE'
    )),
  CHECK (availability_status IN ('available', 'degraded', 'unavailable')),
  CHECK (quality_status IN ('confirmed', 'degraded', 'blocked')),
  CHECK (normalized_warehouse_name <> ''),
  CHECK (country_code <> '' AND country_code <> 'ZZ')
);

CREATE TABLE "app"."growth_sku_warehouse_sales_metrics" (
  "id" uuid,
  "inventory_snapshot_id" uuid NOT NULL,
  "inventory_source_batch_id" uuid NOT NULL,
  "order_source_batch_id" uuid,
  "snapshot_at" timestamptz NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "normalized_source_warehouse_name" text NOT NULL,
  "own_sales_quantity_7d" numeric,
  "own_sales_order_count_7d" integer,
  "own_sales_effective_line_count_7d" integer,
  "own_sales_window_started_at" timestamptz,
  "own_sales_window_ended_at" timestamptz,
  "own_sales_quantity_7d_status" text NOT NULL,
  "source_visible_sales_7d" numeric,
  "source_visible_sales_28d" numeric,
  "source_visible_sales_42d" numeric,
  "source_predicted_daily_sales" numeric,
  "source_predicted_daily_sales_status" text NOT NULL,
  "source_scope_status" text NOT NULL DEFAULT 'unconfirmed',
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("inventory_snapshot_id"),
  CHECK (own_sales_quantity_7d_status IN ('confirmed', 'unavailable')),
  CHECK (source_predicted_daily_sales_status IN ('source_prediction_not_actual', 'unavailable')),
  CHECK (source_scope_status IN ('unconfirmed', 'confirmed'))
);

CREATE TABLE "app"."growth_source_batches" (
  "id" uuid,
  "source_type" text NOT NULL,
  "source_module" text NOT NULL,
  "source_file_id" uuid,
  "source_filename" text,
  "source_sha256" text NOT NULL,
  "source_account_id" uuid,
  "idempotency_key" text NOT NULL,
  "query_started_at" timestamptz,
  "query_ended_at" timestamptz,
  "collected_at" timestamptz,
  "imported_at" timestamptz,
  "source_scope_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source_headers_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "redacted_headers_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "row_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "error_code" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "source_scope_status" text NOT NULL DEFAULT 'unconfirmed',
  "pii_filtered_field_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  UNIQUE ("source_type", "idempotency_key"),
  CHECK (source_type IN ('mabang_order', 'mabang_inventory', 'shop_listing_import')),
  CHECK (row_count >= 0),
  CHECK (status IN ('applying', 'applied', 'failed')),
  CHECK (source_scope_status IN ('unconfirmed', 'confirmed')),
  CHECK (pii_filtered_field_count >= 0)
);

CREATE TABLE "app"."growth_warehouse_country_mappings" (
  "id" uuid,
  "mapping_set_id" uuid NOT NULL,
  "source_system" text NOT NULL,
  "source_warehouse_name" text NOT NULL,
  "normalized_warehouse_name" text NOT NULL,
  "country_code" text NOT NULL,
  "country_name" text NOT NULL,
  "mapping_status" text NOT NULL,
  "exclusion_reason" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("mapping_set_id", "source_system", "normalized_warehouse_name"),
  CHECK (source_system = 'mabang_inventory'),
  CHECK (country_code <> '' AND country_code <> 'ZZ'),
  CHECK (mapping_status IN ('confirmed', 'excluded')),
  CHECK ((mapping_status = 'confirmed' AND exclusion_reason IS NULL)
    OR (mapping_status = 'excluded' AND exclusion_reason IS NOT NULL AND exclusion_reason <> ''))
);

CREATE TABLE "app"."mabang_account_profiles" (
  "id" uuid,
  "name" text NOT NULL,
  "username" text NOT NULL,
  "encrypted_password" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "last_verified_at" timestamptz,
  "last_verify_status" text,
  "last_verify_message" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "app"."mabang_filter_option_cache" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "account_profile_id" uuid NOT NULL,
  "manager" text NOT NULL DEFAULT '',
  "shop_name" text NOT NULL DEFAULT '',
  "platform" text NOT NULL DEFAULT '',
  "region" text NOT NULL DEFAULT '',
  "warehouse" text NOT NULL DEFAULT '',
  "order_status" text NOT NULL DEFAULT '',
  "sku" text NOT NULL DEFAULT '',
  "logistics_channel" text NOT NULL DEFAULT '',
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("account_profile_id", "manager", "shop_name", "platform", "region", "warehouse", "order_status", "sku", "logistics_channel")
);

CREATE TABLE "app"."mabang_sku_image_batches" (
  "id" uuid,
  "account_id" uuid NOT NULL,
  "source_batch_id" uuid,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "paused_at" timestamptz,
  "current_page" integer NOT NULL DEFAULT 0,
  "total_pages" integer,
  "discovered_skus" integer NOT NULL DEFAULT 0,
  "downloaded_images" integer NOT NULL DEFAULT 0,
  "missing_images" integer NOT NULL DEFAULT 0,
  "duplicate_images" integer NOT NULL DEFAULT 0,
  "failed_images" integer NOT NULL DEFAULT 0,
  "linked_products" integer NOT NULL DEFAULT 0,
  "shared_country_links" integer NOT NULL DEFAULT 0,
  "filename_mismatches" integer NOT NULL DEFAULT 0,
  "interface_profile_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error_code" text,
  "last_error_message" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "sync_run_id" uuid,
  "segment_no" integer,
  "start_page" integer,
  "end_page" integer,
  PRIMARY KEY ("id"),
  CHECK (mode IN ('full_initial', 'missing_only', 'retry_failed')),
  CHECK (status IN (
    'pending', 'running', 'pause_requested', 'paused',
    'completed', 'partial_success', 'failed'
  )),
  CHECK (current_page >= 0),
  CHECK (total_pages IS NULL OR total_pages >= 0),
  CHECK (discovered_skus >= 0),
  CHECK (downloaded_images >= 0),
  CHECK (missing_images >= 0),
  CHECK (duplicate_images >= 0),
  CHECK (failed_images >= 0),
  CHECK (linked_products >= 0),
  CHECK (shared_country_links >= 0),
  CHECK (filename_mismatches >= 0),
  CHECK (segment_no IS NULL OR segment_no >= 1),
  CHECK (start_page IS NULL OR start_page >= 1),
  CHECK (end_page IS NULL OR end_page >= 0)
);

CREATE TABLE "app"."mabang_sku_image_checkpoints" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "page_number" integer NOT NULL,
  "page_hash" text NOT NULL,
  "row_count" integer NOT NULL DEFAULT 0,
  "discovered_count" integer NOT NULL DEFAULT 0,
  "failed_count" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "error_code" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "page_number"),
  CHECK (page_number >= 1),
  CHECK (row_count >= 0),
  CHECK (discovered_count >= 0),
  CHECK (failed_count >= 0),
  CHECK (status IN ('running', 'completed', 'failed', 'repeated'))
);

CREATE TABLE "app"."mabang_sku_image_discoveries" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "source_sku" text NOT NULL,
  "source_sku_normalized" text NOT NULL,
  "product_name" text,
  "warehouse_name" text,
  "source_image_url" text,
  "image_src" text,
  "image_data_src" text,
  "image_srcset" text,
  "image_background_url" text,
  "source_kind" text NOT NULL,
  "source_page" integer NOT NULL,
  "source_row_number" integer NOT NULL,
  "filename_sku" text,
  "validation_status" text NOT NULL DEFAULT 'pending',
  "quality_issue_code" text,
  "download_status" text NOT NULL DEFAULT 'pending',
  "asset_id" uuid,
  "download_attempts" integer NOT NULL DEFAULT 0,
  "http_status" integer,
  "discovered_at" timestamptz NOT NULL,
  "last_checked_at" timestamptz NOT NULL,
  "error_code" text,
  "error_message" text,
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "source_page", "source_row_number", "source_sku_normalized"),
  CHECK (source_kind IN ('interface', 'dom', 'cos_network', 'retry')),
  CHECK (source_page >= 1),
  CHECK (source_row_number >= 1),
  CHECK (validation_status IN ('pending', 'valid', 'warning', 'invalid', 'missing')),
  CHECK (download_status IN ('pending', 'skipped', 'downloaded', 'duplicate', 'missing', 'failed')),
  CHECK (download_attempts >= 0)
);

CREATE TABLE "app"."mabang_sku_image_discovery_images" (
  "id" uuid,
  "discovery_id" uuid NOT NULL,
  "image_index" integer NOT NULL,
  "source_url" text NOT NULL,
  "source_url_hash" text NOT NULL,
  "source_kind" text NOT NULL,
  "download_status" text NOT NULL DEFAULT 'pending',
  "asset_id" uuid,
  "download_attempts" integer NOT NULL DEFAULT 0,
  "http_status" integer,
  "error_code" text,
  "error_message" text,
  "discovered_at" timestamptz NOT NULL,
  "last_checked_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("discovery_id", "source_url_hash"),
  CHECK (image_index >= 0),
  CHECK (source_kind IN (
    'src', 'data_src', 'srcset', 'background', 'interface', 'retry'
  )),
  CHECK (download_status IN ('pending', 'skipped', 'downloaded', 'duplicate', 'missing', 'failed')),
  CHECK (download_attempts >= 0)
);

CREATE TABLE "app"."mabang_sku_image_sync_runs" (
  "id" uuid,
  "account_id" uuid NOT NULL,
  "status" text NOT NULL,
  "next_page" integer NOT NULL DEFAULT 1,
  "total_pages" integer,
  "segment_count" integer NOT NULL DEFAULT 0,
  "discovered_skus" integer NOT NULL DEFAULT 0,
  "discovered_images" integer NOT NULL DEFAULT 0,
  "downloaded_images" integer NOT NULL DEFAULT 0,
  "duplicate_images" integer NOT NULL DEFAULT 0,
  "failed_images" integer NOT NULL DEFAULT 0,
  "matched_skus" integer NOT NULL DEFAULT 0,
  "unmatched_skus" integer NOT NULL DEFAULT 0,
  "last_batch_id" uuid,
  "last_error_code" text,
  "last_error_message" text,
  "created_by" text NOT NULL,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (status IN (
    'pending', 'running', 'completed', 'partial_success', 'failed'
  )),
  CHECK (next_page >= 1),
  CHECK (total_pages IS NULL OR total_pages >= 0),
  CHECK (segment_count >= 0),
  CHECK (discovered_skus >= 0),
  CHECK (discovered_images >= 0),
  CHECK (downloaded_images >= 0),
  CHECK (duplicate_images >= 0),
  CHECK (failed_images >= 0),
  CHECK (matched_skus >= 0),
  CHECK (unmatched_skus >= 0)
);

CREATE TABLE "app"."managed_files" (
  "id" uuid,
  "lifecycle_item_id" uuid NOT NULL,
  "scan_id" uuid NOT NULL,
  "root_key" text NOT NULL,
  "relative_path" text NOT NULL,
  "source_type" text NOT NULL,
  "job_id" uuid,
  "mime_type" text NOT NULL,
  "file_size" bigint NOT NULL,
  "file_hash" text NOT NULL,
  "file_created_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'available',
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "registered_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("root_key", "relative_path"),
  UNIQUE ("lifecycle_item_id"),
  CHECK (root_key IN ('ad_upload', 'ad_output', 'ad_temp', 'main_temp')),
  CHECK (source_type IN (
    'advertising_source',
    'advertising_output',
    'advertising_report'
  )),
  CHECK (file_size >= 0),
  CHECK (length(file_hash) = 64),
  CHECK (status IN ('available', 'quarantined', 'restored', 'deleted'))
);

CREATE TABLE "app"."operation_audit_events" (
  "id" uuid,
  "request_id" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "module" text NOT NULL,
  "action" text NOT NULL,
  "http_method" text,
  "request_path" text,
  "status" text NOT NULL,
  "http_status" integer,
  "duration_ms" integer,
  "source_ip" text,
  "actor_type" text,
  "actor_identifier" text,
  "task_id" uuid,
  "run_id" uuid,
  "file_id" uuid,
  "error_stage" text,
  "error_code" text,
  "error_summary" text,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "app"."product_ai_contents" (
  "id" uuid,
  "product_sku_id" uuid NOT NULL,
  "country" text NOT NULL,
  "sku" text NOT NULL,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "content_type" text NOT NULL DEFAULT 'selling_points_and_scenarios',
  "input_context_json" jsonb NOT NULL,
  "output_content_json" jsonb NOT NULL,
  "prompt_version" text NOT NULL,
  "status" text NOT NULL,
  "version" integer NOT NULL,
  "created_by" text NOT NULL,
  "request_id" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "confirmed_at" timestamptz,
  "confirmed_by" text,
  "archived_at" timestamptz,
  "listing_draft_id" uuid,
  "platform" text,
  "shop_name" text,
  "context_hash" text,
  "previous_content_id" uuid,
  "adopted_at" timestamptz,
  "adopted_by" text,
  "adopted_content_json" jsonb,
  "is_manually_modified" integer NOT NULL DEFAULT 0,
  "manual_content_json" jsonb,
  PRIMARY KEY ("id"),
  UNIQUE ("product_sku_id", "content_type", "version"),
  CHECK (status IN ('draft', 'confirmed', 'archived')),
  CHECK (version >= 1)
);

CREATE TABLE "app"."product_categories" (
  "id" uuid,
  "parent_id" uuid,
  "parent_key" text NOT NULL,
  "level" integer NOT NULL,
  "source_system" text NOT NULL,
  "source_name" text NOT NULL,
  "normalized_name" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "first_seen_batch_id" uuid NOT NULL,
  "last_seen_batch_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "inactive_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system", "level", "parent_key", "normalized_name"),
  CHECK (level IN (1, 2)),
  CHECK (status IN ('active', 'inactive', 'review_required'))
);

CREATE TABLE "app"."product_cost_snapshots" (
  "id" uuid,
  "sku_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "country_raw" text,
  "cost_cny" numeric NOT NULL,
  "exchange_rate" numeric NOT NULL,
  "exchange_direction" text NOT NULL,
  "cost_local" numeric NOT NULL,
  "price_tier_20" numeric,
  "price_tier_25" numeric,
  "price_tier_35" numeric,
  "price_tier_45" numeric,
  "attach_rate" numeric,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("sku_id", "batch_id"),
  CHECK (exchange_direction IN ('local_per_cny', 'cny_per_local', 'equivalent'))
);

CREATE TABLE "app"."product_detail_preferences" (
  "scope_key" text,
  "visible_fields_json" jsonb NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "operator_label" text NOT NULL,
  "request_id" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("scope_key"),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."product_field_override_events" (
  "id" uuid,
  "sku_id" uuid NOT NULL,
  "field_code" text NOT NULL,
  "previous_value_json" jsonb,
  "next_value_json" jsonb,
  "operator_label" text NOT NULL,
  "request_id" text,
  "occurred_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "app"."product_field_overrides" (
  "sku_id" uuid,
  "field_code" text,
  "value_json" jsonb,
  "operator_label" text NOT NULL,
  "request_id" text,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  PRIMARY KEY ("sku_id", "field_code"),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."product_identity_mappings" (
  "id" uuid,
  "source_system" text NOT NULL,
  "source_sku" text NOT NULL,
  "normalized_source_sku" text NOT NULL,
  "platform" text NOT NULL,
  "country_code" text NOT NULL,
  "internal_product_id" uuid,
  "internal_sku" text,
  "main_sku" text,
  "mapping_status" text NOT NULL,
  "mapping_source" text NOT NULL,
  "confidence" numeric,
  "first_source_batch_id" uuid,
  "last_source_batch_id" uuid,
  "confirmed_by" text,
  "confirmed_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system", "platform", "country_code", "normalized_source_sku"),
  CHECK (mapping_status IN ('matched', 'manually_confirmed', 'ambiguous', 'unmatched', 'revoked')),
  CHECK (mapping_source IN ('exact_country_sku', 'manual', 'unresolved', 'revoked'))
);

CREATE TABLE "app"."product_image_generation_items" (
  "id" uuid,
  "task_id" uuid NOT NULL,
  "slot_key" text NOT NULL,
  "slot_type" text NOT NULL,
  "slot_index" integer NOT NULL,
  "label" text NOT NULL,
  "aspect_ratio" text,
  "prompt" text NOT NULL,
  "negative_prompt" text,
  "status" text NOT NULL,
  "generated_file_id" uuid,
  "error_code" text,
  "error_message" text,
  "adopted_at" timestamptz,
  "adopted_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("task_id", "slot_key"),
  CHECK (slot_index >= 0),
  CHECK (status IN ('waiting','generating','completed','failed','cancelled'))
);

CREATE TABLE "app"."product_image_generation_tasks" (
  "id" uuid,
  "product_sku_id" uuid NOT NULL,
  "listing_draft_id" uuid,
  "template_key" text NOT NULL,
  "provider" text,
  "model" text,
  "context_hash" text NOT NULL,
  "context_json" jsonb NOT NULL,
  "prompt_plan_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  "cancelled_at" timestamptz,
  PRIMARY KEY ("id"),
  CHECK (status IN (
    'pending','generating_prompt','waiting_generation','generating',
    'partially_completed','completed','failed','cancelled'
  ))
);

CREATE TABLE "app"."product_images" (
  "id" uuid,
  "sku_id" uuid NOT NULL,
  "original_filename" text NOT NULL,
  "storage_filename" text NOT NULL,
  "relative_path" text NOT NULL,
  "mime_type" text NOT NULL,
  "file_size" bigint NOT NULL,
  "file_hash" text NOT NULL,
  "is_primary" integer NOT NULL DEFAULT 0,
  "sort_order" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'available',
  "operator_label" text NOT NULL,
  "request_id" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("relative_path"),
  CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CHECK (file_size > 0),
  CHECK (is_primary IN (0, 1)),
  CHECK (status IN ('available', 'deleted', 'missing', 'integrity_failed'))
);

CREATE TABLE "app"."product_import_batches" (
  "id" uuid,
  "source_system" text NOT NULL DEFAULT 'company_product_center',
  "source_period" text,
  "source_country_raw" text,
  "file_sha256" text NOT NULL,
  "header_fingerprint" text,
  "status" text NOT NULL,
  "row_count" integer NOT NULL DEFAULT 0,
  "new_count" integer NOT NULL DEFAULT 0,
  "updated_count" integer NOT NULL DEFAULT 0,
  "unchanged_count" integer NOT NULL DEFAULT 0,
  "conflict_count" integer NOT NULL DEFAULT 0,
  "exception_count" integer NOT NULL DEFAULT 0,
  "blocker_count" integer NOT NULL DEFAULT 0,
  "reminder_count" integer NOT NULL DEFAULT 0,
  "information_count" integer NOT NULL DEFAULT 0,
  "mapping_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "unknown_fields_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "validation_summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "operator_label" text NOT NULL,
  "request_id" text,
  "revision" integer NOT NULL DEFAULT 1,
  "error_code" text,
  "error_summary" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "applied_at" timestamptz,
  "cancelled_at" timestamptz,
  "unmatched_count" integer NOT NULL DEFAULT 0,
  "will_write_count" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("id"),
  CHECK (status IN ('uploaded', 'validating', 'preview_ready', 'applying', 'applied', 'validation_failed', 'apply_failed', 'cancelled')),
  CHECK (row_count >= 0),
  CHECK (new_count >= 0),
  CHECK (updated_count >= 0),
  CHECK (unchanged_count >= 0),
  CHECK (conflict_count >= 0),
  CHECK (exception_count >= 0),
  CHECK (blocker_count >= 0),
  CHECK (reminder_count >= 0),
  CHECK (information_count >= 0),
  CHECK (revision >= 1),
  CHECK (unmatched_count >= 0),
  CHECK (will_write_count >= 0)
);

CREATE TABLE "app"."product_import_field_changes" (
  "id" uuid,
  "import_batch_id" uuid NOT NULL,
  "import_row_id" uuid NOT NULL,
  "product_package_row_id" uuid,
  "source_row_number" integer NOT NULL,
  "country_raw" text,
  "sku_code" text,
  "warehouse_raw" text,
  "chinese_name" text,
  "source_header" text NOT NULL,
  "field_name" text NOT NULL,
  "old_value_json" jsonb,
  "new_value_json" jsonb,
  "old_type" text,
  "new_type" text,
  "has_manual_override" integer NOT NULL DEFAULT 0,
  "changed_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (source_row_number >= 2),
  CHECK (has_manual_override IN (0, 1))
);

CREATE TABLE "app"."product_import_files" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "export_file_id" uuid NOT NULL,
  "file_role" text NOT NULL DEFAULT 'source',
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("export_file_id"),
  UNIQUE ("batch_id", "file_role"),
  CHECK (file_role IN ('source', 'error_report', 'diff_export'))
);

CREATE TABLE "app"."product_import_issues" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "row_id" uuid,
  "source_row_number" integer,
  "issue_code" text NOT NULL,
  "severity" text NOT NULL,
  "field_code" text,
  "current_value_json" jsonb,
  "suggested_value_json" jsonb,
  "message" text NOT NULL,
  "suggestion" text,
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (severity IN ('blocker', 'reminder', 'information')),
  CHECK (status IN ('open', 'acknowledged', 'resolved', 'ignored'))
);

CREATE TABLE "app"."product_import_rows" (
  "id" uuid,
  "batch_id" uuid NOT NULL,
  "source_row_number" integer NOT NULL,
  "source_sku" text,
  "row_sha256" text NOT NULL,
  "raw_payload_json" jsonb NOT NULL,
  "normalized_payload_json" jsonb NOT NULL,
  "validation_codes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "outcome" text NOT NULL,
  "target_sku_id" uuid,
  "applied_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "source_country_raw" text,
  "product_key" text,
  "product_sha256" text,
  "source_warehouse_raw" text,
  "source_row_key" text,
  "row_occurrence" integer NOT NULL DEFAULT 1,
  "raw_types_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "package_row_id" uuid,
  PRIMARY KEY ("id"),
  UNIQUE ("batch_id", "source_row_number"),
  CHECK (source_row_number >= 2),
  CHECK (outcome IN ('new', 'updated', 'unchanged', 'conflict', 'exception')),
  CHECK (row_occurrence >= 1)
);

CREATE TABLE "app"."product_inventory_snapshots" (
  "id" uuid,
  "sku_id" uuid NOT NULL,
  "batch_id" uuid NOT NULL,
  "warehouse_raw" text NOT NULL,
  "warehouse_stock" numeric,
  "planned_warehouse_raw" text,
  "captured_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("sku_id", "batch_id", "warehouse_raw")
);

CREATE TABLE "app"."product_listing_drafts" (
  "id" uuid,
  "product_sku_id" uuid NOT NULL,
  "country" text NOT NULL,
  "sku" text NOT NULL,
  "platform" text NOT NULL,
  "shop_id" text,
  "shop_key" text NOT NULL,
  "shop_name" text,
  "marketplace" text,
  "platform_category_id" text,
  "platform_category_name" text,
  "listing_mode" text NOT NULL DEFAULT 'standard',
  "title" text,
  "subtitle" text,
  "description" text,
  "search_keywords_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "brand" text,
  "model" text,
  "target_users" text,
  "content_language" text NOT NULL DEFAULT '中文',
  "selling_points_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "usage_scenarios_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "platform_attributes_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "variants_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "pricing_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "media_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "logistics_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "compliance_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'draft',
  "validation_result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "revision" integer NOT NULL DEFAULT 1,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  "country_code" text,
  "country_name" text,
  "marketplace_code" text,
  "product_positioning" text,
  "content_style" text,
  "price_positioning" text,
  "primary_scenarios" text,
  "special_requirements" text,
  "forbidden_content" text,
  "ai_context_hash" text,
  "ai_adoptions_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("id"),
  CHECK (platform IN ('shopee', 'lazada', 'tiktok_shop')),
  CHECK (status IN ('draft', 'ready', 'publishing', 'published', 'failed', 'archived')),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."product_listing_publish_records" (
  "id" uuid,
  "listing_draft_id" uuid NOT NULL,
  "platform" text NOT NULL,
  "shop_id" text,
  "request_payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "response_payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "platform_product_id" text,
  "platform_listing_id" text,
  "publish_status" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "published_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (publish_status IN ('pending', 'publishing', 'published', 'failed', 'cancelled'))
);

CREATE TABLE "app"."product_media_assets" (
  "id" uuid,
  "source_system" text NOT NULL,
  "source_url" text,
  "storage_file_id" uuid NOT NULL,
  "original_filename" text NOT NULL,
  "storage_filename" text NOT NULL,
  "relative_path" text NOT NULL,
  "sha256" text NOT NULL,
  "mime_type" text NOT NULL,
  "width" integer NOT NULL,
  "height" integer NOT NULL,
  "file_size" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'available',
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("sha256"),
  UNIQUE ("relative_path"),
  UNIQUE ("storage_file_id"),
  CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  CHECK (width > 0),
  CHECK (height > 0),
  CHECK (file_size > 0),
  CHECK (status IN ('available', 'missing', 'integrity_failed', 'deleted'))
);

CREATE TABLE "app"."product_media_links" (
  "id" uuid,
  "asset_id" uuid NOT NULL,
  "source_sku" text NOT NULL,
  "source_sku_normalized" text NOT NULL,
  "product_id" uuid NOT NULL,
  "country_code" text NOT NULL DEFAULT '',
  "media_role" text NOT NULL DEFAULT 'gallery',
  "mapping_status" text NOT NULL DEFAULT 'suggested',
  "linked_at" timestamptz NOT NULL,
  "linked_by" text NOT NULL,
  "confirmed_at" timestamptz,
  "confirmed_by" text,
  PRIMARY KEY ("id"),
  UNIQUE ("asset_id", "product_id"),
  CHECK (media_role IN ('gallery', 'suggested_primary', 'primary')),
  CHECK (mapping_status IN ('suggested', 'confirmed', 'rejected', 'invalid'))
);

CREATE TABLE "app"."product_models" (
  "id" uuid,
  "source_system" text NOT NULL,
  "source_main_sku" text NOT NULL,
  "category_id" uuid NOT NULL,
  "canonical_name" text,
  "identity_status" text NOT NULL DEFAULT 'confirmed',
  "first_seen_batch_id" uuid NOT NULL,
  "last_seen_batch_id" uuid NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "inactive_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system", "source_main_sku"),
  CHECK (identity_status IN ('confirmed', 'review_required', 'inactive')),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."product_package_rows" (
  "id" uuid,
  "source_system" text NOT NULL DEFAULT 'company_product_center',
  "source_row_key" text NOT NULL,
  "product_key" text NOT NULL,
  "country_normalized" text NOT NULL,
  "sku_normalized" text NOT NULL,
  "warehouse_normalized" text NOT NULL,
  "row_occurrence" integer NOT NULL,
  "source_row_sha256" text NOT NULL,
  "semantic_row_sha256" text NOT NULL,
  "raw_payload_json" jsonb NOT NULL,
  "raw_types_json" jsonb NOT NULL,
  "normalized_payload_json" jsonb NOT NULL,
  "raw_source_period_json" jsonb,
  "raw_sku_code_json" jsonb,
  "raw_product_name_json" jsonb,
  "raw_main_sku_code_json" jsonb,
  "raw_country_raw_json" jsonb,
  "raw_category_l1_json" jsonb,
  "raw_category_l2_json" jsonb,
  "raw_source_created_date_json" jsonb,
  "raw_new_product_month_json" jsonb,
  "raw_new_product_age_months_json" jsonb,
  "raw_gift_raw_json" jsonb,
  "raw_source_status_json" jsonb,
  "raw_style_code_json" jsonb,
  "raw_style_name_json" jsonb,
  "raw_sales_spec_json" jsonb,
  "raw_item_dimensions_raw_json" jsonb,
  "raw_item_net_weight_g_json" jsonb,
  "raw_item_gross_weight_g_json" jsonb,
  "raw_carton_length_cm_json" jsonb,
  "raw_carton_width_cm_json" jsonb,
  "raw_carton_height_cm_json" jsonb,
  "raw_carton_quantity_json" jsonb,
  "raw_shipping_method_json" jsonb,
  "raw_warehouse_raw_json" jsonb,
  "raw_warehouse_stock_json" jsonb,
  "raw_planned_warehouse_raw_json" jsonb,
  "raw_cost_cny_json" jsonb,
  "raw_exchange_rate_json" jsonb,
  "raw_cost_local_json" jsonb,
  "raw_price_tier_20_json" jsonb,
  "raw_price_tier_25_json" jsonb,
  "raw_price_tier_35_json" jsonb,
  "raw_price_tier_45_json" jsonb,
  "raw_attach_rate_json" jsonb,
  "raw_forecast_daily_sales_json" jsonb,
  "import_batch_id" uuid NOT NULL,
  "source_row_number" integer NOT NULL,
  "first_seen_batch_id" uuid NOT NULL,
  "latest_batch_id" uuid NOT NULL,
  "latest_import_row_id" uuid NOT NULL,
  "latest_source_row_number" integer NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system", "source_row_key"),
  CHECK (row_occurrence >= 1),
  CHECK (source_row_number >= 2),
  CHECK (latest_source_row_number >= 2),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."product_packaging_profiles" (
  "sku_id" uuid,
  "source_row_id" uuid NOT NULL,
  "item_dimensions_raw" text,
  "item_net_weight_g" numeric,
  "item_gross_weight_g" numeric,
  "carton_length_cm" numeric,
  "carton_width_cm" numeric,
  "carton_height_cm" numeric,
  "carton_quantity" integer,
  "shipping_method" text,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("sku_id")
);

CREATE TABLE "app"."product_sku_lifecycle" (
  "sku_id" uuid,
  "status_code" text NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "decision_source" text NOT NULL,
  "source_status_raw" text,
  "source_batch_id" uuid NOT NULL,
  "reason_code" text NOT NULL,
  "operator_label" text NOT NULL,
  "request_id" text,
  "effective_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("sku_id"),
  CHECK (status_code IN ('ACTIVE', 'NEW', 'CLEARANCE', 'DISCONTINUED', 'ARCHIVED')),
  CHECK (revision >= 1),
  CHECK (decision_source IN ('central', 'manual', 'rule'))
);

CREATE TABLE "app"."product_sku_lifecycle_events" (
  "id" uuid,
  "sku_id" uuid NOT NULL,
  "from_status_code" text,
  "to_status_code" text NOT NULL,
  "decision_source" text NOT NULL,
  "source_batch_id" uuid NOT NULL,
  "reason_code" text NOT NULL,
  "operator_label" text NOT NULL,
  "request_id" text,
  "occurred_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (to_status_code IN ('ACTIVE', 'NEW', 'CLEARANCE', 'DISCONTINUED', 'ARCHIVED')),
  CHECK (decision_source IN ('central', 'manual', 'rule'))
);

CREATE TABLE "app"."product_skus" (
  "id" uuid,
  "source_system" text NOT NULL,
  "source_sku" text NOT NULL,
  "normalized_sku" text NOT NULL,
  "category_id" uuid NOT NULL,
  "model_id" uuid,
  "source_product_name" text NOT NULL,
  "source_main_sku" text,
  "source_style_code" text,
  "source_style_name" text,
  "source_sales_spec" text,
  "source_status_raw" text NOT NULL,
  "current_source_row_id" uuid NOT NULL,
  "first_seen_batch_id" uuid NOT NULL,
  "last_seen_batch_id" uuid NOT NULL,
  "revision" integer NOT NULL DEFAULT 1,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "archived_at" timestamptz,
  "country_raw" text NOT NULL DEFAULT '',
  "sku_code_normalized" text NOT NULL DEFAULT '',
  "deleted_at" timestamptz,
  "deleted_by" text,
  "delete_reason" text,
  "restored_at" timestamptz,
  "restored_by" text,
  PRIMARY KEY ("id"),
  UNIQUE ("source_system", "normalized_sku"),
  CHECK (revision >= 1)
);

CREATE TABLE "app"."scheduled_export_run_events" (
  "id" bigint GENERATED BY DEFAULT AS IDENTITY,
  "run_id" uuid NOT NULL,
  "stage" text NOT NULL,
  "status" text NOT NULL,
  "attempt" integer NOT NULL DEFAULT 1,
  "started_at" timestamptz NOT NULL,
  "finished_at" timestamptz,
  "duration_ms" integer,
  "message" text,
  "error_code" text,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "app"."scheduled_export_runs" (
  "id" uuid,
  "task_id" uuid NOT NULL,
  "trigger_type" text NOT NULL,
  "scheduled_run_at" timestamptz NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "status" text NOT NULL,
  "payment_start_date" date,
  "payment_end_date" date,
  "raw_order_count" integer NOT NULL DEFAULT 0,
  "filtered_order_count" integer NOT NULL DEFAULT 0,
  "detail_row_count" integer NOT NULL DEFAULT 0,
  "export_file_id" uuid,
  "notification_status" text,
  "retry_count" integer NOT NULL DEFAULT 0,
  "error_stage" text,
  "error_code" text,
  "error_message" text,
  "log_summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("task_id", "scheduled_run_at")
);

CREATE TABLE "app"."scheduled_export_tasks" (
  "id" uuid,
  "task_type" text NOT NULL DEFAULT 'order_export',
  "name" text NOT NULL,
  "description" text,
  "account_profile_id" uuid NOT NULL,
  "dingtalk_config_id" uuid,
  "schedule_type" text NOT NULL,
  "schedule_config_json" jsonb NOT NULL,
  "timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
  "payment_date_mode" text NOT NULL,
  "payment_date_config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "filters_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "file_retention_days" integer,
  "notify_enabled" boolean NOT NULL DEFAULT TRUE,
  "catch_up_enabled" boolean NOT NULL DEFAULT TRUE,
  "last_run_at" timestamptz,
  "last_run_status" text,
  "next_run_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "deleted_at" timestamptz,
  "deleted_by" text,
  "delete_reason" text,
  PRIMARY KEY ("id"),
  CHECK (deleted_by IS NULL OR length(deleted_by) <= 64),
  CHECK (delete_reason IS NULL OR length(delete_reason) <= 240)
);

CREATE TABLE "app"."scheduler_leases" (
  "name" text,
  "owner_id" text NOT NULL,
  "lease_until" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("name")
);

CREATE TABLE "app"."shopee_health_appeal_events" (
  "id" uuid,
  "appeal_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "from_status" text,
  "to_status" text,
  "note" text,
  "actor_user_id" uuid,
  "actor_name" text,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id")
);

CREATE TABLE "app"."shopee_health_appeals" (
  "id" uuid,
  "issue_id" uuid NOT NULL,
  "shop_id" text NOT NULL,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending_review',
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
  "resolved_at" timestamptz,
  PRIMARY KEY ("id"),
  UNIQUE ("issue_id"),
  CHECK (status IN ('pending_review', 'preparing', 'submitted', 'waiting_result', 'approved', 'rejected', 'closed'))
);

CREATE TABLE "app"."shopee_health_issues" (
  "id" uuid,
  "fingerprint" text NOT NULL,
  "shop_id" text NOT NULL,
  "shop_code" text NOT NULL,
  "shop_name" text NOT NULL,
  "country" text NOT NULL,
  "issue_type" text NOT NULL,
  "severity" text NOT NULL,
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
  "status" text NOT NULL DEFAULT 'open',
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("fingerprint"),
  CHECK (severity IN ('warning', 'critical')),
  CHECK (status IN ('open', 'in_appeal', 'resolved'))
);

CREATE TABLE "app"."shopee_health_notifications" (
  "id" uuid,
  "notification_type" text NOT NULL,
  "severity" text NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "shop_id" text,
  "issue_id" uuid,
  "read_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE TABLE "app"."shopee_health_runs" (
  "id" uuid,
  "trigger_type" text NOT NULL,
  "scheduled_for" text,
  "status" text NOT NULL,
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
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (trigger_type IN ('scheduled', 'manual')),
  CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed'))
);

CREATE TABLE "app"."shopee_health_settings" (
  "id" uuid,
  "encrypted_token_key" text,
  "token_hint" text,
  "token_verified_at" timestamptz,
  "token_shop_count" integer NOT NULL DEFAULT 0,
  "schedule_time" text NOT NULL DEFAULT '09:00',
  "timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
  "retry_count" integer NOT NULL DEFAULT 3,
  "warning_ratio" double precision NOT NULL DEFAULT 0.10,
  "dingtalk_config_id" uuid,
  "site_notifications_enabled" integer NOT NULL DEFAULT 1,
  "dingtalk_notifications_enabled" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "last_key_error" text,
  "updated_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("id"),
  CHECK (id = 'default'),
  CHECK (retry_count BETWEEN 0 AND 5),
  CHECK (warning_ratio >= 0 AND warning_ratio <= 1)
);

CREATE TABLE "app"."shopee_health_snapshots" (
  "id" uuid,
  "run_id" uuid NOT NULL,
  "snapshot_date" date NOT NULL,
  "shop_id" text NOT NULL,
  "shop_code" text NOT NULL,
  "shop_name" text NOT NULL,
  "country" text NOT NULL,
  "status" text NOT NULL,
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
  PRIMARY KEY ("id"),
  UNIQUE ("snapshot_date", "shop_id"),
  CHECK (status IN ('healthy', 'warning', 'critical', 'unavailable'))
);

CREATE TABLE "app"."shopee_health_thresholds" (
  "metric_id" integer,
  "metric_name" text NOT NULL,
  "warning_value" double precision,
  "enabled" boolean NOT NULL DEFAULT TRUE,
  "updated_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  PRIMARY KEY ("metric_id")
);

ALTER TABLE "app"."advertising_performance_facts" ADD CONSTRAINT "fk_advertising_performance_facts_1" FOREIGN KEY ("batch_id") REFERENCES "app"."advertising_source_batches" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."export_files" ADD CONSTRAINT "fk_export_files_1" FOREIGN KEY ("run_id") REFERENCES "app"."scheduled_export_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."export_files" ADD CONSTRAINT "fk_export_files_2" FOREIGN KEY ("task_id") REFERENCES "app"."scheduled_export_tasks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_lifecycle_items" ADD CONSTRAINT "fk_file_lifecycle_items_1" FOREIGN KEY ("scan_id") REFERENCES "app"."file_lifecycle_scans" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."file_lifecycle_protected_files" ADD CONSTRAINT "fk_file_lifecycle_protected_files_1" FOREIGN KEY ("file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."file_lifecycle_scans" ADD CONSTRAINT "fk_file_lifecycle_scans_1" FOREIGN KEY ("report_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_quarantine_records" ADD CONSTRAINT "fk_file_quarantine_records_1" FOREIGN KEY ("managed_file_id") REFERENCES "app"."managed_files" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_quarantine_records" ADD CONSTRAINT "fk_file_quarantine_records_2" FOREIGN KEY ("lifecycle_item_id") REFERENCES "app"."file_lifecycle_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_account_capabilities" ADD CONSTRAINT "fk_foundation_account_capabilities_1" FOREIGN KEY ("account_id") REFERENCES "app"."foundation_integration_accounts" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_identity_links" ADD CONSTRAINT "fk_foundation_identity_links_1" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_integration_accounts" ADD CONSTRAINT "fk_foundation_integration_accounts_1" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_operation_plan_events" ADD CONSTRAINT "fk_foundation_operation_plan_events_1" FOREIGN KEY ("plan_id") REFERENCES "app"."foundation_operation_plans" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_operation_plans" ADD CONSTRAINT "fk_foundation_operation_plans_1" FOREIGN KEY ("task_id") REFERENCES "app"."foundation_tasks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_owners" ADD CONSTRAINT "fk_foundation_owners_1" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_source_runs" ADD CONSTRAINT "fk_foundation_source_runs_1" FOREIGN KEY ("account_id") REFERENCES "app"."foundation_integration_accounts" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_source_runs" ADD CONSTRAINT "fk_foundation_source_runs_2" FOREIGN KEY ("source_system_code") REFERENCES "app"."foundation_source_systems" ("code") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."foundation_task_events" ADD CONSTRAINT "fk_foundation_task_events_1" FOREIGN KEY ("task_id") REFERENCES "app"."foundation_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_task_leases" ADD CONSTRAINT "fk_foundation_task_leases_1" FOREIGN KEY ("task_id") REFERENCES "app"."foundation_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_2" FOREIGN KEY ("warehouse_id") REFERENCES "app"."foundation_warehouses" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_3" FOREIGN KEY ("store_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_4" FOREIGN KEY ("owner_id") REFERENCES "app"."foundation_owners" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_5" FOREIGN KEY ("source_run_id") REFERENCES "app"."foundation_source_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."foundation_tasks" ADD CONSTRAINT "fk_foundation_tasks_6" FOREIGN KEY ("account_id") REFERENCES "app"."foundation_integration_accounts" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."growth_analysis_runs" ADD CONSTRAINT "fk_growth_analysis_runs_1" FOREIGN KEY ("country_mapping_set_id") REFERENCES "app"."growth_country_mapping_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_analysis_runs" ADD CONSTRAINT "fk_growth_analysis_runs_2" FOREIGN KEY ("rule_set_id") REFERENCES "app"."growth_rule_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_analysis_runs" ADD CONSTRAINT "fk_growth_analysis_runs_3" FOREIGN KEY ("inventory_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_data_quality_issues" ADD CONSTRAINT "fk_growth_data_quality_issues_1" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_item_events" ADD CONSTRAINT "fk_growth_focus_item_events_1" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_item_events" ADD CONSTRAINT "fk_growth_focus_item_events_2" FOREIGN KEY ("signal_id") REFERENCES "app"."growth_signals" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_item_events" ADD CONSTRAINT "fk_growth_focus_item_events_3" FOREIGN KEY ("focus_item_id") REFERENCES "app"."growth_focus_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_1" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_2" FOREIGN KEY ("last_analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_3" FOREIGN KEY ("first_analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_focus_items" ADD CONSTRAINT "fk_growth_focus_items_4" FOREIGN KEY ("current_signal_id") REFERENCES "app"."growth_signals" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_inventory_raw_rows" ADD CONSTRAINT "fk_growth_inventory_raw_rows_1" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_inventory_snapshots" ADD CONSTRAINT "fk_growth_inventory_snapshots_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_inventory_snapshots" ADD CONSTRAINT "fk_growth_inventory_snapshots_2" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_mapping_issues" ADD CONSTRAINT "fk_growth_mapping_issues_1" FOREIGN KEY ("source_row_id") REFERENCES "app"."growth_order_raw_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_mapping_issues" ADD CONSTRAINT "fk_growth_mapping_issues_2" FOREIGN KEY ("source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_headers" ADD CONSTRAINT "fk_growth_order_headers_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_headers" ADD CONSTRAINT "fk_growth_order_headers_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_headers" ADD CONSTRAINT "fk_growth_order_headers_3" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_1" FOREIGN KEY ("inventory_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_2" FOREIGN KEY ("inventory_snapshot_id") REFERENCES "app"."growth_inventory_snapshots" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_3" FOREIGN KEY ("order_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_inventory_links" ADD CONSTRAINT "fk_growth_order_inventory_links_4" FOREIGN KEY ("order_line_id") REFERENCES "app"."growth_order_lines" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_2" FOREIGN KEY ("source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_3" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_lines" ADD CONSTRAINT "fk_growth_order_lines_4" FOREIGN KEY ("order_header_id") REFERENCES "app"."growth_order_headers" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_order_raw_rows" ADD CONSTRAINT "fk_growth_order_raw_rows_1" FOREIGN KEY ("batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_daily_metrics" ADD CONSTRAINT "fk_growth_shop_daily_metrics_1" FOREIGN KEY ("country_mapping_set_id") REFERENCES "app"."growth_country_mapping_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_daily_metrics" ADD CONSTRAINT "fk_growth_shop_daily_metrics_2" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_daily_metrics" ADD CONSTRAINT "fk_growth_shop_daily_metrics_3" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_coverage_snapshots" ADD CONSTRAINT "fk_growth_shop_sku_coverage_snapshots_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_coverage_snapshots" ADD CONSTRAINT "fk_growth_shop_sku_coverage_snapshots_2" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_daily_metrics" ADD CONSTRAINT "fk_growth_shop_sku_daily_metrics_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_daily_metrics" ADD CONSTRAINT "fk_growth_shop_sku_daily_metrics_2" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_daily_metrics" ADD CONSTRAINT "fk_growth_shop_sku_daily_metrics_3" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_1" FOREIGN KEY ("last_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_3" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_sku_observations" ADD CONSTRAINT "fk_growth_shop_sku_observations_4" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_source_mappings" ADD CONSTRAINT "fk_growth_shop_source_mappings_1" FOREIGN KEY ("last_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_source_mappings" ADD CONSTRAINT "fk_growth_shop_source_mappings_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_shop_source_mappings" ADD CONSTRAINT "fk_growth_shop_source_mappings_3" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_signals" ADD CONSTRAINT "fk_growth_signals_1" FOREIGN KEY ("internal_shop_id") REFERENCES "app"."growth_shops" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_signals" ADD CONSTRAINT "fk_growth_signals_2" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_daily_metrics" ADD CONSTRAINT "fk_growth_sku_daily_metrics_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_daily_metrics" ADD CONSTRAINT "fk_growth_sku_daily_metrics_2" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_daily_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_daily_metrics_1" FOREIGN KEY ("mapped_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_daily_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_daily_metrics_2" FOREIGN KEY ("analysis_run_id") REFERENCES "app"."growth_analysis_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_sales_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_sales_metrics_1" FOREIGN KEY ("order_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_sales_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_sales_metrics_2" FOREIGN KEY ("inventory_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_sku_warehouse_sales_metrics" ADD CONSTRAINT "fk_growth_sku_warehouse_sales_metrics_3" FOREIGN KEY ("inventory_snapshot_id") REFERENCES "app"."growth_inventory_snapshots" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_source_batches" ADD CONSTRAINT "fk_growth_source_batches_1" FOREIGN KEY ("source_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."growth_warehouse_country_mappings" ADD CONSTRAINT "fk_growth_warehouse_country_mappings_1" FOREIGN KEY ("mapping_set_id") REFERENCES "app"."growth_country_mapping_sets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_filter_option_cache" ADD CONSTRAINT "fk_mabang_filter_option_cache_1" FOREIGN KEY ("account_profile_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_batches" ADD CONSTRAINT "fk_mabang_sku_image_batches_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."mabang_sku_image_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_sku_image_batches" ADD CONSTRAINT "fk_mabang_sku_image_batches_2" FOREIGN KEY ("account_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_sku_image_batches" ADD CONSTRAINT "fk_mabang_sku_image_batches_3" FOREIGN KEY ("sync_run_id") REFERENCES "app"."mabang_sku_image_sync_runs" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_sku_image_checkpoints" ADD CONSTRAINT "fk_mabang_sku_image_checkpoints_1" FOREIGN KEY ("batch_id") REFERENCES "app"."mabang_sku_image_batches" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_discoveries" ADD CONSTRAINT "fk_mabang_sku_image_discoveries_1" FOREIGN KEY ("asset_id") REFERENCES "app"."product_media_assets" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."mabang_sku_image_discoveries" ADD CONSTRAINT "fk_mabang_sku_image_discoveries_2" FOREIGN KEY ("batch_id") REFERENCES "app"."mabang_sku_image_batches" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_discovery_images" ADD CONSTRAINT "fk_mabang_sku_image_discovery_images_1" FOREIGN KEY ("asset_id") REFERENCES "app"."product_media_assets" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."mabang_sku_image_discovery_images" ADD CONSTRAINT "fk_mabang_sku_image_discovery_images_2" FOREIGN KEY ("discovery_id") REFERENCES "app"."mabang_sku_image_discoveries" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."mabang_sku_image_sync_runs" ADD CONSTRAINT "fk_mabang_sku_image_sync_runs_1" FOREIGN KEY ("account_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."managed_files" ADD CONSTRAINT "fk_managed_files_1" FOREIGN KEY ("scan_id") REFERENCES "app"."file_lifecycle_scans" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."managed_files" ADD CONSTRAINT "fk_managed_files_2" FOREIGN KEY ("lifecycle_item_id") REFERENCES "app"."file_lifecycle_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_ai_contents" ADD CONSTRAINT "fk_product_ai_contents_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_3" FOREIGN KEY ("parent_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_cost_snapshots" ADD CONSTRAINT "fk_product_cost_snapshots_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_cost_snapshots" ADD CONSTRAINT "fk_product_cost_snapshots_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_field_override_events" ADD CONSTRAINT "fk_product_field_override_events_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_field_overrides" ADD CONSTRAINT "fk_product_field_overrides_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_identity_mappings" ADD CONSTRAINT "fk_product_identity_mappings_1" FOREIGN KEY ("last_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_identity_mappings" ADD CONSTRAINT "fk_product_identity_mappings_2" FOREIGN KEY ("first_source_batch_id") REFERENCES "app"."growth_source_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_identity_mappings" ADD CONSTRAINT "fk_product_identity_mappings_3" FOREIGN KEY ("internal_product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_image_generation_items" ADD CONSTRAINT "fk_product_image_generation_items_1" FOREIGN KEY ("task_id") REFERENCES "app"."product_image_generation_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."product_image_generation_tasks" ADD CONSTRAINT "fk_product_image_generation_tasks_1" FOREIGN KEY ("listing_draft_id") REFERENCES "app"."product_listing_drafts" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."product_image_generation_tasks" ADD CONSTRAINT "fk_product_image_generation_tasks_2" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_images" ADD CONSTRAINT "fk_product_images_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_field_changes" ADD CONSTRAINT "fk_product_import_field_changes_1" FOREIGN KEY ("product_package_row_id") REFERENCES "app"."product_package_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_field_changes" ADD CONSTRAINT "fk_product_import_field_changes_2" FOREIGN KEY ("import_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_field_changes" ADD CONSTRAINT "fk_product_import_field_changes_3" FOREIGN KEY ("import_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_files" ADD CONSTRAINT "fk_product_import_files_1" FOREIGN KEY ("export_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_files" ADD CONSTRAINT "fk_product_import_files_2" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_issues" ADD CONSTRAINT "fk_product_import_issues_1" FOREIGN KEY ("row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_issues" ADD CONSTRAINT "fk_product_import_issues_2" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_import_rows" ADD CONSTRAINT "fk_product_import_rows_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_inventory_snapshots" ADD CONSTRAINT "fk_product_inventory_snapshots_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_inventory_snapshots" ADD CONSTRAINT "fk_product_inventory_snapshots_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_listing_drafts" ADD CONSTRAINT "fk_product_listing_drafts_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_listing_publish_records" ADD CONSTRAINT "fk_product_listing_publish_records_1" FOREIGN KEY ("listing_draft_id") REFERENCES "app"."product_listing_drafts" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_media_links" ADD CONSTRAINT "fk_product_media_links_1" FOREIGN KEY ("product_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_media_links" ADD CONSTRAINT "fk_product_media_links_2" FOREIGN KEY ("asset_id") REFERENCES "app"."product_media_assets" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_models" ADD CONSTRAINT "fk_product_models_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_models" ADD CONSTRAINT "fk_product_models_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_models" ADD CONSTRAINT "fk_product_models_3" FOREIGN KEY ("category_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_1" FOREIGN KEY ("latest_import_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_2" FOREIGN KEY ("latest_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_3" FOREIGN KEY ("import_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_package_rows" ADD CONSTRAINT "fk_product_package_rows_4" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_packaging_profiles" ADD CONSTRAINT "fk_product_packaging_profiles_1" FOREIGN KEY ("source_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_packaging_profiles" ADD CONSTRAINT "fk_product_packaging_profiles_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle" ADD CONSTRAINT "fk_product_sku_lifecycle_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle" ADD CONSTRAINT "fk_product_sku_lifecycle_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle_events" ADD CONSTRAINT "fk_product_sku_lifecycle_events_1" FOREIGN KEY ("source_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_sku_lifecycle_events" ADD CONSTRAINT "fk_product_sku_lifecycle_events_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_3" FOREIGN KEY ("current_source_row_id") REFERENCES "app"."product_import_rows" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_4" FOREIGN KEY ("model_id") REFERENCES "app"."product_models" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."product_skus" ADD CONSTRAINT "fk_product_skus_5" FOREIGN KEY ("category_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."scheduled_export_run_events" ADD CONSTRAINT "fk_scheduled_export_run_events_1" FOREIGN KEY ("run_id") REFERENCES "app"."scheduled_export_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."scheduled_export_runs" ADD CONSTRAINT "fk_scheduled_export_runs_1" FOREIGN KEY ("task_id") REFERENCES "app"."scheduled_export_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."scheduled_export_tasks" ADD CONSTRAINT "fk_scheduled_export_tasks_1" FOREIGN KEY ("dingtalk_config_id") REFERENCES "app"."dingtalk_robot_configs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."scheduled_export_tasks" ADD CONSTRAINT "fk_scheduled_export_tasks_2" FOREIGN KEY ("account_profile_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."shopee_health_appeal_events" ADD CONSTRAINT "fk_shopee_health_appeal_events_1" FOREIGN KEY ("appeal_id") REFERENCES "app"."shopee_health_appeals" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."shopee_health_appeals" ADD CONSTRAINT "fk_shopee_health_appeals_1" FOREIGN KEY ("issue_id") REFERENCES "app"."shopee_health_issues" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."shopee_health_notifications" ADD CONSTRAINT "fk_shopee_health_notifications_1" FOREIGN KEY ("issue_id") REFERENCES "app"."shopee_health_issues" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."shopee_health_settings" ADD CONSTRAINT "fk_shopee_health_settings_1" FOREIGN KEY ("dingtalk_config_id") REFERENCES "app"."dingtalk_robot_configs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."shopee_health_snapshots" ADD CONSTRAINT "fk_shopee_health_snapshots_1" FOREIGN KEY ("run_id") REFERENCES "app"."shopee_health_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

CREATE INDEX "idx_advertising_performance_facts_start_date" ON "app"."advertising_performance_facts" ("shop_id", "start_date", "ad_key");

CREATE INDEX "idx_advertising_performance_facts_identity" ON "app"."advertising_performance_facts" ("shop_id", "product_id", "ad_name");

CREATE INDEX "idx_advertising_performance_facts_batch" ON "app"."advertising_performance_facts" ("batch_id", "expense" DESC);

CREATE INDEX "idx_advertising_source_batches_shop_period" ON "app"."advertising_source_batches" ("shop_id", "period_to" DESC, "period_days", "imported_at" DESC);

CREATE INDEX "idx_advertising_target_policies_active" ON "app"."advertising_target_policies" ("shop_id", "target_key", "effective_from" DESC, "effective_to");

CREATE UNIQUE INDEX "idx_export_files_request_key" ON "app"."export_files" ("request_key") WHERE request_key IS NOT NULL;

CREATE INDEX "idx_export_files_status" ON "app"."export_files" ("status", "created_at" DESC);

CREATE INDEX "idx_export_files_run_id" ON "app"."export_files" ("run_id");

CREATE INDEX "idx_export_files_task_id" ON "app"."export_files" ("task_id", "created_at" DESC);

CREATE INDEX "idx_export_files_source_type" ON "app"."export_files" ("source_type", "created_at" DESC);

CREATE INDEX "idx_export_files_created_at" ON "app"."export_files" ("created_at" DESC);

CREATE INDEX "idx_export_files_expiry" ON "app"."export_files" ("status", "expires_at");

CREATE INDEX "idx_lifecycle_items_review" ON "app"."file_lifecycle_items" ("scan_id", "review_status", "detected_file_type");

CREATE INDEX "idx_lifecycle_items_file" ON "app"."file_lifecycle_items" ("file_id");

CREATE INDEX "idx_lifecycle_items_source" ON "app"."file_lifecycle_items" ("scan_id", "source_type");

CREATE INDEX "idx_lifecycle_items_scan" ON "app"."file_lifecycle_items" ("scan_id", "classification", "created_at" DESC);

CREATE INDEX "idx_lifecycle_scans_status" ON "app"."file_lifecycle_scans" ("status", "created_at" DESC);

CREATE INDEX "idx_lifecycle_scans_created" ON "app"."file_lifecycle_scans" ("created_at" DESC);

CREATE INDEX "idx_quarantine_records_status" ON "app"."file_quarantine_records" ("status", "quarantined_at" DESC);

CREATE INDEX "idx_foundation_capabilities_lookup" ON "app"."foundation_account_capabilities" ("capability_code", "status", "account_id");

CREATE INDEX "idx_foundation_identity_entity" ON "app"."foundation_identity_links" ("entity_type", "entity_id", "match_status");

CREATE INDEX "idx_foundation_accounts_source_status" ON "app"."foundation_integration_accounts" ("source_system_code", "status", "display_name");

CREATE INDEX "idx_foundation_operation_plan_events_history" ON "app"."foundation_operation_plan_events" ("plan_id", "plan_version" DESC);

CREATE INDEX "idx_foundation_operation_plans_type" ON "app"."foundation_operation_plans" ("operation_type", "state", "created_at" DESC);

CREATE INDEX "idx_foundation_operation_plans_task" ON "app"."foundation_operation_plans" ("task_id", "created_at" DESC);

CREATE INDEX "idx_foundation_operation_plans_state" ON "app"."foundation_operation_plans" ("state", "expires_at", "updated_at" DESC);

CREATE INDEX "idx_foundation_owners_status_name" ON "app"."foundation_owners" ("status", "display_name");

CREATE INDEX "idx_foundation_source_runs_status" ON "app"."foundation_source_runs" ("domain", "status", "created_at" DESC);

CREATE INDEX "idx_foundation_task_events_history" ON "app"."foundation_task_events" ("task_id", "task_version" DESC);

CREATE INDEX "idx_foundation_task_leases_expiry" ON "app"."foundation_task_leases" ("expires_at");

CREATE INDEX "idx_foundation_tasks_owner" ON "app"."foundation_tasks" ("owner_id", "state", "priority", "updated_at" DESC);

CREATE INDEX "idx_foundation_tasks_domain" ON "app"."foundation_tasks" ("domain", "task_kind", "state", "updated_at" DESC);

CREATE INDEX "idx_foundation_tasks_queue" ON "app"."foundation_tasks" ("state", "priority", "available_at", "created_at");

CREATE INDEX "idx_foundation_warehouses_country_status" ON "app"."foundation_warehouses" ("country_code", "identity_status", "display_name");

CREATE INDEX "idx_growth_analysis_runs_inventory" ON "app"."growth_analysis_runs" ("inventory_batch_id", "created_at" DESC);

CREATE INDEX "idx_growth_analysis_runs_published" ON "app"."growth_analysis_runs" ("status", "analysis_date" DESC, "published_at" DESC);

CREATE UNIQUE INDEX "uq_growth_country_mapping_sets_active" ON "app"."growth_country_mapping_sets" ("status") WHERE status = 'active';

CREATE INDEX "idx_growth_data_quality_status" ON "app"."growth_data_quality_issues" ("status", "severity", "created_at" DESC);

CREATE INDEX "idx_growth_focus_item_events_analysis" ON "app"."growth_focus_item_events" ("analysis_run_id", "event_type", "occurred_at" DESC);

CREATE INDEX "idx_growth_focus_item_events_history" ON "app"."growth_focus_item_events" ("focus_item_id", "task_revision" DESC);

CREATE INDEX "idx_growth_focus_items_warehouse" ON "app"."growth_focus_items" ("country_code", "normalized_warehouse_name", "normalized_source_sku", "status", "priority");

CREATE INDEX "idx_growth_focus_items_latest_run" ON "app"."growth_focus_items" ("last_analysis_run_id", "is_hit_in_latest_run", "task_type");

CREATE INDEX "idx_growth_focus_items_shop_queue" ON "app"."growth_focus_items" ("internal_shop_id", "status", "priority", "last_detected_at" DESC);

CREATE INDEX "idx_growth_focus_items_owner_queue" ON "app"."growth_focus_items" ("owner_user_id", "status", "priority", "is_hit_in_latest_run", "last_detected_at" DESC);

CREATE UNIQUE INDEX "uq_growth_focus_items_active_task" ON "app"."growth_focus_items" ("task_key") WHERE status IN (
    'NEW',
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'MONITORING',
    'BLOCKED',
    'REOPENED'
  );

CREATE INDEX "idx_growth_inventory_raw_rows_hash" ON "app"."growth_inventory_raw_rows" ("row_hash");

CREATE INDEX "idx_growth_inventory_snapshots_warehouse" ON "app"."growth_inventory_snapshots" ("normalized_warehouse_name", "snapshot_at");

CREATE UNIQUE INDEX "uq_growth_inventory_snapshot_grain" ON "app"."growth_inventory_snapshots" ("snapshot_at", "normalized_source_sku", "normalized_warehouse_name") WHERE normalized_source_sku <> '' AND normalized_warehouse_name <> '';

CREATE INDEX "idx_growth_inventory_snapshots_sku" ON "app"."growth_inventory_snapshots" ("normalized_source_sku", "snapshot_at");

CREATE INDEX "idx_growth_mapping_events_mapping" ON "app"."growth_mapping_events" ("mapping_type", "mapping_id", "occurred_at" DESC);

CREATE INDEX "idx_growth_mapping_issues_status" ON "app"."growth_mapping_issues" ("issue_type", "status", "created_at" DESC);

CREATE INDEX "idx_growth_order_headers_shop" ON "app"."growth_order_headers" ("platform", "normalized_source_shop_name", "paid_at");

CREATE INDEX "idx_growth_order_headers_batch" ON "app"."growth_order_headers" ("source_batch_id", "effective_status");

CREATE INDEX "idx_growth_order_inventory_links_batch_status" ON "app"."growth_order_inventory_links" ("inventory_source_batch_id", "match_status", "is_current");

CREATE INDEX "idx_growth_order_lines_sku_warehouse" ON "app"."growth_order_lines" ("normalized_source_sku", "normalized_source_warehouse_name", "is_current");

CREATE INDEX "idx_growth_order_lines_sku" ON "app"."growth_order_lines" ("normalized_source_sku", "mapped_country", "mapping_status");

CREATE INDEX "idx_growth_order_lines_order" ON "app"."growth_order_lines" ("order_header_id", "is_current", "source_row_number");

CREATE INDEX "idx_growth_order_raw_rows_hash" ON "app"."growth_order_raw_rows" ("row_hash");

CREATE UNIQUE INDEX "uq_growth_rule_sets_active" ON "app"."growth_rule_sets" ("status") WHERE status = 'active';

CREATE INDEX "idx_growth_shop_metrics_run" ON "app"."growth_shop_daily_metrics" ("analysis_run_id", "platform", "owner_user_id", "display_name");

CREATE INDEX "idx_growth_shop_sku_coverage_current" ON "app"."growth_shop_sku_coverage_snapshots" ("internal_shop_id", "expires_at" DESC);

CREATE INDEX "idx_growth_shop_sku_metrics_sales" ON "app"."growth_shop_sku_daily_metrics" ("analysis_run_id", "internal_shop_id", "own_sales_quantity_28d" DESC);

CREATE INDEX "idx_growth_shop_sku_metrics_focus" ON "app"."growth_shop_sku_daily_metrics" ("analysis_run_id", "internal_shop_id", "is_growth_focus_candidate", "is_key_performer");

CREATE INDEX "idx_growth_shop_sku_observations_shop" ON "app"."growth_shop_sku_observations" ("internal_shop_id", "normalized_source_sku", "last_observed_at" DESC);

CREATE INDEX "idx_growth_shop_mappings_status" ON "app"."growth_shop_source_mappings" ("mapping_status", "platform", "updated_at" DESC);

CREATE INDEX "idx_growth_shops_platform_country" ON "app"."growth_shops" ("platform", "country_code", "status");

CREATE INDEX "idx_growth_signals_warehouse" ON "app"."growth_signals" ("analysis_run_id", "country_code", "normalized_warehouse_name", "normalized_source_sku", "signal_type");

CREATE INDEX "idx_growth_signals_shop" ON "app"."growth_signals" ("analysis_run_id", "internal_shop_id", "signal_type", "severity");

CREATE INDEX "idx_growth_signals_sku" ON "app"."growth_signals" ("analysis_run_id", "normalized_source_sku", "internal_shop_id");

CREATE INDEX "idx_growth_signals_type" ON "app"."growth_signals" ("analysis_run_id", "signal_type", "severity", "rule_code");

CREATE INDEX "idx_growth_sku_metrics_product" ON "app"."growth_sku_daily_metrics" ("mapped_product_id", "analysis_date" DESC);

CREATE INDEX "idx_growth_sku_metrics_status" ON "app"."growth_sku_daily_metrics" ("analysis_run_id", "product_status", "quality_status");

CREATE INDEX "idx_growth_sku_metrics_supply_summary" ON "app"."growth_sku_daily_metrics" ("analysis_run_id", "scope_type", "scope_key", "supply_risk_warehouse_count" DESC);

CREATE INDEX "idx_growth_sku_metrics_demand" ON "app"."growth_sku_daily_metrics" ("analysis_run_id", "scope_type", "scope_key", "category_l2", "assortment_percentile" DESC);

CREATE INDEX "idx_growth_sku_warehouse_metrics_product" ON "app"."growth_sku_warehouse_daily_metrics" ("mapped_product_id", "analysis_date" DESC);

CREATE INDEX "idx_growth_sku_warehouse_metrics_sku" ON "app"."growth_sku_warehouse_daily_metrics" ("analysis_run_id", "country_code", "normalized_source_sku", "normalized_warehouse_name");

CREATE INDEX "idx_growth_sku_warehouse_metrics_risk" ON "app"."growth_sku_warehouse_daily_metrics" ("analysis_run_id", "country_code", "supply_status", "source_current_sellable_days", "normalized_warehouse_name");

CREATE INDEX "idx_growth_sku_warehouse_sales_metrics_grain" ON "app"."growth_sku_warehouse_sales_metrics" ("snapshot_at", "normalized_source_sku", "normalized_source_warehouse_name");

CREATE INDEX "idx_growth_source_batches_hash" ON "app"."growth_source_batches" ("source_type", "source_sha256");

CREATE INDEX "idx_growth_source_batches_type_created" ON "app"."growth_source_batches" ("source_type", "created_at" DESC);

CREATE INDEX "idx_growth_warehouse_country_mappings_country" ON "app"."growth_warehouse_country_mappings" ("mapping_set_id", "country_code", "mapping_status");

CREATE INDEX "idx_mabang_sku_image_batches_sync_run" ON "app"."mabang_sku_image_batches" ("sync_run_id", "segment_no");

CREATE UNIQUE INDEX "uq_mabang_sku_image_batches_sync_segment" ON "app"."mabang_sku_image_batches" ("sync_run_id", "segment_no") WHERE sync_run_id IS NOT NULL;

CREATE INDEX "idx_mabang_sku_image_batches_account" ON "app"."mabang_sku_image_batches" ("account_id", "created_at" DESC);

CREATE INDEX "idx_mabang_sku_image_batches_status" ON "app"."mabang_sku_image_batches" ("status", "created_at" DESC);

CREATE INDEX "idx_mabang_sku_image_checkpoints_batch" ON "app"."mabang_sku_image_checkpoints" ("batch_id", "page_number");

CREATE INDEX "idx_mabang_sku_image_discoveries_failed" ON "app"."mabang_sku_image_discoveries" ("batch_id", "download_status", "error_code");

CREATE INDEX "idx_mabang_sku_image_discoveries_sku" ON "app"."mabang_sku_image_discoveries" ("source_sku_normalized", "download_status");

CREATE INDEX "idx_mabang_sku_image_discoveries_batch" ON "app"."mabang_sku_image_discoveries" ("batch_id", "source_page", "source_row_number");

CREATE INDEX "idx_mabang_sku_image_discovery_images_url_asset" ON "app"."mabang_sku_image_discovery_images" ("source_url_hash", "asset_id");

CREATE INDEX "idx_mabang_sku_image_discovery_images_asset" ON "app"."mabang_sku_image_discovery_images" ("asset_id");

CREATE INDEX "idx_mabang_sku_image_discovery_images_status" ON "app"."mabang_sku_image_discovery_images" ("download_status", "last_checked_at");

CREATE INDEX "idx_mabang_sku_image_discovery_images_discovery" ON "app"."mabang_sku_image_discovery_images" ("discovery_id", "image_index");

CREATE INDEX "idx_mabang_sku_image_sync_runs_account" ON "app"."mabang_sku_image_sync_runs" ("account_id", "created_at" DESC);

CREATE INDEX "idx_mabang_sku_image_sync_runs_status" ON "app"."mabang_sku_image_sync_runs" ("status", "created_at" DESC);

CREATE INDEX "idx_managed_files_job" ON "app"."managed_files" ("job_id", "source_type");

CREATE INDEX "idx_managed_files_source" ON "app"."managed_files" ("source_type", "status", "registered_at" DESC);

CREATE INDEX "idx_operation_audit_status" ON "app"."operation_audit_events" ("status", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_action" ON "app"."operation_audit_events" ("action", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_module" ON "app"."operation_audit_events" ("module", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_occurred_at" ON "app"."operation_audit_events" ("occurred_at" DESC);

CREATE INDEX "idx_product_ai_contents_context" ON "app"."product_ai_contents" ("product_sku_id", "context_hash", "created_at" DESC);

CREATE INDEX "idx_product_ai_contents_listing_type" ON "app"."product_ai_contents" ("listing_draft_id", "content_type", "created_at" DESC);

CREATE INDEX "idx_product_ai_contents_country_sku" ON "app"."product_ai_contents" ("country", "sku", "status", "updated_at" DESC);

CREATE INDEX "idx_product_ai_contents_product_status" ON "app"."product_ai_contents" ("product_sku_id", "content_type", "status", "version" DESC);

CREATE INDEX "idx_product_categories_parent" ON "app"."product_categories" ("parent_id", "status", "normalized_name");

CREATE INDEX "idx_product_cost_snapshots_sku" ON "app"."product_cost_snapshots" ("sku_id", "created_at" DESC);

CREATE INDEX "idx_product_override_events_sku" ON "app"."product_field_override_events" ("sku_id", "occurred_at" DESC);

CREATE INDEX "idx_product_field_overrides_active" ON "app"."product_field_overrides" ("sku_id", "deleted_at", "field_code");

CREATE INDEX "idx_product_identity_mappings_status" ON "app"."product_identity_mappings" ("mapping_status", "platform", "country_code", "updated_at" DESC);

CREATE INDEX "idx_product_image_generation_items_status" ON "app"."product_image_generation_items" ("status", "updated_at");

CREATE INDEX "idx_product_image_generation_items_task" ON "app"."product_image_generation_items" ("task_id", "slot_index");

CREATE INDEX "idx_product_image_generation_tasks_status" ON "app"."product_image_generation_tasks" ("status", "updated_at");

CREATE INDEX "idx_product_image_generation_tasks_product" ON "app"."product_image_generation_tasks" ("product_sku_id", "created_at" DESC);

CREATE INDEX "idx_product_images_sku" ON "app"."product_images" ("sku_id", "status", "is_primary" DESC, "sort_order", "created_at");

CREATE INDEX "idx_product_import_batches_status_created" ON "app"."product_import_batches" ("status", "created_at" DESC);

CREATE UNIQUE INDEX "idx_product_import_batches_file" ON "app"."product_import_batches" ("source_system", "file_sha256");

CREATE INDEX "idx_product_import_field_changes_filter" ON "app"."product_import_field_changes" ("import_batch_id", "country_raw", "sku_code", "field_name");

CREATE INDEX "idx_product_import_field_changes_batch" ON "app"."product_import_field_changes" ("import_batch_id", "source_row_number", "field_name");

CREATE INDEX "idx_product_import_issues_batch" ON "app"."product_import_issues" ("batch_id", "severity", "status", "source_row_number");

CREATE INDEX "idx_product_import_rows_source_identity" ON "app"."product_import_rows" ("batch_id", "source_row_key", "source_row_number");

CREATE INDEX "idx_product_import_rows_product_key" ON "app"."product_import_rows" ("product_key", "batch_id");

CREATE INDEX "idx_product_import_rows_source_sku" ON "app"."product_import_rows" ("source_sku");

CREATE INDEX "idx_product_import_rows_batch_outcome" ON "app"."product_import_rows" ("batch_id", "outcome", "source_row_number");

CREATE INDEX "idx_product_inventory_snapshots_sku" ON "app"."product_inventory_snapshots" ("sku_id", "captured_at" DESC);

CREATE INDEX "idx_product_listing_drafts_target" ON "app"."product_listing_drafts" ("platform", "country", "shop_key", "status");

CREATE INDEX "idx_product_listing_drafts_product" ON "app"."product_listing_drafts" ("product_sku_id", "status", "updated_at" DESC);

CREATE UNIQUE INDEX "uq_product_listing_drafts_active_target" ON "app"."product_listing_drafts" ("product_sku_id", "platform", "country", "shop_key") WHERE deleted_at IS NULL;

CREATE INDEX "idx_product_listing_publish_records_draft" ON "app"."product_listing_publish_records" ("listing_draft_id", "created_at" DESC);

CREATE INDEX "idx_product_media_assets_status" ON "app"."product_media_assets" ("status", "created_at" DESC);

CREATE INDEX "idx_product_media_assets_source" ON "app"."product_media_assets" ("source_system", "created_at" DESC);

CREATE INDEX "idx_product_media_links_sku" ON "app"."product_media_links" ("source_sku_normalized", "country_code", "mapping_status");

CREATE INDEX "idx_product_media_links_product" ON "app"."product_media_links" ("product_id", "mapping_status", "media_role", "linked_at");

CREATE INDEX "idx_product_package_rows_latest_batch" ON "app"."product_package_rows" ("latest_batch_id", "latest_source_row_number");

CREATE INDEX "idx_product_package_rows_product" ON "app"."product_package_rows" ("country_normalized", "sku_normalized", "warehouse_normalized", "row_occurrence");

CREATE INDEX "idx_product_sku_lifecycle_status" ON "app"."product_sku_lifecycle" ("status_code", "updated_at" DESC);

CREATE INDEX "idx_product_lifecycle_events_sku" ON "app"."product_sku_lifecycle_events" ("sku_id", "occurred_at" DESC);

CREATE INDEX "idx_product_skus_deleted" ON "app"."product_skus" ("deleted_at", "country_raw", "sku_code_normalized");

CREATE INDEX "idx_product_skus_sku_code" ON "app"."product_skus" ("sku_code_normalized", "country_raw");

CREATE UNIQUE INDEX "idx_product_skus_country_sku" ON "app"."product_skus" ("source_system", "country_raw", "sku_code_normalized");

CREATE INDEX "idx_product_skus_name" ON "app"."product_skus" ("source_product_name");

CREATE INDEX "idx_product_skus_category" ON "app"."product_skus" ("category_id", "archived_at");

CREATE INDEX "idx_product_skus_model" ON "app"."product_skus" ("model_id", "archived_at");

CREATE INDEX "idx_run_events_run" ON "app"."scheduled_export_run_events" ("run_id", "id");

CREATE INDEX "idx_scheduled_export_runs_task" ON "app"."scheduled_export_runs" ("task_id", "created_at" DESC);

CREATE INDEX "idx_scheduled_export_runs_status" ON "app"."scheduled_export_runs" ("status", "scheduled_run_at");

CREATE INDEX "idx_scheduled_export_tasks_deleted_at" ON "app"."scheduled_export_tasks" ("deleted_at");

CREATE INDEX "idx_scheduled_export_tasks_due" ON "app"."scheduled_export_tasks" ("enabled", "next_run_at");

CREATE INDEX "idx_shopee_health_appeal_events" ON "app"."shopee_health_appeal_events" ("appeal_id", "created_at" DESC);

CREATE INDEX "idx_shopee_health_appeals_status_assignee" ON "app"."shopee_health_appeals" ("status", "assignee_user_id", "due_date");

CREATE INDEX "idx_shopee_health_issues_shop" ON "app"."shopee_health_issues" ("shop_id", "status", "last_seen_at" DESC);

CREATE INDEX "idx_shopee_health_issues_active" ON "app"."shopee_health_issues" ("status", "severity", "last_seen_at" DESC);

CREATE INDEX "idx_shopee_health_notifications_unread" ON "app"."shopee_health_notifications" ("read_at", "created_at" DESC);

CREATE INDEX "idx_shopee_health_runs_created" ON "app"."shopee_health_runs" ("created_at" DESC);

CREATE INDEX "idx_shopee_health_snapshots_date_status" ON "app"."shopee_health_snapshots" ("snapshot_date" DESC, "status");

CREATE INDEX "idx_shopee_health_snapshots_shop_date" ON "app"."shopee_health_snapshots" ("shop_id", "snapshot_date" DESC);
