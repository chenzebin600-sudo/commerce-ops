ALTER TABLE suggestions ADD COLUMN intent TEXT;
ALTER TABLE suggestions ADD COLUMN risk_level TEXT;
ALTER TABLE suggestions ADD COLUMN quality_status TEXT;
ALTER TABLE suggestions ADD COLUMN quality_issues_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE suggestions ADD COLUMN structured_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS suggestion_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    suggestion_id INTEGER REFERENCES suggestions(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN ('edited', 'approved', 'rejected', 'sent')),
    original_content TEXT NOT NULL DEFAULT '',
    final_content TEXT NOT NULL DEFAULT '',
    similarity REAL,
    reason_tags_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    outbound_external_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (message_id, outbound_external_id)
);

CREATE TABLE IF NOT EXISTS review_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK (action IN ('send')),
    approved_content TEXT NOT NULL,
    original_suggestion_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN (
            'pending', 'executing', 'sent', 'blocked_stale',
            'blocked_editor', 'failed', 'unknown', 'cancelled'
        )
    ),
    requested_by TEXT NOT NULL,
    error TEXT,
    requested_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_actions_one_active
ON review_actions(message_id)
WHERE status IN ('pending', 'executing');

CREATE INDEX IF NOT EXISTS idx_review_actions_queue
ON review_actions(status, requested_at, id);

CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_lookup
ON suggestion_feedback(message_id, action, created_at DESC);
