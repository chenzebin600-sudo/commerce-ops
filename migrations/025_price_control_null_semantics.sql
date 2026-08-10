-- Approved by the user on 2026-08-06.
-- Preserve historical price-control events while allowing invalid NULL-derived
-- alerts to be excluded from operational views and notifications.

ALTER TABLE product_price_change_events ADD COLUMN validity_status TEXT NOT NULL DEFAULT 'VALID'
  CHECK (validity_status IN ('VALID','INVALID'));
ALTER TABLE product_price_change_events ADD COLUMN invalid_reason TEXT;
ALTER TABLE product_price_change_events ADD COLUMN invalidated_at TEXT;
ALTER TABLE product_price_change_events ADD COLUMN invalidated_by TEXT;

CREATE INDEX idx_product_price_changes_valid_detected
  ON product_price_change_events(validity_status,detected_at DESC,id);

CREATE INDEX idx_price_control_snapshots_price_key_effective
  ON price_control_price_snapshots(price_key,effective_at DESC,created_at DESC,id DESC);
