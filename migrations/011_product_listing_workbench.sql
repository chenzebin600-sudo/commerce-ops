CREATE TABLE product_listing_drafts (
  id TEXT PRIMARY KEY,
  product_sku_id TEXT NOT NULL,
  country TEXT NOT NULL,
  sku TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('shopee', 'lazada', 'tiktok_shop')),
  shop_id TEXT,
  shop_key TEXT NOT NULL,
  shop_name TEXT,
  marketplace TEXT,
  platform_category_id TEXT,
  platform_category_name TEXT,
  listing_mode TEXT NOT NULL DEFAULT 'standard',
  title TEXT,
  subtitle TEXT,
  description TEXT,
  search_keywords_json TEXT NOT NULL DEFAULT '[]',
  brand TEXT,
  model TEXT,
  target_users TEXT,
  content_language TEXT NOT NULL DEFAULT '中文',
  selling_points_json TEXT NOT NULL DEFAULT '[]',
  usage_scenarios_json TEXT NOT NULL DEFAULT '[]',
  platform_attributes_json TEXT NOT NULL DEFAULT '[]',
  variants_json TEXT NOT NULL DEFAULT '[]',
  pricing_json TEXT NOT NULL DEFAULT '{}',
  media_json TEXT NOT NULL DEFAULT '{}',
  logistics_json TEXT NOT NULL DEFAULT '{}',
  compliance_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'publishing', 'published', 'failed', 'archived')),
  validation_result_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_product_listing_drafts_active_target
  ON product_listing_drafts(product_sku_id, platform, country, shop_key)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_product_listing_drafts_product
  ON product_listing_drafts(product_sku_id, status, updated_at DESC);
CREATE INDEX idx_product_listing_drafts_target
  ON product_listing_drafts(platform, country, shop_key, status);

CREATE TABLE product_listing_publish_records (
  id TEXT PRIMARY KEY,
  listing_draft_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  shop_id TEXT,
  request_payload_json TEXT NOT NULL DEFAULT '{}',
  response_payload_json TEXT NOT NULL DEFAULT '{}',
  platform_product_id TEXT,
  platform_listing_id TEXT,
  publish_status TEXT NOT NULL CHECK (publish_status IN ('pending', 'publishing', 'published', 'failed', 'cancelled')),
  error_code TEXT,
  error_message TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (listing_draft_id) REFERENCES product_listing_drafts(id) ON DELETE RESTRICT
);

CREATE INDEX idx_product_listing_publish_records_draft
  ON product_listing_publish_records(listing_draft_id, created_at DESC);
