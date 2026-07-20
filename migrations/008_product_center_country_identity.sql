ALTER TABLE product_skus ADD COLUMN country_raw TEXT NOT NULL DEFAULT '';
ALTER TABLE product_skus ADD COLUMN sku_code_normalized TEXT NOT NULL DEFAULT '';

UPDATE product_skus
SET country_raw = COALESCE((
      SELECT c.country_raw
      FROM product_cost_snapshots c
      WHERE c.sku_id = product_skus.id
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 1
    ), ''),
    sku_code_normalized = UPPER(TRIM(source_sku));

UPDATE product_skus
SET normalized_sku = UPPER(TRIM(country_raw)) || '|' || sku_code_normalized;

CREATE UNIQUE INDEX idx_product_skus_country_sku
  ON product_skus(source_system, country_raw, sku_code_normalized);
CREATE INDEX idx_product_skus_sku_code
  ON product_skus(sku_code_normalized, country_raw);

ALTER TABLE product_import_rows ADD COLUMN source_country_raw TEXT;
ALTER TABLE product_import_rows ADD COLUMN product_key TEXT;
ALTER TABLE product_import_rows ADD COLUMN product_sha256 TEXT;

UPDATE product_import_rows
SET source_country_raw = COALESCE((
      SELECT s.country_raw FROM product_skus s WHERE s.id = product_import_rows.target_sku_id
    ), ''),
    product_key = COALESCE((
      SELECT s.normalized_sku FROM product_skus s WHERE s.id = product_import_rows.target_sku_id
    ), '|' || UPPER(TRIM(COALESCE(source_sku, '')))),
    product_sha256 = row_sha256;

CREATE INDEX idx_product_import_rows_product_key
  ON product_import_rows(product_key, batch_id);

CREATE TABLE product_field_overrides (
  sku_id TEXT NOT NULL,
  field_code TEXT NOT NULL,
  value_json TEXT,
  operator_label TEXT NOT NULL,
  request_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (sku_id, field_code),
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_field_overrides_active
  ON product_field_overrides(sku_id, deleted_at, field_code);

CREATE TABLE product_field_override_events (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  field_code TEXT NOT NULL,
  previous_value_json TEXT,
  next_value_json TEXT,
  operator_label TEXT NOT NULL,
  request_id TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_override_events_sku
  ON product_field_override_events(sku_id, occurred_at DESC);

CREATE TABLE product_detail_preferences (
  scope_key TEXT PRIMARY KEY,
  visible_fields_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  operator_label TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE product_images (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  file_hash TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'deleted', 'missing', 'integrity_failed')),
  operator_label TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_images_sku
  ON product_images(sku_id, status, is_primary DESC, sort_order, created_at);
