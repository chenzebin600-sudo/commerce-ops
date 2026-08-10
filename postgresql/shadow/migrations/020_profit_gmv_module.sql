ALTER TABLE app.growth_order_headers
  ADD COLUMN original_product_amount_local numeric(24,6),
  ADD COLUMN discount_amount_local numeric(24,6),
  ADD COLUMN gmv_source_status text NOT NULL DEFAULT 'MISSING',
  ADD COLUMN gmv_source_rule_version text NOT NULL DEFAULT 'MABANG-ORDER-GMV-SOURCE-1.0.0',
  ADD CONSTRAINT growth_order_headers_gmv_source_status_check
    CHECK (gmv_source_status IN ('CONFIRMED','MISSING','CONFLICT'));

WITH raw_values AS (
  SELECT header.id AS header_id,
         NULLIF(BTRIM(REPLACE(raw.raw_values_json->>'原始商品总金额', ',', '')), '') AS original_text,
         NULLIF(BTRIM(REPLACE(raw.raw_values_json->>'优惠金额（原始货币）', ',', '')), '') AS discount_text
  FROM app.growth_order_headers header
  JOIN app.growth_order_raw_rows raw
    ON raw.batch_id=header.source_batch_id
   AND raw.raw_values_json->>'订单编号'=header.source_order_id
   AND raw.raw_values_json->>'店铺名'=header.source_shop_name
   AND LOWER(raw.raw_values_json->>'平台')=LOWER(header.platform)
   AND raw.parse_status<>'rejected'
), per_order AS (
  SELECT header_id,
         COUNT(DISTINCT original_text) FILTER (WHERE original_text IS NOT NULL) AS original_count,
         COUNT(DISTINCT discount_text) FILTER (WHERE discount_text IS NOT NULL) AS discount_count,
         MIN(original_text) FILTER (WHERE original_text IS NOT NULL) AS original_text,
         MIN(discount_text) FILTER (WHERE discount_text IS NOT NULL) AS discount_text
  FROM raw_values
  GROUP BY header_id
), typed AS (
  SELECT *,
         CASE WHEN original_text ~ '^-?[0-9]+(?:\.[0-9]+)?$' THEN original_text::numeric END AS original_amount,
         CASE WHEN discount_text ~ '^-?[0-9]+(?:\.[0-9]+)?$' THEN discount_text::numeric END AS discount_amount
  FROM per_order
)
UPDATE app.growth_order_headers header
SET original_product_amount_local=CASE
      WHEN typed.original_count=1 AND typed.discount_count=1
       AND typed.original_amount IS NOT NULL AND typed.discount_amount IS NOT NULL THEN typed.original_amount
    END,
    discount_amount_local=CASE
      WHEN typed.original_count=1 AND typed.discount_count=1
       AND typed.original_amount IS NOT NULL AND typed.discount_amount IS NOT NULL THEN typed.discount_amount
    END,
    gmv_source_status=CASE
      WHEN typed.original_count>1 OR typed.discount_count>1 THEN 'CONFLICT'
      WHEN typed.original_count=1 AND typed.discount_count=1
       AND typed.original_amount IS NOT NULL AND typed.discount_amount IS NOT NULL THEN 'CONFIRMED'
      ELSE 'MISSING'
    END,
    gmv_source_rule_version='MABANG-ORDER-GMV-SOURCE-1.0.0'
FROM typed
WHERE typed.header_id=header.id;

CREATE INDEX IF NOT EXISTS idx_growth_order_headers_gmv_range
  ON app.growth_order_headers(platform, effective_status, paid_at, normalized_source_shop_name);
