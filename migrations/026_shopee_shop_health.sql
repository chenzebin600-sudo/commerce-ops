CREATE TABLE IF NOT EXISTS shopee_health_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  encrypted_token_key TEXT,
  token_hint TEXT,
  token_verified_at TEXT,
  token_shop_count INTEGER NOT NULL DEFAULT 0,
  schedule_time TEXT NOT NULL DEFAULT '09:00',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  retry_count INTEGER NOT NULL DEFAULT 3 CHECK (retry_count BETWEEN 0 AND 5),
  warning_ratio REAL NOT NULL DEFAULT 0.10 CHECK (warning_ratio >= 0 AND warning_ratio <= 1),
  dingtalk_config_id TEXT,
  site_notifications_enabled INTEGER NOT NULL DEFAULT 1,
  dingtalk_notifications_enabled INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_key_error TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dingtalk_config_id) REFERENCES dingtalk_robot_configs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS shopee_health_thresholds (
  metric_id INTEGER PRIMARY KEY,
  metric_name TEXT NOT NULL,
  warning_value REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shopee_health_runs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('scheduled', 'manual')),
  scheduled_for TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  shop_total INTEGER NOT NULL DEFAULT 0,
  shop_success INTEGER NOT NULL DEFAULT 0,
  shop_failed INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shopee_health_runs_created
  ON shopee_health_runs(created_at DESC);

CREATE TABLE IF NOT EXISTS shopee_health_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  shop_id TEXT NOT NULL,
  shop_code TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  country TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('healthy', 'warning', 'critical', 'unavailable')),
  overall_rating INTEGER,
  fulfillment_failed INTEGER NOT NULL DEFAULT 0,
  listing_failed INTEGER NOT NULL DEFAULT 0,
  customer_service_failed INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  critical_count INTEGER NOT NULL DEFAULT 0,
  penalty_points INTEGER NOT NULL DEFAULT 0,
  ongoing_punishments INTEGER NOT NULL DEFAULT 0,
  issue_listing_count INTEGER NOT NULL DEFAULT 0,
  late_order_count INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL DEFAULT '[]',
  collected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES shopee_health_runs(id) ON DELETE CASCADE,
  UNIQUE (snapshot_date, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_shopee_health_snapshots_shop_date
  ON shopee_health_snapshots(shop_id, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_shopee_health_snapshots_date_status
  ON shopee_health_snapshots(snapshot_date DESC, status);

CREATE TABLE IF NOT EXISTS shopee_health_issues (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  shop_code TEXT NOT NULL,
  shop_name TEXT NOT NULL,
  country TEXT NOT NULL,
  issue_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('warning', 'critical')),
  title TEXT NOT NULL,
  reason TEXT,
  reference_id TEXT,
  metric_id INTEGER,
  current_value REAL,
  target_value REAL,
  comparator TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_appeal', 'resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shopee_health_issues_active
  ON shopee_health_issues(status, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopee_health_issues_shop
  ON shopee_health_issues(shop_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS shopee_health_notifications (
  id TEXT PRIMARY KEY,
  notification_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  shop_id TEXT,
  issue_id TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES shopee_health_issues(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shopee_health_notifications_unread
  ON shopee_health_notifications(read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS shopee_health_appeals (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL UNIQUE,
  shop_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'preparing', 'submitted', 'waiting_result', 'approved', 'rejected', 'closed')),
  assignee_user_id TEXT,
  assignee_name TEXT,
  due_date TEXT,
  seller_center_reference TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  resolution TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  resolved_at TEXT,
  FOREIGN KEY (issue_id) REFERENCES shopee_health_issues(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_shopee_health_appeals_status_assignee
  ON shopee_health_appeals(status, assignee_user_id, due_date);

CREATE TABLE IF NOT EXISTS shopee_health_appeal_events (
  id TEXT PRIMARY KEY,
  appeal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  note TEXT,
  actor_user_id TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (appeal_id) REFERENCES shopee_health_appeals(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_shopee_health_appeal_events
  ON shopee_health_appeal_events(appeal_id, created_at DESC);

INSERT OR IGNORE INTO shopee_health_settings
  (id, schedule_time, timezone, retry_count, warning_ratio, site_notifications_enabled,
   dingtalk_notifications_enabled, enabled, created_at, updated_at)
VALUES
  ('default', '09:00', 'Asia/Shanghai', 3, 0.10, 1, 1, 1,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
