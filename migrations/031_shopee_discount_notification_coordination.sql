ALTER TABLE shopee_discount_notifications ADD COLUMN delivery_lease_until TEXT;
ALTER TABLE shopee_discount_notifications ADD COLUMN coordination_state TEXT
  CHECK (coordination_state IS NULL OR coordination_state='UNKNOWN');
ALTER TABLE shopee_discount_notifications ADD COLUMN coordination_evidence_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX idx_shopee_discount_notifications_sending_lease
  ON shopee_discount_notifications(delivery_status,delivery_lease_until,id);
