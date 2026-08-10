ALTER TABLE growth_order_headers
  ADD COLUMN original_product_amount_local NUMERIC;

ALTER TABLE growth_order_headers
  ADD COLUMN discount_amount_local NUMERIC;

ALTER TABLE growth_order_headers
  ADD COLUMN gmv_source_status TEXT NOT NULL DEFAULT 'MISSING'
    CHECK (gmv_source_status IN ('CONFIRMED','MISSING','CONFLICT'));

ALTER TABLE growth_order_headers
  ADD COLUMN gmv_source_rule_version TEXT NOT NULL DEFAULT 'MABANG-ORDER-GMV-SOURCE-1.0.0';

WITH raw_values AS (
  SELECT header.id AS header_id,
         NULLIF(TRIM(REPLACE(CAST(json_extract(raw.raw_values_json, '$.原始商品总金额') AS TEXT), ',', '')), '') AS original_text,
         NULLIF(TRIM(REPLACE(CAST(json_extract(raw.raw_values_json, '$.优惠金额（原始货币）') AS TEXT), ',', '')), '') AS discount_text
  FROM growth_order_headers header
  JOIN growth_order_raw_rows raw
    ON raw.batch_id=header.source_batch_id
   AND CAST(json_extract(raw.raw_values_json, '$.订单编号') AS TEXT)=header.source_order_id
   AND CAST(json_extract(raw.raw_values_json, '$.店铺名') AS TEXT)=header.source_shop_name
   AND LOWER(CAST(json_extract(raw.raw_values_json, '$.平台') AS TEXT))=LOWER(header.platform)
   AND raw.parse_status<>'rejected'
), per_order AS (
  SELECT header_id,
         COUNT(DISTINCT original_text) FILTER (WHERE original_text IS NOT NULL) AS original_count,
         COUNT(DISTINCT discount_text) FILTER (WHERE discount_text IS NOT NULL) AS discount_count,
         MIN(original_text) FILTER (WHERE original_text IS NOT NULL) AS original_text,
         MIN(discount_text) FILTER (WHERE discount_text IS NOT NULL) AS discount_text
  FROM raw_values
  GROUP BY header_id
)
UPDATE growth_order_headers
SET original_product_amount_local=CASE
      WHEN (SELECT original_count FROM per_order WHERE header_id=growth_order_headers.id)=1
       AND (SELECT discount_count FROM per_order WHERE header_id=growth_order_headers.id)=1
      THEN CAST((SELECT original_text FROM per_order WHERE header_id=growth_order_headers.id) AS NUMERIC)
    END,
    discount_amount_local=CASE
      WHEN (SELECT original_count FROM per_order WHERE header_id=growth_order_headers.id)=1
       AND (SELECT discount_count FROM per_order WHERE header_id=growth_order_headers.id)=1
      THEN CAST((SELECT discount_text FROM per_order WHERE header_id=growth_order_headers.id) AS NUMERIC)
    END,
    gmv_source_status=CASE
      WHEN (SELECT original_count FROM per_order WHERE header_id=growth_order_headers.id)>1
        OR (SELECT discount_count FROM per_order WHERE header_id=growth_order_headers.id)>1 THEN 'CONFLICT'
      WHEN (SELECT original_count FROM per_order WHERE header_id=growth_order_headers.id)=1
       AND (SELECT discount_count FROM per_order WHERE header_id=growth_order_headers.id)=1 THEN 'CONFIRMED'
      ELSE 'MISSING'
    END,
    gmv_source_rule_version='MABANG-ORDER-GMV-SOURCE-1.0.0'
WHERE id IN (SELECT header_id FROM per_order);

CREATE INDEX IF NOT EXISTS idx_growth_order_headers_gmv_range
  ON growth_order_headers(platform, effective_status, paid_at, normalized_source_shop_name);
