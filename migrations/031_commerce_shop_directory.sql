ALTER TABLE commerce_shop_registry ADD COLUMN shop_code TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN manager_name TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN senior_manager_name TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN category_name TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN platform_short_code TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN platform_shop_id TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN directory_source TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE commerce_shop_registry ADD COLUMN directory_synced_at TEXT;
ALTER TABLE commerce_shop_registry ADD COLUMN connector_synced_at TEXT;

CREATE UNIQUE INDEX idx_commerce_shop_registry_shop_code
  ON commerce_shop_registry(shop_code)
  WHERE shop_code IS NOT NULL AND shop_code <> '';

CREATE INDEX idx_commerce_shop_registry_platform_shop
  ON commerce_shop_registry(platform,platform_shop_id)
  WHERE platform_shop_id IS NOT NULL AND platform_shop_id <> '';

CREATE INDEX idx_commerce_shop_registry_directory
  ON commerce_shop_registry(platform,source_country_code,status,shop_code);
