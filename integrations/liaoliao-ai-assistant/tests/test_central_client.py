from __future__ import annotations

import httpx
import pytest

from app.central_client import CentralControlPlaneClient
from app.models import ConversationEnvelope, ExtractionBatch, MessageEnvelope


def sample_batch() -> ExtractionBatch:
    return ExtractionBatch(
        conversations=[
            ConversationEnvelope(
                external_id="conversation-1",
                shop_external_id="shop-th-1",
                shop_name="Thailand Home",
                customer_external_id="buyer-1",
                customer_name="Buyer One",
                region="TH",
                unread_count=1,
                messages=[
                    MessageEnvelope(
                        external_id="message-1",
                        direction="inbound",
                        content="Where is my order?",
                        sent_at="2026-08-08T12:00:00Z",
                    )
                ],
            )
        ]
    )


@pytest.mark.asyncio
async def test_central_client_registers_and_publishes_normalized_observations(settings_factory):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/workers/register"):
            return httpx.Response(200, json={"ok": True, "worker": {"id": "worker-test"}})
        if request.url.path.endswith("/lease"):
            return httpx.Response(200, json={"ok": True, "lease": {
                "workerId": "worker-test",
                "leasedUntil": "2099-08-08T12:01:30Z",
                "leaseToken": "lease-token-1",
            }})
        return httpx.Response(200, json={"ok": True, "accepted": 1, "rejected": 0})

    settings = settings_factory(
        central_api_url="http://commerce-ops.test",
        central_account_id="central-account-1",
        central_worker_id="worker-test",
        central_worker_token="worker-secret-token",
    )
    client = CentralControlPlaneClient(settings, transport=httpx.MockTransport(handler))
    result = await client.publish_batch(sample_batch())

    assert result == {"enabled": True, "accepted": 1, "rejected": 0}
    assert [request.url.path for request in requests] == [
        "/api/internal/customer-service/workers/register",
        "/api/internal/customer-service/accounts/central-account-1/lease",
        "/api/internal/customer-service/events/batch",
    ]
    assert all(request.headers["x-cs-worker-id"] == "worker-test" for request in requests)
    assert all(request.headers["authorization"] == "Bearer worker-secret-token" for request in requests)
    assert requests[-1].headers["x-cs-account-lease"] == "lease-token-1"
    payload = __import__("json").loads(requests[-1].content)
    event = payload["events"][0]
    assert event["accountId"] == "central-account-1"
    assert event["conversation"]["externalId"] == "conversation-1"
    assert event["message"]["content"] == "Where is my order?"
    assert event["message"]["direction"] == "INBOUND"
    assert isinstance(event["sequenceNo"], int)


@pytest.mark.asyncio
async def test_central_client_is_idempotent_for_the_same_message(settings_factory):
    settings = settings_factory(
        central_api_url="http://commerce-ops.test",
        central_account_id="central-account-1",
        central_worker_id="worker-test",
        central_worker_token="worker-secret-token",
    )
    client = CentralControlPlaneClient(settings)
    first = client.events_for(sample_batch())[0]
    second = client.events_for(sample_batch())[0]
    assert first["eventId"] == second["eventId"]
    assert first["sequenceNo"] == second["sequenceNo"]


@pytest.mark.asyncio
async def test_central_client_fails_before_browser_use_when_another_worker_owns_the_account(settings_factory):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/workers/register"):
            return httpx.Response(200, json={"ok": True})
        return httpx.Response(409, json={"ok": False, "code": "CS_ACCOUNT_LEASE_CONFLICT"})

    settings = settings_factory(
        central_api_url="http://commerce-ops.test",
        central_account_id="central-account-1",
        central_worker_id="worker-test",
        central_worker_token="worker-secret-token",
    )
    client = CentralControlPlaneClient(settings, transport=httpx.MockTransport(handler))

    with pytest.raises(httpx.HTTPStatusError):
        await client.ensure_ready()

    assert [request.url.path for request in requests] == [
        "/api/internal/customer-service/workers/register",
        "/api/internal/customer-service/accounts/central-account-1/lease",
    ]


@pytest.mark.asyncio
async def test_central_outage_does_not_stop_local_collection(settings_factory):
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"ok": False})

    settings = settings_factory(
        central_api_url="http://commerce-ops.test",
        central_account_id="central-account-1",
        central_worker_id="worker-test",
        central_worker_token="worker-secret-token",
    )
    client = CentralControlPlaneClient(settings, transport=httpx.MockTransport(handler))
    result = await client.publish_batch(sample_batch())
    assert result["enabled"] is True
    assert result["accepted"] == 0
    assert result["rejected"] == 1
    assert result["error"] == "HTTPStatusError"


