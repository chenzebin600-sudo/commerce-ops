ALTER TABLE shopee_discount_settings ADD COLUMN credential_generation INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_shopee_discount_intents_unknown_page
  ON shopee_discount_dispatch_intents(status, dispatched_at, id);
