ALTER TABLE shopee_discount_notifications ADD COLUMN delivery_lease_until TEXT;
ALTER TABLE shopee_discount_notifications ADD COLUMN coordination_state TEXT
  CHECK (coordination_state IS NULL OR coordination_state='UNKNOWN');
ALTER TABLE shopee_discount_notifications ADD COLUMN coordination_evidence_json TEXT NOT NULL DEFAULT '{}';

UPDATE shopee_discount_notifications
SET delivery_status='FAILED', coordination_state='UNKNOWN',
    last_error_code='DINGTALK_DELIVERY_UPGRADE_UNKNOWN',
    coordination_evidence_json='{"source":"migration-031","reason":"legacy-sending-outcome-unknown"}',
    delivery_lease_until=NULL
WHERE delivery_status='SENDING' AND delivery_lease_until IS NULL;

CREATE INDEX idx_shopee_discount_notifications_sending_lease
  ON shopee_discount_notifications(delivery_status,delivery_lease_until,id);