@pytest.mark.asyncio
async def test_central_client_publishes_structured_right_panel_as_separate_idempotent_event(settings_factory):
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/workers/register"):
            return httpx.Response(200, json={"ok": True, "worker": {"id": "worker-test"}})
        if request.url.path.endswith("/lease"):
            return httpx.Response(200, json={"ok": True, "lease": {
                "workerId": "worker-test",
                "leasedUntil": "2099-08-08T12:01:30Z",
                "leaseToken": "lease-token-1",
            }})
        return httpx.Response(200, json={"ok": True, "accepted": 1, "rejected": 0})

    settings = settings_factory(
        central_api_url="http://commerce-ops.test",
        central_account_id="central-account-1",
        central_worker_id="worker-test",
        central_worker_token="worker-secret-token",
    )
    client = CentralControlPlaneClient(settings, transport=httpx.MockTransport(handler))
    item = {
        "conversation_external_id": "conversation-1",
        "message_external_id": "message-1",
        "shop_external_id": "shop-th-1",
        "shop_name": "Thailand Home",
        "region": "TH",
        "customer_external_id": "buyer-1",
        "customer_name": "Buyer One",
        "content": "Where is my order?",
        "sent_at": "2026-08-08T12:00:00Z",
    }
    context = {
        "right_panel_text": "Order ID: ORDER-1\nSKU: T3AA1234567",
        "structured": {
            "order_refs": ["ORDER-1"],
            "skus": ["T3AA1234567"],
            "sections": {"order": ["Order ID: ORDER-1"], "product": ["SKU: T3AA1234567"]},
        },
    }
    result = await client.publish_context(item, context)

    assert result == {"enabled": True, "accepted": 1, "rejected": 0}
    payload = __import__("json").loads(requests[-1].content)
    event = payload["events"][0]
    assert event["eventType"] == "PANEL_OBSERVED"
    assert event["message"]["externalId"] == "message-1"
    assert event["panelSnapshot"]["product"]["skus"] == ["T3AA1234567"]
    assert event["panelSnapshot"]["order"]["references"] == ["ORDER-1"]
    assert "storage" not in __import__("json").dumps(event).lower()


@pytest.mark.asyncio
async def test_central_client_pulls_fill_only_commands_and_reports_no_send_result(settings_factory):
    requests: list[httpx.Request] = []
    command = {
        "id": "command-1",
        "commandType": "FILL_DRAFT",
        "payload": {
            "contractVersion": "CS_FILL_DRAFT_V1",
            "route": {
                "externalConversationId": "conversation-1",
                "externalMessageId": "message-1",
            },
            "draft": "I am checking this for you.",
            "safety": {"automaticSend": False},
        },
    }

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/workers/register"):
            return httpx.Response(200, json={"ok": True, "worker": {"id": "worker-test"}})
        if request.url.path.endswith("/lease"):
            return httpx.Response(200, json={"ok": True, "lease": {
                "workerId": "worker-test",
                "leasedUntil": "2099-08-08T12:01:30Z",
                "leaseToken": "lease-token-1",
            }})
        if request.url.path.endswith("/commands/pull"):
            return httpx.Response(200, json={"ok": True, "commands": [command]})
        return httpx.Response(200, json={"ok": True})

    settings = settings_factory(
        central_api_url="http://commerce-ops.test",
        central_account_id="central-account-1",
        central_worker_id="worker-test",
        central_worker_token="worker-secret-token",
    )
    client = CentralControlPlaneClient(settings, transport=httpx.MockTransport(handler))
    commands = await client.pull_commands()
    reported = await client.complete_command(
        "command-1",
        succeeded=True,
        result_code="DRAFT_FILLED_NO_SEND",
        editor_matched=True,
        conversation_matched=True,
        draft_content_digest="a" * 64,
    )

    assert commands == [command]
    assert reported is True
    assert [request.url.path for request in requests] == [
        "/api/internal/customer-service/workers/register",
        "/api/internal/customer-service/accounts/central-account-1/lease",
        "/api/internal/customer-service/workers/heartbeat",
        "/api/internal/customer-service/commands/pull",
        "/api/internal/customer-service/commands/command-1/result",
    ]
    result_payload = __import__("json").loads(requests[-1].content)
    assert result_payload["resultCode"] == "DRAFT_FILLED_NO_SEND"
    assert result_payload["result"]["editorMatched"] is True
    assert result_payload["result"]["draftContentDigest"] == "a" * 64
