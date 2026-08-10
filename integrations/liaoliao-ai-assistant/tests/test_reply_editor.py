from __future__ import annotations

import pytest
from playwright.async_api import TimeoutError as PlaywrightTimeoutError

from app.browser import BrowserCollector, ReplyEditorBusy
from app.models import ConversationEnvelope


class FakeEditor:
    def __init__(
        self,
        value: str = "",
        *,
        box: dict | None = None,
        visible: bool = True,
        editable: bool = True,
    ):
        self.value = value
        self.box = box or {"x": 500, "y": 650, "width": 700, "height": 120}
        self.visible = visible
        self.editable = editable
        self.actions: list[tuple[str, str]] = []

    async def is_visible(self):
        return self.visible

    async def is_editable(self):
        return self.editable

    async def bounding_box(self):
        return self.box

    async def evaluate(self, script):
        if "tagName" in script:
            return "textarea"
        return self.value

    async def input_value(self):
        return self.value

    async def fill(self, value):
        self.actions.append(("fill", value))
        self.value = value

    async def click(self, *_args, **_kwargs):
        raise AssertionError("fill-only path must not click an editor or send control")

    async def press(self, key, *_args, **_kwargs):
        raise AssertionError(f"fill-only path must not press {key}")


class FakeSendButton:
    def __init__(self, editor: FakeEditor):
        self.editor = editor
        self.clicks = 0

    async def is_visible(self):
        return True

    async def is_enabled(self):
        return True

    async def bounding_box(self):
        return {"x": 1180, "y": 810, "width": 90, "height": 40}

    async def click(self):
        self.clicks += 1
        self.editor.value = ""


class FakeLocatorGroup:
    def __init__(self, items):
        self.items = items if isinstance(items, list) else [items]

    async def count(self):
        return len(self.items)

    def nth(self, index):
        return self.items[index]


class FakePage:
    viewport_size = {"width": 1440, "height": 960}

    def __init__(self, editor):
        self.editor = editor
        self.keyboard = self
        self.requested_selectors: list[str] = []

    def locator(self, selector):
        self.requested_selectors.append(selector)
        return FakeLocatorGroup(self.editor)

    async def press(self, key, *_args, **_kwargs):
        raise AssertionError(f"fill-only path must not press {key}")


class SafeSendPage(FakePage):
    def __init__(self, editor: FakeEditor, button: FakeSendButton):
        super().__init__(editor)
        self.button = button

    def locator(self, selector):
        if selector == "button.send":
            return FakeLocatorGroup(self.button)
        return FakeLocatorGroup(self.editor)

    def is_closed(self):
        return False

    async def wait_for_timeout(self, milliseconds):
        return None


class CaptureEvaluatePage:
    def __init__(self):
        self.script = ""

    async def evaluate(self, script, argument):
        self.script = script
        return []


class OperationalContextPage:
    async def evaluate(self, script):
        assert "right_panel_text" in script
        return {
            "right_panel_text": "订单状态：已发货\n物流状态：运输中",
            "panel_bounds": {"x": 1180, "y": 87, "width": 420, "height": 913},
        }


class EmptyGroup:
    async def count(self):
        return 0


class BlockedConversation:
    async def is_visible(self):
        return True

    async def evaluate(self, script):
        return "conv|buyer|0|0|300|80"

    async def get_attribute(self, name):
        return "conv" if name == "data-conversation-id" else None

    async def inner_text(self):
        return "Buyer\nShop"

    async def click(self, timeout=None):
        raise PlaywrightTimeoutError("modal intercepted the click")


class ConversationGroup:
    def __init__(self):
        self.candidate = BlockedConversation()

    def filter(self, has_text=None):
        return self

    async def count(self):
        return 1

    def nth(self, index):
        return self.candidate


class BlockedConversationPage:
    def locator(self, selector):
        if selector.startswith(".ant-modal"):
            return EmptyGroup()
        return ConversationGroup()


class ConversationCandidate:
    def __init__(self, conversation_id: str, text: str, y: int):
        self.conversation_id = conversation_id
        self.text = text
        self.y = y
        self.clicks = 0

    async def is_visible(self):
        return True

    async def evaluate(self, _script):
        return f"{self.conversation_id}|{self.text}|0|{self.y}|320|72"

    async def get_attribute(self, name):
        if name == "data-conversation-id":
            return self.conversation_id
        return None

    async def inner_text(self):
        return self.text

    async def click(self, timeout=None):
        assert timeout == 5_000
        self.clicks += 1


class ConversationCandidates:
    def __init__(self, candidates):
        self.candidates = list(candidates)

    def filter(self, has_text=None):
        if not has_text:
            return self
        return ConversationCandidates(
            [candidate for candidate in self.candidates if has_text in candidate.text]
        )

    async def count(self):
        return len(self.candidates)

    def nth(self, index):
        return self.candidates[index]


class ConversationCandidatePage:
    def __init__(self, candidates):
        self.candidates = candidates

    def locator(self, selector):
        if selector.startswith(".ant-modal"):
            return EmptyGroup()
        return ConversationCandidates(self.candidates)


@pytest.mark.asyncio
async def test_fill_reply_editor_only_fills_and_never_submits(settings_factory):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"reply_editors": ["textarea"], "send_buttons": ["button.send"]}',
        encoding="utf-8",
    )
    editor = FakeEditor()
    collector = BrowserCollector(settings)

    page = FakePage(editor)

    await collector.fill_reply_editor(page, "Draft only")

    assert editor.value == "Draft only"
    assert editor.actions == [("fill", "Draft only")]
    assert "button.send" not in page.requested_selectors


