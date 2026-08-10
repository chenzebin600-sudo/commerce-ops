from __future__ import annotations

import hashlib
import json
import logging
from datetime import UTC, datetime
from typing import Any

import httpx

from .config import Settings
from .models import ExtractionBatch


def _iso(value: str | None) -> str:
    if value:
        normalized = value.strip()
        if normalized:
            try:
                return datetime.fromisoformat(normalized.replace("Z", "+00:00")).astimezone(UTC).isoformat().replace("+00:00", "Z")
            except ValueError:
                pass
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _event_identity(account_id: str, conversation_id: str, message_id: str) -> tuple[str, int]:
    source = f"{account_id}\n{conversation_id}\n{message_id}".encode("utf-8")
    digest = hashlib.sha256(source).hexdigest()
    return f"liaoliao-message:{digest}", int(digest[:13], 16)


def _panel_event_identity(
    account_id: str,
    conversation_id: str,
    message_id: str,
    panel: dict[str, Any],
) -> tuple[str, int]:
    canonical = json.dumps(panel, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    source = f"panel\n{account_id}\n{conversation_id}\n{message_id}\n{canonical}".encode("utf-8")
    digest = hashlib.sha256(source).hexdigest()
    return f"liaoliao-panel:{digest}", int(digest[:13], 16)


class CentralControlPlaneClient:
    """Safety-scoped bridge from the local Playwright edge to Commerce Ops.

    Login credentials and Playwright storage state never leave the edge machine. Only
    normalized observations are sent, and the central service encrypts message bodies
    before persistence. Observation publishing can recover from a temporary central
    outage, while assisted browser startup fails closed unless this worker owns the
    central account's primary lease.
    """

    def __init__(
        self,
        settings: Settings,
        logger: logging.Logger | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.settings = settings
        self.logger = logger or logging.getLogger("liaoliao.central")
        self.transport = transport
        self._registered = False
        self._lease_token: str | None = None
        self._lease_expires_at: float = 0

    @property
    def enabled(self) -> bool:
        return self.settings.central_enabled

    @property
    def headers(self) -> dict[str, str]:
        headers = {
            "authorization": f"Bearer {self.settings.central_worker_token}",
            "x-cs-worker-id": str(self.settings.central_worker_id),
            "x-cs-account-id": str(self.settings.central_account_id),
            "content-type": "application/json",
        }
        if self._lease_token:
            headers["x-cs-account-lease"] = self._lease_token
        return headers

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        async with httpx.AsyncClient(
            base_url=str(self.settings.central_api_url),
            timeout=self.settings.central_timeout_seconds,
            transport=self.transport,
            headers=self.headers,
        ) as client:
            response = await client.request(method, path, **kwargs)
            response.raise_for_status()
            return response

    async def _ensure_registered(self) -> None:
        if self._registered:
            return
        await self._request(
            "POST",
            "/api/internal/customer-service/workers/register",
            json={
                "displayName": str(self.settings.central_worker_id),
                "version": "liaoliao-ai-assistant/0.4.0",
                "capabilities": ["observe_messages", "capture_panel", "fill_draft"],
                "metadata": {"integration": "playwright"},
            },
        )
        self._registered = True

    async def _ensure_account_lease(self) -> None:
        if not self.enabled:
            return
        now = datetime.now(UTC).timestamp()
        if self._lease_token and self._lease_expires_at > now + 30:
            return
        body = {"leaseToken": self._lease_token} if self._lease_token else {}
        response = await self._request(
            "POST",
            f"/api/internal/customer-service/accounts/{self.settings.central_account_id}/lease",
            json=body,
        )
        lease = response.json().get("lease")
        if not isinstance(lease, dict) or not str(lease.get("leaseToken") or "").strip():
            raise RuntimeError("Commerce Ops returned an invalid LiaoLiao account lease")
        expires_at = datetime.fromisoformat(
            str(lease.get("leasedUntil") or "").replace("Z", "+00:00")
        ).timestamp()
        self._lease_token = str(lease["leaseToken"])
        self._lease_expires_at = expires_at

    async def ensure_ready(self) -> None:
        if not self.enabled:
            return
        await self._ensure_registered()
        await self._ensure_account_lease()

    async def release_account_lease(self) -> bool:
        if not self.enabled or not self._lease_token:
            return False
        try:
            response = await self._request(
                "DELETE",
                f"/api/internal/customer-service/accounts/{self.settings.central_account_id}/lease",
            )
            return bool(response.json().get("released"))
        except Exception as exc:
            self.logger.warning("central.lease_release failed error_type=%s", type(exc).__name__)
            return False
        finally:
            self._lease_token = None
            self._lease_expires_at = 0

    def events_for(self, batch: ExtractionBatch) -> list[dict[str, Any]]:
        account_id = str(self.settings.central_account_id)
        events: list[dict[str, Any]] = []
        for conversation in batch.conversations:
            for message in conversation.messages:
                event_id, sequence_no = _event_identity(
                    account_id, conversation.external_id, message.external_id
                )
                observed_at = _iso(message.sent_at or conversation.last_message_at)
                events.append(
                    {
                        "eventId": event_id,
                        "sequenceNo": sequence_no,
                        "accountId": account_id,
                        "observedAt": observed_at,
                        "eventType": "MESSAGE_OBSERVED",
                        "shop": {
                            "externalId": conversation.shop_external_id,
                            "name": conversation.shop_name or "未识别店铺",
                            "countryCode": conversation.region,
                        },
                        "conversation": {
                            "externalId": conversation.external_id,
                            "customerExternalId": conversation.customer_external_id,
                            "customerDisplayName": conversation.customer_name or "Unknown customer",
                            "priority": "NORMAL",
                        },
                        "message": {
                            "externalId": message.external_id,
                            "direction": message.direction.upper(),
                            "contentType": message.message_type.upper(),
                            "content": message.content,
                            "sentAt": observed_at,
                        },
                        "observation": {
                            "unread": conversation.unread_count > 0,
                            "domVersion": "liaoliao-web-observation-v1",
                        },
                    }
                )
        return events

    async def publish_batch(self, batch: ExtractionBatch) -> dict[str, Any]:
        if not self.enabled:
            return {"enabled": False, "accepted": 0, "rejected": 0}
        events = self.events_for(batch)
        if not events:
            return {"enabled": True, "accepted": 0, "rejected": 0}
        try:
            await self.ensure_ready()
            response = await self._request(
                "POST",
                "/api/internal/customer-service/events/batch",
                json={"events": events},
            )
            payload = response.json()
            result = {
                "enabled": True,
                "accepted": int(payload.get("accepted") or 0),
                "rejected": int(payload.get("rejected") or 0),
            }
            self.logger.info(
                "central.publish completed accepted=%s rejected=%s",
                result["accepted"],
                result["rejected"],
            )
            return result
        except Exception as exc:  # Local collection must continue during control-plane outages.
            self._registered = False
            self.logger.warning("central.publish failed error_type=%s", type(exc).__name__)
            return {
                "enabled": True,
                "accepted": 0,
                "rejected": len(events),
                "error": type(exc).__name__,
            }

    async def publish_context(
        self,
        item: dict[str, Any],
        operational_context: dict[str, Any],
    ) -> dict[str, Any]:
        """Publish a right-panel observation for an already observed message.

        The central control plane encrypts the payload. Credentials, cookies and
        Playwright storage state are never included.
        """

        if not self.enabled:
            return {"enabled": False, "accepted": 0, "rejected": 0}
        account_id = str(self.settings.central_account_id)
        conversation_id = str(item.get("conversation_external_id") or "").strip()
        message_id = str(item.get("message_external_id") or "").strip()
        if not conversation_id or not message_id:
            return {"enabled": True, "accepted": 0, "rejected": 1, "error": "MissingIdentity"}
        structured = operational_context.get("structured")
        if not isinstance(structured, dict):
            structured = {}
        panel = {
            "source": "LIAOLIAO_RIGHT_PANEL",
            "rawText": str(operational_context.get("right_panel_text") or "")[:20_000],
            "structured": structured,
            "order": {
                "references": list(structured.get("order_refs") or [])[:5],
                "observedLines": list((structured.get("sections") or {}).get("order") or [])[:30],
            },
            "logistics": {
                "observedLines": list((structured.get("sections") or {}).get("logistics") or [])[:30],
            },
            "product": {
                "skus": list(structured.get("skus") or [])[:10],
                "observedLines": list((structured.get("sections") or {}).get("product") or [])[:30],
            },
            "afterSales": {
                "observedLines": list((structured.get("sections") or {}).get("after_sales") or [])[:30],
            },
        }
        event_id, sequence_no = _panel_event_identity(account_id, conversation_id, message_id, panel)
        observed_at = _iso(None)
        event = {
            "eventId": event_id,
            "sequenceNo": sequence_no,
            "accountId": account_id,
            "observedAt": observed_at,
            "eventType": "PANEL_OBSERVED",
            "shop": {
                "externalId": str(item.get("shop_external_id") or "").strip(),
                "name": str(item.get("shop_name") or "Unknown shop"),
                "countryCode": item.get("region"),
            },
            "conversation": {
                "externalId": conversation_id,
                "customerExternalId": str(item.get("customer_external_id") or item.get("customer_name") or "Unknown customer"),
                "customerDisplayName": str(item.get("customer_name") or "Unknown customer"),
                "priority": "NORMAL",
            },
            "message": {
                "externalId": message_id,
                "direction": "INBOUND",
                "contentType": "TEXT",
                "content": str(item.get("content") or ""),
                "sentAt": _iso(item.get("sent_at")),
            },
            "observation": {"unread": True, "domVersion": "liaoliao-web-panel-v1"},
            "panelSnapshot": panel,
        }
        try:
            await self.ensure_ready()
            response = await self._request(
                "POST",
                "/api/internal/customer-service/events/batch",
                json={"events": [event]},
            )
            payload = response.json()
            return {
                "enabled": True,
                "accepted": int(payload.get("accepted") or 0),
                "rejected": int(payload.get("rejected") or 0),
            }
        except Exception as exc:
            self._registered = False
            self.logger.warning("central.publish_context failed error_type=%s", type(exc).__name__)
            return {"enabled": True, "accepted": 0, "rejected": 1, "error": type(exc).__name__}

    async def pull_commands(self, limit: int = 10) -> list[dict[str, Any]]:
        if not self.enabled:
            return []
        try:
            await self.ensure_ready()
            await self._request(
                "POST",
                "/api/internal/customer-service/workers/heartbeat",
                json={
                    "status": "ONLINE",
                    "version": "liaoliao-ai-assistant/0.5.0",
                    "capabilities": ["observe_messages", "capture_panel", "fill_draft"],
                    "metadata": {"activeAccounts": 1, "openPages": 1},
                },
            )
            response = await self._request(
                "GET",
                f"/api/internal/customer-service/commands/pull?limit={max(1, min(limit, 20))}",
            )
            payload = response.json()
            commands = payload.get("commands")
            return commands if isinstance(commands, list) else []
        except Exception as exc:
            self._registered = False
            self.logger.warning("central.commands_pull failed error_type=%s", type(exc).__name__)
            return []

    async def complete_command(
        self,
        command_id: str,
        *,
        succeeded: bool,
        result_code: str,
        editor_matched: bool = False,
        conversation_matched: bool = False,
        draft_content_digest: str | None = None,
    ) -> bool:
        if not self.enabled:
            return False
        try:
            await self.ensure_ready()
            await self._request(
                "POST",
                f"/api/internal/customer-service/commands/{command_id}/result",
                json={
                    "succeeded": succeeded,
                    "resultCode": result_code[:120],
                    "result": {
                        "editorMatched": editor_matched,
                        "conversationMatched": conversation_matched,
                        "draftContentDigest": (
                            str(draft_content_digest or "").strip().lower() or None
                        ),
                    },
                },
            )
            return True
        except Exception as exc:
            self._registered = False
            self.logger.warning(
                "central.command_result failed command_id=%s error_type=%s",
                command_id,
                type(exc).__name__,
            )
            return False
