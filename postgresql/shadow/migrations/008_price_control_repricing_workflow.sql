CREATE TABLE app.price_control_repricing_plans (
  id uuid,
  source_round_id text NOT NULL,
  account_id text NOT NULL,
  execution_provider text NOT NULL,
  status text NOT NULL,
  instruction_text text NOT NULL,
  source_assignments_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_provider_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  parsed_commands_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview_token text NOT NULL,
  preview_fingerprint text NOT NULL,
  preview_created_at timestamptz NOT NULL,
  preview_expires_at timestamptz NOT NULL,
  target_shop_count integer NOT NULL DEFAULT 0,
  listing_change_count integer NOT NULL DEFAULT 0,
  warnings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  selected_item_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  confirmed_by text,
  confirmed_at timestamptz,
  confirmation_fingerprint text,
  execution_job_id text,
  execution_state text,
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  CHECK (execution_provider IN ('MABANG_LISTING','PLATFORM_GATEWAY')),
  CHECK (status IN (
    'PREVIEW_READY','CONFIRMING','EXECUTING','EXECUTION_UNKNOWN',
    'SUCCEEDED','PARTIAL','FAILED','EXPIRED','CANCELLED'
  )),
  CHECK (target_shop_count >= 0),
  CHECK (listing_change_count >= 0)
);

CREATE TABLE app.price_control_repricing_items (
  id uuid,
  plan_id uuid NOT NULL,
  source_change_id text NOT NULL,
  source_command_index integer NOT NULL,
  registry_shop_id text NOT NULL,
  provider_change_id text NOT NULL,
  platform text NOT NULL,
  country_code text NOT NULL,
  sku text NOT NULL,
  control_shop_type text NOT NULL,
  price_type text NOT NULL,
  target_field text NOT NULL,
  provider_shop_id text NOT NULL,
  shop_name text NOT NULL,
  internal_listing_id text NOT NULL,
  variation_key text NOT NULL,
  old_value_json jsonb NOT NULL,
  new_value_json jsonb NOT NULL,
  selected boolean NOT NULL DEFAULT FALSE,
  status text NOT NULL DEFAULT 'PREVIEWED',
  result_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_preview_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (plan_id,provider_change_id),
  CHECK (source_command_index >= 1),
  CHECK (target_field IN ('price','special_price')),
  CHECK (status IN (
    'PREVIEWED','SUBMITTED','SUCCEEDED','FAILED','SKIPPED','EXECUTION_UNKNOWN'
  ))
);

ALTER TABLE app.price_control_repricing_plans
  ADD CONSTRAINT fk_price_control_repricing_plans_1
  FOREIGN KEY (source_round_id) REFERENCES app.price_control_sync_runs(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE app.price_control_repricing_plans
  ADD CONSTRAINT fk_price_control_repricing_plans_2
  FOREIGN KEY (account_id) REFERENCES app.foundation_integration_accounts(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE app.price_control_repricing_items
  ADD CONSTRAINT fk_price_control_repricing_items_1
  FOREIGN KEY (plan_id) REFERENCES app.price_control_repricing_plans(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE app.price_control_repricing_items
  ADD CONSTRAINT fk_price_control_repricing_items_2
  FOREIGN KEY (source_change_id) REFERENCES app.product_price_change_events(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

ALTER TABLE app.price_control_repricing_items
  ADD CONSTRAINT fk_price_control_repricing_items_3
  FOREIGN KEY (registry_shop_id) REFERENCES app.commerce_shop_registry(id)
  ON UPDATE NO ACTION ON DELETE RESTRICT;

CREATE INDEX idx_price_control_repricing_plans_round
  ON app.price_control_repricing_plans(source_round_id,created_at DESC);

CREATE INDEX idx_price_control_repricing_plans_status
  ON app.price_control_repricing_plans(status,preview_expires_at,updated_at DESC);

CREATE INDEX idx_price_control_repricing_items_plan
  ON app.price_control_repricing_items(plan_id,selected,status,source_command_index,id);

CREATE INDEX idx_price_control_repricing_items_source
  ON app.price_control_repricing_items(source_change_id,status,updated_at DESC);
