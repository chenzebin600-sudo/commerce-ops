from __future__ import annotations

import asyncio
import logging
import os
import tempfile
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Any, AsyncIterator, Mapping
from urllib.parse import urlparse

from playwright.async_api import (
    Browser,
    BrowserContext,
    Error as PlaywrightError,
    Locator,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
    async_playwright,
)

from .config import Settings
from .extraction import (
    CONVERSATION_ENDPOINT_MARKERS,
    MESSAGE_ENDPOINT_MARKERS,
    batch_from_dom,
    merge_batches,
    normalize_message,
    parse_network_payload,
)
from .models import ConversationEnvelope, ExtractionBatch
from .quality import structure_operational_context


class AuthenticationRequired(RuntimeError):
    pass


class ReplyEditorNotFound(RuntimeError):
    pass


class ReplyEditorBusy(RuntimeError):
    pass


class SendButtonNotFound(RuntimeError):
    pass


class SendResultUnknown(RuntimeError):
    pass


class BrowserCollector:
    """只读采集器：监听工作台自身响应，并用 DOM 点击触发消息加载。"""

    def __init__(self, settings: Settings, logger: logging.Logger | None = None):
        self.settings = settings
        self.logger = logger or logging.getLogger("liaoliao.browser")
        self.selectors = settings.load_selectors()
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._lock = asyncio.Lock()

    async def _start(self, *, headless: bool | None = None) -> None:
        if self._context is not None:
            return
        self.settings.ensure_directories()
        self._playwright = await async_playwright().start()
        launch_options: dict[str, Any] = {
            "headless": self.settings.headless if headless is None else headless,
        }
        if self.settings.browser_channel:
            launch_options["channel"] = self.settings.browser_channel
        self._browser = await self._playwright.chromium.launch(**launch_options)
        context_options: dict[str, Any] = {
            "locale": "zh-CN",
            "viewport": {"width": 1440, "height": 960},
        }
        if self.settings.session_path.exists():
            context_options["storage_state"] = str(self.settings.session_path)
        self._context = await self._browser.new_context(**context_options)
        self._context.set_default_timeout(20_000)
        self._context.set_default_navigation_timeout(60_000)

    async def close(self) -> None:
        if self._context is not None:
            await self._context.close()
        if self._browser is not None:
            await self._browser.close()
        if self._playwright is not None:
            await self._playwright.stop()
        self._context = None
        self._browser = None
        self._playwright = None

    async def _first_visible(self, page: Page, candidates: list[str]) -> Locator | None:
        for selector in candidates:
            locator = page.locator(selector).first
            try:
                if await locator.is_visible(timeout=1_000):
                    return locator
            except PlaywrightTimeoutError:
                continue
        return None

    async def _goto_app(self, page: Page, url: str) -> None:
        """乐聊部分健康检查较慢；以文档提交和 React 根节点水合为准。"""

        try:
            await page.goto(url, wait_until="commit", timeout=60_000)
        except PlaywrightTimeoutError:
            if "mai.zhisuitech.com" not in page.url:
                raise
            self.logger.warning("navigation.timeout_but_committed url=%s", page.url)
        try:
            await page.locator("#root").wait_for(state="attached", timeout=30_000)
            await page.wait_for_function(
                "document.querySelector('#root')?.innerText?.trim().length > 20",
                timeout=60_000,
            )
        except PlaywrightTimeoutError as exc:
            raise RuntimeError(
                "乐聊页面已响应但 SPA 未完成加载；请检查网络、代理或稍后重试。"
            ) from exc

    async def _wait_for_login_form(self, page: Page) -> None:
        candidates = self.selectors.get("login_password", [])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if await self._first_visible(page, candidates):
                return
            if await self._is_authenticated(page):
                return
            await page.wait_for_timeout(1_000)
        raise RuntimeError("乐聊登录页已打开，但登录表单未在 60 秒内就绪。")

    async def _is_authenticated(self, page: Page) -> bool:
        current_url = page.url.lower()
        if any(
            route in current_url
            for route in ("#/login", "#/registry", "#/findpassword", "#/refresh/login")
        ):
            return False
        password = await self._first_visible(page, self.selectors.get("login_password", []))
        if password is not None:
            return False
        return any(
            route in current_url
            for route in (
                "#/workbench",
                "#/welcome",
                "#/dashboard",
                "#/management",
                "#/knowledge",
            )
        )

    async def _save_session(self) -> None:
        if self._context is None:
            raise RuntimeError("Browser context is not running")
        self.settings.session_path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.settings.session_path.name}.",
            suffix=".tmp",
            dir=self.settings.session_path.parent,
        )
        os.close(descriptor)
        temporary_path = Path(temporary_name)
        try:
            try:
                await self._context.storage_state(
                    path=str(temporary_path), indexed_db=True
                )
            except TypeError:
                await self._context.storage_state(path=str(temporary_path))
            try:
                os.chmod(temporary_path, 0o600)
            except OSError:
                pass
            os.replace(temporary_path, self.settings.session_path)
        finally:
            temporary_path.unlink(missing_ok=True)

    @asynccontextmanager
    async def visible_browser_page(self) -> AsyncIterator[Page]:
        """打开一个由客服接管的可见页面，并在退出时保存最新 Session。"""

        async with self._lock:
            await self.close()
            await self._start(headless=False)
            assert self._context is not None
            page = await self._context.new_page()
            try:
                yield page
            finally:
                if self._context is not None:
                    try:
                        await self._save_session()
                    except Exception:
                        self.logger.exception("session.save_on_assistant_exit_failed")
                if not page.is_closed():
                    await page.close()
                await self.close()

    async def navigate_workbench(self, page: Page) -> None:
        await self._goto_app(page, self.settings.workbench_url)
        await page.wait_for_timeout(self.settings.settle_milliseconds)
        if not await self._is_authenticated(page):
            raise AuthenticationRequired(
                "乐聊 Session 不存在或已过期，请先执行 `liaoliao login`。"
            )
        await self._dismiss_startup_overlays(page)

    async def _dismiss_startup_overlays(self, page: Page) -> int:
        """关闭首次语言/功能介绍弹窗，不点击弹窗中的业务操作按钮。"""

        dismissed = 0
        for _ in range(5):
            closes = page.locator(".ant-modal:visible .ant-modal-close:visible")
            if not await closes.count():
                break
            try:
                await closes.first.evaluate("element => element.click()")
                dismissed += 1
                await page.wait_for_timeout(750)
            except PlaywrightError:
                break
        if dismissed:
            self.logger.info("startup_overlays.dismissed count=%s", dismissed)
        return dismissed

    async def interactive_login(self) -> Path:
        """打开有头浏览器。配置凭据时自动填写；验证码/二次验证由用户完成。"""

        async with self._lock:
            await self.close()
            await self._start(headless=False)
            assert self._context is not None
            page = await self._context.new_page()
            self.logger.info("login.start url=%s", self.settings.login_url)
            await self._goto_app(page, self.settings.login_url)
            await self._wait_for_login_form(page)

            submitted = False
            account = await self._first_visible(
                page, self.selectors.get("login_account", [])
            )
            password = await self._first_visible(
                page, self.selectors.get("login_password", [])
            )
            if account and password and self.settings.account and self.settings.password:
                await account.fill(self.settings.account)
                await password.fill(self.settings.password)
                submit = await self._first_visible(
                    page, self.selectors.get("login_submit", [])
                )
                if submit and await submit.is_enabled():
                    await submit.click()
                    submitted = True
                    self.logger.info("login.credentials_submitted")

            deadline = time.monotonic() + self.settings.login_timeout_seconds
            while time.monotonic() < deadline:
                if await self._is_authenticated(page):
                    await self._save_session()
                    self.logger.info(
                        "login.session_saved path=%s submitted=%s",
                        self.settings.session_path,
                        submitted,
                    )
                    await self.close()
                    return self.settings.session_path
                await page.wait_for_timeout(1_000)

            await self.close()
            raise TimeoutError(
                "登录等待超时。请重新执行 `liaoliao login` 并在浏览器中完成验证码或二次验证。"
            )

    @staticmethod
    def _interesting_endpoint(url: str) -> bool:
        path = urlparse(url).path
        return any(marker in path for marker in (*CONVERSATION_ENDPOINT_MARKERS, *MESSAGE_ENDPOINT_MARKERS))

    async def _extract_dom_conversations(self, page: Page) -> list[dict[str, Any]]:
        selectors = self.selectors.get("conversation_items", [])
        unread_selectors = self.selectors.get("unread_badges", [])
        script = """
        ({ selectors, unreadSelectors }) => {
          const seen = new Set();
          const rows = [];
          for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
              if (seen.has(element)) continue;
              seen.add(element);
              const rect = element.getBoundingClientRect();
              if (rect.width < 120 || rect.height < 28 || rect.height > 240) continue;
              const lines = (element.innerText || '').split(/\\n+/).map(v => v.trim()).filter(Boolean);
              if (!lines.length) continue;
              let unread = Number(element.dataset.unreadCount || element.dataset.unread || 0) || 0;
              for (const badgeSelector of unreadSelectors) {
                const badge = element.querySelector(badgeSelector);
                if (badge) unread = Math.max(unread, Number((badge.textContent || '').trim()) || 1);
              }
              rows.push({
                selector,
                conversation_id: element.dataset.conversationId || element.dataset.talkId || null,
                shop_name: element.dataset.storeName || element.dataset.shopName || '未知店铺',
                customer_name: element.dataset.buyerName || element.dataset.customerName || lines[0],
                unread_count: unread,
                message_text: lines.length > 1 ? lines[lines.length - 1] : null,
                text_sample: lines.slice(0, 4).join(' | ')
              });
            }
          }
          return rows;
        }
        """
        result = await page.evaluate(
            script, {"selectors": selectors, "unreadSelectors": unread_selectors}
        )
        return result if isinstance(result, list) else []

    async def _load_more_conversations(self, page: Page) -> None:
        """滚动虚拟会话列表，触发工作台自身的下一页读取。"""

        selectors = self.selectors.get("conversation_items", [])
        script = """
        (selectors) => {
          let item = null;
          for (const selector of selectors) {
            item = document.querySelector(selector);
            if (item) break;
          }
          if (!item) return { found: false };
          let node = item.parentElement;
          for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
            const style = getComputedStyle(node);
            const scrollable = /auto|scroll/.test(style.overflowY) &&
              node.scrollHeight > node.clientHeight + 20;
            if (!scrollable) continue;
            const before = node.scrollTop;
            const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
            node.scrollTop = Math.min(maximum, before + Math.max(200, node.clientHeight * 0.85));
            node.dispatchEvent(new Event('scroll', { bubbles: true }));
            return {
              found: true,
              before,
              after: node.scrollTop,
              maximum,
              height: node.scrollHeight
            };
          }
          return { found: false };
        }
        """
        stable_rounds = 0
        last: tuple[int, int] | None = None
        for _ in range(self.settings.max_scroll_pages):
            state = await page.evaluate(script, selectors)
            if not isinstance(state, Mapping) or not state.get("found"):
                return
            current = (int(state.get("after", 0)), int(state.get("height", 0)))
            if current == last or int(state.get("after", 0)) >= int(
                state.get("maximum", 0)
            ):
                stable_rounds += 1
            else:
                stable_rounds = 0
            if stable_rounds >= 2:
                return
            last = current
            await page.wait_for_timeout(min(self.settings.settle_milliseconds, 1_500))

    async def _extract_dom_messages(
        self, page: Page, conversation: ConversationEnvelope
    ) -> ConversationEnvelope | None:
        selectors = self.selectors.get("message_items", [])
        script = """
        (selectors) => {
          const seen = new Set();
          const rows = [];
          for (const selector of selectors) {
            for (const element of document.querySelectorAll(selector)) {
              if (seen.has(element)) continue;
              seen.add(element);
              const rect = element.getBoundingClientRect();
              const text = (element.innerText || '').trim();
              if (!text || rect.height < 12 || rect.height > 500) continue;
              let lineage = element;
              const lineageClasses = [];
              for (let depth = 0; lineage && depth < 6; depth += 1, lineage = lineage.parentElement) {
                lineageClasses.push(String(lineage.className || '').toLowerCase());
              }
              const className = lineageClasses.join(' ');
              const from = element.dataset.from || element.dataset.direction ||
                (/buyer|incoming|left/.test(className) ? 'BUYER' :
                 /seller|outgoing|right|agent/.test(className) ? 'SELLER' : '');
              rows.push({
                conversationId: element.dataset.conversationId || null,
                msgId: element.dataset.messageId || element.dataset.msgId || null,
                msgFromType: from,
                textContent: text,
                sendTime: element.dataset.sendTime || element.dataset.timestamp || null,
                messageType: element.dataset.messageType || 'TEXT'
              });
            }
          }
          return rows;
        }
        """
        rows = await page.evaluate(script, selectors)
        if not isinstance(rows, list):
            return None
        messages = []
        for row in rows:
            if isinstance(row, Mapping):
                normalized = normalize_message(row, conversation_id=conversation.external_id)
                if normalized:
                    messages.append(normalized)
        if not messages:
            return None
        copy = ConversationEnvelope(**asdict(conversation))
        copy.messages = messages
        return copy

    async def _click_conversation(
        self, page: Page, conversation: ConversationEnvelope
    ) -> bool:
        await self._dismiss_startup_overlays(page)
        name = conversation.customer_name
        if not name or name.startswith("unknown-customer:"):
            return False
        exact: list[Locator] = []
        named: list[Locator] = []
        seen_candidates: set[str] = set()
        for selector in self.selectors.get("conversation_items", []):
            locator = page.locator(selector).filter(has_text=name)
            try:
                count = min(await locator.count(), 8)
                for index in range(count):
                    candidate = locator.nth(index)
                    if not await candidate.is_visible():
                        continue
                    fingerprint = await candidate.evaluate(
                        """element => {
                          const rect = element.getBoundingClientRect();
                          return [
                            element.dataset.conversationId || '',
                            element.dataset.talkId || '',
                            (element.innerText || '').trim(),
                            Math.round(rect.x), Math.round(rect.y),
                            Math.round(rect.width), Math.round(rect.height)
                          ].join('|');
                        }"""
                    )
                    if fingerprint in seen_candidates:
                        continue
                    seen_candidates.add(str(fingerprint))
                    candidate_id = (
                        await candidate.get_attribute("data-conversation-id")
                        or await candidate.get_attribute("data-talk-id")
                        or ""
                    )
                    if candidate_id and candidate_id == conversation.external_id:
                        exact.append(candidate)
                        continue
                    text = (await candidate.inner_text()).strip()
                    if conversation.shop_name and conversation.shop_name in text:
                        named.append(candidate)
                    elif name in text:
                        named.append(candidate)
            except (PlaywrightTimeoutError, PlaywrightError):
                continue
        candidates = exact or named
        if len(candidates) != 1:
            self.logger.warning(
                "conversation.locate_ambiguous conversation=%s exact=%s named=%s",
                conversation.external_id,
                len(exact),
                len(named),
            )
            return False
        try:
            await candidates[0].click(timeout=5_000)
            return True
        except (PlaywrightTimeoutError, PlaywrightError):
            dismissed = await self._dismiss_startup_overlays(page)
            if dismissed:
                try:
                    await candidates[0].click(timeout=5_000)
                    return True
                except (PlaywrightTimeoutError, PlaywrightError):
                    pass
            self.logger.warning(
                "conversation.click_blocked conversation=%s overlays_dismissed=%s",
                conversation.external_id,
                dismissed,
            )
            return False

    async def find_reply_editor(self, page: Page) -> Locator | None:
        """只返回页面右下方可编辑的消息输入区，避免误填搜索框。"""

        viewport = page.viewport_size or {"width": 1440, "height": 960}
        minimum_x = float(viewport["width"]) * 0.20
        minimum_y = float(viewport["height"]) * 0.42
        for selector in self.selectors.get("reply_editors", []):
            group = page.locator(selector)
            try:
                count = min(await group.count(), 12)
            except PlaywrightError:
                continue
            for index in range(count - 1, -1, -1):
                candidate = group.nth(index)
                try:
                    if not await candidate.is_visible() or not await candidate.is_editable():
                        continue
                    box = await candidate.bounding_box()
                    if not box or box["width"] < 240 or box["height"] < 24:
                        continue
                    if box["x"] < minimum_x or box["y"] < minimum_y:
                        continue
                    return candidate
                except PlaywrightError:
                    continue
        return None

    @staticmethod
    async def reply_editor_text(editor: Locator) -> str:
        tag_name = await editor.evaluate("element => element.tagName.toLowerCase()")
        if tag_name in {"input", "textarea"}:
            return (await editor.input_value()).strip()
        return (
            await editor.evaluate(
                "element => (element.innerText || element.textContent || '').trim()"
            )
        ).strip()

    async def fill_reply_editor(
        self, page: Page, suggestion: str, *, allow_existing_same: bool = False
    ) -> Locator:
        """仅写入建议文本；此方法没有任何发送按钮或键盘提交操作。"""

        editor = await self.find_reply_editor(page)
        if editor is None:
            raise ReplyEditorNotFound(
                "未识别到乐聊回复输入框。请执行 `liaoliao probe` 后校准 selectors.json 的 reply_editors。"
            )
        existing = await self.reply_editor_text(editor)
        if existing:
            if allow_existing_same and existing == suggestion.strip():
                return editor
            raise ReplyEditorBusy("当前回复输入框已有内容，为避免覆盖已跳过。")
        await editor.fill(suggestion)
        written = await self.reply_editor_text(editor)
        if written != suggestion.strip():
            raise RuntimeError("AI 建议未能完整写入乐聊回复输入框。")
        return editor

    async def replace_reply_editor(
        self,
        page: Page,
        approved_content: str,
        *,
        expected_content: str,
    ) -> Locator:
        """仅在编辑器为空或仍等于原建议时写入人工批准的内容。"""

        approved = approved_content.strip()
        if not approved:
            raise ValueError("批准发送的回复不能为空。")
        editor = await self.find_reply_editor(page)
        if editor is None:
            raise ReplyEditorNotFound("未识别到乐聊回复输入框。")
        existing = await self.reply_editor_text(editor)
        expected = expected_content.strip()
        if existing not in {"", expected, approved}:
            raise ReplyEditorBusy("输入框内容已被人工修改，与待批准内容不一致。")
        if existing != approved:
            await editor.fill(approved)
        written = await self.reply_editor_text(editor)
        if written != approved:
            raise RuntimeError("人工批准内容未能完整写入乐聊回复输入框。")
        return editor

    async def find_send_button(self, page: Page, editor: Locator) -> Locator | None:
        editor_box = await editor.bounding_box()
        candidates: list[tuple[float, Locator]] = []
        for selector in self.selectors.get("send_buttons", []):
            group = page.locator(selector)
            try:
                count = min(await group.count(), 12)
            except PlaywrightError:
                continue
            for index in range(count):
                candidate = group.nth(index)
                try:
                    if not await candidate.is_visible() or not await candidate.is_enabled():
                        continue
                    box = await candidate.bounding_box()
                    if not box:
                        continue
                    if editor_box:
                        editor_center_x = editor_box["x"] + editor_box["width"] / 2
                        editor_center_y = editor_box["y"] + editor_box["height"] / 2
                        button_center_x = box["x"] + box["width"] / 2
                        button_center_y = box["y"] + box["height"] / 2
                        distance = abs(button_center_x - editor_center_x) + abs(
                            button_center_y - editor_center_y
                        )
                        if distance > max(800, editor_box["width"] * 1.2):
                            continue
                    else:
                        distance = 0
                    candidates.append((distance, candidate))
                except PlaywrightError:
                    continue
        if not candidates:
            return None
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]

    async def send_approved_reply(
        self,
        page: Page,
        approved_content: str,
        *,
        expected_content: str,
    ) -> str:
        """人工批准后的唯一发送入口；不使用 Enter，且结果不明时绝不重试。"""

        editor = await self.replace_reply_editor(
            page,
            approved_content,
            expected_content=expected_content,
        )
        button = await self.find_send_button(page, editor)
        if button is None:
            raise SendButtonNotFound(
                "未识别到乐聊发送按钮；已保留输入框内容，未执行发送。"
            )
        final_check = await self.reply_editor_text(editor)
        if final_check != approved_content.strip():
            raise ReplyEditorBusy("发送前输入框内容发生变化，已停止发送。")
        await button.click()
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline and not page.is_closed():
            try:
                current = await self.reply_editor_text(editor)
            except PlaywrightError:
                current_editor = await self.find_reply_editor(page)
                current = (
                    await self.reply_editor_text(current_editor)
                    if current_editor is not None
                    else approved_content.strip()
                )
            if not current:
                return "confirmed_editor_cleared"
            await page.wait_for_timeout(250)
        raise SendResultUnknown(
            "已点击发送按钮，但页面未在限定时间内确认结果；不得自动重试。"
        )

    async def extract_operational_context(self, page: Page) -> dict[str, Any]:
        """提取当前会话右侧可见的订单、物流和商品事实，不执行任何点击。"""

        script = """
        () => {
          const width = window.innerWidth;
          const height = window.innerHeight;
          const candidates = [];
          for (const element of document.querySelectorAll('aside,section,div')) {
            const rect = element.getBoundingClientRect();
            if (rect.width < 240 || rect.height < height * 0.45) continue;
            if (rect.x < width * 0.58 || rect.right > width + 2) continue;
            const style = getComputedStyle(element);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const text = (element.innerText || '').trim();
            if (text.length < 20) continue;
            candidates.push({
              text,
              score: Math.min(text.length, 12000) + rect.width * rect.height / 1000,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height)
            });
          }
          candidates.sort((a, b) => b.score - a.score);
          if (!candidates.length) return { right_panel_text: '', panel_bounds: null };
          const selected = candidates[0];
          const seen = new Set();
          const lines = selected.text.split(/\\n+/).map(v => v.trim()).filter(v => {
            if (!v || seen.has(v)) return false;
            seen.add(v);
            return true;
          });
          return {
            right_panel_text: lines.join('\\n').slice(0, 20000),
            panel_bounds: {
              x: selected.x, y: selected.y,
              width: selected.width, height: selected.height
            }
          };
        }
        """
        result = await page.evaluate(script)
        if not isinstance(result, Mapping):
            return {
                "right_panel_text": "",
                "structured": structure_operational_context(""),
                "panel_bounds": None,
            }
        raw_text = str(result.get("right_panel_text") or "")[:20_000]
        return {
            "right_panel_text": raw_text,
            "structured": structure_operational_context(raw_text),
            "panel_bounds": result.get("panel_bounds"),
        }

    async def wait_for_manual_review(self, page: Page, suggestion: str) -> str:
        """等待客服修改、清空或发送；脚本不会代替客服触发这些动作。"""

        suggestion = suggestion.strip()
        saw_edit = False
        while not page.is_closed():
            try:
                editor = await self.find_reply_editor(page)
                if editor is None:
                    await page.wait_for_timeout(500)
                    continue
                current = await self.reply_editor_text(editor)
                if not current:
                    return "editor_cleared"
                if current != suggestion:
                    saw_edit = True
                await page.wait_for_timeout(500)
            except PlaywrightError:
                if page.is_closed():
                    break
                await page.wait_for_timeout(500)
        return "page_closed_after_edit" if saw_edit else "page_closed"

    async def collect(self) -> ExtractionBatch:
        async with self._lock:
            await self._start()
            assert self._context is not None
            page = await self._context.new_page()
            captured: list[tuple[str, Any, ConversationEnvelope | None]] = []
            response_tasks: set[asyncio.Task[None]] = set()
            active_hint: ConversationEnvelope | None = None

            async def capture_response(response: Any) -> None:
                if not self._interesting_endpoint(response.url):
                    return
                try:
                    payload = await response.json()
                except Exception:
                    return
                captured.append((response.url, payload, active_hint))

            def on_response(response: Any) -> None:
                task = asyncio.create_task(capture_response(response))
                response_tasks.add(task)
                task.add_done_callback(response_tasks.discard)

            page.on("response", on_response)
            try:
                self.logger.info("collection.navigate url=%s", self.settings.workbench_url)
                await self.navigate_workbench(page)
                await self._load_more_conversations(page)
                if response_tasks:
                    await asyncio.gather(*list(response_tasks), return_exceptions=True)

                initial_batches = [
                    parse_network_payload(url, payload, conversation_hint=hint)
                    for url, payload, hint in captured
                ]
                initial = merge_batches(initial_batches)
                dom_rows = await self._extract_dom_conversations(page)
                dom_batch = batch_from_dom(dom_rows)
                candidates = merge_batches([initial, dom_batch]).conversations
                unread_candidates = [item for item in candidates if item.unread_count > 0]
                if not unread_candidates:
                    unread_candidates = candidates[:1]

                dom_message_batches: list[ExtractionBatch] = []
                for conversation in unread_candidates[: self.settings.collection_limit]:
                    active_hint = conversation
                    if not await self._click_conversation(page, conversation):
                        continue
                    await page.wait_for_timeout(self.settings.settle_milliseconds)
                    dom_messages = await self._extract_dom_messages(page, conversation)
                    if dom_messages:
                        dom_message_batches.append(
                            ExtractionBatch(
                                conversations=[dom_messages], endpoint_hits=["dom-message"]
                            )
                        )

                if response_tasks:
                    await asyncio.gather(*list(response_tasks), return_exceptions=True)
                network_batches = [
                    parse_network_payload(url, payload, conversation_hint=hint)
                    for url, payload, hint in captured
                ]
                result = merge_batches([*network_batches, dom_batch, *dom_message_batches])
                self.logger.info(
                    "collection.complete conversations=%s messages=%s endpoints=%s",
                    len(result.conversations),
                    result.message_count,
                    len(result.endpoint_hits),
                )
                return result
            finally:
                page.remove_listener("response", on_response)
                await page.close()
                await self.close()

    async def probe(self) -> dict[str, Any]:
        """返回不含消息正文/客户名的页面适配信息。"""

        async with self._lock:
            await self._start()
            assert self._context is not None
            page = await self._context.new_page()
            endpoint_hits: set[str] = set()

            def on_response(response: Any) -> None:
                if self._interesting_endpoint(response.url):
                    endpoint_hits.add(urlparse(response.url).path)

            page.on("response", on_response)
            try:
                await self.navigate_workbench(page)
                selector_counts: dict[str, int] = {}
                for group, selectors in self.selectors.items():
                    if group.startswith("login_"):
                        continue
                    for selector in selectors:
                        try:
                            selector_counts[selector] = await page.locator(selector).count()
                        except Exception:
                            selector_counts[selector] = -1
                return {
                    "url": page.url,
                    "title": await page.title(),
                    "selector_counts": selector_counts,
                    "endpoint_hits": sorted(endpoint_hits),
                    "probed_at": datetime_now(),
                }
            finally:
                page.remove_listener("response", on_response)
                await page.close()
                await self.close()


def datetime_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
