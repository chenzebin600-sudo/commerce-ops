CREATE TABLE IF NOT EXISTS mabang_account_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_verified_at TEXT,
  last_verify_status TEXT,
  last_verify_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dingtalk_robot_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  encrypted_webhook_url TEXT NOT NULL,
  encrypted_secret TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  notify_on_success INTEGER NOT NULL DEFAULT 1,
  notify_on_failure INTEGER NOT NULL DEFAULT 1,
  notify_on_empty INTEGER NOT NULL DEFAULT 1,
  at_all INTEGER NOT NULL DEFAULT 0,
  at_mobiles_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_export_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL DEFAULT 'order_export',
  name TEXT NOT NULL,
  description TEXT,
  account_profile_id TEXT NOT NULL,
  dingtalk_config_id TEXT,
  schedule_type TEXT NOT NULL,
  schedule_config_json TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  payment_date_mode TEXT NOT NULL,
  payment_date_config_json TEXT NOT NULL DEFAULT '{}',
  filters_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  file_retention_days INTEGER,
  notify_enabled INTEGER NOT NULL DEFAULT 1,
  catch_up_enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_run_status TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_profile_id) REFERENCES mabang_account_profiles(id) ON DELETE RESTRICT,
  FOREIGN KEY (dingtalk_config_id) REFERENCES dingtalk_robot_configs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_export_tasks_due ON scheduled_export_tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS scheduled_export_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  scheduled_run_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  status TEXT NOT NULL,
  payment_start_date TEXT,
  payment_end_date TEXT,
  raw_order_count INTEGER NOT NULL DEFAULT 0,
  filtered_order_count INTEGER NOT NULL DEFAULT 0,
  detail_row_count INTEGER NOT NULL DEFAULT 0,
  export_file_id TEXT,
  notification_status TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_stage TEXT,
  error_code TEXT,
  error_message TEXT,
  log_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES scheduled_export_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, scheduled_run_at)
);

CREATE INDEX IF NOT EXISTS idx_scheduled_export_runs_status ON scheduled_export_runs(status, scheduled_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_export_runs_task ON scheduled_export_runs(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS export_files (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  storage_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_hash TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES scheduled_export_tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES scheduled_export_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_export_files_expiry ON export_files(status, expires_at);

CREATE TABLE IF NOT EXISTS scheduled_export_run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  message TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES scheduled_export_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_run_events_run ON scheduled_export_run_events(run_id, id);

CREATE TABLE IF NOT EXISTS mabang_filter_option_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_profile_id TEXT NOT NULL,
  manager TEXT NOT NULL DEFAULT '',
  shop_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  warehouse TEXT NOT NULL DEFAULT '',
  order_status TEXT NOT NULL DEFAULT '',
  sku TEXT NOT NULL DEFAULT '',
  logistics_channel TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_profile_id) REFERENCES mabang_account_profiles(id) ON DELETE CASCADE,
  UNIQUE (account_profile_id, manager, shop_name, platform, region, warehouse, order_status, sku, logistics_channel)
);

CREATE TABLE IF NOT EXISTS scheduler_leases (
  name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
