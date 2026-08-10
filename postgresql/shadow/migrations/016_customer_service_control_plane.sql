CREATE TABLE IF NOT EXISTS app.cs_channel_accounts (
  id text PRIMARY KEY,
  channel text NOT NULL,
  display_name text NOT NULL,
  external_account_key_digest text,
  status text NOT NULL DEFAULT 'SETUP_REQUIRED',
  settings_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_observed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (channel, external_account_key_digest),
  CHECK (status IN ('SETUP_REQUIRED','ACTIVE','PAUSED','ERROR','DISABLED'))
);

CREATE TABLE IF NOT EXISTS app.cs_channel_shop_bindings (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES app.cs_channel_accounts(id) ON DELETE CASCADE,
  external_shop_key_digest text NOT NULL,
  commerce_shop_id text,
  shop_name text NOT NULL,
  country_code text,
  identity_status text NOT NULL DEFAULT 'UNRESOLVED',
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (account_id, external_shop_key_digest),
  CHECK (identity_status IN ('UNRESOLVED','MATCHED','REVIEW_REQUIRED','CONFIRMED'))
);

CREATE TABLE IF NOT EXISTS app.cs_worker_nodes (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'OFFLINE',
  version text,
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_heartbeat_at timestamptz,
  last_error_code text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (status IN ('ONLINE','DEGRADED','OFFLINE','DISABLED'))
);

