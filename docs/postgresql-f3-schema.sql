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
  "request_id" uuid NOT NULL,
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

CREATE TABLE "app"."schema_migrations" (
  "version" text,
  "applied_at" timestamptz NOT NULL,
  PRIMARY KEY ("version")
);

ALTER TABLE "app"."export_files" ADD CONSTRAINT "fk_export_files_1" FOREIGN KEY ("run_id") REFERENCES "app"."scheduled_export_runs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."export_files" ADD CONSTRAINT "fk_export_files_2" FOREIGN KEY ("task_id") REFERENCES "app"."scheduled_export_tasks" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_lifecycle_items" ADD CONSTRAINT "fk_file_lifecycle_items_1" FOREIGN KEY ("scan_id") REFERENCES "app"."file_lifecycle_scans" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."file_lifecycle_protected_files" ADD CONSTRAINT "fk_file_lifecycle_protected_files_1" FOREIGN KEY ("file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."file_lifecycle_scans" ADD CONSTRAINT "fk_file_lifecycle_scans_1" FOREIGN KEY ("report_file_id") REFERENCES "app"."export_files" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_quarantine_records" ADD CONSTRAINT "fk_file_quarantine_records_1" FOREIGN KEY ("managed_file_id") REFERENCES "app"."managed_files" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."file_quarantine_records" ADD CONSTRAINT "fk_file_quarantine_records_2" FOREIGN KEY ("lifecycle_item_id") REFERENCES "app"."file_lifecycle_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."mabang_filter_option_cache" ADD CONSTRAINT "fk_mabang_filter_option_cache_1" FOREIGN KEY ("account_profile_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."managed_files" ADD CONSTRAINT "fk_managed_files_1" FOREIGN KEY ("scan_id") REFERENCES "app"."file_lifecycle_scans" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."managed_files" ADD CONSTRAINT "fk_managed_files_2" FOREIGN KEY ("lifecycle_item_id") REFERENCES "app"."file_lifecycle_items" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."scheduled_export_run_events" ADD CONSTRAINT "fk_scheduled_export_run_events_1" FOREIGN KEY ("run_id") REFERENCES "app"."scheduled_export_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."scheduled_export_runs" ADD CONSTRAINT "fk_scheduled_export_runs_1" FOREIGN KEY ("task_id") REFERENCES "app"."scheduled_export_tasks" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

ALTER TABLE "app"."scheduled_export_tasks" ADD CONSTRAINT "fk_scheduled_export_tasks_1" FOREIGN KEY ("dingtalk_config_id") REFERENCES "app"."dingtalk_robot_configs" ("id") ON UPDATE NO ACTION ON DELETE SET NULL;

ALTER TABLE "app"."scheduled_export_tasks" ADD CONSTRAINT "fk_scheduled_export_tasks_2" FOREIGN KEY ("account_profile_id") REFERENCES "app"."mabang_account_profiles" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

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

CREATE INDEX "idx_managed_files_job" ON "app"."managed_files" ("job_id", "source_type");

CREATE INDEX "idx_managed_files_source" ON "app"."managed_files" ("source_type", "status", "registered_at" DESC);

CREATE INDEX "idx_operation_audit_status" ON "app"."operation_audit_events" ("status", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_action" ON "app"."operation_audit_events" ("action", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_module" ON "app"."operation_audit_events" ("module", "occurred_at" DESC);

CREATE INDEX "idx_operation_audit_occurred_at" ON "app"."operation_audit_events" ("occurred_at" DESC);

CREATE INDEX "idx_run_events_run" ON "app"."scheduled_export_run_events" ("run_id", "id");

CREATE INDEX "idx_scheduled_export_runs_task" ON "app"."scheduled_export_runs" ("task_id", "created_at" DESC);

CREATE INDEX "idx_scheduled_export_runs_status" ON "app"."scheduled_export_runs" ("status", "scheduled_run_at");

CREATE INDEX "idx_scheduled_export_tasks_deleted_at" ON "app"."scheduled_export_tasks" ("deleted_at");

CREATE INDEX "idx_scheduled_export_tasks_due" ON "app"."scheduled_export_tasks" ("enabled", "next_run_at");
