CREATE TABLE IF NOT EXISTS cs_channel_accounts (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  display_name TEXT NOT NULL,
  external_account_key_digest TEXT,
  status TEXT NOT NULL DEFAULT 'SETUP_REQUIRED',
  settings_json TEXT NOT NULL DEFAULT '{}',
  last_observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel, external_account_key_digest),
  CHECK (status IN ('SETUP_REQUIRED','ACTIVE','PAUSED','ERROR','DISABLED'))
);

CREATE TABLE IF NOT EXISTS cs_channel_shop_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  external_shop_key_digest TEXT NOT NULL,
  commerce_shop_id TEXT,
  shop_name TEXT NOT NULL,
  country_code TEXT,
  identity_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES cs_channel_accounts(id) ON DELETE CASCADE,
  UNIQUE (account_id, external_shop_key_digest),
  CHECK (identity_status IN ('UNRESOLVED','MATCHED','REVIEW_REQUIRED','CONFIRMED'))
);

CREATE TABLE IF NOT EXISTS cs_worker_nodes (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OFFLINE',
  version TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  last_heartbeat_at TEXT,
  last_error_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('ONLINE','DEGRADED','OFFLINE','DISABLED'))
);

CREATE TABLE IF NOT EXISTS cs_worker_account_leases (
  account_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  lease_token_digest TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES cs_channel_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (worker_id) REFERENCES cs_worker_nodes(id) ON DELETE CASCADE,
  CHECK (status IN ('ACTIVE','RELEASED','EXPIRED'))
);

CREATE TABLE IF NOT EXISTS cs_ingest_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  processed_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'RECEIVED',
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES cs_worker_nodes(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES cs_channel_accounts(id) ON DELETE RESTRICT,
  UNIQUE (worker_id, sequence_no),
  CHECK (processing_status IN ('RECEIVED','PROCESSED','REJECTED'))
);

CREATE TABLE IF NOT EXISTS cs_conversations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  shop_binding_id TEXT,
  external_conversation_digest TEXT NOT NULL,
  routing_ciphertext TEXT NOT NULL,
  customer_external_digest TEXT NOT NULL,
  customer_display_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  unread_count INTEGER NOT NULL DEFAULT 0,
  latest_message_at TEXT,
  current_inbound_message_id TEXT,
  handled_at TEXT,
  assigned_user_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES cs_channel_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (shop_binding_id) REFERENCES cs_channel_shop_bindings(id) ON DELETE SET NULL,
  UNIQUE (account_id, external_conversation_digest),
  CHECK (status IN ('OPEN','HANDLED','ARCHIVED')),
  CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT'))
);

CREATE TABLE IF NOT EXISTS cs_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  external_message_digest TEXT NOT NULL,
  routing_ciphertext TEXT NOT NULL,
  direction TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'TEXT',
  content_ciphertext TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (event_id) REFERENCES cs_ingest_events(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES cs_channel_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id) ON DELETE CASCADE,
  UNIQUE (account_id, external_message_digest),
  CHECK (direction IN ('INBOUND','OUTBOUND','SYSTEM'))
);

