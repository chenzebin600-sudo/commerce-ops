from app.db import Database
from app.models import ConversationEnvelope, ExtractionBatch, MessageEnvelope
from app.repository import Repository


def test_repository_deduplicates_and_marks_processed(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    batch = ExtractionBatch(
        conversations=[
            ConversationEnvelope(
                external_id="conv-1",
                shop_external_id="shop-1",
                shop_name="Shop One",
                customer_external_id="buyer-1",
                customer_name="Buyer One",
                unread_count=1,
                messages=[
                    MessageEnvelope(
                        external_id="msg-1",
                        direction="inbound",
                        content="Hello",
                    )
                ],
            )
        ]
    )
    first = repository.upsert_batch(batch)
    second = repository.upsert_batch(batch)
    assert first["new_messages"] == 1
    assert second["new_messages"] == 0
    item = repository.list_work_items()[0]
    assert item["shop_name"] == "Shop One"
    assert repository.mark_processed(item["message_id"], actor="test") is True
    assert repository.stats()["pending"] == 0
    assert len(repository.list_work_items(status="processed")) == 1


def test_assistant_item_is_not_returned_after_it_was_filled(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-assist",
                    shop_external_id="shop-assist",
                    shop_name="Shop",
                    customer_external_id="buyer-assist",
                    customer_name="Buyer",
                    unread_count=1,
                    messages=[
                        MessageEnvelope(
                            external_id="msg-assist",
                            direction="inbound",
                            content="Where is my parcel?",
                        )
                    ],
                )
            ]
        )
    )
    item = repository.latest_assistant_item("conv-assist")
    assert item is not None
    repository.save_suggestion(
        int(item["message_id"]), status="ready", content="Let me check that for you."
    )
    repository.audit(
        "suggestion.filled",
        "message",
        str(item["message_id"]),
        "test",
        {},
    )

    assert repository.latest_assistant_item("conv-assist") is None


def test_suggestion_claim_prevents_duplicate_workers(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-claim",
                    shop_external_id="shop-claim",
                    shop_name="Shop",
                    customer_external_id="buyer-claim",
                    customer_name="Buyer",
                    messages=[
                        MessageEnvelope(
                            external_id="msg-claim",
                            direction="inbound",
                            content="Hello",
                        )
                    ],
                )
            ]
        )
    )
    message_id = int(repository.list_work_items()[0]["message_id"])

    assert repository.claim_suggestion(message_id) is True
    assert repository.claim_suggestion(message_id) is False
    repository.save_suggestion(message_id, status="error", error="interrupted")
    assert repository.claim_suggestion(message_id) is True


def test_assistant_queue_keeps_latest_message_per_conversation(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-queue",
                    shop_external_id="shop-queue",
                    shop_name="Shop",
                    customer_external_id="buyer-queue",
                    customer_name="Buyer",
                    messages=[
                        MessageEnvelope(
                            external_id="msg-queue-1",
                            direction="inbound",
                            content="First part",
                        ),
                        MessageEnvelope(
                            external_id="msg-queue-2",
                            direction="inbound",
                            content="Second part",
                        ),
                    ],
                )
            ]
        )
    )
    items = repository.list_work_items(limit=10)
    for item in items:
        repository.queue_message(int(item["message_id"]))

    queue = repository.assistant_queue()

    assert len(queue) == 1
    assert queue[0]["content"] == "Second part"
    with repository.database.connect() as connection:
        statuses = [
            row["status"]
            for row in connection.execute(
                "SELECT status FROM assistant_tasks ORDER BY message_id"
            )
        ]
    assert statuses == ["superseded", "queued"]


def test_feedback_becomes_example_and_human_send_is_claimed_once(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-review",
                    shop_external_id="shop-review",
                    shop_name="Review Shop",
                    customer_external_id="buyer-review",
                    customer_name="Buyer",
                    platform="Shopee",
                    messages=[
                        MessageEnvelope(
                            external_id="msg-review",
                            direction="inbound",
                            content="Where is my parcel?",
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
        content="Let me check the tracking for you.",
        intent="delivery",
        risk_level="medium",
        quality_status="passed",
    )
    repository.save_feedback(
        message_id,
        action="sent",
        final_content="I’ll check the latest tracking update for you.",
        source="test",
    )

    examples = repository.feedback_examples(
        shop_name="Review Shop", platform="Shopee", intent="delivery"
    )
    assert examples[0]["final_reply"].startswith("I’ll check")

    action_id = repository.queue_review_send(
        message_id,
        "I’ll check the latest tracking update for you.",
        requested_by="test",
    )
    claimed = repository.claim_next_review_action()
    assert claimed is not None
    assert claimed["review_action_id"] == action_id
    assert repository.claim_next_review_action() is None
    repository.finish_review_action(action_id, "sent")
    assert repository.review_action_status(message_id) == "sent"


def test_new_message_invalidates_pending_send(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    conversation = ConversationEnvelope(
        external_id="conv-stale",
        shop_external_id="shop-stale",
        shop_name="Shop",
        customer_external_id="buyer-stale",
        customer_name="Buyer",
        messages=[
            MessageEnvelope(
                external_id="msg-old", direction="inbound", content="First question"
            )
        ],
    )
    repository.upsert_batch(ExtractionBatch(conversations=[conversation]))
    old_id = int(repository.list_work_items()[0]["message_id"])
    repository.save_suggestion(
        old_id, status="ready", content="First answer", quality_status="passed"
    )
    repository.queue_review_send(old_id, "First answer", requested_by="test")

    conversation.messages = [
        MessageEnvelope(
            external_id="msg-new", direction="inbound", content="Updated question"
        )
    ]
    repository.upsert_batch(ExtractionBatch(conversations=[conversation]))
    new_id = max(int(item["message_id"]) for item in repository.list_work_items())
    repository.queue_message(new_id)

    assert repository.review_action_status(old_id) == "blocked_stale"
    assert repository.claim_next_review_action() is None
