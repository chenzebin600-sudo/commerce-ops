ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS validity_status text NOT NULL DEFAULT 'VALID'
    CHECK (validity_status IN ('VALID','INVALID'));
ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS invalid_reason text;
ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS invalidated_by text;

ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS adjustment_status text NOT NULL DEFAULT 'UNADJUSTED'
    CHECK (adjustment_status IN ('UNADJUSTED','ADJUSTED'));
ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS adjustment_remark text;
ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS adjustment_updated_at timestamptz;
ALTER TABLE app.product_price_change_events
  ADD COLUMN IF NOT EXISTS adjustment_updated_by text;

CREATE INDEX IF NOT EXISTS idx_product_price_changes_valid_detected
  ON app.product_price_change_events(validity_status,detected_at DESC,id);
CREATE INDEX IF NOT EXISTS idx_price_control_snapshots_price_key_effective
  ON app.price_control_price_snapshots(price_key,effective_at DESC,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS idx_product_price_changes_round_status
  ON app.product_price_change_events(validity_status,sync_run_id,adjustment_status,detected_at DESC,id);
