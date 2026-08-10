from __future__ import annotations

import asyncio
import logging
from typing import Any

from .browser import BrowserCollector
from .central_client import CentralControlPlaneClient
from .llm import SuggestionService
from .repository import Repository


class ApplicationService:
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
        self.logger = logger or logging.getLogger("liaoliao.service")
        self.central = central
        self._collection_lock = asyncio.Lock()

    @property
    def collecting(self) -> bool:
        return self._collection_lock.locked()

    async def collect_once(self) -> dict[str, Any]:
        if self._collection_lock.locked():
            raise RuntimeError("采集任务正在运行")
        async with self._collection_lock:
            run_id = self.repository.begin_collection_run()
            self.repository.audit(
                "collection.started", "collection_run", str(run_id), "collector", {}
            )
            try:
                batch = await self.collector.collect()
                persisted = self.repository.upsert_batch(batch)
                central_sync = (
                    await self.central.publish_batch(batch)
                    if self.central is not None
                    else {"enabled": False, "accepted": 0, "rejected": 0}
                )
                generated = await self.suggestions.generate_pending(limit=100)
                self.repository.finish_collection_run(
                    run_id,
                    status="success",
                    conversations_found=len(batch.conversations),
                    messages_found=batch.message_count,
                    suggestions_generated=generated,
                    endpoint_hits=batch.endpoint_hits,
                )
                result = {
                    "run_id": run_id,
                    **persisted,
                    "suggestions_generated": generated,
                    "endpoint_hits": batch.endpoint_hits,
                    "central_sync": central_sync,
                }
                self.repository.audit(
                    "collection.completed",
                    "collection_run",
                    str(run_id),
                    "collector",
                    result,
                )
                return result
            except Exception as exc:
                self.repository.finish_collection_run(
                    run_id,
                    status="failed",
                    error=f"{type(exc).__name__}: {str(exc)[:500]}",
                )
                self.repository.audit(
                    "collection.failed",
                    "collection_run",
                    str(run_id),
                    "collector",
                    {"error_type": type(exc).__name__},
                )
                self.logger.exception("collection.failed run_id=%s", run_id)
                raise

    async def background_loop(self, interval_seconds: int) -> None:
        while True:
            try:
                await self.collect_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                self.logger.exception("background_collection.failed")
            await asyncio.sleep(interval_seconds)
