CREATE TABLE IF NOT EXISTS shadow_meta.migration_state (
  id text PRIMARY KEY,
  source_provider text NOT NULL CHECK (source_provider = 'sqlite'),
  target_provider text NOT NULL CHECK (target_provider = 'postgresql_shadow'),
  stage text NOT NULL CHECK (stage IN (
    'BASELINE', 'INCREMENTAL', 'VALIDATING', 'PAUSED', 'READY', 'FAILED'
  )),
  migration_snapshot_time timestamptz NOT NULL,
  source_snapshot_sha256 text NOT NULL,
  last_sync_started_at timestamptz,
  last_sync_completed_at timestamptz,
  last_successful_batch_id text,
  sync_failure_count bigint NOT NULL DEFAULT 0,
  last_validation_at timestamptz,
  last_validation_status text CHECK (
    last_validation_status IS NULL OR last_validation_status IN ('PASS', 'FAIL')
  ),
  is_switch_ready boolean NOT NULL DEFAULT false,
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS shadow_meta.migration_sync_batches (
  id text PRIMARY KEY,
  migration_state_id text NOT NULL REFERENCES shadow_meta.migration_state(id),
  mode text NOT NULL CHECK (mode IN ('INCREMENTAL', 'FULL_RECONCILE', 'VALIDATE')),
  source_snapshot_time timestamptz NOT NULL,
  source_snapshot_sha256 text NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  table_count integer NOT NULL DEFAULT 0,
  rows_examined bigint NOT NULL DEFAULT 0,
  rows_inserted bigint NOT NULL DEFAULT 0,
  rows_updated bigint NOT NULL DEFAULT 0,
  rows_skipped bigint NOT NULL DEFAULT 0,
  error_count bigint NOT NULL DEFAULT 0,
  error_code text,
  error_summary text,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_migration_sync_batches_state_started
  ON shadow_meta.migration_sync_batches(migration_state_id, started_at DESC);

CREATE TABLE IF NOT EXISTS shadow_meta.migration_sync_table_state (
  migration_state_id text NOT NULL REFERENCES shadow_meta.migration_state(id),
  table_name text NOT NULL,
  domain_name text NOT NULL,
  capture_mode text NOT NULL CHECK (capture_mode IN ('WATERMARK', 'FULL_HASH_SCAN')),
  watermark_column text,
  last_watermark_value timestamptz,
  last_watermark_pk_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_source_row_count bigint NOT NULL DEFAULT 0,
  last_target_row_count bigint NOT NULL DEFAULT 0,
  last_batch_id text,
  last_synced_at timestamptz,
  last_status text NOT NULL DEFAULT 'PENDING' CHECK (
    last_status IN ('PENDING', 'SUCCEEDED', 'FAILED')
  ),
  last_error_code text,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (migration_state_id, table_name)
);

CREATE TABLE IF NOT EXISTS shadow_meta.migration_validation_runs (
  id text PRIMARY KEY,
  migration_state_id text NOT NULL REFERENCES shadow_meta.migration_state(id),
  sync_batch_id text REFERENCES shadow_meta.migration_sync_batches(id),
  status text NOT NULL CHECK (status IN ('PASS', 'FAIL')),
  source_snapshot_time timestamptz NOT NULL,
  source_snapshot_sha256 text NOT NULL,
  tables_checked integer NOT NULL,
  tables_with_differences integer NOT NULL,
  sample_count integer NOT NULL,
  sample_failures integer NOT NULL,
  difference_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_migration_validation_runs_state_created
  ON shadow_meta.migration_validation_runs(migration_state_id, created_at DESC);

