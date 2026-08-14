ALTER TABLE shopee_discount_plans ADD COLUMN preview_owner_token TEXT;
ALTER TABLE shopee_discount_plans ADD COLUMN preview_owner_epoch INTEGER NOT NULL DEFAULT 0 CHECK (preview_owner_epoch >= 0);
ALTER TABLE shopee_discount_plans ADD COLUMN preview_owner_lease_until TEXT;
ALTER TABLE shopee_discount_plan_shards ADD COLUMN content_hash TEXT;

UPDATE shopee_discount_plans SET
  preview_owner_token=json_extract(summary_json,'$.previewOwnerToken'),
  preview_owner_epoch=COALESCE(CAST(json_extract(summary_json,'$.previewOwnerEpoch') AS INTEGER),
    CASE WHEN json_extract(summary_json,'$.previewOwnerToken') IS NULL THEN 0 ELSE 1 END),
  preview_owner_lease_until=json_extract(summary_json,'$.previewOwnerLeaseUntil');

CREATE INDEX idx_shopee_discount_preview_owner_lease
  ON shopee_discount_plans(state,preview_owner_lease_until,id)
  WHERE state='PREVIEWING';
