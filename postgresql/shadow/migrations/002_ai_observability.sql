CREATE SCHEMA IF NOT EXISTS ai_shadow;

CREATE TABLE ai_shadow.agent_runs (
  id text PRIMARY KEY,
  request_id text,
  agent_name text NOT NULL,
  agent_version text NOT NULL,
  context_versions text,
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  duration_ms bigint,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  error_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_shadow_agent_runs_started ON ai_shadow.agent_runs(started_at DESC);
CREATE INDEX idx_shadow_agent_runs_status ON ai_shadow.agent_runs(status, started_at DESC);

CREATE TABLE ai_shadow.context_snapshots (
  id text PRIMARY KEY,
  agent_run_id text NOT NULL REFERENCES ai_shadow.agent_runs(id) ON DELETE CASCADE,
  context_name text NOT NULL,
  context_version text NOT NULL,
  content_sha256 text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  object_key text,
  created_at timestamptz NOT NULL
);

CREATE INDEX idx_shadow_context_run ON ai_shadow.context_snapshots(agent_run_id, created_at);

CREATE TABLE ai_shadow.tool_invocations (
  id text PRIMARY KEY,
  agent_run_id text REFERENCES ai_shadow.agent_runs(id) ON DELETE CASCADE,
  request_id text,
  tool_name text NOT NULL,
  tool_version text,
  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')),
  duration_ms bigint,
  error_code text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX idx_shadow_tool_run ON ai_shadow.tool_invocations(agent_run_id, occurred_at);
CREATE INDEX idx_shadow_tool_name ON ai_shadow.tool_invocations(tool_name, occurred_at DESC);

CREATE TABLE ai_shadow.gateway_calls (
  id text PRIMARY KEY,
  agent_run_id text REFERENCES ai_shadow.agent_runs(id) ON DELETE SET NULL,
  request_id text,
  provider text,
  model text,
  prompt_version text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  duration_ms bigint,
  status text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX idx_shadow_gateway_run ON ai_shadow.gateway_calls(agent_run_id, occurred_at);

CREATE TABLE ai_shadow.agent_evaluations (
  id text PRIMARY KEY,
  agent_run_id text NOT NULL REFERENCES ai_shadow.agent_runs(id) ON DELETE CASCADE,
  evaluator_type text NOT NULL CHECK (evaluator_type IN ('deterministic','human','model')),
  evaluator_version text NOT NULL,
  status text NOT NULL,
  score numeric,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX idx_shadow_evaluation_run ON ai_shadow.agent_evaluations(agent_run_id, created_at);

