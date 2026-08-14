UPDATE "app"."shopee_discount_notifications"
SET "delivery_status"='FAILED',
    "coordination_state"='UNKNOWN',
    "last_error_code"='DINGTALK_DELIVERY_UPGRADE_UNKNOWN',
    "coordination_evidence_json"='{"source":"migration-040","reason":"legacy-sending-outcome-unknown"}'::jsonb,
    "delivery_lease_until"=NULL
WHERE "delivery_status"='SENDING' AND "delivery_lease_until" IS NULL;
