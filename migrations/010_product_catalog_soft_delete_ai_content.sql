ALTER TABLE product_skus ADD COLUMN deleted_at TEXT;
ALTER TABLE product_skus ADD COLUMN deleted_by TEXT;
ALTER TABLE product_skus ADD COLUMN delete_reason TEXT;
ALTER TABLE product_skus ADD COLUMN restored_at TEXT;
ALTER TABLE product_skus ADD COLUMN restored_by TEXT;

CREATE INDEX idx_product_skus_deleted
  ON product_skus(deleted_at, country_raw, sku_code_normalized);

CREATE TABLE product_ai_contents (
  id TEXT PRIMARY KEY,
  product_sku_id TEXT NOT NULL,
  country TEXT NOT NULL,
  sku TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'selling_points_and_scenarios',
  input_context_json TEXT NOT NULL,
  output_content_json TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'confirmed', 'archived')),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_by TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT,
  archived_at TEXT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (product_sku_id, content_type, version)
);

CREATE INDEX idx_product_ai_contents_product_status
  ON product_ai_contents(product_sku_id, content_type, status, version DESC);
CREATE INDEX idx_product_ai_contents_country_sku
  ON product_ai_contents(country, sku, status, updated_at DESC);
