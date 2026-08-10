from fastapi.testclient import TestClient
import re

from app.db import Database
from app.factory import Runtime
from app.models import ConversationEnvelope, ExtractionBatch, MessageEnvelope
from app.repository import Repository
from app.service import ApplicationService
from app.web import create_app


class FakeCollector:
    async def collect(self):
        return ExtractionBatch()

    async def close(self):
        return None


class FakeSuggestions:
    async def generate_pending(self, limit=50):
        return 0

    async def generate_for_message(self, message_id, force=False):
        return False


def test_web_lists_message_and_marks_processed(settings_factory):
    settings = settings_factory(llm_model=None)
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-web",
                    shop_external_id="shop-web",
                    shop_name="Web Shop",
                    customer_external_id="buyer-web",
                    customer_name="Web Buyer",
                    messages=[
                        MessageEnvelope(
                            external_id="msg-web",
                            direction="inbound",
                            content="Web message",
                        )
                    ],
                )
            ]
        )
    )
    collector = FakeCollector()
    suggestions = FakeSuggestions()
    service = ApplicationService(repository, collector, suggestions)
    runtime = Runtime(settings, repository, collector, suggestions, service)

    with TestClient(create_app(runtime=runtime)) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert "Web Shop" in response.text
        assert "Web message" in response.text
        message_id = repository.list_work_items()[0]["message_id"]
        marked = client.post(f"/messages/{message_id}/processed", follow_redirects=False)
        assert marked.status_code == 303
        assert repository.stats()["pending"] == 0


def test_review_page_requires_explicit_confirmation_and_queues_send(settings_factory):
    settings = settings_factory(llm_model=None, human_send_enabled=True)
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-send-web",
                    shop_external_id="shop-send-web",
                    shop_name="Web Shop",
                    customer_external_id="buyer-send-web",
                    customer_name="Web Buyer",
                    messages=[
                        MessageEnvelope(
                            external_id="msg-send-web",
                            direction="inbound",
                            content="Can you check my order?",
                        )
                    ],
                )
            ]
        )
    )
    message_id = int(repository.list_work_items()[0]["message_id"])
    repository.save_suggestion(
        message_id,
        status="ready",
        content="I’ll check the latest order status for you.",
        intent="delivery",
        risk_level="medium",
        quality_status="passed",
    )
    runtime = Runtime(
        settings,
        repository,
        FakeCollector(),
        FakeSuggestions(),
        ApplicationService(repository, FakeCollector(), FakeSuggestions()),
    )

    with TestClient(create_app(runtime=runtime)) as client:
        page = client.get("/?view=review")
        token = re.search(r'name="csrf_token" value="([^"]+)"', page.text).group(1)
        rejected = client.post(
            f"/messages/{message_id}/approve-send",
            data={"csrf_token": token, "approved_content": "Approved"},
            follow_redirects=False,
        )
        assert rejected.status_code == 303
        assert repository.claim_next_review_action() is None

        accepted = client.post(
            f"/messages/{message_id}/approve-send",
            data={
                "csrf_token": token,
                "approved_content": "Approved",
                "confirm_send": "HUMAN_CONFIRMED_SEND",
            },
            follow_redirects=False,
        )
        assert accepted.status_code == 303
        action = repository.claim_next_review_action()
        assert action is not None
        assert action["approved_content"] == "Approved"


def test_regenerate_returns_to_continuous_review(settings_factory):
    settings = settings_factory(llm_model=None)
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    collector = FakeCollector()
    suggestions = FakeSuggestions()
    runtime = Runtime(
        settings,
        repository,
        collector,
        suggestions,
        ApplicationService(repository, collector, suggestions),
    )

    with TestClient(create_app(runtime=runtime)) as client:
        response = client.post(
            "/messages/999/suggest?view=review", follow_redirects=False
        )
        assert response.status_code == 303
        assert response.headers["location"].startswith("/?view=review&")
