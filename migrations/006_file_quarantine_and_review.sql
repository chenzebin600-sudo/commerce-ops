ALTER TABLE file_lifecycle_items
  ADD COLUMN detected_file_type TEXT
  CHECK (detected_file_type IS NULL OR detected_file_type IN (
    'advertising_source',
    'advertising_output',
    'advertising_report',
    'advertising_temp',
    'advertising_unknown'
  ));

ALTER TABLE file_lifecycle_items
  ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending_review'
  CHECK (review_status IN (
    'pending_review',
    'approved_for_registration',
    'registered',
    'approved_for_quarantine',
    'quarantined',
    'restored',
    'rejected',
    'protected'
  ));

ALTER TABLE file_lifecycle_items ADD COLUMN reviewed_at TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN reviewed_by TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN review_reason TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN root_key TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN relative_path TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN full_hash TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN job_id TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN mime_type TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN signature_code TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN detection_reason_code TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN managed_file_id TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN original_relative_path TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN quarantine_relative_path TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN quarantined_at TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN restored_at TEXT;
ALTER TABLE file_lifecycle_items ADD COLUMN deleted_at TEXT;

CREATE TABLE managed_files (
  id TEXT PRIMARY KEY,
  lifecycle_item_id TEXT NOT NULL UNIQUE,
  scan_id TEXT NOT NULL,
  root_key TEXT NOT NULL CHECK (root_key IN ('ad_upload', 'ad_output', 'ad_temp', 'main_temp')),
  relative_path TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN (
    'advertising_source',
    'advertising_output',
    'advertising_report'
  )),
  job_id TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_hash TEXT NOT NULL CHECK (length(file_hash) = 64),
  file_created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'quarantined', 'restored', 'deleted')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  registered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (lifecycle_item_id) REFERENCES file_lifecycle_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (scan_id) REFERENCES file_lifecycle_scans(id) ON DELETE RESTRICT,
  UNIQUE (root_key, relative_path)
);

CREATE TABLE file_quarantine_records (
  id TEXT PRIMARY KEY,
  lifecycle_item_id TEXT NOT NULL,
  managed_file_id TEXT,
  root_key TEXT NOT NULL,
  original_relative_path TEXT NOT NULL,
  quarantine_relative_path TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL CHECK (file_size >= 0),
  file_hash TEXT NOT NULL CHECK (length(file_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('quarantined', 'restored')),
  quarantined_at TEXT NOT NULL,
  quarantined_by TEXT NOT NULL,
  quarantine_reason TEXT NOT NULL,
  restored_at TEXT,
  restored_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lifecycle_item_id) REFERENCES file_lifecycle_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (managed_file_id) REFERENCES managed_files(id) ON DELETE SET NULL
);

UPDATE file_lifecycle_items
SET review_status = 'protected',
    reviewed_at = datetime('now'),
    reviewed_by = 'migration',
    review_reason = 'pre_lifecycle_baseline'
WHERE file_id IN (SELECT file_id FROM file_lifecycle_protected_files);

CREATE INDEX idx_lifecycle_items_review
  ON file_lifecycle_items(scan_id, review_status, detected_file_type);
CREATE INDEX idx_managed_files_source
  ON managed_files(source_type, status, registered_at DESC);
CREATE INDEX idx_managed_files_job
  ON managed_files(job_id, source_type);
CREATE INDEX idx_quarantine_records_status
  ON file_quarantine_records(status, quarantined_at DESC);
