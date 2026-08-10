from __future__ import annotations

import asyncio
import json
import secrets
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import parse_qs, quote

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .config import Settings
from .factory import Runtime, build_runtime


APP_DIR = Path(__file__).resolve().parent


def create_app(
    settings: Settings | None = None, runtime: Runtime | None = None
) -> FastAPI:
    runtime = runtime or build_runtime(settings)
    background_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal background_task
        runtime.repository.initialize()
        if runtime.settings.auto_collect_seconds > 0:
            background_task = asyncio.create_task(
                runtime.service.background_loop(runtime.settings.auto_collect_seconds)
            )
        try:
            yield
        finally:
            if background_task:
                background_task.cancel()
                with suppress(asyncio.CancelledError):
                    await background_task
            await runtime.collector.close()

    app = FastAPI(
        title="乐聊 AI 辅助回复",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.runtime = runtime
    app.state.csrf_token = secrets.token_urlsafe(32)
    templates = Jinja2Templates(directory=str(APP_DIR / "templates"))
    app.mount("/static", StaticFiles(directory=str(APP_DIR / "static")), name="static")

    @app.get("/")
    async def index(
        request: Request,
        status: str = Query("pending", pattern="^(pending|processed|all)$"),
        q: str = Query("", max_length=100),
        notice: str = Query("", max_length=300),
        error: str = Query("", max_length=300),
        view: str = Query("list", pattern="^(list|review)$"),
    ):
        items = runtime.repository.list_work_items(status=status, query=q)
        for item in items:
            try:
                item["suggestion_quality_issues"] = json.loads(
                    item.get("suggestion_quality_issues_json") or "[]"
                )
            except json.JSONDecodeError:
                item["suggestion_quality_issues"] = []
        if view == "review":
            items = [
                item
                for item in items
                if item.get("suggestion_status") == "ready"
                and item.get("review_action_status") not in {"pending", "executing"}
            ][:1]
        return templates.TemplateResponse(
            request=request,
            name="index.html",
            context={
                "items": items,
                "stats": runtime.repository.stats(),
                "status": status,
                "query": q,
                "notice": notice,
                "error": error,
                "collecting": runtime.service.collecting,
                "llm_enabled": runtime.settings.llm_enabled,
                "human_send_enabled": runtime.settings.human_send_enabled,
                "csrf_token": app.state.csrf_token,
                "view": view,
            },
        )

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            {
                "status": "ok",
                "collecting": runtime.service.collecting,
                "llm_enabled": runtime.settings.llm_enabled,
                "human_send_enabled": runtime.settings.human_send_enabled,
                "stats": runtime.repository.stats(),
            }
        )

    async def form_values(request: Request) -> dict[str, str]:
        content_type = request.headers.get("content-type", "")
        if "application/x-www-form-urlencoded" not in content_type:
            raise ValueError("只接受本地审核页提交的表单。")
        raw = (await request.body()).decode("utf-8", errors="strict")
        parsed = parse_qs(raw, keep_blank_values=True, max_num_fields=20)
        return {key: values[-1] for key, values in parsed.items() if values}

    def verify_csrf(values: dict[str, str]) -> None:
        if not secrets.compare_digest(values.get("csrf_token", ""), app.state.csrf_token):
            raise ValueError("审核页已过期，请刷新后重试。")

    @app.post("/actions/collect")
    async def collect_now() -> RedirectResponse:
        try:
            result = await runtime.service.collect_once()
            message = (
                f"采集完成：{result['conversations']} 个会话，"
                f"{result['messages']} 条消息，{result['suggestions_generated']} 条建议"
            )
            return RedirectResponse(f"/?notice={quote(message)}", status_code=303)
        except Exception as exc:
            return RedirectResponse(
                f"/?error={quote(str(exc)[:300])}", status_code=303
            )

    @app.post("/messages/{message_id}/processed")
    async def mark_processed(message_id: int) -> RedirectResponse:
        if not runtime.repository.mark_processed(message_id, actor="web"):
            return RedirectResponse(
                f"/?error={quote('消息不存在')}", status_code=303
            )
        return RedirectResponse(
            f"/?notice={quote('已标记为已处理')}", status_code=303
        )

    @app.post("/messages/{message_id}/suggest")
    async def regenerate_suggestion(
        message_id: int,
        view: str = Query("list", pattern="^(list|review)$"),
    ) -> RedirectResponse:
        target = "/?view=review&" if view == "review" else "/?"
        try:
            generated = await runtime.suggestions.generate_for_message(
                message_id, force=True
            )
            message = "AI 回复建议已生成" if generated else "LLM 未配置，未生成建议"
            return RedirectResponse(f"{target}notice={quote(message)}", status_code=303)
        except Exception as exc:
            return RedirectResponse(
                f"{target}error={quote(str(exc)[:300])}", status_code=303
            )

    @app.post("/messages/{message_id}/feedback")
    async def save_feedback(message_id: int, request: Request) -> RedirectResponse:
        try:
            values = await form_values(request)
            verify_csrf(values)
            final_content = values.get("approved_content", "").strip()
            if not final_content:
                raise ValueError("修改后的回复不能为空。")
            runtime.repository.save_feedback(
                message_id,
                action="edited",
                final_content=final_content,
                source="web-review",
            )
            return RedirectResponse(
                f"/?view=review&notice={quote('修改已保存为质量反馈，尚未发送')}",
                status_code=303,
            )
        except Exception as exc:
            return RedirectResponse(
                f"/?view=review&error={quote(str(exc)[:300])}", status_code=303
            )

    @app.post("/messages/{message_id}/approve-send")
    async def approve_and_send(message_id: int, request: Request) -> RedirectResponse:
        try:
            if not runtime.settings.human_send_enabled:
                raise ValueError("人工批准发送功能当前已关闭。")
            values = await form_values(request)
            verify_csrf(values)
            if values.get("confirm_send") != "HUMAN_CONFIRMED_SEND":
                raise ValueError("缺少明确的人工发送确认。")
            action_id = runtime.repository.queue_review_send(
                message_id,
                values.get("approved_content", ""),
                requested_by="web-review",
            )
            return RedirectResponse(
                f"/?view=review&notice={quote(f'已提交人工批准发送任务 #{action_id}；助手将校验最新消息后执行')}",
                status_code=303,
            )
        except Exception as exc:
            return RedirectResponse(
                f"/?view=review&error={quote(str(exc)[:300])}", status_code=303
            )

    return app
