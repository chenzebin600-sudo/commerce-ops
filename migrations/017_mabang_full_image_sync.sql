CREATE TABLE mabang_sku_image_sync_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'completed', 'partial_success', 'failed'
  )),
  next_page INTEGER NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  total_pages INTEGER CHECK (total_pages IS NULL OR total_pages >= 0),
  segment_count INTEGER NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  discovered_skus INTEGER NOT NULL DEFAULT 0 CHECK (discovered_skus >= 0),
  discovered_images INTEGER NOT NULL DEFAULT 0 CHECK (discovered_images >= 0),
  downloaded_images INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_images >= 0),
  duplicate_images INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_images >= 0),
  failed_images INTEGER NOT NULL DEFAULT 0 CHECK (failed_images >= 0),
  matched_skus INTEGER NOT NULL DEFAULT 0 CHECK (matched_skus >= 0),
  unmatched_skus INTEGER NOT NULL DEFAULT 0 CHECK (unmatched_skus >= 0),
  last_batch_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_by TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES mabang_account_profiles(id) ON DELETE RESTRICT
);

CREATE INDEX idx_mabang_sku_image_sync_runs_status
  ON mabang_sku_image_sync_runs(status, created_at DESC);
CREATE INDEX idx_mabang_sku_image_sync_runs_account
  ON mabang_sku_image_sync_runs(account_id, created_at DESC);

ALTER TABLE mabang_sku_image_batches
  ADD COLUMN sync_run_id TEXT REFERENCES mabang_sku_image_sync_runs(id) ON DELETE RESTRICT;
ALTER TABLE mabang_sku_image_batches
  ADD COLUMN segment_no INTEGER CHECK (segment_no IS NULL OR segment_no >= 1);
ALTER TABLE mabang_sku_image_batches
  ADD COLUMN start_page INTEGER CHECK (start_page IS NULL OR start_page >= 1);
ALTER TABLE mabang_sku_image_batches
  ADD COLUMN end_page INTEGER CHECK (end_page IS NULL OR end_page >= 0);

CREATE UNIQUE INDEX uq_mabang_sku_image_batches_sync_segment
  ON mabang_sku_image_batches(sync_run_id, segment_no)
  WHERE sync_run_id IS NOT NULL;
CREATE INDEX idx_mabang_sku_image_batches_sync_run
  ON mabang_sku_image_batches(sync_run_id, segment_no);

CREATE TABLE mabang_sku_image_discovery_images (
  id TEXT PRIMARY KEY,
  discovery_id TEXT NOT NULL,
  image_index INTEGER NOT NULL CHECK (image_index >= 0),
  source_url TEXT NOT NULL,
  source_url_hash TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'src', 'data_src', 'srcset', 'background', 'interface', 'retry'
  )),
  download_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (download_status IN ('pending', 'skipped', 'downloaded', 'duplicate', 'missing', 'failed')),
  asset_id TEXT,
  download_attempts INTEGER NOT NULL DEFAULT 0 CHECK (download_attempts >= 0),
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  discovered_at TEXT NOT NULL,
  last_checked_at TEXT NOT NULL,
  FOREIGN KEY (discovery_id) REFERENCES mabang_sku_image_discoveries(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES product_media_assets(id) ON DELETE SET NULL,
  UNIQUE (discovery_id, source_url_hash)
);

CREATE INDEX idx_mabang_sku_image_discovery_images_discovery
  ON mabang_sku_image_discovery_images(discovery_id, image_index);
CREATE INDEX idx_mabang_sku_image_discovery_images_status
  ON mabang_sku_image_discovery_images(download_status, last_checked_at);
CREATE INDEX idx_mabang_sku_image_discovery_images_asset
  ON mabang_sku_image_discovery_images(asset_id);
