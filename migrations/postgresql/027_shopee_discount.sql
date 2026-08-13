DO $$
DECLARE capability_constraint text;
BEGIN
  SELECT con.conname INTO capability_constraint
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'app'
    AND rel.relname = 'foundation_account_capabilities'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%capability_code%';
  IF capability_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "app"."foundation_account_capabilities" DROP CONSTRAINT %I', capability_constraint);
  END IF;
END $$;

ALTER TABLE "app"."foundation_account_capabilities"
  ADD CONSTRAINT "foundation_account_capabilities_code_check" CHECK (
    "capability_code" IN (
      'orders.read', 'inventory.read', 'images.read', 'listing.read', 'listing.write',
      'discount.read', 'discount.write'
    )
  );

CREATE TABLE "app"."shopee_discount_settings" (
  "id" text PRIMARY KEY CHECK ("id" = 'default'),
  "encrypted_warehouse_key_ciphertext" text,
  "warehouse_key_reference" text,
  "warehouse_key_hint" text,
  "warehouse_key_updated_at" timestamptz,
  "timezone" text NOT NULL DEFAULT 'Asia/Shanghai',
  "enabled" boolean NOT NULL DEFAULT false,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_by" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CHECK (
    "encrypted_warehouse_key_ciphertext" IS NOT NULL
    OR "warehouse_key_reference" IS NOT NULL
    OR "warehouse_key_hint" IS NULL
  )
);

CREATE TABLE "app"."shopee_discount_plans" (
  "id" text PRIMARY KEY,
  "foundation_plan_id" uuid,
  "country" text NOT NULL,
  "state" text NOT NULL DEFAULT 'PREVIEWING' CHECK (
    "state" IN ('PREVIEWING','PREVIEWED','APPROVED','EXECUTING','PARTIAL_SUCCESS','SUCCEEDED','FAILED','BLOCKED','EXPIRED','CANCELLED')
  ),
  "target_starts_at" timestamptz NOT NULL,
  "target_ends_at" timestamptz NOT NULL,
  "source_snapshot_hash" text NOT NULL,
  "policy_hash" text NOT NULL,
  "merkle_root" text,
  "item_count" integer NOT NULL DEFAULT 0 CHECK ("item_count" >= 0),
  "shard_count" integer NOT NULL DEFAULT 0 CHECK ("shard_count" >= 0),
  "state_version" integer NOT NULL DEFAULT 1 CHECK ("state_version" >= 1),
  "reason_code" text,
  "expires_at" timestamptz,
  "sealed_at" timestamptz,
  "approved_at" timestamptz,
  "created_by" text NOT NULL,
  "retention_until" timestamptz NOT NULL,
  "summary_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  CHECK ("target_ends_at" > "target_starts_at"),
  CHECK ("expires_at" IS NULL OR "expires_at" > "created_at"),
  CHECK (
    "state" NOT IN ('PREVIEWED','APPROVED','EXECUTING','PARTIAL_SUCCESS','SUCCEEDED')
    OR ("merkle_root" IS NOT NULL AND length(btrim("merkle_root")) > 0)
  )
);

CREATE INDEX "idx_shopee_discount_plans_country_state_created"
  ON "app"."shopee_discount_plans" ("country", "state", "created_at" DESC, "id");

CREATE TABLE "app"."shopee_discount_activities" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "shop_id" text NOT NULL,
  "activity_type" text NOT NULL DEFAULT 'TARGET_PRICE',
  "platform_activity_id" text,
  "target_starts_at" timestamptz NOT NULL,
  "target_ends_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'PLANNED' CHECK ("status" IN ('PLANNED','ACTIVE','ENDED','CANCELLED')),
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("plan_id", "shop_id"),
  CHECK ("target_ends_at" > "target_starts_at")
);

CREATE INDEX "idx_shopee_discount_activities_shop_time"
  ON "app"."shopee_discount_activities" ("shop_id", "target_starts_at", "target_ends_at", "plan_id")
  WHERE "status" IN ('PLANNED', 'ACTIVE');

CREATE TABLE "app"."shopee_discount_plan_shards" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "shard_index" integer NOT NULL CHECK ("shard_index" >= 0),
  "shard_hash" text NOT NULL,
  "item_count" integer NOT NULL CHECK ("item_count" >= 0),
  "created_at" timestamptz NOT NULL,
  UNIQUE ("plan_id", "shard_index"),
  UNIQUE ("plan_id", "shard_hash")
);

