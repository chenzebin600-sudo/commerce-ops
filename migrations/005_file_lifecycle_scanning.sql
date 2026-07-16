CREATE TABLE file_lifecycle_scans (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT NOT NULL DEFAULT '{}',
  scope_errors_json TEXT NOT NULL DEFAULT '[]',
  total_files INTEGER NOT NULL DEFAULT 0 CHECK (total_files >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  report_file_id TEXT,
  error_code TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (report_file_id) REFERENCES export_files(id) ON DELETE SET NULL
);

CREATE TABLE file_lifecycle_items (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  categories_json TEXT NOT NULL DEFAULT '[]',
  scope TEXT NOT NULL,
  source_type TEXT,
  file_id TEXT,
  task_id TEXT,
  run_id TEXT,
  masked_filename TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0 CHECK (file_size >= 0),
  file_created_at TEXT,
  file_modified_at TEXT,
  database_status TEXT,
  physical_status TEXT NOT NULL,
  suggest_quarantine INTEGER NOT NULL DEFAULT 0 CHECK (suggest_quarantine IN (0, 1)),
  suggest_cleanup INTEGER NOT NULL DEFAULT 0 CHECK (suggest_cleanup IN (0, 1)),
  reason_code TEXT NOT NULL,
  short_hash TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scan_id) REFERENCES file_lifecycle_scans(id) ON DELETE CASCADE
);

CREATE TABLE file_lifecycle_protected_files (
  file_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (file_id) REFERENCES export_files(id) ON DELETE CASCADE
);

INSERT INTO file_lifecycle_protected_files(file_id, reason, created_at)
SELECT id, 'pre_lifecycle_baseline', datetime('now') FROM export_files;

CREATE INDEX idx_lifecycle_scans_created ON file_lifecycle_scans(created_at DESC);
CREATE INDEX idx_lifecycle_scans_status ON file_lifecycle_scans(status, created_at DESC);
CREATE INDEX idx_lifecycle_items_scan ON file_lifecycle_items(scan_id, classification, created_at DESC);
CREATE INDEX idx_lifecycle_items_source ON file_lifecycle_items(scan_id, source_type);
CREATE INDEX idx_lifecycle_items_file ON file_lifecycle_items(file_id);
