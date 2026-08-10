CREATE INDEX idx_foundation_tasks_product_sku
  ON app.foundation_tasks(sku_id);
CREATE INDEX idx_growth_inventory_snapshots_mapped_product
  ON app.growth_inventory_snapshots(mapped_product_id);
CREATE INDEX idx_growth_order_lines_mapped_product
  ON app.growth_order_lines(mapped_product_id);
CREATE INDEX idx_growth_shop_sku_coverage_product
  ON app.growth_shop_sku_coverage_snapshots(product_sku_id);
CREATE INDEX idx_growth_shop_sku_daily_mapped_product
  ON app.growth_shop_sku_daily_metrics(mapped_product_id);
CREATE INDEX idx_growth_shop_sku_observations_mapped_product
  ON app.growth_shop_sku_observations(mapped_product_id);
CREATE INDEX idx_product_identity_mappings_internal_product
  ON app.product_identity_mappings(internal_product_id);