CREATE TABLE "app"."shopee_discount_plan_items" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "shard_id" text NOT NULL REFERENCES "app"."shopee_discount_plan_shards" ("id") ON DELETE RESTRICT,
  "shard_index" integer NOT NULL CHECK ("shard_index" >= 0),
  "sequence_no" integer NOT NULL CHECK ("sequence_no" >= 0),
  "shop_id" text NOT NULL,
  "item_id" text NOT NULL,
  "model_id" text NOT NULL,
  "item_key" text NOT NULL,
  "sku" text NOT NULL,
  "currency" text NOT NULL,
  "scale" integer NOT NULL CHECK ("scale" BETWEEN 0 AND 9),
  "current_price_minor" text NOT NULL CHECK ("current_price_minor" ~ '^(0|[1-9][0-9]*)$'),
  "control_price_minor" text CHECK ("control_price_minor" IS NULL OR "control_price_minor" ~ '^(0|[1-9][0-9]*)$'),
  "target_price_minor" text NOT NULL CHECK ("target_price_minor" ~ '^(0|[1-9][0-9]*)$'),
  "payload_hash" text NOT NULL,
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "execution_status" text NOT NULL DEFAULT 'PENDING' CHECK (
    "execution_status" IN ('PENDING','SKIPPED_SAFETY','DISPATCHED','SUCCEEDED','UNKNOWN','FAILED','ABANDONED')
  ),
  "execution_reason_code" text,
  "retention_until" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL,
  UNIQUE ("plan_id", "item_key"),
  UNIQUE ("plan_id", "sequence_no"),
  CHECK ("item_key" = "shop_id" || chr(31) || "item_id" || chr(31) || "model_id")
);

CREATE INDEX "idx_shopee_discount_items_plan_shop_key"
  ON "app"."shopee_discount_plan_items" ("plan_id", "shop_id", "item_key", "sequence_no");
CREATE INDEX "idx_shopee_discount_items_retention"
  ON "app"."shopee_discount_plan_items" ("retention_until", "plan_id");

CREATE FUNCTION "app"."shopee_discount_reject_shard_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Shopee Discount plan shards are immutable'; END $$;
CREATE TRIGGER "shopee_discount_plan_shards_immutable"
  BEFORE UPDATE OR DELETE ON "app"."shopee_discount_plan_shards"
  FOR EACH ROW EXECUTE FUNCTION "app"."shopee_discount_reject_shard_mutation"();

CREATE FUNCTION "app"."shopee_discount_reject_item_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Shopee Discount plan items are immutable'; END $$;
CREATE TRIGGER "shopee_discount_plan_items_immutable_delete"
  BEFORE DELETE ON "app"."shopee_discount_plan_items"
  FOR EACH ROW EXECUTE FUNCTION "app"."shopee_discount_reject_item_delete"();

CREATE FUNCTION "app"."shopee_discount_reject_item_payload_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    NEW."plan_id", NEW."shard_id", NEW."shard_index", NEW."sequence_no", NEW."shop_id", NEW."item_id", NEW."model_id",
    NEW."item_key", NEW."sku", NEW."currency", NEW."scale", NEW."current_price_minor", NEW."control_price_minor",
    NEW."target_price_minor", NEW."payload_hash", NEW."payload_json"
  ) IS DISTINCT FROM ROW(
    OLD."plan_id", OLD."shard_id", OLD."shard_index", OLD."sequence_no", OLD."shop_id", OLD."item_id", OLD."model_id",
    OLD."item_key", OLD."sku", OLD."currency", OLD."scale", OLD."current_price_minor", OLD."control_price_minor",
    OLD."target_price_minor", OLD."payload_hash", OLD."payload_json"
  ) THEN
    RAISE EXCEPTION 'Shopee Discount plan item payload is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "shopee_discount_plan_items_payload_immutable"
  BEFORE UPDATE ON "app"."shopee_discount_plan_items"
  FOR EACH ROW EXECUTE FUNCTION "app"."shopee_discount_reject_item_payload_mutation"();

CREATE TABLE "app"."shopee_discount_approvals" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL UNIQUE REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "merkle_root" text NOT NULL,
  "policy_hash" text NOT NULL,
  "approval_mode" text NOT NULL CHECK ("approval_mode" IN ('human','system')),
  "actor_id" text NOT NULL,
  "actor_name" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "approved_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL
);

CREATE TABLE "app"."shopee_discount_jobs" (
  "id" text PRIMARY KEY,
  "plan_id" text NOT NULL REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "foundation_task_id" uuid REFERENCES "app"."foundation_tasks" ("id") ON DELETE SET NULL,
  "job_type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK (
    "status" IN ('PENDING','RUNNING','PARTIAL_SUCCESS','SUCCEEDED','FAILED','BLOCKED','CANCELLED')
  ),
  "owner_id" text,
  "fencing_epoch" bigint NOT NULL DEFAULT 0 CHECK ("fencing_epoch" >= 0),
  "lease_until" timestamptz,
  "cursor_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "counters_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "input_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error_code" text,
  "created_by" text NOT NULL,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE INDEX "idx_shopee_discount_jobs_runnable_lease"
  ON "app"."shopee_discount_jobs" ("lease_until", "created_at", "id")
  WHERE "status" IN ('PENDING', 'RUNNING');

