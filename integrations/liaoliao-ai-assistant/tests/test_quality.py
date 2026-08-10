import json

import httpx

from app.llm import OpenAICompatibleLLM
from app.quality import (
    detect_intent,
    deterministic_quality_issues,
    structure_operational_context,
)


def test_structures_operational_context_and_detects_risk_intent():
    context = structure_operational_context(
        "订单号: PH12345678\n物流状态: Parcel picked up\nSKU: BLUE-M\n商品: Travel bag"
    )

    assert context["available"] is True
    assert context["order_refs"] == ["PH12345678"]
    assert context["skus"] == ["BLUE-M"]
    assert "logistics" in context["sections"]
    assert detect_intent("I want a refund for the wrong item") == "refund"
    assert "unsupported_resource_promise" in deterministic_quality_issues(
        "I'll send you the link in the next message.",
        intent="product",
        operational_context_available=False,
        knowledge_available=False,
    )


async def test_two_stage_quality_review_revises_risky_draft(settings_factory):
    settings = settings_factory(quality_review_enabled=True)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            content = {
                "intent": "refund",
                "risk_level": "high",
                "language": "English",
                "facts_used": [],
                "missing_facts": ["refund eligibility"],
                "reply": "We have refunded you already.",
            }
        else:
            content = {
                "approved": False,
                "risk_level": "high",
                "issues": ["unsupported_refund_claim"],
                "revised_reply": "I’m sorry about this. Let me verify the order and refund eligibility first.",
            }
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": json.dumps(content)}}]},
        )

    llm = OpenAICompatibleLLM(settings, transport=httpx.MockTransport(handler))
    result = await llm.generate(
        {
            "message_id": 1,
            "shop_name": "Shop",
            "platform": "Shopee",
            "region": "PH",
            "content": "Where is my refund?",
            "intent_hint": "refund",
            "risk_hint": "high",
            "operational_context": {"available": False},
            "knowledge_context": {"sections": [], "examples": []},
        },
        [{"direction": "inbound", "content": "Where is my refund?"}],
    )

    assert len(calls) == 2
    assert result.risk_level == "high"
    assert result.quality_status == "needs_review"
    assert "verify the order" in result.content
    assert "unsupported_refund_claim" in result.quality_issues