CREATE TABLE IF NOT EXISTS cs_message_observations (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  observation_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES cs_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (worker_id) REFERENCES cs_worker_nodes(id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES cs_ingest_events(id) ON DELETE RESTRICT,
  UNIQUE (message_id, worker_id, event_id)
);

CREATE TABLE IF NOT EXISTS cs_panel_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  snapshot_ciphertext TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL,
  completeness_json TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES cs_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (worker_id) REFERENCES cs_worker_nodes(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS cs_context_snapshots (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  context_ciphertext TEXT NOT NULL,
  context_digest TEXT NOT NULL,
  context_version TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  built_at TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES cs_messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cs_suggestions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  context_snapshot_id TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  draft_ciphertext TEXT,
  language_code TEXT,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  confidence NUMERIC,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  intent_code TEXT,
  risk_level TEXT,
  country_code TEXT,
  commerce_shop_id TEXT,
  product_model_id TEXT,
  product_sku_id TEXT,
  category_id TEXT,
  category_name TEXT,
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  superseded_by_message_id TEXT,
  generation_started_at TEXT,
  generation_finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES cs_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (context_snapshot_id) REFERENCES cs_context_snapshots(id) ON DELETE SET NULL,
  CHECK (status IN ('QUEUED','GENERATING','READY','STALE','FAILED','ACCEPTED','EDITED','REJECTED','FILLED')),
  CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH')),
  CHECK (input_tokens IS NULL OR input_tokens >= 0),
  CHECK (output_tokens IS NULL OR output_tokens >= 0),
  CHECK (total_tokens IS NULL OR total_tokens >= 0)
);

CREATE TABLE IF NOT EXISTS cs_suggestion_evidence (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT,
  source_version TEXT,
  label TEXT NOT NULL,
  excerpt_ciphertext TEXT,
  rank_no INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (suggestion_id) REFERENCES cs_suggestions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cs_suggestion_reviews (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  action TEXT NOT NULL,
  final_text_ciphertext TEXT,
  reason_code TEXT,
  comment_ciphertext TEXT,
  edit_distance_ratio NUMERIC,
  edit_metric_version TEXT,
  edit_metric_approximate INTEGER NOT NULL DEFAULT 0,
  original_length INTEGER,
  final_length INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (suggestion_id) REFERENCES cs_suggestions(id) ON DELETE CASCADE,
  CHECK (action IN ('ACCEPT','EDIT','REJECT','MARK_HANDLED')),
  CHECK (edit_distance_ratio IS NULL OR (edit_distance_ratio >= 0 AND edit_distance_ratio <= 1)),
  CHECK (edit_metric_approximate IN (0,1))
);

CREATE TABLE IF NOT EXISTS cs_worker_commands (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  conversation_id TEXT,
  trigger_message_id TEXT,
  suggestion_id TEXT,
  command_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  payload_ciphertext TEXT NOT NULL,
  available_at TEXT NOT NULL,
  leased_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_code TEXT,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (worker_id) REFERENCES cs_worker_nodes(id) ON DELETE RESTRICT,
  FOREIGN KEY (account_id) REFERENCES cs_channel_accounts(id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (trigger_message_id) REFERENCES cs_messages(id) ON DELETE CASCADE,
  FOREIGN KEY (suggestion_id) REFERENCES cs_suggestions(id) ON DELETE CASCADE,
  CHECK (command_type IN ('FOCUS_CONVERSATION','FILL_DRAFT','CLEAR_DRAFT','CAPTURE_PANEL')),
  CHECK (status IN ('PENDING','LEASED','SUCCEEDED','FAILED','CANCELED','EXPIRED'))
);

CREATE TABLE IF NOT EXISTS cs_send_actions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  suggestion_id TEXT,
  message_id TEXT,
  action TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES cs_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (suggestion_id) REFERENCES cs_suggestions(id) ON DELETE SET NULL,
  FOREIGN KEY (message_id) REFERENCES cs_messages(id) ON DELETE SET NULL,
  CHECK (action IN ('DRAFT_FILLED','SEND_CONFIRMED','SEND_OBSERVED','MARK_HANDLED')),
  CHECK (actor_type IN ('USER','WORKER','SYSTEM'))
);

CREATE INDEX IF NOT EXISTS idx_cs_shop_bindings_shop ON cs_channel_shop_bindings(commerce_shop_id, identity_status);
CREATE INDEX IF NOT EXISTS idx_cs_workers_heartbeat ON cs_worker_nodes(status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_cs_ingest_account_time ON cs_ingest_events(account_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_cs_conversations_inbox ON cs_conversations(status, priority, latest_message_at);
CREATE INDEX IF NOT EXISTS idx_cs_messages_conversation_time ON cs_messages(conversation_id, sent_at, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_suggestions_queue ON cs_suggestions(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_suggestions_quality_dimensions ON cs_suggestions(country_code,category_id,intent_code,risk_level);
CREATE INDEX IF NOT EXISTS idx_cs_suggestions_conversation ON cs_suggestions(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cs_commands_worker_queue ON cs_worker_commands(worker_id, status, available_at);