CREATE TABLE "app"."shopee_discount_dispatch_intents" (
  "id" text PRIMARY KEY,
  "job_id" text NOT NULL REFERENCES "app"."shopee_discount_jobs" ("id") ON DELETE RESTRICT,
  "plan_id" text NOT NULL REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "plan_item_id" text REFERENCES "app"."shopee_discount_plan_items" ("id") ON DELETE RESTRICT,
  "operation_uuid" uuid NOT NULL UNIQUE,
  "target_type" text NOT NULL,
  "target_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "epoch" bigint NOT NULL CHECK ("epoch" >= 1),
  "owner_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'DISPATCHED' CHECK (
    "status" IN ('DISPATCHED','SUCCEEDED','UNKNOWN','LINK_VERIFIED_OBJECT','CONFIRMED_NOT_SENT','ABANDONED')
  ),
  "platform_object_id" text,
  "readback_json" jsonb,
  "evidence_json" jsonb,
  "reconciled_by" text,
  "dispatched_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "reconciled_at" timestamptz,
  "updated_at" timestamptz NOT NULL
);

CREATE INDEX "idx_shopee_discount_intents_operation_status_age"
  ON "app"."shopee_discount_dispatch_intents" ("operation_uuid", "status", "dispatched_at");
CREATE INDEX "idx_shopee_discount_intents_unknown_age"
  ON "app"."shopee_discount_dispatch_intents" ("updated_at", "id")
  WHERE "status" IN ('DISPATCHED', 'UNKNOWN');

CREATE TABLE "app"."shopee_discount_events" (
  "id" text PRIMARY KEY,
  "plan_id" text REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE RESTRICT,
  "job_id" text REFERENCES "app"."shopee_discount_jobs" ("id") ON DELETE RESTRICT,
  "intent_id" text REFERENCES "app"."shopee_discount_dispatch_intents" ("id") ON DELETE RESTRICT,
  "event_type" text NOT NULL,
  "actor_id" text,
  "reason_code" text,
  "evidence_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL,
  "retention_until" timestamptz,
  "created_at" timestamptz NOT NULL
);

CREATE INDEX "idx_shopee_discount_events_plan_time"
  ON "app"."shopee_discount_events" ("plan_id", "occurred_at" DESC, "id");
CREATE INDEX "idx_shopee_discount_events_retention"
  ON "app"."shopee_discount_events" ("retention_until", "occurred_at");

CREATE TABLE "app"."shopee_discount_due_jobs" (
  "id" text PRIMARY KEY,
  "job_type" text NOT NULL,
  "dedupe_key" text NOT NULL UNIQUE,
  "due_at" timestamptz NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','CLAIMED','SUCCEEDED','FAILED','CANCELLED')),
  "owner_id" text,
  "fencing_epoch" bigint NOT NULL DEFAULT 0 CHECK ("fencing_epoch" >= 0),
  "lease_until" timestamptz,
  "payload_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "last_error_code" text,
  "created_at" timestamptz NOT NULL,
  "updated_at" timestamptz NOT NULL,
  "completed_at" timestamptz
);

CREATE INDEX "idx_shopee_discount_due_jobs_claim"
  ON "app"."shopee_discount_due_jobs" ("due_at", "lease_until", "id")
  WHERE "status" IN ('PENDING', 'CLAIMED');

CREATE TABLE "app"."shopee_discount_notifications" (
  "id" text PRIMARY KEY,
  "plan_id" text REFERENCES "app"."shopee_discount_plans" ("id") ON DELETE SET NULL,
  "notification_type" text NOT NULL,
  "severity" text NOT NULL CHECK ("severity" IN ('INFO','WARNING','CRITICAL')),
  "title" text NOT NULL,
  "message" text NOT NULL,
  "metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "read_at" timestamptz,
  "retention_until" timestamptz,
  "created_at" timestamptz NOT NULL
);

CREATE INDEX "idx_shopee_discount_notifications_unread"
  ON "app"."shopee_discount_notifications" ("created_at" DESC, "id")
  WHERE "read_at" IS NULL;

INSERT INTO "app"."shopee_discount_settings" ("id", "timezone", "enabled", "created_at", "updated_at")
VALUES ('default', 'Asia/Shanghai', false, clock_timestamp(), clock_timestamp())
ON CONFLICT ("id") DO NOTHING;
