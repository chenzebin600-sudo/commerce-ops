ALTER TABLE product_import_batches ADD COLUMN removed_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0);

CREATE TABLE product_package_sync_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('initial', 'manual', 'scheduled')),
  status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'NO_CHANGES', 'FAILED')),
  source_system TEXT NOT NULL DEFAULT 'ai_project_a',
  source_table TEXT NOT NULL DEFAULT 'product_package',
  schedule_date TEXT,
  import_batch_id TEXT,
  source_snapshot_sha256 TEXT,
  source_row_count INTEGER NOT NULL DEFAULT 0 CHECK (source_row_count >= 0),
  local_row_count_before INTEGER NOT NULL DEFAULT 0 CHECK (local_row_count_before >= 0),
  local_row_count_after INTEGER NOT NULL DEFAULT 0 CHECK (local_row_count_after >= 0),
  new_count INTEGER NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  removed_count INTEGER NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
  field_change_count INTEGER NOT NULL DEFAULT 0 CHECK (field_change_count >= 0),
  source_checked_at TEXT,
  source_table_updated_at TEXT,
  source_max_updated_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (import_batch_id) REFERENCES product_import_batches(id) ON DELETE RESTRICT,
  UNIQUE (trigger_type, schedule_date)
);

CREATE INDEX idx_product_package_sync_runs_created
  ON product_package_sync_runs(created_at DESC, id DESC);
CREATE INDEX idx_product_package_sync_runs_status
  ON product_package_sync_runs(status, created_at DESC);
CREATE INDEX idx_product_package_sync_runs_batch
  ON product_package_sync_runs(import_batch_id);

