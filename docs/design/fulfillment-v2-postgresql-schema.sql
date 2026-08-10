BEGIN;

CREATE SCHEMA IF NOT EXISTS fulfillment;

CREATE TABLE fulfillment.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fulfillment.actors (
  id uuid PRIMARY KEY,
  actor_type text NOT NULL CHECK (actor_type IN ('human', 'service', 'system')),
  auth_source text NOT NULL,
  external_subject text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (auth_source, external_subject)
);

CREATE TABLE fulfillment.shops (
  id uuid PRIMARY KEY,
  platform text NOT NULL,
  external_shop_id text NOT NULL,
  display_name text NOT NULL,
  country_code text NOT NULL,
  account_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_shop_id)
);

CREATE TABLE fulfillment.shipping_channels (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES fulfillment.shops(id) ON DELETE CASCADE,
  external_channel_id text NOT NULL,
  channel_name text NOT NULL,
  provider_id text,
  logistics_id text,
  logistics_name text,
  active boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (shop_id, external_channel_id)
);

CREATE TABLE fulfillment.shop_policy_versions (
  id uuid PRIMARY KEY,
  shop_id uuid NOT NULL REFERENCES fulfillment.shops(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  mode text NOT NULL CHECK (mode IN ('manual', 'automatic', 'disabled')),
  shipping_channel_id uuid REFERENCES fulfillment.shipping_channels(id) ON DELETE RESTRICT,
  warehouse_policy text NOT NULL,
  allowed_warehouses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_warehouses) = 'array'),
  min_order_age_minutes integer NOT NULL CHECK (min_order_age_minutes >= 0),
  max_batch_size integer NOT NULL CHECK (max_batch_size > 0),
  policy_document jsonb NOT NULL,
  policy_hash text NOT NULL CHECK (length(policy_hash) = 64),
  created_by_actor_id uuid NOT NULL REFERENCES fulfillment.actors(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  UNIQUE (shop_id, version),
  UNIQUE (shop_id, policy_hash)
);

CREATE TABLE fulfillment.scan_runs (
  id uuid PRIMARY KEY,
  shop_id uuid REFERENCES fulfillment.shops(id) ON DELETE RESTRICT,
  trigger_type text NOT NULL CHECK (trigger_type IN ('scheduled', 'manual', 'recovery', 'migration')),
  requested_by_actor_id uuid NOT NULL REFERENCES fulfillment.actors(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partially_succeeded', 'failed', 'cancelled')),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligible_count integer NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  excluded_count integer NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  error_code text,
  error_message text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE fulfillment.order_candidates (
  id uuid PRIMARY KEY,
  scan_run_id uuid NOT NULL REFERENCES fulfillment.scan_runs(id) ON DELETE RESTRICT,
  shop_id uuid NOT NULL REFERENCES fulfillment.shops(id) ON DELETE RESTRICT,
  order_key text NOT NULL,
  display_order_id text NOT NULL,
  trade_number text,
  source_order_status text NOT NULL,
  warehouse_name text,
  sku_count integer NOT NULL DEFAULT 0 CHECK (sku_count >= 0),
  eligible boolean NOT NULL,
  exclusion_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exclusion_codes) = 'array'),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL CHECK (length(snapshot_hash) = 64),
  discovered_at timestamptz NOT NULL,
  UNIQUE (scan_run_id, order_key)
);

CREATE TABLE fulfillment.previews (
  id uuid PRIMARY KEY,
  scan_run_id uuid NOT NULL REFERENCES fulfillment.scan_runs(id) ON DELETE RESTRICT,
  shop_id uuid NOT NULL REFERENCES fulfillment.shops(id) ON DELETE RESTRICT,
  policy_version_id uuid NOT NULL REFERENCES fulfillment.shop_policy_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  preview_hash text NOT NULL CHECK (length(preview_hash) = 64),
  policy_hash text NOT NULL CHECK (length(policy_hash) = 64),
  approval_challenge_hash text NOT NULL CHECK (length(approval_challenge_hash) = 64),
  eligible_count integer NOT NULL CHECK (eligible_count >= 0),
  excluded_count integer NOT NULL CHECK (excluded_count >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  UNIQUE (id, preview_hash),
  UNIQUE (id, policy_hash)
);

CREATE TABLE fulfillment.preview_items (
  id uuid PRIMARY KEY,
  preview_id uuid NOT NULL REFERENCES fulfillment.previews(id) ON DELETE RESTRICT,
  candidate_id uuid NOT NULL REFERENCES fulfillment.order_candidates(id) ON DELETE RESTRICT,
  order_key text NOT NULL,
  display_order_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  selected boolean NOT NULL,
  eligible boolean NOT NULL,
  exclusion_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(exclusion_codes) = 'array'),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (preview_id, order_key),
  UNIQUE (preview_id, position)
);

