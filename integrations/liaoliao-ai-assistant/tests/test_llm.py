import json

import httpx

from app.db import Database
from app.llm import OpenAICompatibleLLM, SuggestionService
from app.knowledge import KnowledgeBase
from app.models import ConversationEnvelope, ExtractionBatch, MessageEnvelope
from app.repository import Repository


async def test_openai_compatible_suggestion_is_saved(settings_factory):
    settings = settings_factory()
    repository = Repository(Database(settings.database_path))
    repository.initialize()
    repository.upsert_batch(
        ExtractionBatch(
            conversations=[
                ConversationEnvelope(
                    external_id="conv",
                    shop_external_id="shop",
                    shop_name="Shop",
                    customer_external_id="buyer",
                    customer_name="Buyer",
                    messages=[
                        MessageEnvelope(
                            external_id="msg",
                            direction="inbound",
                            content="Can I change the color?",
                        )
                    ],
                )
            ]
        )
    )
    item = repository.list_work_items()[0]
    repository.save_context_snapshot(
        int(item["message_id"]),
        {"right_panel_text": "物流状态：包裹已由承运商揽收\n商品 SKU：BLUE-M"},
        "https://mai.zhisuitech.com/#/workbench/conversation",
    )
    settings.knowledge_dir.mkdir(parents=True, exist_ok=True)
    (settings.knowledge_dir / "global.md").write_text(
        "不得承诺未确认的送达日期。", encoding="utf-8"
    )
    (settings.knowledge_dir / "shops.json").write_text(
        json.dumps({"Shop": "换色请求必须先确认库存。"}), encoding="utf-8"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-key"
        payload = json.loads(request.content)
        assert payload["model"] == "test-model"
        prompt = payload["messages"][1]["content"]
        assert "包裹已由承运商揽收" in prompt
        assert "不得承诺未确认的送达日期" in prompt
        assert "换色请求必须先确认库存" in prompt
        return httpx.Response(
            200,
            json={
                "choices": [
                    {"message": {"content": "Yes—please share your preferred color and I’ll check availability."}}
                ]
            },
        )

    llm = OpenAICompatibleLLM(settings, transport=httpx.MockTransport(handler))
    service = SuggestionService(
        repository, llm, settings, KnowledgeBase(settings.knowledge_dir)
    )
    assert await service.generate_pending() == 1
    item = repository.list_work_items()[0]
    assert item["suggestion_status"] == "ready"
    assert "preferred color" in item["ai_reply"]
