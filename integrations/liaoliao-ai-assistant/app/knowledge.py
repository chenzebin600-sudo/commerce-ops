from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "default"


def _clean(text: str, limit: int = 12_000) -> str:
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n".join(lines)[:limit]


class KnowledgeBase:
    """加载版本可控的全局、平台和店铺客服政策。"""

    def __init__(self, directory: Path):
        self.directory = directory

    def _read(self, path: Path) -> str:
        if not path.exists() or not path.is_file():
            return ""
        return _clean(path.read_text(encoding="utf-8"))

    def _shop_policy(self, shop_name: str) -> str:
        path = self.directory / "shops.json"
        if not path.exists():
            return ""
        try:
            payload: Any = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return ""
        if not isinstance(payload, dict):
            return ""
        value = payload.get(shop_name)
        if isinstance(value, list):
            value = "\n".join(str(item) for item in value)
        return _clean(str(value)) if value else ""

    def _examples(
        self,
        *,
        shop_name: str,
        platform: str | None,
        intent: str,
        limit: int = 3,
    ) -> list[dict[str, str]]:
        path = self.directory / "examples.jsonl"
        if not path.exists():
            return []
        result: list[tuple[int, dict[str, str]]] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(payload, dict):
                continue
            customer_message = str(payload.get("customer_message") or "").strip()
            final_reply = str(payload.get("final_reply") or "").strip()
            if not customer_message or not final_reply:
                continue
            example_shop = str(payload.get("shop_name") or "").strip()
            example_platform = str(payload.get("platform") or "").strip()
            example_intent = str(payload.get("intent") or "").strip()
            if example_shop and example_shop != shop_name:
                continue
            if example_platform and platform and _slug(example_platform) != _slug(platform):
                continue
            if example_intent and example_intent != intent:
                continue
            score = int(bool(example_shop)) * 4 + int(bool(example_intent)) * 2 + int(bool(example_platform))
            result.append(
                (
                    score,
                    {
                        "customer_message": customer_message[:500],
                        "final_reply": final_reply[:1_000],
                    },
                )
            )
        result.sort(key=lambda item: item[0], reverse=True)
        return [item for _, item in result[:limit]]

    def structured_context_for(
        self,
        *,
        shop_name: str,
        platform: str | None,
        region: str | None,
        intent: str,
        skus: list[str] | None = None,
    ) -> dict[str, Any]:
        """按低到高优先级返回可审计的政策与示例。"""

        sections: list[dict[str, Any]] = []

        def append(kind: str, label: str, priority: int, content: str) -> None:
            if content:
                sections.append(
                    {
                        "kind": kind,
                        "label": label,
                        "priority": priority,
                        "content": content,
                    }
                )

        append("global", "全局客服规则", 10, self._read(self.directory / "global.md"))
        if platform:
            append(
                "platform",
                f"平台政策：{platform}",
                20,
                self._read(self.directory / "platforms" / f"{_slug(platform)}.md"),
            )
        if region:
            append(
                "region",
                f"国家/地区政策：{region}",
                30,
                self._read(self.directory / "regions" / f"{_slug(region)}.md"),
            )
        for sku in (skus or [])[:5]:
            append(
                "product",
                f"商品资料：{sku}",
                40,
                self._read(self.directory / "products" / f"{_slug(sku)}.md"),
            )
        append("shop", f"店铺政策：{shop_name}", 50, self._shop_policy(shop_name))
        append(
            "intent",
            f"场景规则：{intent}",
            60,
            self._read(self.directory / "intents" / f"{_slug(intent)}.md"),
        )
        sections.sort(key=lambda item: int(item["priority"]))
        return {
            "precedence": "优先级数字越高越优先；冲突时采用更高优先级，事实不足时不得猜测",
            "sections": sections,
            "examples": self._examples(
                shop_name=shop_name,
                platform=platform,
                intent=intent,
            ),
        }

    def context_for(self, *, shop_name: str, platform: str | None) -> str:
        structured = self.structured_context_for(
            shop_name=shop_name,
            platform=platform,
            region=None,
            intent="general",
        )
        return "\n\n".join(
            f"[{section['label']}]\n{section['content']}"
            for section in structured["sections"]
        )[:20_000]
