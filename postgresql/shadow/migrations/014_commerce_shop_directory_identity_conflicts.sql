DROP INDEX IF EXISTS app.idx_commerce_shop_registry_platform_shop;

CREATE INDEX idx_commerce_shop_registry_platform_shop
  ON app.commerce_shop_registry(platform,platform_shop_id)
  WHERE platform_shop_id IS NOT NULL AND platform_shop_id <> '';