CREATE TABLE fulfillment.approval_decisions (
  id uuid PRIMARY KEY,
  preview_id uuid NOT NULL REFERENCES fulfillment.previews(id) ON DELETE RESTRICT,
  supersedes_decision_id uuid REFERENCES fulfillment.approval_decisions(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'revoked')),
  approval_mode text NOT NULL CHECK (approval_mode IN ('manual', 'automatic')),
  actor_id uuid NOT NULL REFERENCES fulfillment.actors(id) ON DELETE RESTRICT,
  actor_type_snapshot text NOT NULL CHECK (actor_type_snapshot IN ('human', 'service', 'system')),
  actor_subject_snapshot text NOT NULL,
  actor_display_name_snapshot text NOT NULL,
  auth_source_snapshot text NOT NULL,
  preview_hash text NOT NULL CHECK (length(preview_hash) = 64),
  policy_hash text NOT NULL CHECK (length(policy_hash) = 64),
  reason_code text NOT NULL,
  decision_note text,
  request_id text NOT NULL,
  source_ip inet,
  user_agent text,
  decided_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (approval_mode = 'manual' AND actor_type_snapshot = 'human') OR
    (approval_mode = 'automatic' AND actor_type_snapshot IN ('service', 'system'))
  ),
  CHECK (
    (decision = 'revoked' AND supersedes_decision_id IS NOT NULL) OR
    (decision <> 'revoked' AND supersedes_decision_id IS NULL)
  ),
  UNIQUE (id, preview_id)
);

CREATE TABLE fulfillment.preview_approval_state (
  preview_id uuid PRIMARY KEY REFERENCES fulfillment.previews(id) ON DELETE RESTRICT,
  current_decision_id uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('approved', 'rejected', 'revoked')),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (current_decision_id, preview_id)
    REFERENCES fulfillment.approval_decisions(id, preview_id) ON DELETE RESTRICT
);

CREATE TABLE fulfillment.jobs (
  id uuid PRIMARY KEY,
  preview_id uuid NOT NULL UNIQUE REFERENCES fulfillment.previews(id) ON DELETE RESTRICT,
  approval_decision_id uuid NOT NULL UNIQUE,
  shop_id uuid NOT NULL REFERENCES fulfillment.shops(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partially_succeeded', 'failed', 'needs_attention', 'cancelled')),
  item_count integer NOT NULL CHECK (item_count > 0),
  queued_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (started_at IS NULL OR started_at >= queued_at),
  CHECK (finished_at IS NULL OR finished_at >= COALESCE(started_at, queued_at)),
  FOREIGN KEY (approval_decision_id, preview_id)
    REFERENCES fulfillment.approval_decisions(id, preview_id) ON DELETE RESTRICT
);

CREATE TABLE fulfillment.job_items (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES fulfillment.jobs(id) ON DELETE RESTRICT,
  preview_item_id uuid NOT NULL REFERENCES fulfillment.preview_items(id) ON DELETE RESTRICT,
  order_key text NOT NULL,
  display_order_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'submitting', 'succeeded', 'failed', 'recovery_required', 'needs_attention', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  before_status text,
  after_status text,
  tracking_number_masked text,
  last_error_code text,
  last_error_message text,
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, order_key),
  UNIQUE (job_id, preview_item_id)
);

CREATE TABLE fulfillment.idempotency_keys (
  id uuid PRIMARY KEY,
  scope text NOT NULL DEFAULT 'fulfillment_order',
  shop_id uuid NOT NULL REFERENCES fulfillment.shops(id) ON DELETE RESTRICT,
  order_key text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  job_item_id uuid NOT NULL REFERENCES fulfillment.job_items(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('reserved', 'running', 'succeeded', 'failed', 'needs_attention', 'released')),
  reserved_at timestamptz NOT NULL,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, shop_id, order_key)
);

