ALTER TABLE scheduled_export_tasks
  ADD COLUMN deleted_at TEXT;

ALTER TABLE scheduled_export_tasks
  ADD COLUMN deleted_by TEXT
  CHECK (deleted_by IS NULL OR length(deleted_by) <= 64);

ALTER TABLE scheduled_export_tasks
  ADD COLUMN delete_reason TEXT
  CHECK (delete_reason IS NULL OR length(delete_reason) <= 240);

CREATE INDEX IF NOT EXISTS idx_scheduled_export_tasks_deleted_at
  ON scheduled_export_tasks(deleted_at);
