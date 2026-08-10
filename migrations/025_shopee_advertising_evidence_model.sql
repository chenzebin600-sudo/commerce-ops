ALTER TABLE advertising_performance_facts ADD COLUMN start_date TEXT;

CREATE INDEX idx_advertising_performance_facts_start_date
  ON advertising_performance_facts(shop_id, start_date, ad_key);
