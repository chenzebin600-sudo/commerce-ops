ALTER TABLE product_listing_drafts ADD COLUMN country_code TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN country_name TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN marketplace_code TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN product_positioning TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN content_style TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN price_positioning TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN primary_scenarios TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN special_requirements TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN forbidden_content TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN ai_context_hash TEXT;
ALTER TABLE product_listing_drafts ADD COLUMN ai_adoptions_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE product_ai_contents ADD COLUMN listing_draft_id TEXT;
ALTER TABLE product_ai_contents ADD COLUMN platform TEXT;
ALTER TABLE product_ai_contents ADD COLUMN shop_name TEXT;
ALTER TABLE product_ai_contents ADD COLUMN context_hash TEXT;
ALTER TABLE product_ai_contents ADD COLUMN previous_content_id TEXT;
ALTER TABLE product_ai_contents ADD COLUMN adopted_at TEXT;
ALTER TABLE product_ai_contents ADD COLUMN adopted_by TEXT;
ALTER TABLE product_ai_contents ADD COLUMN adopted_content_json TEXT;
ALTER TABLE product_ai_contents ADD COLUMN is_manually_modified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE product_ai_contents ADD COLUMN manual_content_json TEXT;

CREATE INDEX idx_product_ai_contents_listing_type
  ON product_ai_contents(listing_draft_id, content_type, created_at DESC);
CREATE INDEX idx_product_ai_contents_context
  ON product_ai_contents(product_sku_id, context_hash, created_at DESC);

CREATE TABLE product_image_generation_tasks (
  id TEXT PRIMARY KEY,
  product_sku_id TEXT NOT NULL,
  listing_draft_id TEXT,
  template_key TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  context_hash TEXT NOT NULL,
  context_json TEXT NOT NULL,
  prompt_plan_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN (
    'pending','generating_prompt','waiting_generation','generating',
    'partially_completed','completed','failed','cancelled'
  )),
  error_code TEXT,
  error_message TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (product_sku_id) REFERENCES product_skus(id) ON DELETE RESTRICT,
  FOREIGN KEY (listing_draft_id) REFERENCES product_listing_drafts(id) ON DELETE SET NULL
);

CREATE INDEX idx_product_image_generation_tasks_product
  ON product_image_generation_tasks(product_sku_id, created_at DESC);
CREATE INDEX idx_product_image_generation_tasks_status
  ON product_image_generation_tasks(status, updated_at);

CREATE TABLE product_image_generation_items (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  slot_key TEXT NOT NULL,
  slot_type TEXT NOT NULL,
  slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
  label TEXT NOT NULL,
  aspect_ratio TEXT,
  prompt TEXT NOT NULL,
  negative_prompt TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting','generating','completed','failed','cancelled')),
  generated_file_id TEXT,
  error_code TEXT,
  error_message TEXT,
  adopted_at TEXT,
  adopted_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES product_image_generation_tasks(id) ON DELETE CASCADE,
  UNIQUE (task_id, slot_key)
);

CREATE INDEX idx_product_image_generation_items_task
  ON product_image_generation_items(task_id, slot_index);
CREATE INDEX idx_product_image_generation_items_status
  ON product_image_generation_items(status, updated_at);
