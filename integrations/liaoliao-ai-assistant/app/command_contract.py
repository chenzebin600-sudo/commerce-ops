from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any


class CommandContractError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True, slots=True)
class FillDraftCommand:
    command_id: str
    external_conversation_id: str
    external_message_id: str
    draft: str
    draft_content_digest: str
    route: dict[str, Any]
    expected: dict[str, Any]


def _text(value: Any, maximum: int = 500) -> str:
    return str(value or "").strip()[:maximum]


def validate_fill_draft_command(
    command: dict[str, Any], *, expected_account_id: str
) -> FillDraftCommand:
    command_id = _text(command.get("id"), 120)
    if not command_id:
        raise CommandContractError("MISSING_COMMAND_ID")
    if _text(command.get("commandType"), 40) != "FILL_DRAFT":
        raise CommandContractError("UNSUPPORTED_COMMAND")
    if _text(command.get("accountId"), 120) != _text(expected_account_id, 120):
        raise CommandContractError("ACCOUNT_SCOPE_MISMATCH")

    payload = command.get("payload")
    if not isinstance(payload, dict):
        raise CommandContractError("INVALID_COMMAND_PAYLOAD")
    if _text(payload.get("contractVersion"), 40) != "CS_FILL_DRAFT_V1":
        raise CommandContractError("UNSUPPORTED_COMMAND_CONTRACT")
    route = payload.get("route")
    expected = payload.get("expected")
    safety = payload.get("safety")
    if not isinstance(route, dict) or not isinstance(expected, dict) or not isinstance(safety, dict):
        raise CommandContractError("INVALID_COMMAND_PAYLOAD")
    if safety.get("automaticSend") is not False or any(
        safety.get(field) is not True
        for field in (
            "requireCurrentConversation",
            "requireLatestInboundMessage",
            "requireEmptyOrSameEditor",
        )
    ):
        raise CommandContractError("UNSAFE_COMMAND_CONTRACT")

    external_conversation_id = _text(route.get("externalConversationId"))
    route_message_id = _text(route.get("externalMessageId"))
    expected_message_id = _text(expected.get("externalMessageId"))
    draft_content_digest = _text(expected.get("draftContentDigest"), 64).lower()
    draft = str(payload.get("draft") or "").strip()
    if not external_conversation_id or not route_message_id or not expected_message_id:
        raise CommandContractError("MISSING_ROUTE_IDENTITY")
    if route_message_id != expected_message_id:
        raise CommandContractError("MESSAGE_ROUTE_MISMATCH")
    if not draft or len(draft) > 8_000:
        raise CommandContractError("INVALID_DRAFT")
    if draft_content_digest and re.fullmatch(r"[a-f0-9]{64}", draft_content_digest) is None:
        raise CommandContractError("INVALID_DRAFT_DIGEST")

    command_trigger_id = _text(command.get("triggerMessageId"), 120)
    expected_trigger_id = _text(expected.get("centralTriggerMessageId"), 120)
    if command_trigger_id and expected_trigger_id != command_trigger_id:
        raise CommandContractError("CENTRAL_TRIGGER_MISMATCH")
    return FillDraftCommand(
        command_id=command_id,
        external_conversation_id=external_conversation_id,
        external_message_id=expected_message_id,
        draft=draft,
        draft_content_digest=draft_content_digest,
        route=route,
        expected=expected,
    )
