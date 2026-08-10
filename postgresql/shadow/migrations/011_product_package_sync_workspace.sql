CREATE TABLE app.product_package_sync_stage_source (
  run_id text NOT NULL REFERENCES app.product_package_sync_runs(id) ON DELETE CASCADE,
  source_row_number integer NOT NULL,
  source_row_key text NOT NULL,
  row_sha256 text NOT NULL,
  product_key text NOT NULL,
  country_code text NOT NULL,
  stock_sku text NOT NULL,
  warehouse_id text NOT NULL,
  warehouse_name text NOT NULL,
  sales_sku text,
  product_name text NOT NULL,
  category_l1 text NOT NULL,
  category_l2 text NOT NULL,
  category_l3 text,
  source_period text,
  source_status text NOT NULL,
  lifecycle_status text NOT NULL,
  lifecycle_reason_code text NOT NULL,
  source_updated_at text,
  raw_payload_json text NOT NULL,
  raw_types_json text NOT NULL,
  normalized_payload_json text NOT NULL,
  category_l1_id text NOT NULL,
  category_l2_id text NOT NULL,
  model_id text,
  product_id text NOT NULL,
  PRIMARY KEY (run_id,source_row_key)
);
CREATE INDEX idx_product_package_sync_stage_source_product
  ON app.product_package_sync_stage_source(run_id,product_key);

CREATE TABLE app.product_package_sync_stage_changed_keys (
  run_id text NOT NULL REFERENCES app.product_package_sync_runs(id) ON DELETE CASCADE,
  source_row_key text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('ADDED','UPDATED','REMOVED')),
  PRIMARY KEY (run_id,source_row_key)
);

CREATE TABLE app.product_package_sync_stage_changed_rows (
  run_id text NOT NULL REFERENCES app.product_package_sync_runs(id) ON DELETE CASCADE,
  source_row_key text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('ADDED','UPDATED','REMOVED')),
  source_row_number integer NOT NULL,
  new_row_sha256 text,
  old_row_sha256 text,
  new_product_key text,
  old_product_key text,
  country_code text,
  stock_sku text,
  warehouse_id text,
  warehouse_name text,
  product_name text,
  new_raw_payload_json text,
  old_raw_payload_json text,
  new_raw_types_json text,
  old_raw_types_json text,
  new_normalized_payload_json text,
  old_normalized_payload_json text,
  old_package_row_id text,
  PRIMARY KEY (run_id,source_row_key)
);

CREATE TABLE app.product_package_sync_stage_field_events (
  run_id text NOT NULL REFERENCES app.product_package_sync_runs(id) ON DELETE CASCADE,
  source_row_key text NOT NULL,
  change_type text NOT NULL CHECK (change_type IN ('ADDED','UPDATED','REMOVED')),
  field_name text NOT NULL,
  old_value_json text,
  new_value_json text,
  old_type text,
  new_type text,
  PRIMARY KEY (run_id,source_row_key,field_name)
);

CREATE TABLE app.product_package_sync_stage_products (
  run_id text NOT NULL REFERENCES app.product_package_sync_runs(id) ON DELETE CASCADE,
  source_row_number integer NOT NULL,
  source_row_key text NOT NULL,
  row_sha256 text NOT NULL,
  product_key text NOT NULL,
  country_code text NOT NULL,
  stock_sku text NOT NULL,
  warehouse_id text NOT NULL,
  warehouse_name text NOT NULL,
  sales_sku text,
  product_name text NOT NULL,
  category_l1 text NOT NULL,
  category_l2 text NOT NULL,
  category_l3 text,
  source_period text,
  source_status text NOT NULL,
  lifecycle_status text NOT NULL,
  lifecycle_reason_code text NOT NULL,
  source_updated_at text,
  raw_payload_json text NOT NULL,
  raw_types_json text NOT NULL,
  normalized_payload_json text NOT NULL,
  category_l1_id text NOT NULL,
  category_l2_id text NOT NULL,
  model_id text,
  product_id text NOT NULL,
  product_hash text NOT NULL,
  latest_import_row_id text NOT NULL,
  effective_batch_id text NOT NULL,
  PRIMARY KEY (run_id,product_key)
);

CREATE TABLE app.product_package_sync_stage_lifecycle (
  run_id text NOT NULL REFERENCES app.product_package_sync_runs(id) ON DELETE CASCADE,
  sku_id text NOT NULL,
  previous_status text,
  next_status text NOT NULL,
  reason_code text NOT NULL,
  source_status text NOT NULL,
  effective_batch_id text NOT NULL,
  PRIMARY KEY (run_id,sku_id)
);

CREATE VIEW app.tmp_product_package_source WITH (security_invoker=true) AS
  SELECT source_row_number,source_row_key,row_sha256,product_key,country_code,stock_sku,
    warehouse_id,warehouse_name,sales_sku,product_name,category_l1,category_l2,category_l3,
    source_period,source_status,lifecycle_status,lifecycle_reason_code,source_updated_at,
    raw_payload_json,raw_types_json,normalized_payload_json,category_l1_id,category_l2_id,model_id,product_id
  FROM app.product_package_sync_stage_source
  WHERE run_id=current_setting('commerce_ops.product_package_sync_run_id',true);

CREATE VIEW app.tmp_product_package_changed_keys WITH (security_invoker=true) AS
  SELECT source_row_key,change_type FROM app.product_package_sync_stage_changed_keys
  WHERE run_id=current_setting('commerce_ops.product_package_sync_run_id',true);

CREATE VIEW app.tmp_product_package_changed_rows WITH (security_invoker=true) AS
  SELECT source_row_key,change_type,source_row_number,new_row_sha256,old_row_sha256,
    new_product_key,old_product_key,country_code,stock_sku,warehouse_id,warehouse_name,product_name,
    new_raw_payload_json,old_raw_payload_json,new_raw_types_json,old_raw_types_json,
    new_normalized_payload_json,old_normalized_payload_json,old_package_row_id
  FROM app.product_package_sync_stage_changed_rows
  WHERE run_id=current_setting('commerce_ops.product_package_sync_run_id',true);

CREATE VIEW app.tmp_product_package_field_events WITH (security_invoker=true) AS
  SELECT source_row_key,change_type,field_name,old_value_json,new_value_json,old_type,new_type
  FROM app.product_package_sync_stage_field_events
  WHERE run_id=current_setting('commerce_ops.product_package_sync_run_id',true);

CREATE VIEW app.tmp_product_package_products WITH (security_invoker=true) AS
  SELECT source_row_number,source_row_key,row_sha256,product_key,country_code,stock_sku,
    warehouse_id,warehouse_name,sales_sku,product_name,category_l1,category_l2,category_l3,
    source_period,source_status,lifecycle_status,lifecycle_reason_code,source_updated_at,
    raw_payload_json,raw_types_json,normalized_payload_json,category_l1_id,category_l2_id,model_id,product_id,
    product_hash,latest_import_row_id,effective_batch_id
  FROM app.product_package_sync_stage_products
  WHERE run_id=current_setting('commerce_ops.product_package_sync_run_id',true);

CREATE VIEW app.tmp_product_package_lifecycle_changes WITH (security_invoker=true) AS
  SELECT sku_id,previous_status,next_status,reason_code,source_status,effective_batch_id
  FROM app.product_package_sync_stage_lifecycle
  WHERE run_id=current_setting('commerce_ops.product_package_sync_run_id',true);
