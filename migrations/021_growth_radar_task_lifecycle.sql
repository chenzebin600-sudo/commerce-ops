CREATE TABLE growth_focus_items (
  id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (
    task_type IN (
      'DATA_BLOCKED',
      'STORE_WATCH',
      'INVENTORY_RISK',
      'GROWTH_OPPORTUNITY',
      'BLUE_OCEAN',
      'CROSS_COUNTRY_CANDIDATE',
      'STORE_SALES_DECLINE',
      'STORE_ASSORTMENT_GAP',
      'SKU_SALES_GROWTH',
      'SKU_SALES_DECLINE',
      'NEW_PRODUCT_OPPORTUNITY'
    )
  ),
  current_signal_id TEXT,
  first_analysis_run_id TEXT NOT NULL,
  last_analysis_run_id TEXT NOT NULL,
  owner_user_id TEXT,
  internal_shop_id TEXT,
  country_code TEXT,
  source_warehouse_name TEXT,
  normalized_warehouse_name TEXT,
  platform TEXT,
  category_l1 TEXT,
  category_l2 TEXT,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN (
      'shop',
      'shop_category',
      'shop_sku',
      'warehouse_sku',
      'country_category',
      'sku',
      'data_configuration'
    )
  ),
  normalized_source_sku TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (
    status IN (
      'NEW',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'MONITORING',
      'RESOLVED',
      'BLOCKED',
      'DISMISSED',
      'REOPENED'
    )
  ),
  reason_code TEXT NOT NULL,
  recommended_action_code TEXT NOT NULL,
  evidence_snapshot_json TEXT NOT NULL DEFAULT '{}',
  consecutive_hit_count INTEGER NOT NULL DEFAULT 1 CHECK (consecutive_hit_count >= 1),
  is_hit_in_latest_run INTEGER NOT NULL DEFAULT 1 CHECK (is_hit_in_latest_run IN (0, 1)),
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  acknowledged_at TEXT,
  started_at TEXT,
  due_at TEXT,
  snoozed_until TEXT,
  blocked_reason_code TEXT,
  resolution_code TEXT,
  resolution_note TEXT,
  resolved_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (current_signal_id) REFERENCES growth_signals(id) ON DELETE RESTRICT,
  FOREIGN KEY (first_analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (last_analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  FOREIGN KEY (internal_shop_id) REFERENCES growth_shops(id) ON DELETE RESTRICT,
  CHECK (task_key <> ''),
  CHECK (reason_code <> ''),
  CHECK (recommended_action_code <> ''),
  CHECK (
    (source_warehouse_name IS NULL AND normalized_warehouse_name IS NULL)
    OR (
      source_warehouse_name IS NOT NULL
      AND source_warehouse_name <> ''
      AND normalized_warehouse_name IS NOT NULL
      AND normalized_warehouse_name <> ''
    )
  ),
  CHECK (
    subject_type <> 'warehouse_sku'
    OR normalized_warehouse_name IS NOT NULL
  ),
  CHECK (status <> 'BLOCKED' OR (blocked_reason_code IS NOT NULL AND blocked_reason_code <> '')),
  CHECK (
    status <> 'MONITORING'
    OR due_at IS NOT NULL
    OR snoozed_until IS NOT NULL
  ),
  CHECK (
    status NOT IN ('RESOLVED', 'DISMISSED')
    OR (
      resolution_code IS NOT NULL
      AND resolution_code <> ''
      AND resolved_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_growth_focus_items_active_task
  ON growth_focus_items(task_key)
  WHERE status IN (
    'NEW',
    'ACKNOWLEDGED',
    'IN_PROGRESS',
    'MONITORING',
    'BLOCKED',
    'REOPENED'
  );

CREATE INDEX idx_growth_focus_items_owner_queue
  ON growth_focus_items(
    owner_user_id,
    status,
    priority,
    is_hit_in_latest_run,
    last_detected_at DESC
  );

CREATE INDEX idx_growth_focus_items_shop_queue
  ON growth_focus_items(
    internal_shop_id,
    status,
    priority,
    last_detected_at DESC
  );

CREATE INDEX idx_growth_focus_items_latest_run
  ON growth_focus_items(last_analysis_run_id, is_hit_in_latest_run, task_type);

CREATE INDEX idx_growth_focus_items_warehouse
  ON growth_focus_items(
    country_code,
    normalized_warehouse_name,
    normalized_source_sku,
    status,
    priority
  );

CREATE TABLE growth_focus_item_events (
  id TEXT PRIMARY KEY,
  focus_item_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'CREATED',
      'ASSIGNED',
      'ACKNOWLEDGED',
      'STARTED',
      'MONITORING_STARTED',
      'BLOCKED',
      'RESOLVED',
      'DISMISSED',
      'REOPENED',
      'SIGNAL_REFRESHED',
      'NOT_HIT_IN_LATEST_RUN',
      'SCHEDULED'
    )
  ),
  task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
  from_status TEXT CHECK (
    from_status IS NULL
    OR from_status IN (
      'NEW',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'MONITORING',
      'RESOLVED',
      'BLOCKED',
      'DISMISSED',
      'REOPENED'
    )
  ),
  to_status TEXT NOT NULL CHECK (
    to_status IN (
      'NEW',
      'ACKNOWLEDGED',
      'IN_PROGRESS',
      'MONITORING',
      'RESOLVED',
      'BLOCKED',
      'DISMISSED',
      'REOPENED'
    )
  ),
  actor_user_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
  reason_code TEXT,
  note TEXT,
  signal_id TEXT,
  analysis_run_id TEXT,
  evidence_snapshot_json TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (focus_item_id) REFERENCES growth_focus_items(id) ON DELETE RESTRICT,
  FOREIGN KEY (signal_id) REFERENCES growth_signals(id) ON DELETE RESTRICT,
  FOREIGN KEY (analysis_run_id) REFERENCES growth_analysis_runs(id) ON DELETE RESTRICT,
  UNIQUE (focus_item_id, idempotency_key),
  UNIQUE (focus_item_id, task_revision),
  CHECK (idempotency_key <> '')
);

CREATE INDEX idx_growth_focus_item_events_history
  ON growth_focus_item_events(focus_item_id, task_revision DESC);

CREATE INDEX idx_growth_focus_item_events_analysis
  ON growth_focus_item_events(analysis_run_id, event_type, occurred_at DESC);

CREATE VIEW growth_open_focus_items_v AS
SELECT *
FROM growth_focus_items
WHERE status IN (
  'NEW',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
  'MONITORING',
  'BLOCKED',
  'REOPENED'
);
