-- Approved for activation after the user confirmed promotion on 2026-08-05.
-- Reuses the existing encrypted DingTalk robot registry and price-control run history.

CREATE TABLE price_control_automation_settings (
  id TEXT PRIMARY KEY CHECK (id = 'default'),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (interval_minutes BETWEEN 15 AND 1440),
  dingtalk_config_id TEXT,
  notify_on_change INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_change IN (0,1)),
  notify_on_failure INTEGER NOT NULL DEFAULT 1 CHECK (notify_on_failure IN (0,1)),
  last_run_at TEXT,
  last_run_status TEXT CHECK (last_run_status IS NULL OR last_run_status IN ('SUCCEEDED','FAILED','PARTIAL_SUCCESS')),
  last_notification_at TEXT,
  last_notification_status TEXT CHECK (last_notification_status IS NULL OR last_notification_status IN ('SENT','SKIPPED','FAILED','NOT_CONFIGURED')),
  next_run_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (dingtalk_config_id) REFERENCES dingtalk_robot_configs(id) ON DELETE SET NULL
);

INSERT INTO price_control_automation_settings (
  id,enabled,interval_minutes,dingtalk_config_id,notify_on_change,notify_on_failure,
  created_at,updated_at
) VALUES ('default',0,60,NULL,1,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);

CREATE INDEX idx_price_control_automation_due
  ON price_control_automation_settings(enabled,next_run_at);

ALTER TABLE price_control_sync_runs ADD COLUMN notification_status TEXT
  CHECK (notification_status IS NULL OR notification_status IN ('SENT','SKIPPED','FAILED','NOT_CONFIGURED'));
ALTER TABLE price_control_sync_runs ADD COLUMN notified_at TEXT;
ALTER TABLE price_control_sync_runs ADD COLUMN notification_error_code TEXT;