CREATE TABLE fulfillment.submission_attempts (
  id uuid PRIMARY KEY,
  job_item_id uuid NOT NULL REFERENCES fulfillment.job_items(id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  request_id text NOT NULL,
  request_hash text NOT NULL CHECK (length(request_hash) = 64),
  request_payload_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_payload_redacted jsonb,
  outcome text NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'uncertain', 'cancelled')),
  http_status integer,
  external_error_code text,
  error_message text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  UNIQUE (job_item_id, attempt_no),
  UNIQUE (request_id)
);

CREATE TABLE fulfillment.events (
  id uuid PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('preview', 'approval', 'job', 'job_item', 'recovery')),
  aggregate_id uuid NOT NULL,
  job_item_id uuid REFERENCES fulfillment.job_items(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  from_state text,
  to_state text,
  actor_id uuid NOT NULL REFERENCES fulfillment.actors(id) ON DELETE RESTRICT,
  actor_display_name_snapshot text NOT NULL,
  reason_code text,
  request_id text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (aggregate_type, aggregate_id, request_id, event_type)
);

CREATE TABLE fulfillment.recovery_tasks (
  id uuid PRIMARY KEY,
  job_item_id uuid NOT NULL REFERENCES fulfillment.job_items(id) ON DELETE RESTRICT,
  recovery_type text NOT NULL CHECK (recovery_type IN ('tracking_number', 'uncertain_submission', 'message_review', 'manual')),
  status text NOT NULL CHECK (status IN ('pending', 'checking', 'waiting', 'retry_ready', 'recovered', 'manual_attention', 'expired', 'cancelled')),
  check_count integer NOT NULL DEFAULT 0 CHECK (check_count >= 0),
  next_check_at timestamptz,
  deadline_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_fulfillment_active_recovery
  ON fulfillment.recovery_tasks(job_item_id, recovery_type)
  WHERE status IN ('pending', 'checking', 'waiting', 'retry_ready');

CREATE TABLE fulfillment.recovery_checks (
  id uuid PRIMARY KEY,
  recovery_task_id uuid NOT NULL REFERENCES fulfillment.recovery_tasks(id) ON DELETE RESTRICT,
  check_no integer NOT NULL CHECK (check_no > 0),
  actor_id uuid NOT NULL REFERENCES fulfillment.actors(id) ON DELETE RESTRICT,
  outcome text NOT NULL CHECK (outcome IN ('waiting', 'retry_ready', 'recovered', 'manual_attention', 'failed')),
  observed_order_status text,
  tracking_number_masked text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  checked_at timestamptz NOT NULL,
  UNIQUE (recovery_task_id, check_no)
);

CREATE TABLE fulfillment.outbox_messages (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fulfillment_policy_effective
  ON fulfillment.shop_policy_versions(shop_id, effective_from DESC);
CREATE INDEX idx_fulfillment_scan_queue
  ON fulfillment.scan_runs(status, started_at DESC);
CREATE INDEX idx_fulfillment_candidates_order
  ON fulfillment.order_candidates(shop_id, order_key, discovered_at DESC);
CREATE INDEX idx_fulfillment_previews_queue
  ON fulfillment.previews(status, expires_at, created_at);
CREATE INDEX idx_fulfillment_approval_actor
  ON fulfillment.approval_decisions(actor_id, decided_at DESC);
CREATE INDEX idx_fulfillment_jobs_queue
  ON fulfillment.jobs(status, queued_at);
CREATE INDEX idx_fulfillment_job_items_queue
  ON fulfillment.job_items(status, updated_at);
CREATE INDEX idx_fulfillment_attempts_item
  ON fulfillment.submission_attempts(job_item_id, attempt_no DESC);
CREATE INDEX idx_fulfillment_events_aggregate
  ON fulfillment.events(aggregate_type, aggregate_id, occurred_at);
CREATE INDEX idx_fulfillment_recovery_queue
  ON fulfillment.recovery_tasks(status, next_check_at);
CREATE INDEX idx_fulfillment_outbox_queue
  ON fulfillment.outbox_messages(status, available_at);

INSERT INTO fulfillment.schema_migrations(version)
VALUES ('FULFILLMENT_V2_FOUNDATION_001');

COMMIT;
