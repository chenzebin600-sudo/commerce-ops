from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any, Iterable, Iterator, Mapping, Sequence
from urllib.parse import urlparse

from .models import ConversationEnvelope, ExtractionBatch, MessageEnvelope


CONVERSATION_ENDPOINT_MARKERS = (
    "advanceQueryConversationList",
    "getImportantTodoConversationList",
    "getAggTalkList",
    "queryConversationList",
)
MESSAGE_ENDPOINT_MARKERS = (
    "/aggregation/v1/queryConversation",
    "/oversea-user-voice/v1/queryConversation",
    "/oversea-conversation/v1/queryMessage",
    "/oversea-conversation/v1/syncMessage",
)


def _first(mapping: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _string(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        clean = re.sub(r"\s+", " ", value).strip()
        return clean or None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return None


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _timestamp(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        if number > 10_000_000_000:
            number /= 1000
        try:
            return datetime.fromtimestamp(number, UTC).isoformat().replace("+00:00", "Z")
        except (OSError, OverflowError, ValueError):
            return str(value)
    return _string(value)


def _hash_id(prefix: str, value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str).encode(
        "utf-8"
    )
    return f"{prefix}:sha256:{hashlib.sha256(encoded).hexdigest()}"


def _walk_named_lists(value: Any, names: set[str]) -> Iterator[list[Any]]:
    if isinstance(value, Mapping):
        for key, item in value.items():
            if key in names and isinstance(item, list):
                yield item
            yield from _walk_named_lists(item, names)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_named_lists(item, names)


def _content_from_mapping(message: Mapping[str, Any]) -> str | None:
    direct = _first(
        message,
        (
            "textContent",
            "content",
            "message",
            "msgContent",
            "text",
            "translatedText",
            "translation",
            "caption",
        ),
    )
    if isinstance(direct, str):
        return _string(direct)
    if isinstance(direct, Mapping):
        nested = _first(
            direct,
            ("text", "content", "message", "title", "name", "description", "url"),
        )
        if nested is not None:
            return _string(nested)
    for key in ("textContent", "messageContent", "quote", "body", "payload"):
        nested_value = message.get(key)
        if isinstance(nested_value, Mapping):
            nested = _content_from_mapping(nested_value)
            if nested:
                return nested
    message_type = _string(
        _first(message, ("messageType", "msgType", "type", "contentType"))
    )
    if message_type and message_type.upper() not in {"TEXT", "MESSAGE", "NORMAL"}:
        return f"[{message_type}]"
    return None


def normalize_message(
    raw: Mapping[str, Any], *, conversation_id: str | None = None
) -> MessageEnvelope | None:
    content = _content_from_mapping(raw)
    if not content:
        return None
    external_id = _string(
        _first(raw, ("msgId", "messageId", "externalMsgId", "id", "mid"))
    )
    if not external_id:
        external_id = _hash_id("message", [conversation_id, content, raw])

    from_type = str(
        _first(
            raw,
            (
                "msgFromType",
                "fromType",
                "senderType",
                "messageFrom",
                "role",
                "direction",
            ),
        )
        or ""
    ).upper()
    is_buyer = raw.get("isBuyerMessage")
    if is_buyer is True or any(
        marker in from_type for marker in ("BUYER", "CUSTOMER", "USER", "INBOUND")
    ):
        direction = "inbound"
    elif any(
        marker in from_type
        for marker in ("SELLER", "ASSISTANT", "AGENT", "SERVICE", "OUTBOUND")
    ):
        direction = "outbound"
    else:
        direction = "system"

    return MessageEnvelope(
        external_id=external_id,
        direction=direction,
        content=content,
        sent_at=_timestamp(
            _first(raw, ("sendTime", "sentAt", "createTime", "createdAt", "timestamp"))
        ),
        sender_name=_string(
            _first(raw, ("senderName", "buyerNick", "buyerName", "fromName", "nickname"))
        ),
        message_type=(
            _string(_first(raw, ("messageType", "msgType", "contentType", "type")))
            or "text"
        ).lower(),
        raw=dict(raw),
    )


def normalize_conversation(raw: Mapping[str, Any]) -> ConversationEnvelope:
    talk = raw.get("talk") if isinstance(raw.get("talk"), Mapping) else raw
    external_id = _string(
        _first(talk, ("conversationId", "talkId", "conversation_id", "id"))
    )
    shop_id = _string(
        _first(
            talk,
            (
                "storeId",
                "internalStoreId",
                "internal_store_id",
                "externalStoreId",
                "shopId",
            ),
        )
    )
    buyer_id = _string(
        _first(
            talk,
            (
                "buyerId",
                "internalBuyerId",
                "externalBuyerId",
                "internal_buyer_id",
                "customerId",
            ),
        )
    )
    external_id = external_id or _hash_id("conversation", [shop_id, buyer_id, talk])
    shop_id = shop_id or f"unknown-shop:{external_id}"
    buyer_id = buyer_id or f"unknown-customer:{external_id}"

    shop_info = talk.get("storeInfo") if isinstance(talk.get("storeInfo"), Mapping) else {}
    buyer_info = talk.get("buyerDetail") if isinstance(talk.get("buyerDetail"), Mapping) else {}
    shop_name = _string(
        _first(talk, ("storeAlias", "storeName", "shopName"))
        or _first(shop_info, ("storeAlias", "storeName", "name"))
    ) or shop_id
    customer_name = _string(
        _first(talk, ("buyerNick", "buyerName", "customerName", "nickname"))
        or _first(buyer_info, ("buyerNick", "buyerName", "name", "nickname"))
    ) or buyer_id

    messages: list[MessageEnvelope] = []
    preview = normalize_message(talk, conversation_id=external_id)
    if preview and preview.direction != "system":
        messages.append(preview)

    return ConversationEnvelope(
        external_id=external_id,
        shop_external_id=shop_id,
        shop_name=shop_name,
        customer_external_id=buyer_id,
        customer_name=customer_name,
        platform=_string(_first(talk, ("channel", "platform", "externalType"))),
        region=_string(_first(talk, ("region", "country", "site"))),
        unread_count=max(
            0,
            _integer(_first(talk, ("unreadCount", "unread_count", "unread", "badge"))),
        ),
        last_message_at=_timestamp(
            _first(talk, ("lastMessageTime", "lastMsgTime", "updateTime", "sendTime"))
        ),
        raw=dict(raw),
        messages=messages,
    )


def _message_lists(payload: Any) -> list[list[Any]]:
    return list(
        _walk_named_lists(payload, {"message", "messages", "messageList", "msgList"})
    )


def _conversation_lists(payload: Any) -> list[list[Any]]:
    return list(
        _walk_named_lists(
            payload,
            {
                "talkInfo",
                "aggTalks",
                "conversations",
                "conversationList",
                "talkList",
                "records",
            },
        )
    )


def parse_network_payload(
    url: str, payload: Any, *, conversation_hint: ConversationEnvelope | None = None
) -> ExtractionBatch:
    path = urlparse(url).path
    is_conversation_list = any(marker in path for marker in CONVERSATION_ENDPOINT_MARKERS)
    is_message_payload = any(marker in path for marker in MESSAGE_ENDPOINT_MARKERS)
    if not is_conversation_list and not is_message_payload:
        return ExtractionBatch()

    conversations: list[ConversationEnvelope] = []
    if is_conversation_list:
        for values in _conversation_lists(payload):
            for value in values:
                if isinstance(value, Mapping):
                    conversations.append(normalize_conversation(value))

    if is_message_payload:
        grouped: dict[str, list[MessageEnvelope]] = defaultdict(list)
        raw_by_conversation: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for values in _message_lists(payload):
            for value in values:
                if not isinstance(value, Mapping):
                    continue
                conversation_id = _string(
                    _first(value, ("conversationId", "talkId", "conversation_id"))
                ) or (conversation_hint.external_id if conversation_hint else None)
                normalized = normalize_message(value, conversation_id=conversation_id)
                if normalized is None:
                    continue
                conversation_id = conversation_id or _hash_id("conversation", value)
                grouped[conversation_id].append(normalized)
                raw_by_conversation[conversation_id].append(dict(value))

        for conversation_id, messages in grouped.items():
            if conversation_hint and conversation_hint.external_id == conversation_id:
                envelope = conversation_hint
                envelope.messages = messages
            else:
                first_raw = raw_by_conversation[conversation_id][0]
                seed = dict(first_raw)
                seed["conversationId"] = conversation_id
                envelope = normalize_conversation(seed)
                envelope.messages = messages
            conversations.append(envelope)

    return merge_batches(
        [ExtractionBatch(conversations=conversations, endpoint_hits=[path])]
    )


def batch_from_dom(payload: Iterable[Mapping[str, Any]]) -> ExtractionBatch:
    conversations: list[ConversationEnvelope] = []
    for item in payload:
        raw = dict(item)
        raw.setdefault("conversationId", item.get("conversation_id"))
        raw.setdefault("buyerName", item.get("customer_name"))
        raw.setdefault("storeName", item.get("shop_name"))
        raw.setdefault("unreadCount", item.get("unread_count", 0))
        envelope = normalize_conversation(raw)
        message_text = _string(item.get("message_text"))
        if message_text:
            envelope.messages = [
                MessageEnvelope(
                    external_id=_string(item.get("message_id"))
                    or _hash_id("dom-message", [envelope.external_id, message_text]),
                    direction=(
                        "inbound" if _integer(item.get("unread_count"), 0) > 0 else "system"
                    ),
                    content=message_text,
                    raw=raw,
                )
            ]
        conversations.append(envelope)
    return ExtractionBatch(conversations=conversations, endpoint_hits=["dom"])


def merge_batches(batches: Iterable[ExtractionBatch]) -> ExtractionBatch:
    conversations: dict[str, ConversationEnvelope] = {}
    message_ids: dict[str, set[str]] = defaultdict(set)
    endpoint_hits: set[str] = set()

    for batch in batches:
        endpoint_hits.update(batch.endpoint_hits)
        for incoming in batch.conversations:
            current = conversations.get(incoming.external_id)
            if current is None:
                current = ConversationEnvelope(
                    external_id=incoming.external_id,
                    shop_external_id=incoming.shop_external_id,
                    shop_name=incoming.shop_name,
                    customer_external_id=incoming.customer_external_id,
                    customer_name=incoming.customer_name,
                    platform=incoming.platform,
                    region=incoming.region,
                    unread_count=incoming.unread_count,
                    last_message_at=incoming.last_message_at,
                    raw=incoming.raw,
                )
                conversations[incoming.external_id] = current
            else:
                current.shop_external_id = incoming.shop_external_id or current.shop_external_id
                current.shop_name = incoming.shop_name or current.shop_name
                current.customer_external_id = (
                    incoming.customer_external_id or current.customer_external_id
                )
                current.customer_name = incoming.customer_name or current.customer_name
                current.platform = incoming.platform or current.platform
                current.region = incoming.region or current.region
                current.unread_count = max(current.unread_count, incoming.unread_count)
                current.last_message_at = incoming.last_message_at or current.last_message_at
                if incoming.raw:
                    current.raw = incoming.raw

            known = message_ids[incoming.external_id]
            for message in incoming.messages:
                if message.external_id not in known:
                    known.add(message.external_id)
                    current.messages.append(message)

    return ExtractionBatch(
        conversations=list(conversations.values()), endpoint_hits=sorted(endpoint_hits)
    )

