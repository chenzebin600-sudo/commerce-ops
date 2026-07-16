CREATE TABLE export_files_d2b1 (
  id TEXT PRIMARY KEY,
  file_type TEXT NOT NULL DEFAULT 'excel'
    CHECK (file_type IN ('excel')),
  source_type TEXT NOT NULL
    CHECK (source_type IN (
      'mabang_manual_order',
      'mabang_manual_inventory',
      'mabang_scheduled_order',
      'mabang_scheduled_inventory'
    )),
  task_id TEXT,
  run_id TEXT UNIQUE,
  request_key TEXT,
  original_filename TEXT NOT NULL,
  storage_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL DEFAULT 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  file_size INTEGER NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  file_hash TEXT,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'missing', 'expired', 'deleted', 'generation_failed', 'integrity_failed')),
  expires_at TEXT,
  missing_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES scheduled_export_tasks(id) ON DELETE SET NULL,
  FOREIGN KEY (run_id) REFERENCES scheduled_export_runs(id) ON DELETE SET NULL
);

INSERT INTO export_files_d2b1 (
  id,
  file_type,
  source_type,
  task_id,
  run_id,
  request_key,
  original_filename,
  storage_filename,
  relative_path,
  mime_type,
  file_size,
  file_hash,
  status,
  expires_at,
  missing_at,
  metadata_json,
  created_at,
  updated_at
)
SELECT
  f.id,
  'excel',
  CASE
    WHEN t.task_type = 'inventory_export' THEN 'mabang_scheduled_inventory'
    ELSE 'mabang_scheduled_order'
  END,
  f.task_id,
  f.run_id,
  NULL,
  f.original_filename,
  f.storage_filename,
  f.relative_path,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  f.file_size,
  f.file_hash,
  f.status,
  f.expires_at,
  NULL,
  '{}',
  f.created_at,
  f.created_at
FROM export_files f
LEFT JOIN scheduled_export_tasks t ON t.id = f.task_id;

DROP TABLE export_files;
ALTER TABLE export_files_d2b1 RENAME TO export_files;

CREATE INDEX idx_export_files_expiry
  ON export_files(status, expires_at);
CREATE INDEX idx_export_files_created_at
  ON export_files(created_at DESC);
CREATE INDEX idx_export_files_source_type
  ON export_files(source_type, created_at DESC);
CREATE INDEX idx_export_files_task_id
  ON export_files(task_id, created_at DESC);
CREATE INDEX idx_export_files_run_id
  ON export_files(run_id);
CREATE INDEX idx_export_files_status
  ON export_files(status, created_at DESC);
CREATE UNIQUE INDEX idx_export_files_request_key
  ON export_files(request_key)
  WHERE request_key IS NOT NULL;
