CREATE TABLE foundation_operation_plans (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  operation_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'PREVIEWED',
      'APPROVED',
      'IN_FLIGHT',
      'SUCCEEDED',
      'FAILED',
      'UNKNOWN',
      'EXPIRED',
      'BLOCKED',
      'CANCELLED'
    )
  ),
  approval_mode TEXT NOT NULL CHECK (approval_mode IN ('human', 'system')),
  scope_hash TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  items_hash TEXT NOT NULL,
  approval_text_hash TEXT,
  plan_hash TEXT NOT NULL UNIQUE,
  scope_json TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  items_json TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  approved_by TEXT,
  approved_at TEXT,
  expires_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  last_error_message TEXT,
  state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES foundation_tasks(id) ON DELETE SET NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_foundation_operation_plans_state
  ON foundation_operation_plans(state, expires_at, updated_at DESC);
CREATE INDEX idx_foundation_operation_plans_task
  ON foundation_operation_plans(task_id, created_at DESC);
CREATE INDEX idx_foundation_operation_plans_type
  ON foundation_operation_plans(operation_type, state, created_at DESC);

CREATE TABLE foundation_operation_plan_events (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  actor_id TEXT NOT NULL,
  reason_code TEXT,
  message TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  plan_version INTEGER NOT NULL CHECK (plan_version >= 1),
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (plan_id) REFERENCES foundation_operation_plans(id) ON DELETE CASCADE,
  UNIQUE (plan_id, idempotency_key),
  UNIQUE (plan_id, plan_version)
);

CREATE INDEX idx_foundation_operation_plan_events_history
  ON foundation_operation_plan_events(plan_id, plan_version DESC);
