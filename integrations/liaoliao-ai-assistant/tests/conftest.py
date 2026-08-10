from __future__ import annotations

from pathlib import Path

import pytest

from app.config import Settings


@pytest.fixture
def settings_factory(tmp_path: Path):
    def factory(**overrides):
        selectors_path = tmp_path / "selectors.json"
        if not selectors_path.exists():
            selectors_path.write_text(
                '{"login_account": [], "login_password": [], "login_submit": [], '
                '"conversation_items": [], "unread_badges": [], "message_items": []}',
                encoding="utf-8",
            )
        values = dict(
            project_dir=tmp_path,
            login_url="https://mai.zhisuitech.com/#/login",
            workbench_url="https://mai.zhisuitech.com/#/workbench/conversation",
            account=None,
            password=None,
            headless=True,
            login_timeout_seconds=30,
            collection_limit=10,
            max_scroll_pages=2,
            settle_milliseconds=250,
            database_path=tmp_path / "data" / "test.db",
            session_path=tmp_path / "runtime" / "state.json",
            selectors_path=selectors_path,
            knowledge_dir=tmp_path / "knowledge",
            log_dir=tmp_path / "logs",
            llm_base_url="https://llm.example/v1",
            llm_api_key="test-key",
            llm_model="test-model",
            llm_review_model="test-review-model",
            llm_timeout_seconds=5,
            quality_review_enabled=False,
            max_history_messages=12,
            human_send_enabled=True,
            web_host="127.0.0.1",
            web_port=8765,
            auto_collect_seconds=0,
        )
        values.update(overrides)
        return Settings(**values)

    return factory
