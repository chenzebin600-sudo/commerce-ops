CREATE TABLE mabang_sku_image_batches (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_batch_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('full_initial', 'missing_only', 'retry_failed')),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'pause_requested', 'paused',
    'completed', 'partial_success', 'failed'
  )),
  started_at TEXT,
  completed_at TEXT,
  paused_at TEXT,
  current_page INTEGER NOT NULL DEFAULT 0 CHECK (current_page >= 0),
  total_pages INTEGER CHECK (total_pages IS NULL OR total_pages >= 0),
  discovered_skus INTEGER NOT NULL DEFAULT 0 CHECK (discovered_skus >= 0),
  downloaded_images INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_images >= 0),
  missing_images INTEGER NOT NULL DEFAULT 0 CHECK (missing_images >= 0),
  duplicate_images INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_images >= 0),
  failed_images INTEGER NOT NULL DEFAULT 0 CHECK (failed_images >= 0),
  linked_products INTEGER NOT NULL DEFAULT 0 CHECK (linked_products >= 0),
  shared_country_links INTEGER NOT NULL DEFAULT 0 CHECK (shared_country_links >= 0),
  filename_mismatches INTEGER NOT NULL DEFAULT 0 CHECK (filename_mismatches >= 0),
  interface_profile_json TEXT NOT NULL DEFAULT '{}',
  last_error_code TEXT,
  last_error_message TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES mabang_account_profiles(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_batch_id) REFERENCES mabang_sku_image_batches(id) ON DELETE RESTRICT
);

CREATE INDEX idx_mabang_sku_image_batches_status
  ON mabang_sku_image_batches(status, created_at DESC);
CREATE INDEX idx_mabang_sku_image_batches_account
  ON mabang_sku_image_batches(account_id, created_at DESC);

CREATE TABLE mabang_sku_image_checkpoints (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number >= 1),
  page_hash TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'repeated')),
  error_code TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES mabang_sku_image_batches(id) ON DELETE CASCADE,
  UNIQUE (batch_id, page_number)
);

CREATE INDEX idx_mabang_sku_image_checkpoints_batch
  ON mabang_sku_image_checkpoints(batch_id, page_number);

CREATE TABLE product_media_assets (
  id TEXT PRIMARY KEY,
  source_system TEXT NOT NULL,
  source_url TEXT,
  storage_file_id TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  storage_filename TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  file_size INTEGER NOT NULL CHECK (file_size > 0),
  status TEXT NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'missing', 'integrity_failed', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_product_media_assets_source
  ON product_media_assets(source_system, created_at DESC);
CREATE INDEX idx_product_media_assets_status
  ON product_media_assets(status, created_at DESC);

CREATE TABLE mabang_sku_image_discoveries (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  source_sku_normalized TEXT NOT NULL,
  product_name TEXT,
  warehouse_name TEXT,
  source_image_url TEXT,
  image_src TEXT,
  image_data_src TEXT,
  image_srcset TEXT,
  image_background_url TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('interface', 'dom', 'cos_network', 'retry')),
  source_page INTEGER NOT NULL CHECK (source_page >= 1),
  source_row_number INTEGER NOT NULL CHECK (source_row_number >= 1),
  filename_sku TEXT,
  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'valid', 'warning', 'invalid', 'missing')),
  quality_issue_code TEXT,
  download_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (download_status IN ('pending', 'skipped', 'downloaded', 'duplicate', 'missing', 'failed')),
  asset_id TEXT,
  download_attempts INTEGER NOT NULL DEFAULT 0 CHECK (download_attempts >= 0),
  http_status INTEGER,
  discovered_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  FOREIGN KEY (batch_id) REFERENCES mabang_sku_image_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES product_media_assets(id) ON DELETE SET NULL,
  UNIQUE (batch_id, source_page, source_row_number, source_sku_normalized)
);

CREATE INDEX idx_mabang_sku_image_discoveries_batch
  ON mabang_sku_image_discoveries(batch_id, source_page, source_row_number);
CREATE INDEX idx_mabang_sku_image_discoveries_sku
  ON mabang_sku_image_discoveries(source_sku_normalized, download_status);
CREATE INDEX idx_mabang_sku_image_discoveries_failed
  ON mabang_sku_image_discoveries(batch_id, download_status, error_code);

CREATE TABLE product_media_links (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  source_sku TEXT NOT NULL,
  source_sku_normalized TEXT NOT NULL,
  product_id TEXT NOT NULL,
  country_code TEXT NOT NULL DEFAULT '',
  media_role TEXT NOT NULL DEFAULT 'gallery'
    CHECK (media_role IN ('gallery', 'suggested_primary', 'primary')),
  mapping_status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (mapping_status IN ('suggested', 'confirmed', 'rejected', 'invalid')),
  linked_at TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  confirmed_at TEXT,
  confirmed_by TEXT,
  FOREIGN KEY (asset_id) REFERENCES product_media_assets(id) ON DELETE RESTRICT,
  FOREIGN KEY (product_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  UNIQUE (asset_id, product_id)
);

CREATE INDEX idx_product_media_links_product
  ON product_media_links(product_id, mapping_status, media_role, linked_at);
CREATE INDEX idx_product_media_links_sku
  ON product_media_links(source_sku_normalized, country_code, mapping_status);
