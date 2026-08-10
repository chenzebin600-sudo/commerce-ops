from contextlib import asynccontextmanager
from types import SimpleNamespace

from app.assistant import ReplyAssistant
from app.browser import ReplyEditorNotFound
from app.db import Database
from app.models import ConversationEnvelope, ExtractionBatch, MessageEnvelope
from app.repository import Repository


class MissingEditorCollector:
    async def extract_operational_context(self, page):
        return {"right_panel_text": "", "structured": {"available": False}}

    async def fill_reply_editor(self, page, suggestion):
        raise ReplyEditorNotFound("editor missing")


class UnusedSuggestions:
    pass


class FakePage:
    url = "https://mai.zhisuitech.com/#/workbench/conversation"


async def test_missing_editor_delays_one_task_without_crashing_assistant(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv-editor-missing",
                    shop_external_id="shop",
                    shop_name="Shop",
                    customer_external_id="buyer",
                    customer_name="Buyer",
                    messages=[
                        MessageEnvelope(
                            external_id="msg",
                            direction="inbound",
                            content="Hello",
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
        content="Hello!",
        quality_status="passed",
    )
    repository.queue_message(message_id)
    repository.set_assistant_task_status(message_id, "ready")
    item = repository.assistant_task_for_conversation("conv-editor-missing")
    assistant = ReplyAssistant(repository, MissingEditorCollector(), UnusedSuggestions())

    assert await assistant._stage_task(FakePage(), item) is False

    with repository.database.connect() as connection:
        row = connection.execute(
            "SELECT status, last_error FROM assistant_tasks WHERE message_id = ?",
            (message_id,),
        ).fetchone()
    assert row["status"] == "blocked_draft"
    assert "editor missing" in row["last_error"]


class FillCommandPage:
    def __init__(self):
        self.actions: list[tuple[str, str]] = []
        self.keyboard = self

    async def wait_for_timeout(self, _milliseconds):
        return None

    async def fill(self, value):
        self.actions.append(("fill", value))

    async def click(self, *_args, **_kwargs):
        self.actions.append(("click", ""))
        raise AssertionError("central fill-draft must not click a send control")

    async def press(self, key, *_args, **_kwargs):
        self.actions.append(("press", key))
        raise AssertionError("central fill-draft must not press a submit key")

    async def send(self, *_args, **_kwargs):
        self.actions.append(("send", ""))
        raise AssertionError("central fill-draft must not send")


class FillOnlyCollector:
    def __init__(self):
        self.settings = SimpleNamespace(settle_milliseconds=0)
        self.conversation_focuses = 0
        self.focused_conversations: list[str] = []
        self.fill_calls: list[tuple[str, bool]] = []
        self.legacy_send_calls = 0

    async def _click_conversation(self, page, conversation):
        self.conversation_focuses += 1
        self.focused_conversations.append(conversation.external_id)
        page.current_conversation = conversation.external_id
        return True

    async def _dismiss_startup_overlays(self, _page):
        return 0

    async def _extract_dom_messages(self, _page, _conversation):
        return None

    async def fill_reply_editor(self, page, draft, *, allow_existing_same=False):
        self.fill_calls.append((draft, allow_existing_same))
        await page.fill(draft)

    async def send_approved_reply(self, *_args, **_kwargs):
        self.legacy_send_calls += 1
        raise AssertionError("central command reached the legacy send capability")


class FillCommandRepository:
    def __init__(self, expected_message_id=None, *, expected_by_conversation=None):
        self.expected_message_id = expected_message_id
        self.expected_by_conversation = dict(expected_by_conversation or {})
        self.audit_events: list[str] = []

    def upsert_batch(self, _batch):
        return None

    def record_observed_outbound_feedback(self, _batch):
        return 0

    def latest_inbound_external_message_id(self, conversation_id):
        if self.expected_by_conversation:
            return self.expected_by_conversation.get(conversation_id)
        return self.expected_message_id

    def message_id_for_external(self, _conversation_id, _message_id):
        return None

    def audit(self, event, *_args, **_kwargs):
        self.audit_events.append(event)


class FillCommandCentral:
    def __init__(self, account_id, command_batches=None):
        self.settings = SimpleNamespace(central_account_id=account_id)
        self.enabled = True
        self.completions: list[dict] = []
        self.command_batches = list(command_batches or [])

    async def publish_batch(self, _batch):
        return {"accepted": 0, "rejected": 0}

    async def pull_commands(self, limit=10):
        assert 1 <= limit <= 20
        return self.command_batches.pop(0) if self.command_batches else []

    async def complete_command(self, command_id, **result):
        self.completions.append({"command_id": command_id, **result})
        return True


def fill_command(account_id, command_id, conversation_id, message_id, draft):
    return {
        "id": command_id,
        "commandType": "FILL_DRAFT",
        "accountId": account_id,
        "payload": {
            "contractVersion": "CS_FILL_DRAFT_V1",
            "draft": draft,
            "route": {
                "externalConversationId": conversation_id,
                "externalMessageId": message_id,
                "customerDisplayName": f"Buyer {conversation_id}",
            },
            "expected": {"externalMessageId": message_id},
            "safety": {
                "automaticSend": False,
                "requireCurrentConversation": True,
                "requireLatestInboundMessage": True,
                "requireEmptyOrSameEditor": True,
            },
        },
    }


async def test_central_fill_draft_only_fills_and_never_uses_send_click_enter_or_press():
    account_id = "central-account-1"
    conversation_id = "conversation-1"
    message_id = "message-1"
    draft = "Draft for human review"
    repository = FillCommandRepository(message_id)
    collector = FillOnlyCollector()
    central = FillCommandCentral(account_id)
    assistant = ReplyAssistant(
        repository,
        collector,
        UnusedSuggestions(),
        central=central,
    )
    page = FillCommandPage()
    command = fill_command(
        account_id, "command-1", conversation_id, message_id, draft
    )

    await assistant._execute_central_command(page, command, [], set())

    assert collector.conversation_focuses == 1
    assert collector.fill_calls == [(draft, True)]
    assert collector.legacy_send_calls == 0
    assert page.actions == [("fill", draft)]
    assert central.completions == [
        {
            "command_id": "command-1",
            "succeeded": True,
            "result_code": "DRAFT_FILLED_NO_SEND",
            "editor_matched": True,
            "conversation_matched": True,
            "draft_content_digest": "",
        }
    ]


async def test_stale_command_is_rejected_and_does_not_block_another_conversation():
    account_id = "central-account-1"
    repository = FillCommandRepository(
        expected_by_conversation={
            "conversation-a": "message-a-new",
            "conversation-b": "message-b-1",
        }
    )
    collector = FillOnlyCollector()
    commands = [
        fill_command(
            account_id,
            "command-a-old",
            "conversation-a",
            "message-a-old",
            "Stale draft",
        ),
        fill_command(
            account_id,
            "command-b-current",
            "conversation-b",
            "message-b-1",
            "Current draft",
        ),
    ]
    central = FillCommandCentral(account_id, command_batches=[commands])
    assistant = ReplyAssistant(
        repository,
        collector,
        UnusedSuggestions(),
        central=central,
    )
    page = FillCommandPage()

    processed = await assistant._execute_central_commands(page, [], set())

    assert processed == 2
    assert collector.focused_conversations == ["conversation-a", "conversation-b"]
    assert collector.fill_calls == [("Current draft", True)]
    assert collector.legacy_send_calls == 0
    assert page.actions == [("fill", "Current draft")]
    assert central.completions[0] == {
        "command_id": "command-a-old",
        "succeeded": False,
        "result_code": "LATEST_INBOUND_MISMATCH",
        "conversation_matched": True,
    }
    assert central.completions[1]["command_id"] == "command-b-current"
    assert central.completions[1]["result_code"] == "DRAFT_FILLED_NO_SEND"


class BoundaryPage:
    def __init__(self):
        self.closed = False

    def on(self, *_args):
        return None

    def remove_listener(self, *_args):
        return None

    def is_closed(self):
        return self.closed

    async def wait_for_timeout(self, _milliseconds):
        return None


class BoundaryCollector:
    def __init__(self, page):
        self.page = page
        self.settings = SimpleNamespace(collection_limit=10, settle_milliseconds=0)
        self.dom_reads = 0

    @asynccontextmanager
    async def visible_browser_page(self):
        yield self.page

    async def navigate_workbench(self, _page):
        return None

    async def _load_more_conversations(self, _page):
        return None

    async def _extract_dom_conversations(self, _page):
        self.dom_reads += 1
        if self.dom_reads > 1:
            return []
        return [
            {
                "conversation_id": "conversation-a",
                "customer_name": "Buyer A",
                "shop_name": "Shop",
                "unread_count": 1,
            },
            {
                "conversation_id": "conversation-b",
                "customer_name": "Buyer B",
                "shop_name": "Shop",
                "unread_count": 1,
            },
        ]


class BoundaryRepository:
    def __init__(self):
        self.audit_events = []

    def recover_assistant_tasks(self):
        return 0

    def recover_review_actions(self):
        return 0

    def max_message_id(self):
        return 0

    def audit(self, event, *_args, **_kwargs):
        self.audit_events.append(event)

    def upsert_batch(self, _batch):
        return None

    def record_observed_outbound_feedback(self, _batch):
        return 0

    def queue_latest_for_conversation(self, _conversation_id):
        return None

    def assistant_task_for_conversation(self, _conversation_id):
        return None

    def assistant_queue(self, limit):
        assert limit == 10
        return []


class BoundaryCentral:
    def __init__(self):
        self.enabled = True
        self.settings = SimpleNamespace(central_account_id="central-account-1")
        self.pull_count = 0
        self.released = False

    async def ensure_ready(self):
        return None

    async def publish_batch(self, _batch):
        return {"accepted": 0, "rejected": 0}

    async def pull_commands(self, limit=10):
        assert limit == 10
        self.pull_count += 1
        if self.pull_count == 2:
            return [{"id": "command-between-conversations"}]
        return []

    async def release_account_lease(self):
        self.released = True
        return True


class BoundarySuggestions:
    settings = SimpleNamespace(llm_enabled=False, human_send_enabled=False)


class BoundaryAssistant(ReplyAssistant):
    def __init__(self, *args, events, **kwargs):
        super().__init__(*args, **kwargs)
        self.events = events

    async def _open_conversation(
        self, page, conversation, _captured, _response_tasks
    ):
        self.events.append(f"open:{conversation.external_id}")
        if conversation.external_id == "conversation-b":
            page.closed = True
        return ExtractionBatch()

    async def _execute_central_command(
        self, _page, command, _captured, _response_tasks
    ):
        self.events.append(f"command:{command['id']}")


async def test_run_pulls_central_commands_between_busy_unread_conversations():
    events = []
    page = BoundaryPage()
    central = BoundaryCentral()
    assistant = BoundaryAssistant(
        BoundaryRepository(),
        BoundaryCollector(page),
        BoundarySuggestions(),
        central=central,
        events=events,
    )

    await assistant.run()

    assert events == [
        "open:conversation-a",
        "command:command-between-conversations",
        "open:conversation-b",
    ]
    assert central.pull_count == 2
    assert central.released is True
