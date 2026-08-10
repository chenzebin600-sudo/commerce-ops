from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable

from .db import Database
from .models import ConversationEnvelope, ExtractionBatch, MessageEnvelope
from .quality import edit_similarity


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _fallback_message_id(conversation_id: str, message: MessageEnvelope) -> str:
    material = "\u241f".join(
        [
            conversation_id,
            message.direction,
            message.sent_at or "",
            message.sender_name or "",
            message.content,
        ]
    )
    return "sha256:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


class Repository:
    def __init__(self, database: Database):
        self.database = database

    def initialize(self) -> None:
        self.database.initialize()

    def upsert_batch(self, batch: ExtractionBatch) -> dict[str, int]:
        new_messages = 0
        with self.database.transaction() as connection:
            for conversation in batch.conversations:
                now = utc_now()
                connection.execute(
                    """
                    INSERT INTO shops(external_id, name, platform, region, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(external_id) DO UPDATE SET
                        name = excluded.name,
                        platform = COALESCE(excluded.platform, shops.platform),
                        region = COALESCE(excluded.region, shops.region),
                        updated_at = excluded.updated_at
                    """,
                    (
                        conversation.shop_external_id,
                        conversation.shop_name,
                        conversation.platform,
                        conversation.region,
                        now,
                        now,
                    ),
                )
                shop_id = int(
                    connection.execute(
                        "SELECT id FROM shops WHERE external_id = ?",
                        (conversation.shop_external_id,),
                    ).fetchone()["id"]
                )
                connection.execute(
                    """
                    INSERT INTO customers(shop_id, external_id, name, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT(shop_id, external_id) DO UPDATE SET
                        name = excluded.name,
                        updated_at = excluded.updated_at
                    """,
                    (
                        shop_id,
                        conversation.customer_external_id,
                        conversation.customer_name,
                        now,
                        now,
                    ),
                )
                customer_id = int(
                    connection.execute(
                        "SELECT id FROM customers WHERE shop_id = ? AND external_id = ?",
                        (shop_id, conversation.customer_external_id),
                    ).fetchone()["id"]
                )
                connection.execute(
                    """
                    INSERT INTO conversations(
                        external_id, shop_id, customer_id, unread_count, status,
                        last_message_at, raw_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
                    ON CONFLICT(external_id) DO UPDATE SET
                        shop_id = excluded.shop_id,
                        customer_id = excluded.customer_id,
                        unread_count = excluded.unread_count,
                        last_message_at = COALESCE(excluded.last_message_at, conversations.last_message_at),
                        raw_json = excluded.raw_json,
                        updated_at = excluded.updated_at
                    """,
                    (
                        conversation.external_id,
                        shop_id,
                        customer_id,
                        max(0, conversation.unread_count),
                        conversation.last_message_at,
                        _json(conversation.raw),
                        now,
                        now,
                    ),
                )
                local_conversation_id = int(
                    connection.execute(
                        "SELECT id FROM conversations WHERE external_id = ?",
                        (conversation.external_id,),
                    ).fetchone()["id"]
                )

                for message in conversation.messages:
                    external_message_id = message.external_id or _fallback_message_id(
                        conversation.external_id, message
                    )
                    existing = connection.execute(
                        "SELECT id FROM messages WHERE conversation_id = ? AND external_id = ?",
                        (local_conversation_id, external_message_id),
                    ).fetchone()
                    connection.execute(
                        """
                        INSERT INTO messages(
                            conversation_id, external_id, direction, sender_name,
                            message_type, content, sent_at, raw_json, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(conversation_id, external_id) DO UPDATE SET
                            direction = excluded.direction,
                            sender_name = COALESCE(excluded.sender_name, messages.sender_name),
                            message_type = excluded.message_type,
                            content = excluded.content,
                            sent_at = COALESCE(excluded.sent_at, messages.sent_at),
                            raw_json = excluded.raw_json,
                            updated_at = excluded.updated_at
                        """,
                        (
                            local_conversation_id,
                            external_message_id,
                            message.direction,
                            message.sender_name,
                            message.message_type,
                            message.content,
                            message.sent_at,
                            _json(message.raw),
                            now,
                            now,
                        ),
                    )
                    if existing is None:
                        new_messages += 1
                        if message.direction == "inbound":
                            connection.execute(
                                "UPDATE conversations SET status = 'pending', updated_at = ? WHERE id = ?",
                                (now, local_conversation_id),
                            )

        return {
            "conversations": len(batch.conversations),
            "messages": batch.message_count,
            "new_messages": new_messages,
        }

    def list_work_items(
        self, status: str = "pending", query: str = "", limit: int = 200
    ) -> list[dict[str, Any]]:
        clauses = ["m.direction = 'inbound'"]
        params: list[Any] = []
        if status in {"pending", "processed"}:
            clauses.append("m.is_processed = ?")
            params.append(1 if status == "processed" else 0)
        if query.strip():
            clauses.append("(s.name LIKE ? OR c.name LIKE ? OR m.content LIKE ?)")
            like = f"%{query.strip()}%"
            params.extend([like, like, like])
        params.append(max(1, min(limit, 1000)))
        sql = f"""
            SELECT
                m.id AS message_id,
                m.external_id AS message_external_id,
                m.content AS original_message,
                m.sent_at,
                m.is_processed,
                m.processed_at,
                s.name AS shop_name,
                s.platform,
                s.region,
                c.name AS customer_name,
                conv.id AS conversation_id,
                conv.external_id AS conversation_external_id,
                conv.unread_count,
                sug.content AS ai_reply,
                sug.status AS suggestion_status,
                sug.error AS suggestion_error,
                sug.model AS suggestion_model,
                sug.intent AS suggestion_intent,
                sug.risk_level AS suggestion_risk_level,
                sug.quality_status AS suggestion_quality_status,
                sug.quality_issues_json AS suggestion_quality_issues_json,
                sug.updated_at AS suggestion_updated_at,
                task.status AS assistant_task_status,
                (
                    SELECT ra.status FROM review_actions ra
                    WHERE ra.message_id = m.id
                    ORDER BY ra.id DESC LIMIT 1
                ) AS review_action_status,
                (
                    SELECT sf.final_content FROM suggestion_feedback sf
                    WHERE sf.message_id = m.id
                    ORDER BY sf.id DESC LIMIT 1
                ) AS latest_feedback_content
            FROM messages m
            JOIN conversations conv ON conv.id = m.conversation_id
            JOIN shops s ON s.id = conv.shop_id
            JOIN customers c ON c.id = conv.customer_id
            LEFT JOIN suggestions sug ON sug.message_id = m.id
            LEFT JOIN assistant_tasks task ON task.message_id = m.id
            WHERE {' AND '.join(clauses)}
            ORDER BY m.is_processed ASC, COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
            LIMIT ?
        """
        with self.database.connect() as connection:
            return [dict(row) for row in connection.execute(sql, params).fetchall()]

    def pending_for_suggestions(self, limit: int = 50) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    m.id AS message_id,
                    m.content,
                    m.sent_at,
                    m.external_id AS message_external_id,
                    s.name AS shop_name,
                    s.external_id AS shop_external_id,
                    s.platform,
                    s.region,
                    c.name AS customer_name,
                    c.external_id AS customer_external_id,
                    conv.external_id AS conversation_external_id
                FROM messages m
                JOIN conversations conv ON conv.id = m.conversation_id
                JOIN shops s ON s.id = conv.shop_id
                JOIN customers c ON c.id = conv.customer_id
                LEFT JOIN suggestions sug ON sug.message_id = m.id
                WHERE m.direction = 'inbound'
                  AND m.is_processed = 0
                  AND (sug.id IS NULL OR sug.status IN ('error', 'disabled'))
                ORDER BY COALESCE(m.sent_at, m.created_at) ASC, m.id ASC
                LIMIT ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
            return [dict(row) for row in rows]

    def claim_suggestion(self, message_id: int, *, force: bool = False) -> bool:
        """原子占用一条建议任务，避免多个进程重复调用模型。"""

        now = utc_now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT status FROM suggestions WHERE message_id = ?", (message_id,)
            ).fetchone()
            if row is None:
                connection.execute(
                    """
                    INSERT INTO suggestions(message_id, status, created_at, updated_at)
                    VALUES (?, 'pending', ?, ?)
                    """,
                    (message_id, now, now),
                )
                return True
            if row["status"] == "pending":
                return False
            if row["status"] == "ready" and not force:
                return False
            connection.execute(
                """
                UPDATE suggestions
                SET content = NULL, provider = NULL, status = 'pending', error = NULL,
                    prompt_hash = NULL, updated_at = ?
                WHERE message_id = ?
                """,
                (now, message_id),
            )
            return True

    def max_message_id(self) -> int:
        with self.database.connect() as connection:
            row = connection.execute("SELECT COALESCE(MAX(id), 0) AS value FROM messages").fetchone()
            return int(row["value"])

    def queue_message(self, message_id: int) -> bool:
        now = utc_now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT conversation_id FROM messages WHERE id = ? AND direction = 'inbound'",
                (message_id,),
            ).fetchone()
            if row is None:
                return False
            connection.execute(
                """
                UPDATE review_actions
                SET status = 'blocked_stale',
                    error = '客户发来更新消息，旧批准请求已失效',
                    finished_at = ?
                WHERE status = 'pending'
                  AND message_id IN (
                      SELECT id FROM messages
                      WHERE conversation_id = ? AND id <> ?
                  )
                """,
                (now, int(row["conversation_id"]), message_id),
            )
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO assistant_tasks(
                    message_id, conversation_id, status, detected_at, updated_at
                ) VALUES (?, ?, 'queued', ?, ?)
                """,
                (message_id, int(row["conversation_id"]), now, now),
            )
            return cursor.rowcount > 0

    def queue_latest_for_conversation(self, conversation_external_id: str) -> int | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT m.id
                FROM messages m
                JOIN conversations conv ON conv.id = m.conversation_id
                WHERE conv.external_id = ?
                  AND m.direction = 'inbound'
                  AND m.is_processed = 0
                ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
                LIMIT 1
                """,
                (conversation_external_id,),
            ).fetchone()
        if row is None:
            return None
        message_id = int(row["id"])
        self.queue_message(message_id)
        return message_id

    def queue_new_inbound_after(self, message_id: int) -> int:
        now = utc_now()
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                INSERT OR IGNORE INTO assistant_tasks(
                    message_id, conversation_id, status, detected_at, updated_at
                )
                SELECT id, conversation_id, 'queued', ?, ?
                FROM messages
                WHERE id > ? AND direction = 'inbound' AND is_processed = 0
                """,
                (now, now, message_id),
            )
            return max(0, cursor.rowcount)

    def recover_assistant_tasks(self) -> int:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE assistant_tasks
                SET status = 'queued', last_error = '进程中断后自动恢复', updated_at = ?
                WHERE status = 'generating'
                """,
                (utc_now(),),
            )
            return max(0, cursor.rowcount)

    def recover_review_actions(self) -> int:
        """执行中的发送在进程中断后结果不明，绝不能自动重试。"""

        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE review_actions
                SET status = 'unknown',
                    error = '发送执行期间进程中断；需要人工核对乐聊会话',
                    finished_at = ?
                WHERE status = 'executing'
                """,
                (utc_now(),),
            )
            return max(0, cursor.rowcount)

    def assistant_queue(self, limit: int = 100) -> list[dict[str, Any]]:
        now = utc_now()
        active = ("queued", "ready", "blocked_draft")
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE assistant_tasks
                SET status = 'superseded', updated_at = ?
                WHERE status IN ('queued', 'ready', 'blocked_draft')
                  AND EXISTS (
                      SELECT 1 FROM assistant_tasks newer
                      WHERE newer.conversation_id = assistant_tasks.conversation_id
                        AND newer.message_id > assistant_tasks.message_id
                        AND newer.status IN ('queued', 'ready', 'blocked_draft')
                  )
                """,
                (now,),
            )
            rows = connection.execute(
                """
                SELECT
                    task.message_id,
                    task.status AS task_status,
                    task.attempt_count,
                    m.content,
                    m.sent_at,
                    m.external_id AS message_external_id,
                    s.name AS shop_name,
                    s.external_id AS shop_external_id,
                    s.platform,
                    s.region,
                    c.name AS customer_name,
                    c.external_id AS customer_external_id,
                    conv.external_id AS conversation_external_id,
                    sug.content AS ai_reply,
                    sug.status AS suggestion_status
                FROM assistant_tasks task
                JOIN messages m ON m.id = task.message_id
                JOIN conversations conv ON conv.id = task.conversation_id
                JOIN shops s ON s.id = conv.shop_id
                JOIN customers c ON c.id = conv.customer_id
                LEFT JOIN suggestions sug ON sug.message_id = m.id
                WHERE task.status IN (?, ?, ?)
                  AND (task.next_attempt_at IS NULL OR task.next_attempt_at <= ?)
                  AND m.is_processed = 0
                ORDER BY task.detected_at ASC, task.message_id ASC
                LIMIT ?
                """,
                (*active, now, max(1, min(limit, 500))),
            ).fetchall()
            return [dict(row) for row in rows]

    def latest_inbound_external_message_id(
        self, conversation_external_id: str
    ) -> str | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT message.external_id
                FROM messages message
                JOIN conversations conversation ON conversation.id = message.conversation_id
                WHERE conversation.external_id = ? AND message.direction = 'inbound'
                ORDER BY COALESCE(message.sent_at, message.created_at) DESC, message.id DESC
                LIMIT 1
                """,
                (conversation_external_id,),
            ).fetchone()
            return str(row["external_id"]) if row is not None else None

    def message_id_for_external(
        self, conversation_external_id: str, message_external_id: str
    ) -> int | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT message.id
                FROM messages message
                JOIN conversations conversation ON conversation.id = message.conversation_id
                WHERE conversation.external_id = ? AND message.external_id = ?
                LIMIT 1
                """,
                (conversation_external_id, message_external_id),
            ).fetchone()
            return int(row["id"]) if row is not None else None

    def assistant_task_for_conversation(
        self, conversation_external_id: str
    ) -> dict[str, Any] | None:
        items = self.assistant_queue(limit=500)
        return next(
            (
                item
                for item in items
                if item["conversation_external_id"] == conversation_external_id
            ),
            None,
        )

    def set_assistant_task_status(
        self,
        message_id: int,
        status: str,
        *,
        error: str | None = None,
        context_snapshot_id: int | None = None,
        retry_after_seconds: int = 0,
    ) -> None:
        now = datetime.now(UTC)
        retry_at = (
            (now + timedelta(seconds=retry_after_seconds))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
            if retry_after_seconds > 0
            else None
        )
        now_text = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE assistant_tasks SET
                    status = ?,
                    context_snapshot_id = COALESCE(?, context_snapshot_id),
                    attempt_count = attempt_count + CASE WHEN ? = 'generating' THEN 1 ELSE 0 END,
                    next_attempt_at = ?,
                    last_error = ?,
                    filled_at = CASE WHEN ? = 'filled' THEN ? ELSE filled_at END,
                    updated_at = ?
                WHERE message_id = ?
                """,
                (
                    status,
                    context_snapshot_id,
                    status,
                    retry_at,
                    error,
                    status,
                    now_text,
                    now_text,
                    message_id,
                ),
            )

    def save_context_snapshot(
        self, message_id: int, context: dict[str, Any], source_url: str
    ) -> int:
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT conversation_id FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
            if row is None:
                raise KeyError(f"Message {message_id} does not exist")
            cursor = connection.execute(
                """
                INSERT INTO conversation_context_snapshots(
                    conversation_id, message_id, context_json, source_url, captured_at
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    int(row["conversation_id"]),
                    message_id,
                    _json(context),
                    source_url,
                    utc_now(),
                ),
            )
            return int(cursor.lastrowid)

    def message_operational_context(self, message_id: int) -> str:
        payload = self.message_operational_context_data(message_id)
        return str(payload.get("right_panel_text") or "")[:20_000]

    def message_operational_context_data(self, message_id: int) -> dict[str, Any]:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT snapshot.context_json
                FROM conversation_context_snapshots snapshot
                JOIN messages m ON m.conversation_id = snapshot.conversation_id
                WHERE m.id = ?
                ORDER BY CASE WHEN snapshot.message_id = ? THEN 0 ELSE 1 END,
                         snapshot.captured_at DESC, snapshot.id DESC
                LIMIT 1
                """,
                (message_id, message_id),
            ).fetchone()
        if row is None:
            return {}
        try:
            payload = json.loads(row["context_json"])
        except json.JSONDecodeError:
            return {}
        if not isinstance(payload, dict):
            return {}
        return payload

    def get_message_for_suggestion(self, message_id: int) -> dict[str, Any] | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT
                    m.id AS message_id,
                    m.content,
                    m.sent_at,
                    s.name AS shop_name,
                    s.platform,
                    s.region,
                    c.name AS customer_name,
                    conv.external_id AS conversation_external_id
                FROM messages m
                JOIN conversations conv ON conv.id = m.conversation_id
                JOIN shops s ON s.id = conv.shop_id
                JOIN customers c ON c.id = conv.customer_id
                WHERE m.id = ? AND m.direction = 'inbound'
                """,
                (message_id,),
            ).fetchone()
            return dict(row) if row else None

    def latest_assistant_item(
        self, conversation_external_id: str
    ) -> dict[str, Any] | None:
        """返回尚未写入乐聊编辑器的最新一条入站消息。"""

        with self.database.connect() as connection:
            row = connection.execute(
                """
                WITH latest_message AS (
                    SELECT m.*
                    FROM messages m
                    JOIN conversations candidate ON candidate.id = m.conversation_id
                    WHERE candidate.external_id = ?
                      AND m.direction = 'inbound'
                      AND m.is_processed = 0
                    ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
                    LIMIT 1
                )
                SELECT
                    m.id AS message_id,
                    m.content,
                    m.sent_at,
                    s.name AS shop_name,
                    s.platform,
                    s.region,
                    c.name AS customer_name,
                    conv.external_id AS conversation_external_id,
                    sug.content AS ai_reply,
                    sug.status AS suggestion_status
                FROM latest_message m
                JOIN conversations conv ON conv.id = m.conversation_id
                JOIN shops s ON s.id = conv.shop_id
                JOIN customers c ON c.id = conv.customer_id
                LEFT JOIN suggestions sug ON sug.message_id = m.id
                WHERE NOT EXISTS (
                      SELECT 1 FROM audit_events ae
                      WHERE ae.event_type = 'suggestion.filled'
                        AND ae.entity_type = 'message'
                        AND ae.entity_id = CAST(m.id AS TEXT)
                  )
                """,
                (conversation_external_id,),
            ).fetchone()
            return dict(row) if row else None

    def message_context(self, message_id: int, limit: int = 8) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT conversation_id FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
            if row is None:
                return []
            messages = connection.execute(
                """
                SELECT direction, sender_name, content, sent_at
                FROM messages
                WHERE conversation_id = ? AND id <= ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (row["conversation_id"], message_id, max(1, min(limit, 30))),
            ).fetchall()
            return [dict(item) for item in reversed(messages)]

    def save_suggestion(
        self,
        message_id: int,
        *,
        status: str,
        content: str | None = None,
        provider: str | None = None,
        model: str | None = None,
        error: str | None = None,
        prompt_hash: str | None = None,
        intent: str | None = None,
        risk_level: str | None = None,
        quality_status: str | None = None,
        quality_issues: list[str] | None = None,
        structured: dict[str, Any] | None = None,
    ) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO suggestions(
                    message_id, content, provider, model, status, error,
                    prompt_hash, intent, risk_level, quality_status,
                    quality_issues_json, structured_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id) DO UPDATE SET
                    content = excluded.content,
                    provider = excluded.provider,
                    model = excluded.model,
                    status = excluded.status,
                    error = excluded.error,
                    prompt_hash = excluded.prompt_hash,
                    intent = excluded.intent,
                    risk_level = excluded.risk_level,
                    quality_status = excluded.quality_status,
                    quality_issues_json = excluded.quality_issues_json,
                    structured_json = excluded.structured_json,
                    updated_at = excluded.updated_at
                """,
                (
                    message_id,
                    content,
                    provider,
                    model,
                    status,
                    error,
                    prompt_hash,
                    intent,
                    risk_level,
                    quality_status,
                    _json(quality_issues or []),
                    _json(structured or {}),
                    now,
                    now,
                ),
            )

    def save_feedback(
        self,
        message_id: int,
        *,
        action: str,
        final_content: str,
        source: str,
        reason_tags: list[str] | None = None,
        outbound_external_id: str | None = None,
    ) -> int:
        final = final_content.strip()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT id, COALESCE(content, '') AS content FROM suggestions WHERE message_id = ?",
                (message_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"Message {message_id} does not have a suggestion")
            original = str(row["content"] or "")
            cursor = connection.execute(
                """
                INSERT INTO suggestion_feedback(
                    message_id, suggestion_id, action, original_content,
                    final_content, similarity, reason_tags_json, source,
                    outbound_external_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(message_id, outbound_external_id) DO UPDATE SET
                    action = excluded.action,
                    final_content = excluded.final_content,
                    similarity = excluded.similarity,
                    reason_tags_json = excluded.reason_tags_json,
                    source = excluded.source
                """,
                (
                    message_id,
                    int(row["id"]),
                    action,
                    original,
                    final,
                    edit_similarity(original, final),
                    _json(reason_tags or []),
                    source,
                    outbound_external_id,
                    utc_now(),
                ),
            )
            feedback_id = int(cursor.lastrowid or 0)
        self.audit(
            "suggestion.feedback_saved",
            "message",
            str(message_id),
            source,
            {"action": action, "has_edit": original.strip() != final},
        )
        return feedback_id

    def feedback_examples(
        self,
        *,
        shop_name: str,
        platform: str | None,
        intent: str,
        limit: int = 3,
    ) -> list[dict[str, Any]]:
        with self.database.connect() as connection:
            rows = connection.execute(
                """
                SELECT
                    inbound.content AS customer_message,
                    sf.final_content AS final_reply,
                    s.name AS shop_name,
                    s.platform,
                    sug.intent
                FROM suggestion_feedback sf
                JOIN messages inbound ON inbound.id = sf.message_id
                JOIN suggestions sug ON sug.message_id = inbound.id
                JOIN conversations conv ON conv.id = inbound.conversation_id
                JOIN shops s ON s.id = conv.shop_id
                WHERE sf.action IN ('approved', 'sent')
                  AND sf.final_content <> ''
                  AND (s.name = ? OR (? IS NOT NULL AND s.platform = ?))
                  AND (sug.intent = ? OR sug.intent IS NULL)
                ORDER BY CASE WHEN s.name = ? THEN 0 ELSE 1 END, sf.created_at DESC
                LIMIT ?
                """,
                (
                    shop_name,
                    platform,
                    platform,
                    intent,
                    shop_name,
                    max(1, min(limit, 10)),
                ),
            ).fetchall()
        return [dict(row) for row in rows]

    def latest_inbound_message_id(self, conversation_id: int) -> int | None:
        with self.database.connect() as connection:
            row = connection.execute(
                """
                SELECT id FROM messages
                WHERE conversation_id = ? AND direction = 'inbound'
                ORDER BY COALESCE(sent_at, created_at) DESC, id DESC
                LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        return int(row["id"]) if row else None

    def queue_review_send(
        self,
        message_id: int,
        approved_content: str,
        *,
        requested_by: str = "web",
    ) -> int:
        approved = approved_content.strip()
        if not approved:
            raise ValueError("批准发送的回复不能为空。")
        if len(approved) > 4_000:
            raise ValueError("批准发送的回复超过 4000 字符。")
        now = utc_now()
        with self.database.transaction() as connection:
            row = connection.execute(
                """
                SELECT m.conversation_id, sug.content, sug.status, sug.quality_status
                FROM messages m
                JOIN suggestions sug ON sug.message_id = m.id
                WHERE m.id = ? AND m.direction = 'inbound' AND m.is_processed = 0
                """,
                (message_id,),
            ).fetchone()
            if row is None or row["status"] != "ready" or not str(row["content"] or "").strip():
                raise ValueError("消息没有可发送的有效 AI 建议。")
            if row["quality_status"] not in {"passed", "needs_review"}:
                raise ValueError("该建议尚未经过新版质量校验，请先重新生成。")
            latest = connection.execute(
                """
                SELECT id FROM messages
                WHERE conversation_id = ? AND direction = 'inbound'
                ORDER BY COALESCE(sent_at, created_at) DESC, id DESC LIMIT 1
                """,
                (int(row["conversation_id"]),),
            ).fetchone()
            if latest is None or int(latest["id"]) != message_id:
                raise ValueError("客户已发来更新消息，旧建议不能发送。")
            original = str(row["content"])
            cursor = connection.execute(
                """
                INSERT INTO review_actions(
                    message_id, action, approved_content, original_suggestion_hash,
                    status, requested_by, requested_at
                ) VALUES (?, 'send', ?, ?, 'pending', ?, ?)
                """,
                (
                    message_id,
                    approved,
                    hashlib.sha256(original.encode("utf-8")).hexdigest(),
                    requested_by,
                    now,
                ),
            )
            action_id = int(cursor.lastrowid)
        self.save_feedback(
            message_id,
            action="approved",
            final_content=approved,
            source=requested_by,
        )
        self.audit(
            "review.send_requested",
            "review_action",
            str(action_id),
            requested_by,
            {"message_id": message_id},
        )
        return action_id

    def claim_next_review_action(self) -> dict[str, Any] | None:
        with self.database.transaction() as connection:
            row = connection.execute(
                """
                SELECT
                    ra.id AS review_action_id,
                    ra.message_id,
                    ra.approved_content,
                    ra.original_suggestion_hash,
                    m.conversation_id,
                    m.content,
                    s.name AS shop_name,
                    s.platform,
                    s.region,
                    c.name AS customer_name,
                    conv.external_id AS conversation_external_id,
                    sug.content AS ai_reply,
                    sug.risk_level
                FROM review_actions ra
                JOIN messages m ON m.id = ra.message_id
                JOIN conversations conv ON conv.id = m.conversation_id
                JOIN shops s ON s.id = conv.shop_id
                JOIN customers c ON c.id = conv.customer_id
                JOIN suggestions sug ON sug.message_id = m.id
                WHERE ra.status = 'pending'
                ORDER BY ra.requested_at ASC, ra.id ASC
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            cursor = connection.execute(
                """
                UPDATE review_actions
                SET status = 'executing', started_at = ?
                WHERE id = ? AND status = 'pending'
                """,
                (utc_now(), int(row["review_action_id"])),
            )
            return dict(row) if cursor.rowcount == 1 else None

    def finish_review_action(
        self,
        action_id: int,
        status: str,
        *,
        error: str | None = None,
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE review_actions
                SET status = ?, error = ?, finished_at = ?
                WHERE id = ? AND status = 'executing'
                """,
                (status, error[:500] if error else None, utc_now(), action_id),
            )

    def review_action_status(self, message_id: int) -> str | None:
        with self.database.connect() as connection:
            row = connection.execute(
                "SELECT status FROM review_actions WHERE message_id = ? ORDER BY id DESC LIMIT 1",
                (message_id,),
            ).fetchone()
        return str(row["status"]) if row else None

    def record_observed_outbound_feedback(self, batch: ExtractionBatch) -> int:
        """将乐聊页面观察到的新客服回复关联到最近一份已填草稿。"""

        recorded = 0
        for conversation in batch.conversations:
            outbound = [message for message in conversation.messages if message.direction == "outbound"]
            for message in outbound:
                external_id = message.external_id or _fallback_message_id(
                    conversation.external_id, message
                )
                with self.database.connect() as connection:
                    row = connection.execute(
                        """
                        SELECT task.message_id
                        FROM assistant_tasks task
                        JOIN conversations conv ON conv.id = task.conversation_id
                        JOIN messages outbound
                          ON outbound.conversation_id = conv.id
                         AND outbound.external_id = ?
                         AND outbound.direction = 'outbound'
                        JOIN suggestions sug ON sug.message_id = task.message_id
                        WHERE conv.external_id = ?
                          AND task.status = 'filled'
                          AND task.filled_at IS NOT NULL
                          AND outbound.sent_at IS NOT NULL
                          AND outbound.sent_at >= task.filled_at
                          AND sug.status = 'ready'
                          AND NOT EXISTS (
                              SELECT 1 FROM suggestion_feedback sf
                              WHERE sf.message_id = task.message_id
                                AND sf.outbound_external_id = ?
                          )
                        ORDER BY task.filled_at DESC, task.message_id DESC
                        LIMIT 1
                        """,
                        (external_id, conversation.external_id, external_id),
                    ).fetchone()
                if row is None:
                    continue
                message_id = int(row["message_id"])
                self.save_feedback(
                    message_id,
                    action="sent",
                    final_content=message.content,
                    source="browser-observed",
                    outbound_external_id=external_id,
                )
                self.mark_processed(message_id, actor="browser-observed")
                recorded += 1
        return recorded

    def mark_processed(self, message_id: int, actor: str = "web") -> bool:
        now = utc_now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT conversation_id FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
            if row is None:
                return False
            connection.execute(
                """
                UPDATE messages
                SET is_processed = 1, processed_at = ?, processed_by = ?, updated_at = ?
                WHERE id = ?
                """,
                (now, actor, now, message_id),
            )
            pending = connection.execute(
                """
                SELECT COUNT(*) AS total FROM messages
                WHERE conversation_id = ? AND direction = 'inbound' AND is_processed = 0
                """,
                (row["conversation_id"],),
            ).fetchone()["total"]
            if pending == 0:
                connection.execute(
                    "UPDATE conversations SET status = 'processed', unread_count = 0, updated_at = ? WHERE id = ?",
                    (now, row["conversation_id"]),
                )
        self.audit("message.processed", "message", str(message_id), actor, {})
        return True

    def audit(
        self,
        event_type: str,
        entity_type: str | None,
        entity_id: str | None,
        actor: str,
        details: dict[str, Any],
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO audit_events(
                    event_type, entity_type, entity_id, actor, details_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (event_type, entity_type, entity_id, actor, _json(details), utc_now()),
            )

    def begin_collection_run(self) -> int:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                "INSERT INTO collection_runs(status, started_at) VALUES ('running', ?)",
                (utc_now(),),
            )
            return int(cursor.lastrowid)

    def finish_collection_run(
        self,
        run_id: int,
        *,
        status: str,
        conversations_found: int = 0,
        messages_found: int = 0,
        suggestions_generated: int = 0,
        endpoint_hits: Iterable[str] = (),
        error: str | None = None,
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE collection_runs SET
                    status = ?, conversations_found = ?, messages_found = ?,
                    suggestions_generated = ?, endpoint_hits_json = ?, error = ?,
                    finished_at = ?
                WHERE id = ?
                """,
                (
                    status,
                    conversations_found,
                    messages_found,
                    suggestions_generated,
                    _json(sorted(set(endpoint_hits))),
                    error,
                    utc_now(),
                    run_id,
                ),
            )

    def stats(self) -> dict[str, Any]:
        with self.database.connect() as connection:
            counts = connection.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM shops) AS shops,
                    (SELECT COUNT(*) FROM customers) AS customers,
                    (SELECT COUNT(*) FROM messages WHERE direction='inbound' AND is_processed=0) AS pending,
                    (SELECT COUNT(*) FROM suggestions WHERE status='ready') AS suggestions,
                    (SELECT COUNT(*) FROM assistant_tasks WHERE status IN ('queued','generating','ready','blocked_draft')) AS assistant_queue,
                    (SELECT COUNT(*) FROM review_actions WHERE status='pending') AS review_queue,
                    (SELECT COUNT(*) FROM suggestion_feedback) AS feedback_count
                """
            ).fetchone()
            last_run = connection.execute(
                "SELECT * FROM collection_runs ORDER BY id DESC LIMIT 1"
            ).fetchone()
            return {
                **dict(counts),
                "last_run": dict(last_run) if last_run else None,
            }

    def seed_demo(self) -> None:
        message = MessageEnvelope(
            external_id="demo-message-1",
            direction="inbound",
            content="Hi, can this item arrive before next Friday?",
            sent_at=utc_now(),
            sender_name="Demo Buyer",
        )
        conversation = ConversationEnvelope(
            external_id="demo-conversation-1",
            shop_external_id="demo-shop-1",
            shop_name="Demo PH Shop",
            customer_external_id="demo-buyer-1",
            customer_name="Demo Buyer",
            platform="Shopee",
            region="PH",
            unread_count=1,
            messages=[message],
        )
        self.upsert_batch(ExtractionBatch(conversations=[conversation]))
