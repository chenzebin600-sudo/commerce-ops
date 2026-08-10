ALTER TABLE app.product_import_batches
  ADD COLUMN removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0);

CREATE TABLE app.product_package_sync_runs (
  id text PRIMARY KEY,
  trigger_type text NOT NULL CHECK (trigger_type IN ('initial', 'manual', 'scheduled')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'NO_CHANGES', 'FAILED')),
  source_system text NOT NULL DEFAULT 'ai_project_a',
  source_table text NOT NULL DEFAULT 'product_package',
  schedule_date date,
  import_batch_id text,
  source_snapshot_sha256 text,
  source_row_count integer NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  local_row_count_before integer NOT NULL DEFAULT 0 CHECK (local_row_count_before >= 0),
  local_row_count_after integer NOT NULL DEFAULT 0 CHECK (local_row_count_after >= 0),
  new_count integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  updated_count integer NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  unchanged_count integer NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  removed_count integer NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  field_change_count integer NOT NULL DEFAULT 0 CHECK (field_change_count >= 0),
  source_checked_at timestamptz,
  source_table_updated_at timestamptz,
  source_max_updated_at timestamptz,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  error_code text,
  error_message text,
  requested_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (trigger_type, schedule_date),
  CONSTRAINT fk_product_package_sync_runs_1
    FOREIGN KEY (import_batch_id) REFERENCES app.product_import_batches(id)
    ON UPDATE NO ACTION ON DELETE RESTRICT
);

CREATE INDEX idx_product_package_sync_runs_created
  ON app.product_package_sync_runs(created_at DESC, id DESC);
CREATE INDEX idx_product_package_sync_runs_status
  ON app.product_package_sync_runs(status, created_at DESC);
CREATE INDEX idx_product_package_sync_runs_batch
  ON app.product_package_sync_runs(import_batch_id);
