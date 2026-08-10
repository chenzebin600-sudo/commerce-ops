from app.extraction import merge_batches, parse_network_payload


def test_parses_conversation_list_and_inbound_preview():
    payload = {
        "data": {
            "data": {
                "talkInfo": [
                    {
                        "talk": {
                            "conversationId": "conv-1",
                            "storeId": "shop-1",
                            "storeName": "PH Shop",
                            "buyerId": "buyer-1",
                            "buyerNick": "Maria",
                            "channel": "SHOPEE",
                            "region": "PH",
                            "unreadCount": 2,
                            "msgId": "msg-preview",
                            "msgFromType": "BUYER",
                            "textContent": "Do you have size M?",
                            "sendTime": 1_786_000_000_000,
                        }
                    }
                ]
            }
        }
    }
    batch = parse_network_payload(
        "https://api.example/aggregation/v1/advanceQueryConversationList", payload
    )
    assert len(batch.conversations) == 1
    conversation = batch.conversations[0]
    assert conversation.shop_name == "PH Shop"
    assert conversation.customer_name == "Maria"
    assert conversation.unread_count == 2
    assert conversation.messages[0].direction == "inbound"


def test_merges_message_detail_into_conversation():
    list_payload = {
        "data": {
            "talkInfo": [
                {
                    "talk": {
                        "conversationId": "conv-2",
                        "storeId": "shop-2",
                        "buyerId": "buyer-2",
                        "buyerNick": "Ana",
                        "unreadCount": 1,
                    }
                }
            ]
        }
    }
    list_batch = parse_network_payload(
        "https://api.example/aggregation/v1/advanceQueryConversationList", list_payload
    )
    hint = list_batch.conversations[0]
    detail_payload = {
        "data": {
            "data": {
                "message": [
                    {
                        "conversationId": "conv-2",
                        "msgId": "msg-2",
                        "msgFromType": "BUYER",
                        "textContent": "Where is my order?",
                    },
                    {
                        "conversationId": "conv-2",
                        "msgId": "msg-3",
                        "msgFromType": "SELLER",
                        "textContent": "Let me check that for you.",
                    },
                ]
            }
        }
    }
    detail_batch = parse_network_payload(
        "https://api.example/aggregation/v1/queryConversation",
        detail_payload,
        conversation_hint=hint,
    )
    merged = merge_batches([list_batch, detail_batch, detail_batch])
    assert len(merged.conversations) == 1
    assert [item.external_id for item in merged.conversations[0].messages] == [
        "msg-2",
        "msg-3",
    ]

