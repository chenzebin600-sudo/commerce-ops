ALTER TABLE shopee_discount_notifications ADD COLUMN dedupe_key TEXT;
ALTER TABLE shopee_discount_notifications ADD COLUMN channel TEXT NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE shopee_discount_notifications ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (delivery_status IN ('PENDING','SENDING','RETRY_WAIT','DELIVERED','FAILED'));
ALTER TABLE shopee_discount_notifications ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE shopee_discount_notifications ADD COLUMN last_error_code TEXT;
ALTER TABLE shopee_discount_notifications ADD COLUMN delivered_at TEXT;
ALTER TABLE shopee_discount_notifications ADD COLUMN updated_at TEXT;

UPDATE shopee_discount_notifications SET updated_at=created_at WHERE updated_at IS NULL;

CREATE UNIQUE INDEX uq_shopee_discount_notifications_dedupe
  ON shopee_discount_notifications(dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX idx_shopee_discount_notifications_delivery
  ON shopee_discount_notifications(delivery_status,created_at,id);
