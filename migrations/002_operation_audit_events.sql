CREATE TABLE operation_audit_events (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  http_method TEXT,
  request_path TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  duration_ms INTEGER,
  source_ip TEXT,
  actor_type TEXT,
  actor_identifier TEXT,
  task_id TEXT,
  run_id TEXT,
  file_id TEXT,
  error_stage TEXT,
  error_code TEXT,
  error_summary TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX idx_operation_audit_occurred_at ON operation_audit_events(occurred_at DESC);
CREATE INDEX idx_operation_audit_module ON operation_audit_events(module, occurred_at DESC);
CREATE INDEX idx_operation_audit_action ON operation_audit_events(action, occurred_at DESC);
CREATE INDEX idx_operation_audit_status ON operation_audit_events(status, occurred_at DESC);
