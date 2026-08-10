from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


Direction = Literal["inbound", "outbound", "system"]


@dataclass(slots=True)
class MessageEnvelope:
    external_id: str
    direction: Direction
    content: str
    sent_at: str | None = None
    sender_name: str | None = None
    message_type: str = "text"
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class ConversationEnvelope:
    external_id: str
    shop_external_id: str
    shop_name: str
    customer_external_id: str
    customer_name: str
    platform: str | None = None
    region: str | None = None
    unread_count: int = 0
    last_message_at: str | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    messages: list[MessageEnvelope] = field(default_factory=list)


@dataclass(slots=True)
class ExtractionBatch:
    conversations: list[ConversationEnvelope] = field(default_factory=list)
    endpoint_hits: list[str] = field(default_factory=list)

    @property
    def message_count(self) -> int:
        return sum(len(item.messages) for item in self.conversations)