@pytest.mark.asyncio
async def test_fill_reply_editor_ignores_search_field_and_fills_bottom_reply_box(
    settings_factory,
):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"reply_editors": ["textarea"], "send_buttons": ["button.send"]}',
        encoding="utf-8",
    )
    search = FakeEditor(
        box={"x": 40, "y": 30, "width": 420, "height": 36}
    )
    reply = FakeEditor(
        box={"x": 480, "y": 690, "width": 760, "height": 130}
    )
    page = FakePage([search, reply])
    collector = BrowserCollector(settings)

    selected = await collector.fill_reply_editor(page, "Correct conversation draft")

    assert selected is reply
    assert search.value == ""
    assert search.actions == []
    assert reply.actions == [("fill", "Correct conversation draft")]
    assert page.requested_selectors == ["textarea"]


@pytest.mark.asyncio
async def test_fill_reply_editor_does_not_overwrite_human_draft(settings_factory):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"reply_editors": ["textarea"]}', encoding="utf-8"
    )
    editor = FakeEditor("Human draft")
    collector = BrowserCollector(settings)

    with pytest.raises(ReplyEditorBusy):
        await collector.fill_reply_editor(FakePage(editor), "AI draft")

    assert editor.value == "Human draft"
    assert editor.actions == []


@pytest.mark.asyncio
async def test_dom_conversation_script_keeps_newline_regex_valid(settings_factory):
    collector = BrowserCollector(settings_factory())
    page = CaptureEvaluatePage()

    assert await collector._extract_dom_conversations(page) == []
    assert "split(/\\n+/)" in page.script


@pytest.mark.asyncio
async def test_extract_operational_context_reads_right_panel(settings_factory):
    collector = BrowserCollector(settings_factory())

    context = await collector.extract_operational_context(OperationalContextPage())

    assert "已发货" in context["right_panel_text"]
    assert context["panel_bounds"]["x"] == 1180


@pytest.mark.asyncio
async def test_human_approved_send_clicks_button_only_after_exact_content_check(settings_factory):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"reply_editors": ["textarea"], "send_buttons": ["button.send"]}',
        encoding="utf-8",
    )
    editor = FakeEditor("AI draft")
    button = FakeSendButton(editor)
    collector = BrowserCollector(settings)

    result = await collector.send_approved_reply(
        SafeSendPage(editor, button),
        "Human approved reply",
        expected_content="AI draft",
    )

    assert result == "confirmed_editor_cleared"
    assert button.clicks == 1
    assert ("fill", "Human approved reply") in editor.actions


@pytest.mark.asyncio
async def test_human_approved_send_stops_when_editor_has_unexpected_text(settings_factory):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"reply_editors": ["textarea"], "send_buttons": ["button.send"]}',
        encoding="utf-8",
    )
    editor = FakeEditor("Someone is editing this")
    button = FakeSendButton(editor)
    collector = BrowserCollector(settings)

    with pytest.raises(ReplyEditorBusy):
        await collector.send_approved_reply(
            SafeSendPage(editor, button),
            "Approved reply",
            expected_content="AI draft",
        )

    assert button.clicks == 0


@pytest.mark.asyncio
async def test_blocked_conversation_click_returns_false_instead_of_crashing(settings_factory):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"conversation_items": ["div[data-key=convItem]"]}', encoding="utf-8"
    )
    collector = BrowserCollector(settings)
    conversation = ConversationEnvelope(
        external_id="conv",
        shop_external_id="shop",
        shop_name="Shop",
        customer_external_id="buyer",
        customer_name="Buyer",
    )

    assert await collector._click_conversation(
        BlockedConversationPage(), conversation
    ) is False


@pytest.mark.asyncio
async def test_conversation_locator_prefers_exact_external_id_over_same_name(
    settings_factory,
):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"conversation_items": ["[data-conversation-id]"]}', encoding="utf-8"
    )
    lookalike = ConversationCandidate(
        "conversation-other", "Buyer A\nShop MY", 100
    )
    exact = ConversationCandidate(
        "conversation-target", "Buyer A\nShop MY", 180
    )
    collector = BrowserCollector(settings)
    conversation = ConversationEnvelope(
        external_id="conversation-target",
        shop_external_id="shop-my",
        shop_name="Shop MY",
        customer_external_id="buyer-a",
        customer_name="Buyer A",
    )

    matched = await collector._click_conversation(
        ConversationCandidatePage([lookalike, exact]), conversation
    )

    assert matched is True
    assert exact.clicks == 1
    assert lookalike.clicks == 0


@pytest.mark.asyncio
async def test_conversation_locator_fails_closed_when_name_and_shop_are_ambiguous(
    settings_factory,
):
    settings = settings_factory()
    settings.selectors_path.write_text(
        '{"conversation_items": ["[data-conversation-id]"]}', encoding="utf-8"
    )
    first = ConversationCandidate("conversation-1", "Buyer A\nShop MY", 100)
    second = ConversationCandidate("conversation-2", "Buyer A\nShop MY", 180)
    collector = BrowserCollector(settings)
    conversation = ConversationEnvelope(
        external_id="conversation-not-present",
        shop_external_id="shop-my",
        shop_name="Shop MY",
        customer_external_id="buyer-a",
        customer_name="Buyer A",
    )

    matched = await collector._click_conversation(
        ConversationCandidatePage([first, second]), conversation
    )

    assert matched is False
    assert first.clicks == 0
    assert second.clicks == 0
