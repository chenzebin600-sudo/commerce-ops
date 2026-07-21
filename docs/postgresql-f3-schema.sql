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

ALTER TABLE "app"."product_ai_contents" ADD CONSTRAINT "fk_product_ai_contents_1" FOREIGN KEY ("product_sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_1" FOREIGN KEY ("last_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_2" FOREIGN KEY ("first_seen_batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_categories" ADD CONSTRAINT "fk_product_categories_3" FOREIGN KEY ("parent_id") REFERENCES "app"."product_categories" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_cost_snapshots" ADD CONSTRAINT "fk_product_cost_snapshots_1" FOREIGN KEY ("batch_id") REFERENCES "app"."product_import_batches" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_cost_snapshots" ADD CONSTRAINT "fk_product_cost_snapshots_2" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_field_override_events" ADD CONSTRAINT "fk_product_field_override_events_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE "app"."product_field_overrides" ADD CONSTRAINT "fk_product_field_overrides_1" FOREIGN KEY ("sku_id") REFERENCES "app"."product_skus" ("id") ON UPDATE NO ACTION ON DELETE RESTRICT;

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

CREATE INDEX "idx_product_ai_contents_country_sku" ON "app"."product_ai_contents" ("country", "sku", "status", "updated_at" DESC);

CREATE INDEX "idx_product_ai_contents_product_status" ON "app"."product_ai_contents" ("product_sku_id", "content_type", "status", "version" DESC);

CREATE INDEX "idx_product_categories_parent" ON "app"."product_categories" ("parent_id", "status", "normalized_name");

CREATE INDEX "idx_product_cost_snapshots_sku" ON "app"."product_cost_snapshots" ("sku_id", "created_at" DESC);

CREATE INDEX "idx_product_override_events_sku" ON "app"."product_field_override_events" ("sku_id", "occurred_at" DESC);

CREATE INDEX "idx_product_field_overrides_active" ON "app"."product_field_overrides" ("sku_id", "deleted_at", "field_code");

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
