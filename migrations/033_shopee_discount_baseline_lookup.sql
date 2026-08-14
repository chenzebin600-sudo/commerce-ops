ALTER TABLE shopee_discount_events ADD COLUMN baseline_country TEXT;
ALTER TABLE shopee_discount_events ADD COLUMN baseline_category TEXT;
ALTER TABLE shopee_discount_events ADD COLUMN baseline_shop_id TEXT;
ALTER TABLE shopee_discount_events ADD COLUMN baseline_tier TEXT;

UPDATE shopee_discount_events
SET baseline_country=json_extract(evidence_json,'$.scope.country'),
    baseline_category=json_extract(evidence_json,'$.scope.category'),
    baseline_shop_id=json_extract(evidence_json,'$.scope.shopId'),
    baseline_tier=json_extract(evidence_json,'$.scope.tier')
WHERE event_type='WAREHOUSE_BASELINE';

CREATE INDEX idx_shopee_discount_events_baseline_scope
  ON shopee_discount_events(event_type,baseline_country,baseline_category,baseline_shop_id,baseline_tier,occurred_at DESC,id DESC)
  WHERE event_type='WAREHOUSE_BASELINE';
