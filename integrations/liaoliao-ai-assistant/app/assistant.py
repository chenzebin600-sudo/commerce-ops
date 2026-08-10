from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

from playwright.async_api import Page

from .browser import (
    BrowserCollector,
    ReplyEditorBusy,
    ReplyEditorNotFound,
    SendButtonNotFound,
    SendResultUnknown,
)
from .central_client import CentralControlPlaneClient
from .command_contract import CommandContractError, validate_fill_draft_command
from .extraction import batch_from_dom, merge_batches, parse_network_payload
from .llm import SuggestionService
from .models import ConversationEnvelope, ExtractionBatch
from .repository import Repository


CapturedResponse = tuple[str, Any, ConversationEnvelope | None]


class ReplyAssistant:
    """持久排队生成草稿；只有明确的人工批准动作才能触发发送。"""

    def __init__(
        self,
        repository: Repository,
        collector: BrowserCollector,
        suggestions: SuggestionService,
        logger: logging.Logger | None = None,
        central: CentralControlPlaneClient | None = None,
    ):
        self.repository = repository
        self.collector = collector
        self.suggestions = suggestions
        self.logger = logger or logging.getLogger("liaoliao.assistant")
        self.central = central

    async def _persist_batch(self, batch: ExtractionBatch) -> None:
        self.repository.upsert_batch(batch)
        if self.central is not None:
            await self.central.publish_batch(batch)

    @staticmethod
    async def _drain(tasks: set[asyncio.Task[None]]) -> None:
        if tasks:
            await asyncio.gather(*list(tasks), return_exceptions=True)

    async def _consume_captured(
        self,
        captured: list[CapturedResponse],
        response_tasks: set[asyncio.Task[None]],
    ) -> ExtractionBatch:
        await self._drain(response_tasks)
        snapshot = list(captured)
        captured.clear()
        if not snapshot:
            return ExtractionBatch()
        batch = merge_batches(
            [
                parse_network_payload(url, payload, conversation_hint=hint)
                for url, payload, hint in snapshot
            ]
        )
        await self._persist_batch(batch)
        recorded = self.repository.record_observed_outbound_feedback(batch)
        if recorded:
            self.logger.info("feedback.observed_outbound recorded=%s", recorded)
        return batch

    async def _open_conversation(
        self,
        page: Page,
        conversation: ConversationEnvelope,
        captured: list[CapturedResponse],
        response_tasks: set[asyncio.Task[None]],
    ) -> ExtractionBatch:
        if not await self.collector._click_conversation(page, conversation):
            return ExtractionBatch()
        await page.wait_for_timeout(self.collector.settings.settle_milliseconds)
        await self.collector._dismiss_startup_overlays(page)
        network = await self._consume_captured(captured, response_tasks)
        dom_messages = await self.collector._extract_dom_messages(page, conversation)
        batches = [network]
        if dom_messages:
            batches.append(
                ExtractionBatch(
                    conversations=[dom_messages], endpoint_hits=["dom-message"]
                )
            )
        result = merge_batches(batches)
        await self._persist_batch(result)
        return result

    @staticmethod
    def _conversation_from_item(item: dict[str, Any]) -> ConversationEnvelope:
        external_id = str(item["conversation_external_id"])
        return ConversationEnvelope(
            external_id=external_id,
            shop_external_id=f"queued-shop:{external_id}",
            shop_name=str(item["shop_name"]),
            customer_external_id=f"queued-customer:{external_id}",
            customer_name=str(item["customer_name"]),
            platform=item.get("platform"),
            region=item.get("region"),
            unread_count=1,
        )

    async def _stage_task(self, page: Page, item: dict[str, Any]) -> bool:
        """向当前会话写入一份草稿后立即返回，不等待人工发送。"""

        message_id = int(item["message_id"])
        context = await self.collector.extract_operational_context(page)
        snapshot_id = self.repository.save_context_snapshot(
            message_id, context, page.url
        )
        if self.central is not None:
            central_result = await self.central.publish_context(item, context)
            if self.central.enabled:
                if int(central_result.get("accepted") or 0) > 0:
                    self.repository.set_assistant_task_status(
                        message_id, "generating", context_snapshot_id=snapshot_id
                    )
                    self.repository.audit(
                        "suggestion.delegated_to_central",
                        "message",
                        str(message_id),
                        "browser-assistant",
                        {"context_snapshot_id": snapshot_id},
                    )
                    return True
                self.repository.set_assistant_task_status(
                    message_id,
                    "blocked_draft",
                    error="Commerce Ops 中央 Context 暂未接收，稍后重试",
                    context_snapshot_id=snapshot_id,
                    retry_after_seconds=10,
                )
                return False

        if item.get("task_status") != "ready":
            self.repository.set_assistant_task_status(
                message_id,
                "generating",
                context_snapshot_id=snapshot_id,
            )
            if not await self.suggestions.generate_for_message(message_id, force=True):
                self.repository.set_assistant_task_status(
                    message_id,
                    "error",
                    error="AI 建议生成失败或任务已被其他进程占用",
                    context_snapshot_id=snapshot_id,
                )
                print(
                    f"AI 生成失败：{item['customer_name']}，详情见 logs/liaoliao.log",
                    flush=True,
                )
                return False
            self.repository.set_assistant_task_status(
                message_id, "ready", context_snapshot_id=snapshot_id
            )
            refreshed = self.repository.assistant_task_for_conversation(
                str(item["conversation_external_id"])
            )
            if refreshed is None:
                return False
            item = refreshed

        suggestion = str(item.get("ai_reply") or "").strip()
        if not suggestion:
            self.repository.set_assistant_task_status(
                message_id, "error", error="AI 建议为空"
            )
            return False

        try:
            await self.collector.fill_reply_editor(page, suggestion)
        except ReplyEditorNotFound as exc:
            self.repository.set_assistant_task_status(
                message_id,
                "blocked_draft",
                error=str(exc),
                context_snapshot_id=snapshot_id,
                retry_after_seconds=60,
            )
            self.repository.audit(
                "suggestion.fill_skipped_editor_missing",
                "message",
                str(message_id),
                "browser-assistant",
                {},
            )
            self.logger.warning(
                "suggestion.fill_editor_missing message_id=%s conversation=%s",
                message_id,
                item["conversation_external_id"],
            )
            return False
        except ReplyEditorBusy:
            self.repository.set_assistant_task_status(
                message_id,
                "blocked_draft",
                error="当前会话已有人工或 AI 草稿",
                context_snapshot_id=snapshot_id,
                retry_after_seconds=60,
            )
            self.repository.audit(
                "suggestion.fill_skipped_busy",
                "message",
                str(message_id),
                "browser-assistant",
                {},
            )
            print(
                f"已暂缓 {item['customer_name']}：该会话已有草稿，继续处理其他会话。",
                flush=True,
            )
            return False
        except Exception as exc:
            self.repository.set_assistant_task_status(
                message_id,
                "error",
                error=str(exc)[:500],
                context_snapshot_id=snapshot_id,
            )
            self.logger.exception("suggestion.fill_failed message_id=%s", message_id)
            return False

        self.repository.set_assistant_task_status(
            message_id, "filled", context_snapshot_id=snapshot_id
        )
        self.repository.audit(
            "suggestion.filled",
            "message",
            str(message_id),
            "browser-assistant",
            {
                "conversation_external_id": item["conversation_external_id"],
                "context_snapshot_id": snapshot_id,
            },
        )
        self.logger.info(
            "suggestion.filled message_id=%s conversation=%s context_snapshot=%s",
            message_id,
            item["conversation_external_id"],
            snapshot_id,
        )
        print(
            f"已把 AI 建议填入【{item['shop_name']} / {item['customer_name']}】，"
            "正在切换到下一条；发送仍由人工确认。",
            flush=True,
        )
        return True

    async def _execute_central_command(
        self,
        page: Page,
        command: dict[str, Any],
        captured: list[CapturedResponse],
        response_tasks: set[asyncio.Task[None]],
    ) -> None:
        if self.central is None:
            return
        command_id = str(command.get("id") or "")
        try:
            validated = validate_fill_draft_command(
                command,
                expected_account_id=str(self.central.settings.central_account_id),
            )
        except CommandContractError as exc:
            if command_id:
                await self.central.complete_command(
                    command_id,
                    succeeded=False,
                    result_code=exc.code,
                )
            return
        route = validated.route
        draft = validated.draft
        external_conversation_id = validated.external_conversation_id
        expected_message_id = validated.external_message_id
        conversation = ConversationEnvelope(
            external_id=external_conversation_id,
            shop_external_id=str(route.get("shopExternalId") or f"central-shop:{external_conversation_id}"),
            shop_name=str(route.get("shopName") or ""),
            customer_external_id=str(route.get("customerExternalId") or f"central-customer:{external_conversation_id}"),
            customer_name=str(route.get("customerDisplayName") or ""),
            unread_count=1,
        )
        if not await self.collector._click_conversation(page, conversation):
            await self.central.complete_command(
                command_id,
                succeeded=False,
                result_code="CONVERSATION_NOT_UNIQUELY_LOCATED",
            )
            return
        await page.wait_for_timeout(self.collector.settings.settle_milliseconds)
        await self.collector._dismiss_startup_overlays(page)
        network = await self._consume_captured(captured, response_tasks)
        dom_messages = await self.collector._extract_dom_messages(page, conversation)
        batches = [network]
        if dom_messages:
            batches.append(ExtractionBatch(conversations=[dom_messages], endpoint_hits=["dom-message"]))
        await self._persist_batch(merge_batches(batches))
        latest_message_id = self.repository.latest_inbound_external_message_id(
            external_conversation_id
        )
        if latest_message_id != expected_message_id:
            await self.central.complete_command(
                command_id,
                succeeded=False,
                result_code="LATEST_INBOUND_MISMATCH",
                conversation_matched=True,
            )
            return
        try:
            await self.collector.fill_reply_editor(
                page, draft, allow_existing_same=True
            )
        except ReplyEditorNotFound:
            await self.central.complete_command(
                command_id,
                succeeded=False,
                result_code="REPLY_EDITOR_NOT_FOUND",
                conversation_matched=True,
            )
            return
        except ReplyEditorBusy:
            await self.central.complete_command(
                command_id,
                succeeded=False,
                result_code="REPLY_EDITOR_BUSY",
                conversation_matched=True,
            )
            return
        except Exception:
            self.logger.exception("central.fill_failed command_id=%s", command_id)
            await self.central.complete_command(
                command_id,
                succeeded=False,
                result_code="FILL_DRAFT_FAILED",
                conversation_matched=True,
            )
            return
        local_message_id = self.repository.message_id_for_external(
            external_conversation_id, expected_message_id
        )
        if local_message_id is not None:
            self.repository.set_assistant_task_status(local_message_id, "filled")
        await self.central.complete_command(
            command_id,
            succeeded=True,
            result_code="DRAFT_FILLED_NO_SEND",
            editor_matched=True,
            conversation_matched=True,
            draft_content_digest=validated.draft_content_digest,
        )
        self.repository.audit(
            "central_suggestion.filled",
            "message",
            str(local_message_id or expected_message_id),
            "browser-assistant",
            {"command_id": command_id, "automatic_send": False},
        )

    async def _execute_central_commands(
        self,
        page: Page,
        captured: list[CapturedResponse],
        response_tasks: set[asyncio.Task[None]],
    ) -> int:
        if self.central is None or not self.central.enabled:
            return 0
        commands = await self.central.pull_commands(limit=10)
        for command in commands:
            await self._execute_central_command(
                page, command, captured, response_tasks
            )
        return len(commands)

    async def _execute_review_action(
        self,
        page: Page,
        item: dict[str, Any],
        captured: list[CapturedResponse],
        response_tasks: set[asyncio.Task[None]],
    ) -> None:
        action_id = int(item["review_action_id"])
        message_id = int(item["message_id"])
        conversation_id = int(item["conversation_id"])

        def finish(status: str, error: str | None = None) -> None:
            self.repository.finish_review_action(action_id, status, error=error)
            self.repository.audit(
                f"review.send_{status}",
                "review_action",
                str(action_id),
                "browser-assistant",
                {"message_id": message_id},
            )

        if self.repository.latest_inbound_message_id(conversation_id) != message_id:
            finish("blocked_stale", "客户已发来更新消息，旧建议不能发送")
            return
        original = str(item.get("ai_reply") or "")
        if hashlib.sha256(original.encode("utf-8")).hexdigest() != str(
            item["original_suggestion_hash"]
        ):
            finish("blocked_stale", "AI 建议已更新，批准内容对应的旧版本不能发送")
            return

        conversation = self._conversation_from_item(item)
        if not await self.collector._click_conversation(page, conversation):
            finish("failed", "无法唯一定位乐聊会话；未执行发送")
            return
        await page.wait_for_timeout(self.collector.settings.settle_milliseconds)
        await self.collector._dismiss_startup_overlays(page)
        await self._consume_captured(captured, response_tasks)
        if self.repository.latest_inbound_message_id(conversation_id) != message_id:
            finish("blocked_stale", "打开会话后发现客户有新消息；旧建议未发送")
            return

        try:
            result = await self.collector.send_approved_reply(
                page,
                str(item["approved_content"]),
                expected_content=original,
            )
        except ReplyEditorBusy as exc:
            finish("blocked_editor", str(exc))
            return
        except SendButtonNotFound as exc:
            finish("failed", str(exc))
            return
        except SendResultUnknown as exc:
            finish("unknown", str(exc))
            return
        except Exception as exc:
            self.logger.exception("review.send_failed action_id=%s", action_id)
            finish("failed", str(exc)[:500])
            return

        self.repository.save_feedback(
            message_id,
            action="sent",
            final_content=str(item["approved_content"]),
            source="human-approved-send",
        )
        self.repository.mark_processed(message_id, actor="human-approved-send")
        finish("sent")
        self.logger.info(
            "review.send_confirmed action_id=%s message_id=%s result=%s",
            action_id,
            message_id,
            result,
        )

    async def run(self) -> None:
        if not self.suggestions.settings.llm_enabled and not (
            self.central is not None and self.central.enabled
        ):
            raise RuntimeError(
                "AI 尚未配置。请设置 LIAOLIAO_LLM_MODEL/API_KEY，或使用仓库已有的 DEEPSEEK_API_KEY。"
            )

        if self.central is not None and self.central.enabled:
            # A real account may be active on only one Edge process at a time.
            # Lease conflicts fail before a browser window is opened.
            await self.central.ensure_ready()

        recovered = self.repository.recover_assistant_tasks()
        recovered_sends = self.repository.recover_review_actions()
        baseline_message_id = self.repository.max_message_id()
        self.repository.audit(
            "assistant.started",
            None,
            None,
            "browser-assistant",
            {
                "recovered_tasks": recovered,
                "recovered_unknown_sends": recovered_sends,
                "baseline_message_id": baseline_message_id,
                "human_send_enabled": self.suggestions.settings.human_send_enabled,
            },
        )
        print(
            "乐聊 AI 辅助已启动：草稿填入后立即处理下一会话；"
            "仅本地审核页的明确人工批准可以触发发送。",
            flush=True,
        )

        first_hydration = True
        try:
            async with self.collector.visible_browser_page() as page:
                captured: list[CapturedResponse] = []
                response_tasks: set[asyncio.Task[None]] = set()
                active_hint: ConversationEnvelope | None = None

                async def capture_response(
                    response: Any, hint: ConversationEnvelope | None
                ) -> None:
                    if not self.collector._interesting_endpoint(response.url):
                        return
                    try:
                        payload = await response.json()
                    except Exception:
                        return
                    captured.append((response.url, payload, hint))

                def on_response(response: Any) -> None:
                    hint = active_hint
                    task = asyncio.create_task(capture_response(response, hint))
                    response_tasks.add(task)
                    task.add_done_callback(response_tasks.discard)

                page.on("response", on_response)
                try:
                    await self.collector.navigate_workbench(page)
                    while not page.is_closed():
                        central_commands = await self._execute_central_commands(
                            page, captured, response_tasks
                        )
                        if central_commands:
                            active_hint = None
                            continue
                        if self.suggestions.settings.human_send_enabled:
                            review_action = self.repository.claim_next_review_action()
                            if review_action is not None:
                                active_hint = self._conversation_from_item(review_action)
                                await self._execute_review_action(
                                    page,
                                    review_action,
                                    captured,
                                    response_tasks,
                                )
                                active_hint = None
                                continue
                        await self.collector._load_more_conversations(page)
                        network_batch = await self._consume_captured(
                            captured, response_tasks
                        )
                        dom_rows = await self.collector._extract_dom_conversations(page)
                        dom_batch = batch_from_dom(dom_rows)
                        source_batch = (
                            network_batch
                            if network_batch.conversations
                            else dom_batch
                        )
                        if not network_batch.conversations:
                            await self._persist_batch(dom_batch)

                        current_max = self.repository.max_message_id()
                        if first_hydration:
                            baseline_message_id = current_max
                            first_hydration = False
                        elif current_max > baseline_message_id:
                            self.repository.queue_new_inbound_after(
                                baseline_message_id
                            )
                            baseline_message_id = current_max

                        unread = [
                            conversation
                            for conversation in source_batch.conversations
                            if conversation.unread_count > 0
                        ][: self.collector.settings.collection_limit]

                        handled_ids: set[int] = set()
                        for conversation in unread:
                            active_hint = conversation
                            await self._open_conversation(
                                page, conversation, captured, response_tasks
                            )
                            current_max = self.repository.max_message_id()
                            if current_max > baseline_message_id:
                                self.repository.queue_new_inbound_after(
                                    baseline_message_id
                                )
                                baseline_message_id = current_max
                            self.repository.queue_latest_for_conversation(
                                conversation.external_id
                            )
                            item = self.repository.assistant_task_for_conversation(
                                conversation.external_id
                            )
                            if item is not None:
                                handled_ids.add(int(item["message_id"]))
                                await self._stage_task(page, item)
                            if page.is_closed():
                                break
                            # A busy unread list must not postpone central draft commands
                            # (or the heartbeat performed by pull_commands) until the whole
                            # collection round completes. Keep one page and service the
                            # control plane serially at each conversation boundary.
                            active_hint = None
                            await self._execute_central_commands(
                                page, captured, response_tasks
                            )

                        active_hint = None
                        late_batch = await self._consume_captured(
                            captured, response_tasks
                        )
                        if late_batch.message_count:
                            current_max = self.repository.max_message_id()
                            if current_max > baseline_message_id:
                                self.repository.queue_new_inbound_after(
                                    baseline_message_id
                                )
                                baseline_message_id = current_max

                        queue = self.repository.assistant_queue(
                            limit=self.collector.settings.collection_limit
                        )
                        for item in queue:
                            message_id = int(item["message_id"])
                            if message_id in handled_ids:
                                continue
                            conversation = self._conversation_from_item(item)
                            active_hint = conversation
                            if not await self.collector._click_conversation(
                                page, conversation
                            ):
                                self.repository.set_assistant_task_status(
                                    message_id,
                                    "error",
                                    error="未能在当前会话列表定位客户",
                                )
                                active_hint = None
                                await self._execute_central_commands(
                                    page, captured, response_tasks
                                )
                                continue
                            await page.wait_for_timeout(
                                self.collector.settings.settle_milliseconds
                            )
                            await self.collector._dismiss_startup_overlays(page)
                            await self._consume_captured(captured, response_tasks)
                            latest = self.repository.assistant_task_for_conversation(
                                conversation.external_id
                            )
                            if latest is not None:
                                await self._stage_task(page, latest)
                            if page.is_closed():
                                break
                            active_hint = None
                            await self._execute_central_commands(
                                page, captured, response_tasks
                            )

                        active_hint = None
                        if not unread and not queue and not page.is_closed():
                            await page.wait_for_timeout(3_000)
                finally:
                    page.remove_listener("response", on_response)
                    await self._drain(response_tasks)
        finally:
            if self.central is not None and self.central.enabled:
                await self.central.release_account_lease()
            self.repository.audit(
                "assistant.stopped", None, None, "browser-assistant", {}
            )
