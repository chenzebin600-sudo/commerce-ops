CREATE TABLE IF NOT EXISTS conversation_context_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    source_url TEXT,
    captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_tasks (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (
        status IN (
            'queued', 'generating', 'ready', 'filled',
            'blocked_draft', 'superseded', 'error'
        )
    ),
    context_snapshot_id INTEGER REFERENCES conversation_context_snapshots(id) ON DELETE SET NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    detected_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    filled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assistant_tasks_queue
ON assistant_tasks(status, next_attempt_at, detected_at);

CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation
ON conversation_context_snapshots(conversation_id, captured_at DESC);
