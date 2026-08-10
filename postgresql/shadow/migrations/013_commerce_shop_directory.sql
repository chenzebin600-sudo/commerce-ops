ALTER TABLE app.commerce_shop_registry
  ADD COLUMN IF NOT EXISTS shop_code text,
  ADD COLUMN IF NOT EXISTS manager_name text,
  ADD COLUMN IF NOT EXISTS senior_manager_name text,
  ADD COLUMN IF NOT EXISTS category_name text,
  ADD COLUMN IF NOT EXISTS platform_short_code text,
  ADD COLUMN IF NOT EXISTS platform_shop_id text,
  ADD COLUMN IF NOT EXISTS directory_source text NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN IF NOT EXISTS directory_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS connector_synced_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_shop_registry_shop_code
  ON app.commerce_shop_registry(shop_code)
  WHERE shop_code IS NOT NULL AND shop_code <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_commerce_shop_registry_platform_shop
  ON app.commerce_shop_registry(platform,platform_shop_id)
  WHERE platform_shop_id IS NOT NULL AND platform_shop_id <> '';

CREATE INDEX IF NOT EXISTS idx_commerce_shop_registry_directory
  ON app.commerce_shop_registry(platform,source_country_code,status,shop_code);
