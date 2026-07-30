from __future__ import annotations

import ast
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


SITE_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = SITE_ROOT.parent
CLIENT_PATH = WORKSPACE_ROOT / "mabang_listing_client.py"
CREDENTIAL_SOURCE = WORKSPACE_ROOT / "mabang_order_sync_fast.py"
DATA_DIR = SITE_ROOT / "public"
INDEX_PATH = DATA_DIR / "listings-index.json"
CHUNK_SIZE = 250

sys.path.insert(0, str(WORKSPACE_ROOT))

from mabang_listing_client import MabangListingClient, PLATFORMS  # noqa: E402


STATE_LABELS = {
    "online": "在线商品",
    "examining": "审核中",
    "offline": "已下架",
    "prohibited": "禁售",
    "deleted": "已删除",
    "sold_out": "已售罄",
    "draft": "草稿",
    "pending": "待处理",
    "deactivated": "已停用",
}


def read_credentials(path: Path) -> tuple[str, str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    values: dict[str, str] = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name) or target.id not in {"USERNAME", "PASSWORD"}:
            continue
        value = ast.literal_eval(node.value)
        if isinstance(value, str):
            values[target.id] = value
    if not values.get("USERNAME") or not values.get("PASSWORD"):
        raise RuntimeError("未能从现有马帮脚本读取登录配置。")
    return values["USERNAME"], values["PASSWORD"]


def first(source: dict[str, Any], *names: str) -> Any:
    for name in names:
        value = source.get(name)
        if value not in (None, ""):
            return value
    return ""


def compact_shop(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": first(raw, "id", "shop_id", "shopId"),
        "name": first(raw, "name", "shop_name", "shopName"),
        "site": first(raw, "amazonsite", "site", "site_name", "country"),
        "currency": first(raw, "currency", "currency_code"),
        "shop_type": first(raw, "shop_type", "shopType", "type"),
    }


def compact_variant(raw: dict[str, Any]) -> dict[str, Any]:
    warehouse_stock = raw.get("warehouse_stock")
    return {
        "variant_id": raw.get("variant_id", ""),
        "sku": raw.get("sku", ""),
        "stock_sku": raw.get("stock_sku", ""),
        "price": raw.get("price", ""),
        "sale_price": raw.get("sale_price", ""),
        "stock": raw.get("stock", 0),
        "warehouse_stock": warehouse_stock if isinstance(warehouse_stock, list) else [],
        "supply_price": raw.get("supply_price", ""),
    }


def compact_listing(raw: dict[str, Any]) -> dict[str, Any]:
    variants = raw.get("variants")
    return {
        "platform": raw.get("platform", ""),
        "platform_name": raw.get("platform_name", ""),
        "state": raw.get("state", ""),
        "internal_id": raw.get("internal_id", ""),
        "product_id": raw.get("product_id", ""),
        "product_url": raw.get("product_url", ""),
        "title": raw.get("title", ""),
        "parent_sku": raw.get("parent_sku", ""),
        "currency": raw.get("currency", ""),
        "image": raw.get("image", ""),
        "shop_id": raw.get("shop_id", ""),
        "shop_name": raw.get("shop_name", ""),
        "site": raw.get("site", ""),
        "category_id": raw.get("category_id", ""),
        "create_time": raw.get("create_time", ""),
        "update_time": raw.get("update_time", ""),
        "publish_time": raw.get("publish_time", ""),
        "variants": [
            compact_variant(item)
            for item in (variants if isinstance(variants, list) else [])
            if isinstance(item, dict)
        ],
    }


def main() -> None:
    username, password = read_credentials(CREDENTIAL_SOURCE)
    client = MabangListingClient()
    client.login(username, password)

    platforms: list[dict[str, Any]] = []
    all_listings: list[dict[str, Any]] = []
    data_files: dict[str, dict[str, list[str]]] = {}

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for old_chunk in DATA_DIR.glob("listings-*-*.json"):
        old_chunk.unlink()

    for platform_key, config in PLATFORMS.items():
        shops_raw = client.get_shops(platform_key)
        shops = [
            compact_shop(item)
            for item in shops_raw
            if isinstance(item, dict)
        ]
        listings = [
            compact_listing(item)
            for item in client.iter_listings(
                platform_key,
                states="all",
                page_size=500,
                progress=lambda state, page, rows, key=platform_key: print(
                    f"{key}: {state} 第 {page} 页，{rows} 条"
                ),
            )
        ]
        counts = Counter(str(item.get("state", "")) for item in listings)
        platform_files: dict[str, list[str]] = {}
        for state in config.states:
            state_rows = [item for item in listings if item.get("state") == state.key]
            state_files: list[str] = []
            for chunk_number, offset in enumerate(
                range(0, len(state_rows), CHUNK_SIZE),
                start=1,
            ):
                filename = (
                    f"listings-{platform_key}-{state.key}-{chunk_number}.json"
                )
                (DATA_DIR / filename).write_text(
                    json.dumps(
                        state_rows[offset : offset + CHUNK_SIZE],
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    encoding="utf-8",
                )
                state_files.append(f"/{filename}")
            platform_files[state.key] = state_files
        data_files[platform_key] = platform_files
        states = [
            {
                "key": state.key,
                "label": STATE_LABELS.get(state.key, state.key),
                "count": counts.get(state.key, 0),
            }
            for state in config.states
        ]
        platforms.append(
            {
                "key": platform_key,
                "name": config.display_name,
                "shop_count": len(shops),
                "listing_count": len(listings),
                "shops": shops,
                "states": states,
            }
        )
        all_listings.extend(listings)

    snapshot_index = {
        "meta": {
            "source": "马帮 ERP 刊登",
            "generated_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(
                timespec="seconds"
            ),
            "timezone": "Asia/Shanghai",
            "mode": "只读快照",
            "platform_count": len(platforms),
            "shop_count": sum(item["shop_count"] for item in platforms),
            "listing_count": len(all_listings),
        },
        "platforms": platforms,
        "data_files": data_files,
    }
    INDEX_PATH.write_text(
        json.dumps(snapshot_index, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"已写入 {INDEX_PATH} 与分片数据，"
        f"{snapshot_index['meta']['shop_count']} 家店铺，"
        f"{snapshot_index['meta']['listing_count']} 条刊登。"
    )


if __name__ == "__main__":
    main()