CREATE TABLE IF NOT EXISTS app.cs_worker_account_leases (
  account_id text PRIMARY KEY REFERENCES app.cs_channel_accounts(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES app.cs_worker_nodes(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ACTIVE',
  lease_token_digest text NOT NULL,
  leased_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (status IN ('ACTIVE','RELEASED','EXPIRED'))
);

CREATE TABLE IF NOT EXISTS app.cs_ingest_events (
  id text PRIMARY KEY,
  event_key text NOT NULL UNIQUE,
  worker_id text NOT NULL REFERENCES app.cs_worker_nodes(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES app.cs_channel_accounts(id) ON DELETE RESTRICT,
  sequence_no bigint NOT NULL,
  event_type text NOT NULL,
  payload_digest text NOT NULL,
  observed_at timestamptz NOT NULL,
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'RECEIVED',
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (worker_id, sequence_no),
  CHECK (processing_status IN ('RECEIVED','PROCESSED','REJECTED'))
);

CREATE TABLE IF NOT EXISTS app.cs_conversations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES app.cs_channel_accounts(id) ON DELETE CASCADE,
  shop_binding_id text REFERENCES app.cs_channel_shop_bindings(id) ON DELETE SET NULL,
  external_conversation_digest text NOT NULL,
  routing_ciphertext text NOT NULL,
  customer_external_digest text NOT NULL,
  customer_display_ciphertext text NOT NULL,
  status text NOT NULL DEFAULT 'OPEN',
  priority text NOT NULL DEFAULT 'NORMAL',
  unread_count integer NOT NULL DEFAULT 0,
  latest_message_at timestamptz,
  current_inbound_message_id text,
  handled_at timestamptz,
  assigned_user_id text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (account_id, external_conversation_digest),
  CHECK (status IN ('OPEN','HANDLED','ARCHIVED')),
  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT'))
);

CREATE TABLE IF NOT EXISTS app.cs_messages (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES app.cs_ingest_events(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES app.cs_channel_accounts(id) ON DELETE RESTRICT,
  conversation_id text NOT NULL REFERENCES app.cs_conversations(id) ON DELETE CASCADE,
  external_message_digest text NOT NULL,
  routing_ciphertext text NOT NULL,
  direction text NOT NULL,
  content_type text NOT NULL DEFAULT 'TEXT',
  content_ciphertext text NOT NULL,
  content_digest text NOT NULL,
  sent_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (account_id, external_message_digest),
  CHECK (direction IN ('INBOUND','OUTBOUND','SYSTEM'))
);

CREATE TABLE IF NOT EXISTS app.cs_message_observations (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES app.cs_messages(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES app.cs_worker_nodes(id) ON DELETE RESTRICT,
  event_id text NOT NULL REFERENCES app.cs_ingest_events(id) ON DELETE RESTRICT,
  observation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (message_id, worker_id, event_id)
);

CREATE TABLE IF NOT EXISTS app.cs_panel_snapshots (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES app.cs_conversations(id) ON DELETE CASCADE,
  trigger_message_id text NOT NULL REFERENCES app.cs_messages(id) ON DELETE CASCADE,
  worker_id text NOT NULL REFERENCES app.cs_worker_nodes(id) ON DELETE RESTRICT,
  snapshot_ciphertext text NOT NULL,
  snapshot_digest text NOT NULL,
  completeness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app.cs_context_snapshots (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES app.cs_conversations(id) ON DELETE CASCADE,
  trigger_message_id text NOT NULL REFERENCES app.cs_messages(id) ON DELETE CASCADE,
  context_ciphertext text NOT NULL,
  context_digest text NOT NULL,
  context_version text NOT NULL,
  evidence_count integer NOT NULL DEFAULT 0,
  missing_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  built_at timestamptz NOT NULL,
  expires_at timestamptz,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app.cs_suggestions (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES app.cs_conversations(id) ON DELETE CASCADE,
  trigger_message_id text NOT NULL REFERENCES app.cs_messages(id) ON DELETE CASCADE,
  context_snapshot_id text REFERENCES app.cs_context_snapshots(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  draft_ciphertext text,
  language_code text,
  provider text,
  model text,
  prompt_version text,
  confidence numeric,
  input_tokens integer,
  output_tokens integer,
  total_tokens integer,
  intent_code text,
  risk_level text,
  country_code text,
  commerce_shop_id text,
  product_model_id text,
  product_sku_id text,
  category_id text,
  category_name text,
  quality_flags_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code text,
  superseded_by_message_id text,
  generation_started_at timestamptz,
  generation_finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (status IN ('QUEUED','GENERATING','READY','STALE','FAILED','ACCEPTED','EDITED','REJECTED','FILLED')),
  CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH')),
  CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CHECK (total_tokens IS NULL OR total_tokens >= 0)
);

CREATE TABLE IF NOT EXISTS app.cs_suggestion_evidence (
  id text PRIMARY KEY,
  suggestion_id text NOT NULL REFERENCES app.cs_suggestions(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id text,
  source_version text,
  label text NOT NULL,
  excerpt_ciphertext text,
  rank_no integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS app.cs_suggestion_reviews (
  id text PRIMARY KEY,
  suggestion_id text NOT NULL REFERENCES app.cs_suggestions(id) ON DELETE CASCADE,
  reviewer_id text NOT NULL,
  action text NOT NULL,
  final_text_ciphertext text,
  reason_code text,
  comment_ciphertext text,
  edit_distance_ratio numeric,
  edit_metric_version text,
  edit_metric_approximate integer NOT NULL DEFAULT 0,
  original_length integer,
  final_length integer,
  created_at timestamptz NOT NULL,
  CHECK (action IN ('ACCEPT','EDIT','REJECT','MARK_HANDLED')),
  CHECK (edit_distance_ratio IS NULL OR (edit_distance_ratio >= 0 AND edit_distance_ratio <= 1)),
  CHECK (edit_metric_approximate IN (0,1))
);

CREATE TABLE IF NOT EXISTS app.cs_worker_commands (
  id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  worker_id text NOT NULL REFERENCES app.cs_worker_nodes(id) ON DELETE RESTRICT,
  account_id text NOT NULL REFERENCES app.cs_channel_accounts(id) ON DELETE RESTRICT,
  conversation_id text REFERENCES app.cs_conversations(id) ON DELETE CASCADE,
  trigger_message_id text REFERENCES app.cs_messages(id) ON DELETE CASCADE,
  suggestion_id text REFERENCES app.cs_suggestions(id) ON DELETE CASCADE,
  command_type text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  payload_ciphertext text NOT NULL,
  available_at timestamptz NOT NULL,
  leased_until timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  result_code text,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (command_type IN ('FOCUS_CONVERSATION','FILL_DRAFT','CLEAR_DRAFT','CAPTURE_PANEL')),
  CHECK (status IN ('PENDING','LEASED','SUCCEEDED','FAILED','CANCELED','EXPIRED'))
);

CREATE TABLE IF NOT EXISTS app.cs_send_actions (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES app.cs_conversations(id) ON DELETE CASCADE,
  suggestion_id text REFERENCES app.cs_suggestions(id) ON DELETE SET NULL,
  message_id text REFERENCES app.cs_messages(id) ON DELETE SET NULL,
  action text NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  outcome text NOT NULL,
  detail_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  CHECK (action IN ('DRAFT_FILLED','SEND_CONFIRMED','SEND_OBSERVED','MARK_HANDLED')),
  CHECK (actor_type IN ('USER','WORKER','SYSTEM'))
);

CREATE INDEX IF NOT EXISTS idx_cs_shop_bindings_shop ON app.cs_channel_shop_bindings(commerce_shop_id, identity_status);
CREATE INDEX IF NOT EXISTS idx_cs_workers_heartbeat ON app.cs_worker_nodes(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_cs_ingest_account_time ON app.cs_ingest_events(account_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_cs_conversations_inbox ON app.cs_conversations(status, priority, latest_message_at);
CREATE INDEX IF NOT EXISTS idx_cs_messages_conversation_time ON app.cs_messages(conversation_id, sent_at, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_suggestions_queue ON app.cs_suggestions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_suggestions_quality_dimensions ON app.cs_suggestions(country_code,category_id,intent_code,risk_level);
CREATE INDEX IF NOT EXISTS idx_cs_suggestions_conversation ON app.cs_suggestions(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_commands_worker_queue ON app.cs_worker_commands(worker_id, status, available_at);
