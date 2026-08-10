-- Candidate migration. Apply to the formal database only after explicit user approval.
-- Adds an auditable operator disposition to each valid price-change event.

ALTER TABLE product_price_change_events ADD COLUMN adjustment_status TEXT NOT NULL DEFAULT 'UNADJUSTED'
  CHECK (adjustment_status IN ('UNADJUSTED','ADJUSTED'));
ALTER TABLE product_price_change_events ADD COLUMN adjustment_remark TEXT;
ALTER TABLE product_price_change_events ADD COLUMN adjustment_updated_at TEXT;
ALTER TABLE product_price_change_events ADD COLUMN adjustment_updated_by TEXT;

CREATE INDEX idx_product_price_changes_round_status
  ON product_price_change_events(validity_status,sync_run_id,adjustment_status,detected_at DESC,id);
