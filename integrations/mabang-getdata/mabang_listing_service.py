# -*- coding: utf-8 -*-
"""Local HTTP bridge for the Mabang publishing dashboard.

The service binds to 127.0.0.1 only.  Mabang credentials live in memory for the
current process and are never returned to the browser or written to disk.
Writes use a preview -> explicit confirm action -> serial execution -> fresh
read-back flow.
"""

from __future__ import annotations

import copy
import hmac
import json
import os
import re
import secrets
import threading
import time
import traceback
import unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal, InvalidOperation
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import parse_qs, urlparse


def _hydrate_windows_user_environment(name: str) -> None:
    """Reuse a persisted user environment variable after desktop app restarts."""

    if os.getenv(name, "").strip() or os.name != "nt":
        return
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _value_type = winreg.QueryValueEx(key, name)
        if str(value or "").strip():
            os.environ[name] = str(value)
    except (ImportError, FileNotFoundError, OSError):
        return


_hydrate_windows_user_environment("DEEPSEEK_API_KEY")

from ai_service import (
    AIConfigurationError,
    AIServiceError,
    AIValidationError,
    ai_status,
    generate_listing_material as generate_ai_listing_material,
    generate_preview as generate_ai_preview,
    parse_command as parse_ai_command,
    parse_commands as parse_ai_commands,
    validate_command as validate_ai_command,
)
from mabang_listing_client import (
    extract_shopee_warehouse_stock,
    MabangAuthenticationError,
    MabangListingClient,
    MabangListingError,
    MabangPublishProtocolNotCaptured,
    MabangProtocolError,
    PLATFORMS,
    normalize_listing,
    resolve_platform,
)
from mabang_publisher import (
    PublisherError,
    PublisherManager,
    PublisherNotFoundError,
    PublisherStateError,
    PublisherStore,
    PublisherValidationError,
)


HOST = os.getenv("MABANG_LISTING_HOST", "127.0.0.1")
PORT = int(os.getenv("MABANG_LISTING_PORT", "8877"))
DEFAULT_ACCOUNT_HOST = os.getenv(
    "MABANG_ACCOUNT_HOST",
    "900445.private.mabangerp.com",
).strip()
DEFAULT_OPERATOR = os.getenv("MABANG_LISTING_OPERATOR", "陈泽彬").strip()
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_BATCH_TARGETS = 100
PREVIEW_TTL_SECONDS = 15 * 60
JOB_TTL_SECONDS = 24 * 60 * 60
# Mabang can acknowledge a save before its detail endpoint reflects the store.
# Give the user an immediate "accepted" state, verify products concurrently,
# and retry one idempotent save instead of blocking the whole queue for a minute.
READBACK_RETRY_DELAYS_SECONDS = (0.0, 1.0, 2.0, 4.0, 6.0)
LAZADA_WAREHOUSE_READBACK_DELAYS_SECONDS = (0.0, 1.0, 2.0)
RETRY_READBACK_DELAYS_SECONDS = (0.0, 2.0, 4.0, 6.0, 8.0)
# Mabang's own publishing console polls this task endpoint every second.
BATCH_STATUS_POLL_DELAYS_SECONDS = (0.0,) + (1.0,) * 15
PREVIEW_READ_WORKERS = 6
VERIFY_WORKERS = 4
SHOP_CACHE_TTL_SECONDS = 5 * 60
LISTING_CACHE_TTL_SECONDS = 5 * 60
TARGET_CACHE_TTL_SECONDS = 60
LOCAL_TOKEN = (
    os.getenv("MABANG_LISTING_LOCAL_TOKEN", "").strip()
    or secrets.token_urlsafe(32)
)
INTERNAL_TOKEN = os.getenv("MABANG_LISTING_INTERNAL_TOKEN", "").strip()
ORIGIN_PATTERN = re.compile(r"^http://(?:127\.0\.0\.1|localhost)(?::\d+)?$")
DEFAULT_STORAGE_ROOT = (
    Path(__file__).resolve().parent / "mabang-listing-dashboard" / "work"
)
STORAGE_ROOT = Path(
    os.getenv("MABANG_LISTING_STORAGE_ROOT", str(DEFAULT_STORAGE_ROOT))
).expanduser().resolve()
AUDIT_PATH = STORAGE_ROOT / "audit.jsonl"
PUBLISHER_DB_PATH = STORAGE_ROOT / "publisher.db"
PUBLISHER_STORE = PublisherStore(PUBLISHER_DB_PATH)
PUBLISHER = PublisherManager(PUBLISHER_STORE)

SESSION_LOCK = threading.RLock()
CLIENT_REQUEST_LOCK = threading.Lock()
EXECUTION_LOCK = threading.Lock()
STATE_LOCK = threading.RLock()
SESSION: dict[str, Any] = {
    "client": None,
    "username": "",
    "connected_at": "",
}
PREVIEWS: dict[str, dict[str, Any]] = {}
JOBS: dict[str, dict[str, Any]] = {}
SHOP_CACHE: dict[tuple[int, str], tuple[float, list[dict[str, Any]]]] = {}
LISTING_CACHE: dict[tuple[Any, ...], tuple[float, dict[str, Any]]] = {}
TARGET_CACHE: dict[tuple[Any, ...], tuple[float, list[dict[str, str]]]] = {}


def request_authorized(
    *,
    origin: str,
    local_token: str,
    internal_token: str,
) -> bool:
    if INTERNAL_TOKEN and internal_token:
        return hmac.compare_digest(internal_token, INTERNAL_TOKEN)
    if not ORIGIN_PATTERN.fullmatch(origin):
        return False
    return bool(local_token) and hmac.compare_digest(local_token, LOCAL_TOKEN)


FIELD_SPECS: dict[str, dict[str, Any]] = {
    "price": {
        "label": "售价",
        "kind": "decimal",
        "minimum": Decimal("0"),
        "maximum": Decimal("999999999"),
        "scale": 2,
    },
    "special_price": {
        "label": "促销价",
        "kind": "decimal",
        "minimum": Decimal("0"),
        "maximum": Decimal("999999999"),
        "scale": 2,
    },
    "stock": {
        "label": "库存",
        "kind": "integer",
        "minimum": Decimal("0"),
        "maximum": Decimal("9999999"),
        "scale": 0,
    },
    "package_length": {
        "label": "包裹长度",
        "kind": "decimal",
        "minimum": Decimal("0.000001"),
        "maximum": Decimal("99999"),
        "scale": None,
    },
    "package_width": {
        "label": "包裹宽度",
        "kind": "decimal",
        "minimum": Decimal("0.000001"),
        "maximum": Decimal("99999"),
        "scale": None,
    },
    "package_height": {
        "label": "包裹高度",
        "kind": "decimal",
        "minimum": Decimal("0.000001"),
        "maximum": Decimal("99999"),
        "scale": None,
    },
    "package_weight": {
        "label": "包裹重量",
        "kind": "decimal",
        "minimum": Decimal("0.000001"),
        "maximum": Decimal("99999"),
        "scale": None,
    },
}

TEXT_FIELD_SPECS: dict[str, dict[str, Any]] = {
    "sku": {
        "label": "变体 SKU",
        "maximum_length": 50,
    },
    "variation": {
        "label": "规格值",
        "maximum_length": 100,
    },
}

PLATFORM_WRITE_FIELDS: dict[str, set[str]] = {
    "lazada": set(FIELD_SPECS),
    "shopee": {*FIELD_SPECS, *TEXT_FIELD_SPECS},
    "tiktokshop": {*FIELD_SPECS, *TEXT_FIELD_SPECS},
}

PLATFORM_SPECIAL_PRICE_FIELDS = {
    "lazada": "special_price",
    "shopee": "discount_price",
    "tiktokshop": "sale_price",
}

PLATFORM_PRICE_FIELDS = {
    "shopee": "original_price",
}

STATE_LABELS = {
    "online": "在线商品",
    "examining": "审核中",
    "offline": "已下架",
    "prohibited": "平台禁售",
    "deleted": "已删除",
    "sold_out": "已售罄",
    "draft": "草稿",
    "pending": "待处理",
    "deactivated": "已停用",
}


def log(message: str) -> None:
    stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{stamp} - {message}", flush=True)


def now_text() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def public_session() -> dict[str, Any]:
    with SESSION_LOCK:
        connected = SESSION["client"] is not None
        return {
            "connected": connected,
            "username": SESSION["username"] if connected else DEFAULT_OPERATOR,
            "account_host": DEFAULT_ACCOUNT_HOST,
            "connected_at": SESSION["connected_at"] if connected else "",
        }


def require_client() -> MabangListingClient:
    with SESSION_LOCK:
        client = SESSION.get("client")
    if not isinstance(client, MabangListingClient):
        raise MabangAuthenticationError("请先在本地工作台连接马帮账号。")
    return client


def connect(username: str, password: str, account_host: str = "") -> dict[str, Any]:
    if EXECUTION_LOCK.locked():
        raise MabangListingError("批量同步正在执行，完成前不能切换马帮账号。")
    username = str(username or "").strip()
    password = str(password or "")
    host = str(account_host or DEFAULT_ACCOUNT_HOST).strip().strip("/")
    if not username or not password:
        raise ValueError("马帮账号和密码不能为空。")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", host):
        raise ValueError("马帮账号站点格式不正确。")

    client = MabangListingClient(account_host=host)
    client.login(username, password)
    # Open every supported publishing context once so the dashboard can show
    # the actual account scope immediately after login.
    platform_shops: dict[str, list[dict[str, Any]]] = {}
    with CLIENT_REQUEST_LOCK:
        for platform in PLATFORM_WRITE_FIELDS:
            platform_shops[platform] = client.get_shops(platform)
    with SESSION_LOCK:
        SESSION.update(
            client=client,
            username=username,
            connected_at=now_text(),
        )
    with STATE_LOCK:
        PREVIEWS.clear()
        SHOP_CACHE.clear()
        LISTING_CACHE.clear()
        TARGET_CACHE.clear()
        for platform, shops in platform_shops.items():
            SHOP_CACHE[(id(client), platform)] = (
                time.time() + SHOP_CACHE_TTL_SECONDS,
                [normalize_shop(item) for item in shops if isinstance(item, dict)],
            )
    counts = {
        f"{platform}_shop_count": len(shops)
        for platform, shops in platform_shops.items()
    }
    log(
        "马帮刊登会话已连接："
        + username
        + "，"
        + "，".join(
            f"{PLATFORMS[platform].display_name} 店铺 {len(shops)} 家"
            for platform, shops in platform_shops.items()
        )
    )
    return {
        **public_session(),
        **counts,
    }


def disconnect() -> None:
    if EXECUTION_LOCK.locked():
        raise MabangListingError("批量同步正在执行，完成前不能断开马帮账号。")
    with SESSION_LOCK:
        SESSION.update(client=None, username="", connected_at="")
    with STATE_LOCK:
        PREVIEWS.clear()
        SHOP_CACHE.clear()
        LISTING_CACHE.clear()
        TARGET_CACHE.clear()


def platform_catalog() -> list[dict[str, Any]]:
    result = []
    for config in PLATFORMS.values():
        result.append(
            {
                "key": config.key,
                "name": config.display_name,
                "platform_id": config.platform_id,
                "states": [
                    {
                        "key": item.key,
                        "label": STATE_LABELS.get(item.key, item.key),
                        "count_field": item.total_field,
                    }
                    for item in config.states
                ],
                "write_enabled": config.key in PLATFORM_WRITE_FIELDS,
                "write_fields": sorted(PLATFORM_WRITE_FIELDS.get(config.key, set())),
                "write_note": (
                    "价格、库存等字段已验证；SKU/规格受平台权限限制"
                    if config.key == "lazada"
                    else "已接入在线详情、SKU/规格保存与回读"
                ),
            }
        )
    return result


def normalize_shop(raw: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "id": raw.get("id") or raw.get("shop_id") or "",
        "name": raw.get("name") or raw.get("shopName") or "",
        "site": raw.get("amazonsite") or raw.get("site") or raw.get("site_name") or "",
        "currency": raw.get("currency") or "",
        "shop_type": raw.get("shop_type") or raw.get("type") or "",
    }


def _shop_name_key(value: Any) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", "", normalized).casefold()


def _apply_ai_platform_context(
    commands: Sequence[dict[str, Any]],
    active_platform: Any,
) -> list[dict[str, Any]]:
    platform = str(active_platform or "").strip().lower()
    if not platform:
        return [copy.deepcopy(command) for command in commands]
    if platform not in PLATFORM_WRITE_FIELDS:
        raise ValueError("当前页面平台不支持 AI 在线写入。")

    contextualized: list[dict[str, Any]] = []
    for original in commands:
        command = copy.deepcopy(original)
        scope = command["scope"]
        if not scope.get("platforms"):
            scope["platforms"] = [platform]
        contextualized.append(command)
    return contextualized


def _get_shops_cached(
    client: MabangListingClient,
    platform: str,
) -> list[dict[str, Any]]:
    cache_key = (id(client), str(platform).strip().lower())
    with STATE_LOCK:
        cached = SHOP_CACHE.get(cache_key)
        if cached and cached[0] > time.time():
            return copy.deepcopy(cached[1])
    with CLIENT_REQUEST_LOCK:
        rows = client.get_shops(platform)
    shops = [normalize_shop(item) for item in rows if isinstance(item, dict)]
    with STATE_LOCK:
        SHOP_CACHE[cache_key] = (
            time.time() + SHOP_CACHE_TTL_SECONDS,
            copy.deepcopy(shops),
        )
    return shops


def get_shops(platform: str) -> list[dict[str, Any]]:
    return _get_shops_cached(require_client(), platform)


def _safe_listing(raw: Mapping[str, Any], platform: str, state: str) -> dict[str, Any]:
    item = normalize_listing(platform, state, raw)
    item.pop("raw", None)
    for variation in item.get("variants") or []:
        if isinstance(variation, dict):
            variation.pop("raw", None)
    return item


def get_listings(
    platform: str,
    state: str,
    page: int,
    page_size: int,
    shop_ids: Sequence[str],
    search_type: str,
    search_value: str,
    force_refresh: bool = False,
) -> dict[str, Any]:
    client = require_client()
    config = resolve_platform(platform)
    state_config = config.state(state)
    cache_key = (
        id(client),
        config.key,
        state,
        int(page),
        int(page_size),
        tuple(sorted(str(item).strip() for item in shop_ids if str(item).strip())),
        str(search_type or "").strip(),
        str(search_value or "").strip(),
    )
    now = time.time()
    if not force_refresh:
        with STATE_LOCK:
            cached = LISTING_CACHE.get(cache_key)
            if cached and cached[0] > now:
                result = copy.deepcopy(cached[1])
                result["cached"] = True
                return result
    with CLIENT_REQUEST_LOCK:
        payload = client.get_listing_page(
            config,
            state=state,
            page=page,
            page_size=page_size,
            shop_ids=shop_ids,
            search_type=search_type,
            search_value=search_value,
        )
    raw_rows = payload.get("data") or []
    if not isinstance(raw_rows, list):
        raise MabangProtocolError("马帮刊登列表响应的 data 不是列表。")
    rows = [
        _safe_listing(item, config.key, state)
        for item in raw_rows
        if isinstance(item, dict)
    ]
    totals = payload.get("total")
    if not isinstance(totals, dict):
        totals = {}
    raw_total = totals.get(state_config.total_field)
    try:
        total = int(raw_total)
    except (TypeError, ValueError):
        raw_total = payload.get("count") or payload.get("total_count")
        try:
            total = int(raw_total)
        except (TypeError, ValueError):
            total = len(rows)
    result = {
        "items": rows,
        "page": page,
        "page_size": page_size,
        "total": total,
        "totals": totals,
        "fetched_at": now_text(),
        "cached": False,
    }
    with STATE_LOCK:
        for key, (expires_at, _) in list(LISTING_CACHE.items()):
            if expires_at <= now:
                LISTING_CACHE.pop(key, None)
        LISTING_CACHE[cache_key] = (
            now + LISTING_CACHE_TTL_SECONDS,
            copy.deepcopy(result),
        )
    return result


def _decimal(value: Any, label: str) -> Decimal:
    try:
        parsed = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        raise ValueError(f"{label}不是有效数字。") from None
    if not parsed.is_finite():
        raise ValueError(f"{label}不是有限数字。")
    return parsed


def _format_decimal(value: Decimal, old_value: Any, spec: Mapping[str, Any]) -> Any:
    kind = spec["kind"]
    if kind == "integer":
        if value != value.to_integral_value():
            raise ValueError(f"{spec['label']}必须是整数。")
        rendered = str(int(value))
    else:
        scale = spec.get("scale")
        if scale is None:
            rendered = format(value.normalize(), "f")
            if "." in rendered:
                rendered = rendered.rstrip("0").rstrip(".")
        else:
            quantum = Decimal(1).scaleb(-int(scale))
            rendered = format(value.quantize(quantum), f".{scale}f")

    if isinstance(old_value, int) and kind == "integer":
        return int(rendered)
    if isinstance(old_value, float):
        return float(rendered)
    return rendered


def _field_label(
    field: str,
    spec_name: str = "",
    platform: str = "",
) -> str:
    if platform == "shopee":
        if field == "price":
            return "原价"
        if field == "special_price":
            return "售价"
    if field in FIELD_SPECS:
        return str(FIELD_SPECS[field]["label"])
    if field == "variation" and spec_name:
        return f"规格（{spec_name}）"
    if field in TEXT_FIELD_SPECS:
        return str(TEXT_FIELD_SPECS[field]["label"])
    return field or "未知字段"


def _validate_text_value(field: str, value: Any) -> str:
    spec = TEXT_FIELD_SPECS[field]
    rendered = str(value or "").strip()
    if not rendered:
        raise ValueError(f"{spec['label']}不能为空。")
    if len(rendered) > int(spec["maximum_length"]):
        raise ValueError(
            f"{spec['label']}不能超过 {spec['maximum_length']} 个字符。"
        )
    if any(ord(character) < 32 for character in rendered):
        raise ValueError(f"{spec['label']}不能包含控制字符。")
    if field == "sku" and re.search(r"[\u3400-\u9fff]", rendered):
        raise ValueError("Shopee / TikTok Shop 变体 SKU 不能包含中文。")
    return rendered


def _calculate_new_value(old_value: Any, operation: Mapping[str, Any]) -> Any:
    field = str(operation.get("field") or "").strip()
    if field in TEXT_FIELD_SPECS:
        mode = str(operation.get("mode") or "replace").strip().lower()
        if mode not in {"replace", "set"}:
            raise ValueError(f"{TEXT_FIELD_SPECS[field]['label']}仅支持替换。")
        return _validate_text_value(field, operation.get("value"))

    spec = FIELD_SPECS.get(field)
    if not spec:
        raise ValueError(f"不支持批量修改字段：{field or '空字段'}。")

    mode = str(operation.get("mode") or "set").strip().lower()
    operand = _decimal(operation.get("value"), f"{spec['label']}目标值")
    old_number = _decimal(old_value, f"{spec['label']}原值")
    if mode == "set":
        result = operand
    elif mode == "add":
        result = old_number + operand
    elif mode == "percent":
        if spec["kind"] == "integer":
            raise ValueError("库存暂不支持百分比修改，请使用设置或增减。")
        result = old_number * (Decimal("1") + operand / Decimal("100"))
    else:
        raise ValueError(f"不支持的修改方式：{mode}。")

    if result < spec["minimum"] or result > spec["maximum"]:
        raise ValueError(
            f"{spec['label']}修改结果 {result} 超出允许范围 "
            f"{spec['minimum']}～{spec['maximum']}。"
        )
    return _format_decimal(result, old_value, spec)


def _variation_key(variation: Mapping[str, Any]) -> str:
    return str(
        variation.get("sku_id")
        or variation.get("variation_id")
        or variation.get("id")
        or variation.get("sku")
        or ""
    )


def _values_equal(left: Any, right: Any) -> bool:
    try:
        return _decimal(left, "值") == _decimal(right, "值")
    except ValueError:
        return str(left) == str(right)


def _validate_operations(operations: Any) -> list[dict[str, Any]]:
    if not isinstance(operations, list) or not operations:
        raise ValueError("至少需要一项修改。")
    if len(operations) > len(FIELD_SPECS) + len(TEXT_FIELD_SPECS):
        raise ValueError("单次任务的修改字段过多。")
    normalized = []
    seen: set[tuple[str, str]] = set()
    for operation in operations:
        if not isinstance(operation, dict):
            raise ValueError("修改项格式不正确。")
        field = str(operation.get("field") or "").strip()
        spec_name = str(operation.get("spec_name") or "").strip()
        warehouse_key = str(operation.get("warehouse_key") or "").strip()
        if warehouse_key and field != "stock":
            raise ValueError("A warehouse can only be selected for a stock change.")
        if field == "variation" and not spec_name:
            raise ValueError("修改规格值时必须填写规格名称，例如 Color 或 Size。")
        field_key = (field, spec_name.casefold())
        if field_key in seen:
            raise ValueError(f"字段 {_field_label(field, spec_name)} 在同一任务中重复出现。")
        # Validate field/mode/value with a neutral old value.  The real value is
        # checked again for each matched variation.
        neutral = "1" if field.startswith("package_") else "0"
        _calculate_new_value(neutral, operation)
        seen.add(field_key)
        normalized.append(
            {
                "field": field,
                "mode": str(
                    operation.get("mode")
                    or ("replace" if field in TEXT_FIELD_SPECS else "set")
                ).strip().lower(),
                "value": str(operation.get("value") or "").strip(),
                "spec_name": spec_name,
                "warehouse_key": warehouse_key,
            }
        )
    return normalized


def _validate_targets(targets: Any) -> list[dict[str, str]]:
    if not isinstance(targets, list) or not targets:
        raise ValueError("请先选择需要修改的在线商品。")
    if len(targets) > MAX_BATCH_TARGETS:
        raise ValueError(f"单次最多选择 {MAX_BATCH_TARGETS} 个商品。")
    result = []
    seen: set[tuple[str, str]] = set()
    for raw in targets:
        if not isinstance(raw, dict):
            raise ValueError("批量目标格式不正确。")
        platform = str(raw.get("platform") or "").strip().lower()
        internal_id = str(raw.get("internal_id") or "").strip()
        if platform not in PLATFORM_WRITE_FIELDS:
            raise ValueError(f"当前平台 {platform or '为空'} 尚未开放在线写入。")
        if not internal_id:
            raise ValueError("选中商品缺少马帮刊登内部 ID。")
        key = (platform, internal_id)
        if key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "platform": platform,
                "internal_id": internal_id,
                "product_id": str(raw.get("product_id") or ""),
                "shop_name": str(raw.get("shop_name") or ""),
                "title": str(raw.get("title") or ""),
            }
        )
    return result


def _targets_from_query(
    client: MabangListingClient,
    target_query: Any,
) -> list[dict[str, str]]:
    """Resolve an entire filtered result set without relying on the visible page."""

    if not isinstance(target_query, dict):
        raise ValueError("跨页选择缺少有效的筛选范围。")

    platform = str(target_query.get("platform") or "lazada").strip().lower()
    state = str(target_query.get("state") or "online").strip().lower()
    if platform not in PLATFORM_WRITE_FIELDS:
        raise ValueError(f"当前平台 {platform or '为空'} 尚未开放在线写入。")
    if state != "online":
        raise ValueError("当前批量写入仅开放在线商品。")

    shop_ids = [
        str(item).strip()
        for item in (target_query.get("shop_ids") or [])
        if str(item).strip()
    ]
    search_type = str(target_query.get("search_type") or "").strip()
    search_value = str(target_query.get("search_value") or "").strip()
    allowed_search_types = {"", "title", "sku", "variation_sku", "product_id"}
    if search_type not in allowed_search_types:
        raise ValueError(f"不支持的商品搜索字段：{search_type}。")
    # Mabang's current publishing API uses `sku` for both parent and variant
    # SKU. `variation_sku` is silently ignored and returns the whole shop.
    api_search_type = "sku" if search_type == "variation_sku" else search_type

    category_ids = {
        str(item).strip()
        for item in (target_query.get("category_ids") or [])
        if str(item).strip()
    }
    cache_key = (
        id(client),
        platform,
        state,
        tuple(sorted(shop_ids)),
        api_search_type,
        search_value.casefold(),
        tuple(sorted(category_ids)),
    )
    with STATE_LOCK:
        cached = TARGET_CACHE.get(cache_key)
        if cached and cached[0] > time.time():
            return copy.deepcopy(cached[1])

    targets: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    with CLIENT_REQUEST_LOCK:
        pages = client.iter_listing_pages(
            platform,
            states=(state,),
            page_size=500,
            shop_ids=shop_ids,
            search_type=api_search_type,
            search_value=search_value,
        )
        for page_state, payload in pages:
            for raw in payload.get("data") or []:
                if not isinstance(raw, dict):
                    continue
                listing = _safe_listing(raw, platform, page_state)
                if category_ids and str(listing.get("category_id") or "") not in category_ids:
                    continue
                internal_id = str(listing.get("internal_id") or "").strip()
                if not internal_id:
                    continue
                key = (platform, internal_id)
                if key in seen:
                    continue
                seen.add(key)
                targets.append(
                    {
                        "platform": platform,
                        "internal_id": internal_id,
                        "product_id": str(listing.get("product_id") or ""),
                        "shop_name": str(listing.get("shop_name") or ""),
                        "title": str(listing.get("title") or ""),
                    }
                )
                if len(targets) > MAX_BATCH_TARGETS:
                    raise ValueError(
                        f"当前筛选命中超过 {MAX_BATCH_TARGETS} 个商品。为避免误操作，"
                        "请增加平台、国家、店铺、类目或 SKU 条件后再生成预览。"
                    )

    if not targets:
        raise ValueError(
            f"当前范围没有匹配到可修改的 {PLATFORMS[platform].display_name} 在线商品。"
        )
    with STATE_LOCK:
        TARGET_CACHE[cache_key] = (
            time.time() + TARGET_CACHE_TTL_SECONDS,
            copy.deepcopy(targets),
        )
    return targets


def _operation_from_ai(command: Mapping[str, Any]) -> dict[str, str]:
    operation = command["operation"]
    field = str(operation.get("field") or "").strip()
    mode = str(operation.get("mode") or "").strip()
    value = operation.get("value")
    if field == "sku":
        return {
            "field": "sku",
            "mode": "replace",
            "value": _validate_text_value("sku", value),
            "spec_name": "",
        }
    if field == "variation":
        if not isinstance(value, Mapping):
            raise ValueError("规格修改必须同时包含规格名称和新规格值。")
        spec_name = str(value.get("name") or value.get("spec_name") or "").strip()
        spec_value = value.get("value")
        if not spec_name:
            raise ValueError("规格修改缺少规格名称，例如 Color 或 Size。")
        return {
            "field": "variation",
            "mode": "replace",
            "value": _validate_text_value("variation", spec_value),
            "spec_name": spec_name,
        }
    if field not in FIELD_SPECS:
        raise ValueError("该 AI 指令尚未映射到可安全写入的商品字段。")

    if mode == "set":
        service_mode = "set"
        service_value = value
    elif mode == "increase_amount":
        service_mode = "add"
        service_value = abs(float(value))
    elif mode == "decrease_amount":
        service_mode = "add"
        service_value = -abs(float(value))
    elif mode == "increase_percent":
        service_mode = "percent"
        service_value = abs(float(value))
    elif mode == "decrease_percent":
        service_mode = "percent"
        service_value = -abs(float(value))
    else:
        raise ValueError(f"AI解析出的修改方式暂不支持执行：{mode or '空值'}。")

    if field == "stock" and service_mode == "percent":
        raise ValueError("库存暂不支持按百分比修改，请改用“设为”或“增加/减少数量”。")
    return {
        "field": field,
        "mode": service_mode,
        "value": str(service_value),
        "spec_name": "",
    }


def _resolve_ai_target_query(
    client: MabangListingClient,
    command: Mapping[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    scope = command["scope"]
    target = command["target"]
    platforms = [str(item).strip().lower() for item in scope.get("platforms") or []]
    if not platforms:
        platforms = ["lazada"]
    if len(set(platforms)) != 1:
        raise ValueError("单条 AI 指令只能指定一个平台，请拆成多行指令。")
    platform = platforms[0]
    if platform not in PLATFORM_WRITE_FIELDS:
        raise ValueError(f"{platform} 尚未开放 AI 在线写入。")

    requested_shop_ids = {
        str(item).strip() for item in scope.get("shop_ids") or [] if str(item).strip()
    }
    requested_shop_name_values = [
        str(item).strip()
        for item in scope.get("shop_names") or []
        if str(item).strip()
    ]
    requested_shop_name_keys = [
        _shop_name_key(item) for item in requested_shop_name_values
    ]
    requested_countries = {
        str(item).strip().upper()
        for item in scope.get("countries") or []
        if str(item).strip()
    }
    shops = _get_shops_cached(client, platform)
    authorized_shops_by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for shop in shops:
        key = _shop_name_key(shop.get("name"))
        if key:
            authorized_shops_by_name[key].append(shop)

    unknown_shop_names: list[str] = []
    ambiguous_shop_names: list[tuple[str, list[str]]] = []
    resolved_shop_name_keys: set[str] = set()
    for original, key in zip(requested_shop_name_values, requested_shop_name_keys):
        candidates = authorized_shops_by_name.get(key, [])
        if not candidates:
            unknown_shop_names.append(original)
            continue
        unique_candidates = {
            (
                str(shop.get("id") or ""),
                str(shop.get("name") or ""),
                str(shop.get("site") or ""),
            )
            for shop in candidates
        }
        if len(unique_candidates) > 1:
            ambiguous_shop_names.append(
                (
                    original,
                    sorted(
                        {
                            str(shop.get("name") or "").strip()
                            for shop in candidates
                            if str(shop.get("name") or "").strip()
                        }
                    ),
                )
            )
            continue
        resolved_shop_name_keys.add(key)

    if unknown_shop_names:
        raise ValueError(
            "没有找到授权店铺："
            + "、".join(unknown_shop_names)
            + "。店铺名已忽略大小写和空格，仍未匹配；请输入完整名称。"
        )
    if ambiguous_shop_names:
        details = "；".join(
            f"{requested} → {', '.join(candidates)}"
            for requested, candidates in ambiguous_shop_names
        )
        raise ValueError(
            "店铺名称忽略大小写和空格后匹配到多个授权店铺："
            + details
            + "。为避免误操作，请使用店铺 ID 或更准确的授权名称。"
        )

    def shop_matches(shop: Mapping[str, Any]) -> bool:
        shop_id = str(shop.get("id") or "")
        shop_name_key = _shop_name_key(shop.get("name"))
        site = str(shop.get("site") or "").strip().upper()
        if requested_shop_ids and shop_id not in requested_shop_ids:
            return False
        if resolved_shop_name_keys and shop_name_key not in resolved_shop_name_keys:
            return False
        if requested_countries and site not in requested_countries:
            return False
        return True

    has_shop_scope = bool(
        requested_shop_ids or requested_shop_name_keys or requested_countries
    )
    matched_shops = [shop for shop in shops if shop_matches(shop)]
    if has_shop_scope and not matched_shops:
        raise ValueError("AI 指令指定的国家或店铺不在当前马帮账号授权范围内。")

    sku = str(target.get("sku") or "").strip()
    parent_sku = str(target.get("parent_sku") or "").strip()
    category_values = [
        str(item).strip()
        for item in [
            target.get("category"),
            *(scope.get("categories") or []),
        ]
        if str(item or "").strip()
    ]
    invalid_categories = [item for item in category_values if not item.isdigit()]
    if invalid_categories:
        raise ValueError(
            "当前马帮列表只返回类目 ID，尚不能把类目名称“"
            + "、".join(dict.fromkeys(invalid_categories))
            + "”安全映射到商品。请补充 SKU，或改用马帮类目 ID。"
        )

    if sku:
        search_type, search_value = "sku", sku
    elif parent_sku:
        search_type, search_value = "sku", parent_sku
    else:
        search_type, search_value = "", ""

    query = {
        "platform": platform,
        "state": "online",
        "shop_ids": [
            str(shop.get("id") or "") for shop in matched_shops
        ] if has_shop_scope else [],
        "search_type": search_type,
        "search_value": search_value,
        "category_ids": list(dict.fromkeys(category_values)),
    }
    resolved = {
        "platform": platform,
        "countries": sorted(requested_countries),
        "shops": [
            {
                "id": str(shop.get("id") or ""),
                "name": str(shop.get("name") or ""),
                "site": str(shop.get("site") or ""),
            }
            for shop in matched_shops
        ] if has_shop_scope else [],
        "sku": sku,
        "parent_sku": parent_sku,
        "category_ids": query["category_ids"],
    }
    return query, resolved


def _combine_ai_preview_tokens(
    preview_tokens: Sequence[str],
) -> dict[str, Any]:
    """Combine independently resolved AI instructions into one confirmable preview."""

    if not preview_tokens:
        raise ValueError("没有可合并的 AI 修改预览。")

    targets: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    operations: list[dict[str, Any]] = []
    warnings: list[str] = []
    match_skus: list[str] = []
    seen_targets: set[tuple[str, str]] = set()
    seen_changes: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}

    with STATE_LOCK:
        raw_previews: list[dict[str, Any]] = []
        for token in preview_tokens:
            preview = PREVIEWS.get(token)
            if not preview:
                raise ValueError("AI 子预览已过期，请重新生成。")
            raw_previews.append(copy.deepcopy(preview))

        for command_index, preview in enumerate(raw_previews, start=1):
            for target in preview["targets"]:
                target_key = (
                    str(target.get("platform") or ""),
                    str(target.get("internal_id") or ""),
                )
                if target_key not in seen_targets:
                    seen_targets.add(target_key)
                    targets.append(target)
            operations.extend(preview["operations"])
            sku = str(preview.get("match_sku") or "").strip()
            if sku and sku not in match_skus:
                match_skus.append(sku)
            for warning in preview["warnings"]:
                if warning not in warnings:
                    warnings.append(warning)
            for change in preview["changes"]:
                change["source_command_index"] = command_index
                change_key = (
                    str(change.get("platform") or ""),
                    str(change.get("internal_id") or ""),
                    str(change.get("variation_key") or ""),
                    str(change.get("field") or ""),
                    str(change.get("spec_name") or "").casefold(),
                )
                previous = seen_changes.get(change_key)
                if previous is not None:
                    if not _values_equal(
                        previous.get("new_value"),
                        change.get("new_value"),
                    ):
                        raise ValueError(
                            "多条指令对同一店铺、SKU 和字段给出了不同目标值，"
                            "请删除冲突指令后重试。"
                        )
                    continue
                seen_changes[change_key] = change
                changes.append(change)

        token = secrets.token_urlsafe(24)
        now = time.time()
        combined = {
            "preview_token": token,
            "created_ts": now,
            "created_at": now_text(),
            "expires_at_ts": now + PREVIEW_TTL_SECONDS,
            "targets": targets,
            "operations": operations,
            "match_sku": "、".join(match_skus),
            "changes": changes,
            "warnings": warnings,
            "command_count": len(raw_previews),
            "job_id": "",
        }
        for old_token in preview_tokens:
            PREVIEWS.pop(old_token, None)
        PREVIEWS[token] = combined
    return public_preview(combined)


def _instruction_segments(text: str) -> list[str]:
    return [
        re.sub(r"^\s*(?:[-*]|\d+[.、)])\s*", "", item).strip()
        for item in re.split(r"(?:\r?\n)+|[；;]+", text)
        if item.strip()
    ]


def _source_segment_for_command(
    commands: Sequence[dict[str, Any]],
    index: int,
    source_text: str,
) -> str:
    segments = _instruction_segments(source_text)
    command = commands[index]
    sku = str(command["target"].get("sku") or "").casefold()
    sku_segments = [
        segment for segment in segments if sku and sku in segment.casefold()
    ]
    if len(sku_segments) == 1:
        return sku_segments[0]
    if len(segments) == len(commands):
        return segments[index]
    return source_text


def _apply_ai_default_price_fields(
    commands: Sequence[dict[str, Any]],
    source_text: str,
) -> list[dict[str, Any]]:
    """Apply deterministic platform defaults when a price phrase is ambiguous."""

    normalized_source = unicodedata.normalize("NFKC", source_text).strip()
    if not normalized_source:
        return [copy.deepcopy(command) for command in commands]

    adjusted: list[dict[str, Any]] = []
    for index, original in enumerate(commands):
        command = copy.deepcopy(original)
        operation = command["operation"]
        if (
            command.get("action") not in {"price_update", "promotion_update"}
            and operation.get("field") not in {"price", "special_price"}
        ):
            adjusted.append(command)
            continue

        platforms = {
            str(item).strip().lower()
            for item in command["scope"].get("platforms") or []
            if str(item).strip()
        }
        if len(platforms) != 1:
            adjusted.append(command)
            continue
        platform = next(iter(platforms))
        source_segment = unicodedata.normalize(
            "NFKC",
            _source_segment_for_command(commands, index, normalized_source),
        ).casefold()

        if platform == "shopee":
            use_base_price = "原价" in source_segment or "original price" in source_segment
            if not use_base_price and any(
                term in source_segment
                for term in ("售价", "折扣价", "促销价", "价格", "改价", "selling price")
            ):
                command["action"] = "promotion_update"
                operation["field"] = "special_price"
            elif use_base_price:
                command["action"] = "price_update"
                operation["field"] = "price"
        elif platform == "lazada":
            use_base_price = any(
                term in source_segment
                for term in ("原价", "售价", "基础价", "基础价格", "selling price")
            )
            use_promotion_price = any(
                term in source_segment
                for term in ("促销价", "折扣价", "special price", "promotion price")
            )
            generic_price = (
                "价格" in source_segment or "改价" in source_segment
            ) and not use_base_price
            if use_promotion_price or generic_price:
                command["action"] = "promotion_update"
                operation["field"] = "special_price"
            elif use_base_price:
                command["action"] = "price_update"
                operation["field"] = "price"
        adjusted.append(command)
    return adjusted


def _restore_authorized_shop_scopes(
    client: MabangListingClient,
    commands: Sequence[dict[str, Any]],
    source_text: str,
) -> list[dict[str, Any]]:
    """Recover explicitly named shops when the model omits shop_names."""

    restored: list[dict[str, Any]] = []
    for index, original in enumerate(commands):
        command = copy.deepcopy(original)
        scope = command["scope"]
        if scope.get("shop_ids"):
            restored.append(command)
            continue
        command_platforms = [
            str(item).strip().lower()
            for item in scope.get("platforms") or []
            if str(item).strip()
        ]
        platform = command_platforms[0] if len(set(command_platforms)) == 1 else "lazada"
        authorized_shops = (
            _get_shops_cached(client, platform)
            if platform in PLATFORM_WRITE_FIELDS
            else []
        )

        source_segment = _source_segment_for_command(commands, index, source_text)
        folded_segment = source_segment.casefold()
        matches_by_end: dict[int, str] = {}
        for shop in authorized_shops:
            name = str(shop.get("name") or "").strip()
            if not name:
                continue
            for match in re.finditer(
                re.escape(name.casefold()) + r"\s*店铺",
                folded_segment,
            ):
                previous = matches_by_end.get(match.end())
                if previous is None or len(name) > len(previous):
                    matches_by_end[match.end()] = name
        matched_names = list(dict.fromkeys(matches_by_end.values()))
        if matched_names:
            # The authorized Mabang shop list is the source of truth. This also
            # repairs model output such as an accidental "店铺" suffix.
            scope["shop_names"] = list(dict.fromkeys(matched_names))
        restored.append(command)
    return restored


def _apply_ai_warehouse_recommendation(
    preview_token: str,
) -> tuple[dict[str, Any], bool]:
    """Finalize an AI stock preview using warehouse data already read once."""

    with STATE_LOCK:
        preview = PREVIEWS.get(preview_token)
        if not preview:
            raise ValueError("AI preview expired before warehouse selection.")
        managed_changes = [
            change
            for change in preview["changes"]
            if str(change.get("field") or "") == "stock"
            and bool(change.get("warehouse_managed"))
        ]
        if not managed_changes:
            return public_preview(preview), False

        option_sets = [
            [
                dict(option)
                for option in change.get("warehouse_options") or []
                if isinstance(option, Mapping)
            ]
            for change in managed_changes
        ]
        if any(not options for options in option_sets):
            return public_preview(preview), True

        summary = _summarize_warehouse_options(
            option_sets,
            target_count=len(preview["targets"]),
        )
        warehouse_key = str(
            summary.get("recommended_warehouse_key") or ""
        )
        if not warehouse_key:
            return public_preview(preview), True

        operations = [
            dict(operation) for operation in preview.get("operations") or []
        ]
        stock_operation = next(
            (
                operation
                for operation in operations
                if str(operation.get("field") or "") == "stock"
            ),
            None,
        )
        if stock_operation is None:
            raise ValueError("AI stock preview has no stock operation.")

        for change, options in zip(managed_changes, option_sets):
            selected = next(
                (
                    option
                    for option in options
                    if str(option.get("key") or "") == warehouse_key
                ),
                None,
            )
            if selected is None:
                return public_preview(preview), True
            old_value = int(str(selected.get("stock") or "0"))
            effective_operation = {
                **stock_operation,
                "warehouse_key": warehouse_key,
                "warehouse_label": str(selected.get("label") or ""),
            }
            change.update(
                warehouse_key=warehouse_key,
                warehouse_label=str(selected.get("label") or ""),
                old_value=old_value,
                new_value=_calculate_new_value(
                    old_value,
                    effective_operation,
                ),
            )

        preview["operations"] = [
            {
                **operation,
                "warehouse_key": warehouse_key,
            }
            if str(operation.get("field") or "") == "stock"
            else operation
            for operation in operations
        ]
        return public_preview(preview), False


def create_ai_scope_preview(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Parse one or more natural-language instructions into one safe preview."""

    client = require_client()
    source_text = str(payload.get("command") or "")
    provided_commands = payload.get("parsed_commands")
    provided_command = payload.get("parsed_command")
    if isinstance(provided_commands, list) and provided_commands:
        commands = [
            validate_ai_command(item)
            for item in provided_commands
            if isinstance(item, Mapping)
        ]
        if len(commands) != len(provided_commands):
            raise ValueError("parsed_commands 中包含无效指令。")
    elif isinstance(provided_command, dict):
        commands = [validate_ai_command(provided_command)]
    else:
        commands = parse_ai_commands(source_text)
    commands = _apply_ai_platform_context(
        commands,
        payload.get("active_platform"),
    )
    commands = _apply_ai_default_price_fields(commands, source_text)
    commands = _restore_authorized_shop_scopes(client, commands, source_text)

    intents: list[dict[str, Any]] = []
    resolved_scopes: list[dict[str, Any]] = []
    preview_tokens: list[str] = []
    warehouse_selection_required = False
    for index, command in enumerate(commands, start=1):
        if command["clarifications"]:
            raise ValueError(
                f"第 {index} 条指令需要补充信息："
                + "；".join(command["clarifications"])
            )
        intent = generate_ai_preview(command)
        target_query, resolved_scope = _resolve_ai_target_query(client, command)
        operation = _operation_from_ai(command)
        try:
            targets = _targets_from_query(client, target_query)
            child_preview = create_preview(
                {
                    "targets": targets,
                    "match_sku": str(command["target"].get("sku") or ""),
                    "operations": [operation],
                }
            )
            if (
                operation["field"] == "stock"
                and resolved_scope["platform"] in {"lazada", "shopee"}
                and any(
                    bool(change.get("warehouse_managed"))
                    for change in child_preview["changes"]
                )
            ):
                (
                    child_preview,
                    selection_required,
                ) = _apply_ai_warehouse_recommendation(
                    child_preview["preview_token"]
                )
                warehouse_selection_required = (
                    warehouse_selection_required or selection_required
                )
        except Exception as exc:
            raise ValueError(f"第 {index} 条指令无法生成预览：{exc}") from None
        intents.append(intent)
        resolved_scopes.append(resolved_scope)
        preview_tokens.append(child_preview["preview_token"])

    batch_preview = (
        public_preview(PREVIEWS[preview_tokens[0]])
        if len(preview_tokens) == 1
        else _combine_ai_preview_tokens(preview_tokens)
    )
    if len(preview_tokens) == 1:
        with STATE_LOCK:
            PREVIEWS[preview_tokens[0]]["command_count"] = 1
        batch_preview["command_count"] = 1

    return {
        "provider": ai_status(),
        # Keep singular fields for older local frontends.
        "command": commands[0],
        "intent_preview": intents[0],
        "resolved_scope": resolved_scopes[0],
        "commands": commands,
        "intent_previews": intents,
        "resolved_scopes": resolved_scopes,
        "batch_preview": batch_preview,
        "warehouse_selection_required": warehouse_selection_required,
    }


def _variation_sku_values(variation: Mapping[str, Any]) -> list[str]:
    values: list[str] = []
    for key in ("sku", "seller_sku", "platform_sku", "vsku"):
        value = str(variation.get(key) or "").strip()
        if value and value.casefold() not in {item.casefold() for item in values}:
            values.append(value)
    return values


def _variation_sku_match(
    variation: Mapping[str, Any],
    match_sku: str,
) -> dict[str, str] | None:
    requested = match_sku.strip()
    needle = requested.casefold()
    if not needle:
        return {
            "match_type": "all",
            "requested_sku": "",
            "matched_sku": str(variation.get("sku") or ""),
            "virtual_suffix": "",
        }

    values = _variation_sku_values(variation)
    primary = str(variation.get("sku") or "").strip()
    ordered = ([primary] if primary else []) + [
        value for value in values if value.casefold() != primary.casefold()
    ]
    virtual_pattern = re.compile(
        rf"^{re.escape(requested)}(S[1-9])$",
        flags=re.IGNORECASE,
    )
    for value in ordered:
        if value.casefold() == needle:
            return {
                "match_type": "exact",
                "requested_sku": requested,
                "matched_sku": value,
                "virtual_suffix": "",
            }
        virtual_match = virtual_pattern.fullmatch(value)
        if virtual_match:
            return {
                "match_type": "virtual",
                "requested_sku": requested,
                "matched_sku": value,
                "virtual_suffix": virtual_match.group(1).upper(),
            }
    return None


def _matched_variations(detail: Mapping[str, Any], match_sku: str) -> list[dict[str, Any]]:
    variations = detail.get("variations")
    if not isinstance(variations, list):
        raise MabangProtocolError("在线商品详情缺少 variations 列表。")
    valid = [item for item in variations if isinstance(item, dict)]
    needle = match_sku.strip().casefold()
    if not needle:
        return valid
    return [
        item
        for item in valid
        if _variation_sku_match(item, match_sku) is not None
    ]


def _storage_field(platform: str, field: str) -> str:
    if field == "price":
        return PLATFORM_PRICE_FIELDS.get(platform, field)
    if field == "special_price":
        return PLATFORM_SPECIAL_PRICE_FIELDS.get(platform, field)
    return field


def _shopee_spec_selection(
    detail: Mapping[str, Any],
    matched: Sequence[Mapping[str, Any]],
    spec_name: str,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    tiers = detail.get("tierVariationOption")
    variations = detail.get("variations")
    if not isinstance(tiers, list) or not isinstance(variations, list):
        raise MabangProtocolError("Shopee 在线详情缺少规格或变体列表。")
    folded = spec_name.casefold()
    dimension_index = next(
        (
            index
            for index, tier in enumerate(tiers)
            if isinstance(tier, Mapping)
            and str(
                tier.get("name") or tier.get("variation_name") or ""
            ).strip().casefold()
            == folded
        ),
        -1,
    )
    if dimension_index < 0:
        available = [
            str(tier.get("name") or tier.get("variation_name") or "").strip()
            for tier in tiers
            if isinstance(tier, Mapping)
        ]
        raise ValueError(
            f"Shopee 商品没有规格“{spec_name}”；可选："
            + "、".join(item for item in available if item)
        )
    tier = tiers[dimension_index]
    options = tier.get("option_list") or tier.get("variation_option_list")
    if not isinstance(options, list):
        raise MabangProtocolError(f"Shopee 规格“{spec_name}”缺少选项列表。")

    selected_indexes: set[int] = set()
    for variation in matched:
        tier_index = variation.get("tier_index")
        if not isinstance(tier_index, list) or dimension_index >= len(tier_index):
            raise MabangProtocolError(
                f"Shopee 变体 {variation.get('sku') or ''} 缺少规格索引。"
            )
        try:
            selected_indexes.add(int(tier_index[dimension_index]))
        except (TypeError, ValueError):
            raise MabangProtocolError("Shopee 变体规格索引格式不正确。") from None

    result: list[tuple[dict[str, Any], dict[str, Any]]] = []
    actual_name = str(tier.get("name") or tier.get("variation_name") or spec_name)
    for variation in variations:
        if not isinstance(variation, dict):
            continue
        tier_index = variation.get("tier_index")
        if not isinstance(tier_index, list) or dimension_index >= len(tier_index):
            continue
        try:
            option_index = int(tier_index[dimension_index])
        except (TypeError, ValueError):
            continue
        if option_index not in selected_indexes:
            continue
        if option_index < 0 or option_index >= len(options):
            raise MabangProtocolError("Shopee 规格选项索引超出范围。")
        option = options[option_index]
        if not isinstance(option, Mapping):
            raise MabangProtocolError("Shopee 规格选项格式不正确。")
        result.append(
            (
                variation,
                {
                    "spec_name": actual_name,
                    "variation_dimension_index": dimension_index,
                    "variation_option_index": option_index,
                    "old_value": str(
                        option.get("option")
                        or option.get("variation_option_name")
                        or ""
                    ),
                },
            )
        )
    return result


def _tiktok_attribute(
    variation: Mapping[str, Any],
    spec_name: str,
) -> dict[str, Any] | None:
    attributes = variation.get("attributes")
    if not isinstance(attributes, list):
        return None
    folded = spec_name.casefold()
    return next(
        (
            item
            for item in attributes
            if isinstance(item, dict)
            and str(
                item.get("name")
                or item.get("attributeName")
                or item.get("attribute_name")
                or ""
            ).strip().casefold()
            == folded
        ),
        None,
    )


def _tiktok_spec_selection(
    detail: Mapping[str, Any],
    matched: Sequence[Mapping[str, Any]],
    spec_name: str,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    variations = detail.get("variations")
    if not isinstance(variations, list):
        raise MabangProtocolError("TikTok Shop 在线详情缺少 variations 列表。")
    identities: set[tuple[str, str, str]] = set()
    actual_name = spec_name
    for variation in matched:
        attribute = _tiktok_attribute(variation, spec_name)
        if attribute is None:
            available = [
                str(
                    item.get("name")
                    or item.get("attributeName")
                    or item.get("attribute_name")
                    or ""
                ).strip()
                for item in variation.get("attributes") or []
                if isinstance(item, Mapping)
            ]
            raise ValueError(
                f"TikTok Shop 变体 {variation.get('sku') or ''} 没有规格"
                f"“{spec_name}”；可选：" + "、".join(item for item in available if item)
            )
        actual_name = str(
            attribute.get("name")
            or attribute.get("attributeName")
            or attribute.get("attribute_name")
            or spec_name
        )
        identities.add(
            (
                str(attribute.get("id") or attribute.get("attributeId") or ""),
                str(attribute.get("valueId") or attribute.get("value_id") or ""),
                str(
                    attribute.get("valueName")
                    or attribute.get("customValue")
                    or attribute.get("custom_value")
                    or ""
                ).casefold(),
            )
        )

    result: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for variation in variations:
        if not isinstance(variation, dict):
            continue
        attribute = _tiktok_attribute(variation, actual_name)
        if attribute is None:
            continue
        identity = (
            str(attribute.get("id") or attribute.get("attributeId") or ""),
            str(attribute.get("valueId") or attribute.get("value_id") or ""),
            str(
                attribute.get("valueName")
                or attribute.get("customValue")
                or attribute.get("custom_value")
                or ""
            ).casefold(),
        )
        if identity not in identities:
            continue
        result.append(
            (
                variation,
                {
                    "spec_name": actual_name,
                    "variation_attribute_id": identity[0],
                    "variation_value_id": identity[1],
                    "old_value": str(
                        attribute.get("valueName")
                        or attribute.get("customValue")
                        or attribute.get("custom_value")
                        or ""
                    ),
                },
            )
        )
    return result


def _spec_selection(
    detail: Mapping[str, Any],
    platform: str,
    matched: Sequence[Mapping[str, Any]],
    spec_name: str,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    if platform == "shopee":
        return _shopee_spec_selection(detail, matched, spec_name)
    if platform == "tiktokshop":
        return _tiktok_spec_selection(detail, matched, spec_name)
    raise ValueError("Lazada 当前账号权限不支持修改 SKU 或规格。")


def _validate_price_relationship(
    variation: Mapping[str, Any],
    platform: str = "lazada",
) -> None:
    if platform == "shopee":
        return
    price = variation.get(_storage_field(platform, "price"))
    special = variation.get(_storage_field(platform, "special_price"))
    if price in (None, "") or special in (None, "", "0", "0.0", "0.00"):
        return
    if _decimal(special, _field_label("special_price", platform=platform)) > _decimal(
        price,
        _field_label("price", platform=platform),
    ):
        raise ValueError("促销价不能高于售价。")


def _fetch_details_for_targets(
    client: MabangListingClient,
    targets: Sequence[Mapping[str, str]],
) -> list[tuple[Mapping[str, str], dict[str, Any]]]:
    if len(targets) < 2 or client.__class__ is not MabangListingClient:
        result = []
        for target in targets:
            with CLIENT_REQUEST_LOCK:
                detail = client.get_online_detail(
                    target["platform"],
                    target["internal_id"],
                )
            result.append((target, detail))
        return result

    worker_state = threading.local()

    def fetch(target: Mapping[str, str]) -> tuple[Mapping[str, str], dict[str, Any]]:
        worker_client = getattr(worker_state, "client", None)
        if worker_client is None:
            worker_client = client.clone_authenticated()
            worker_state.client = worker_client
        return (
            target,
            worker_client.get_online_detail(
                target["platform"],
                target["internal_id"],
            ),
        )

    workers = min(PREVIEW_READ_WORKERS, len(targets))
    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="mabang-preview") as pool:
        futures = [pool.submit(fetch, target) for target in targets]
        return [future.result() for future in futures]


def create_preview(payload: Mapping[str, Any]) -> dict[str, Any]:
    client = require_client()
    if payload.get("targets"):
        targets = _validate_targets(payload.get("targets"))
    else:
        targets = _targets_from_query(client, payload.get("target_query"))
    operations = _validate_operations(payload.get("operations"))
    for target in targets:
        platform = target["platform"]
        for operation in operations:
            field = operation["field"]
            if field not in PLATFORM_WRITE_FIELDS.get(platform, set()):
                if platform == "lazada" and field in TEXT_FIELD_SPECS:
                    raise ValueError(
                        "Lazada 当前账号权限不能安全修改 SKU 或规格。"
                    )
                raise ValueError(
                    f"{PLATFORMS[platform].display_name} 尚未开放"
                    f"{_field_label(field, operation.get('spec_name', ''), platform)}写入。"
                )
    match_sku = str(payload.get("match_sku") or "").strip()
    changes: list[dict[str, Any]] = []
    warnings: list[str] = []
    matched_targets: list[dict[str, str]] = []

    has_stock_operation = any(
        operation["field"] == "stock" for operation in operations
    )
    has_price_operation = any(
        operation["field"] in {"price", "special_price"}
        for operation in operations
    )
    for target, detail in _fetch_details_for_targets(client, targets):
        if target["platform"] == "shopee" and has_price_operation:
            # Shopee's ordinary editor detail can lag behind the batch editor
            # and may expose a different selling-price field. Preview against
            # the exact detail contract used by the eventual batch write.
            with CLIENT_REQUEST_LOCK:
                detail = _batch_detail_for_listing(
                    client=client,
                    platform="shopee",
                    internal_id=target["internal_id"],
                    product_id=target["product_id"],
                )
        if target["platform"] == "shopee" and has_stock_operation:
            try:
                detail = _shopee_warehouse_detail_for_listing(
                    client=client,
                    internal_id=target["internal_id"],
                    product_id=target["product_id"],
                    detail=detail,
                )
            except MabangListingError:
                # A normal single-warehouse Shopee listing remains editable.
                pass
        if target["platform"] == "lazada" and has_stock_operation:
            with CLIENT_REQUEST_LOCK:
                detail = _lazada_warehouse_detail_for_listing(
                    client=client,
                    internal_id=target["internal_id"],
                    product_id=target["product_id"],
                    detail=detail,
                )
        matched = _matched_variations(detail, match_sku)
        if not matched:
            log(
                f"预览跳过 {target['shop_name'] or target['internal_id']}："
                f"未找到 SKU {match_sku or '（全部变体）'}"
            )
            continue

        matched_targets.append(dict(target))
        platform = target["platform"]
        detail_changes: list[dict[str, Any]] = []

        def build_change(
            variation: Mapping[str, Any],
            sku_match: Mapping[str, str],
            operation: Mapping[str, Any],
            old_value: Any,
            new_value: Any,
            **extra: Any,
        ) -> dict[str, Any]:
            variation_key = _variation_key(variation)
            if not variation_key:
                raise MabangProtocolError("在线商品变体缺少 SKU ID。")
            field = str(operation["field"])
            return {
                "change_id": secrets.token_urlsafe(12),
                "platform": platform,
                "internal_id": target["internal_id"],
                "product_id": target["product_id"]
                or str(detail.get("product_id") or detail.get("item_id") or ""),
                "shop_id": str(
                    detail.get("shop_id")
                    or detail.get("shopId")
                    or (
                        detail.get("shop", {}).get("id")
                        if isinstance(detail.get("shop"), Mapping)
                        else ""
                    )
                    or ""
                ),
                "shop_name": target["shop_name"]
                or str((detail.get("shop") or {}).get("name") or ""),
                "title": target["title"] or str(detail.get("title") or ""),
                "variation_key": variation_key,
                "sku_id": str(variation.get("sku_id") or ""),
                "sku": str(variation.get("sku") or ""),
                "requested_sku": sku_match["requested_sku"],
                "matched_sku": sku_match["matched_sku"],
                "sku_match_type": sku_match["match_type"],
                "virtual_suffix": sku_match["virtual_suffix"],
                "field": field,
                "storage_field": _storage_field(platform, field),
                "spec_name": str(operation.get("spec_name") or ""),
                "warehouse_key": str(operation.get("warehouse_key") or ""),
                "warehouse_label": str(operation.get("warehouse_label") or ""),
                "field_label": _field_label(
                    field,
                    str(operation.get("spec_name") or ""),
                    platform,
                ),
                "old_value": old_value,
                "new_value": new_value,
                **extra,
            }

        for operation in operations:
            field = operation["field"]
            if field == "variation":
                selected = _spec_selection(
                    detail,
                    platform,
                    matched,
                    str(operation["spec_name"]),
                )
                grouped_specs: dict[tuple[Any, ...], list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
                for variation, metadata in selected:
                    if platform == "shopee":
                        group_key = (
                            metadata["variation_dimension_index"],
                            metadata["variation_option_index"],
                        )
                    else:
                        group_key = (
                            metadata["variation_attribute_id"],
                            metadata["variation_value_id"],
                            str(metadata["old_value"]).casefold(),
                        )
                    grouped_specs[group_key].append((variation, metadata))
                matched_keys = {_variation_key(item) for item in matched}
                for affected in grouped_specs.values():
                    primary, metadata = next(
                        (
                            item
                            for item in affected
                            if _variation_key(item[0]) in matched_keys
                        ),
                        affected[0],
                    )
                    sku_match = _variation_sku_match(primary, match_sku) or {
                        "match_type": "all",
                        "requested_sku": match_sku,
                        "matched_sku": str(primary.get("sku") or ""),
                        "virtual_suffix": "",
                    }
                    new_value = _calculate_new_value(
                        metadata["old_value"],
                        operation,
                    )
                    affected_variations = [item[0] for item in affected]
                    detail_changes.append(
                        build_change(
                            primary,
                            sku_match,
                            operation,
                            metadata["old_value"],
                            new_value,
                            affected_variation_keys=[
                                _variation_key(item) for item in affected_variations
                            ],
                            affected_skus=[
                                str(item.get("sku") or "")
                                for item in affected_variations
                            ],
                            **{
                                key: value
                                for key, value in metadata.items()
                                if key != "old_value"
                            },
                        )
                    )
                continue

            storage_field = _storage_field(platform, field)
            for variation in matched:
                sku_match = _variation_sku_match(variation, match_sku)
                if sku_match is None:
                    continue
                variation_key = _variation_key(variation)
                if not variation_key:
                    warnings.append(
                        f"{target['shop_name'] or target['internal_id']} 有变体缺少 SKU ID，已跳过。"
                    )
                    continue
                if storage_field not in variation:
                    warnings.append(
                        f"{target['shop_name'] or target['internal_id']} / "
                        f"{variation.get('sku') or variation_key} 未返回 "
                        f"{_field_label(field, platform=platform)}，已跳过该字段。"
                    )
                    continue
                old_value = variation.get(storage_field)
                warehouse_key = str(operation.get("warehouse_key") or "")
                effective_operation = operation
                if field == "stock" and warehouse_key:
                    warehouse, warehouse_index = _find_warehouse(
                        variation,
                        warehouse_key,
                    )
                    old_value = warehouse.get("stock")
                    effective_operation = {
                        **operation,
                        "warehouse_label": _warehouse_label(
                            warehouse,
                            warehouse_index,
                        ),
                    }
                new_value = _calculate_new_value(old_value, effective_operation)
                if field == "sku" and sku_match.get("virtual_suffix"):
                    suffix = str(sku_match["virtual_suffix"])
                    if not str(new_value).upper().endswith(suffix):
                        new_value = _validate_text_value("sku", f"{new_value}{suffix}")
                prospective = copy.deepcopy(variation)
                prospective[storage_field] = new_value
                _validate_price_relationship(prospective, platform)
                detail_changes.append(
                    build_change(
                        variation,
                        sku_match,
                        effective_operation,
                        old_value,
                        new_value,
                        warehouse_managed=bool(
                            field == "stock"
                            and isinstance(
                                variation.get("warehouse_stock"),
                                list,
                            )
                            and variation.get("warehouse_stock")
                        ),
                        warehouse_options=(
                            _warehouse_options_for_variation(variation)
                            if field == "stock"
                            else []
                        ),
                    )
                )

        proposed_skus = {
            _variation_key(item): str(item.get("sku") or "").strip()
            for item in detail.get("variations") or []
            if isinstance(item, Mapping) and _variation_key(item)
        }
        for change in detail_changes:
            if change["field"] == "sku":
                proposed_skus[change["variation_key"]] = str(change["new_value"])
        duplicate_skus: dict[str, list[str]] = defaultdict(list)
        for variation_key, value in proposed_skus.items():
            if value:
                duplicate_skus[value.casefold()].append(variation_key)
        collisions = [value for value in duplicate_skus.values() if len(value) > 1]
        if (
            platform != "shopee"
            and collisions
            and any(change["field"] == "sku" for change in detail_changes)
        ):
            raise ValueError(
                f"{target['shop_name'] or target['internal_id']} 的 SKU 替换会造成"
                "同一商品内变体 SKU 重复，请调整目标 SKU。"
            )

        if any(change["field"] == "sku" for change in detail_changes):
            warnings.append(
                f"{target['shop_name'] or target['internal_id']} 包含 SKU 替换；"
                "请确认马帮库存 SKU、父 SKU、订单关联和历史映射。"
            )
        if any(change["field"] == "variation" for change in detail_changes):
            warnings.append(
                f"{target['shop_name'] or target['internal_id']} 包含规格修改；"
                "同一规格选项关联的所有变体会一起更新，请核对影响 SKU。"
            )
        changes.extend(detail_changes)

    if not changes:
        raise ValueError("没有生成可执行的变更，请检查选中商品、SKU 和修改字段。")

    virtual_sku_count = len(
        {
            (change["internal_id"], change["variation_key"])
            for change in changes
            if change.get("sku_match_type") == "virtual"
        }
    )
    if virtual_sku_count:
        warnings.insert(
            0,
            f"已匹配 {virtual_sku_count} 个 S1～S9 虚拟 SKU，"
            "提交前请人工确认实际 SKU 与基础 SKU 的对应关系。",
        )

    token = secrets.token_urlsafe(24)
    preview = {
        "preview_token": token,
        "created_ts": time.time(),
        "created_at": now_text(),
        "expires_at_ts": time.time() + PREVIEW_TTL_SECONDS,
        "targets": matched_targets,
        "operations": operations,
        "match_sku": match_sku,
        "changes": changes,
        "warnings": warnings,
        "job_id": "",
    }
    with STATE_LOCK:
        _cleanup_state_locked()
        PREVIEWS[token] = preview
    return public_preview(preview)


def public_preview(preview: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "preview_token": preview["preview_token"],
        "created_at": preview["created_at"],
        "expires_in_seconds": max(
            0,
            int(float(preview["expires_at_ts"]) - time.time()),
        ),
        "target_count": len(preview["targets"]),
        "change_count": len(preview["changes"]),
        "virtual_sku_count": len(
            {
                (change["internal_id"], change["variation_key"])
                for change in preview["changes"]
                if change.get("sku_match_type") == "virtual"
            }
        ),
        "match_sku": preview["match_sku"],
        "changes": preview["changes"],
        "warnings": preview["warnings"],
        "command_count": int(preview.get("command_count") or 1),
        "capability_note": (
            "提交时会重新读取详情；若原值已变化，该商品不会被覆盖。"
        ),
    }


def _cleanup_state_locked() -> None:
    now = time.time()
    for token in [
        key
        for key, value in PREVIEWS.items()
        if float(value.get("expires_at_ts") or 0) < now and not value.get("job_id")
    ]:
        PREVIEWS.pop(token, None)
    for job_id in [
        key
        for key, value in JOBS.items()
        if float(value.get("updated_ts") or 0) < now - JOB_TTL_SECONDS
        and value.get("state") not in {"queued", "running"}
    ]:
        JOBS.pop(job_id, None)


def public_job(job: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["job_id"],
        "state": job["state"],
        "message": job.get("message", ""),
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
        "total_products": job["total_products"],
        "submitted_products": job.get("submitted_products", 0),
        "processed_products": job["processed_products"],
        "successful_products": job["successful_products"],
        "failed_products": job["failed_products"],
        "change_count": job["change_count"],
        "results": copy.deepcopy(job["results"]),
    }


def _update_job(job_id: str, **values: Any) -> None:
    with STATE_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(values)
        job["updated_at"] = now_text()
        job["updated_ts"] = time.time()


def _find_variation(detail: Mapping[str, Any], change: Mapping[str, Any]) -> dict[str, Any]:
    variations = detail.get("variations")
    if not isinstance(variations, list):
        raise MabangProtocolError("在线商品详情缺少 variations 列表。")
    for item in variations:
        if not isinstance(item, dict):
            continue
        if _variation_key(item) == str(change["variation_key"]):
            return item
    raise MabangListingError(
        f"重新读取后找不到变体 {change.get('sku') or change['variation_key']}。"
    )


def _spec_value_from_detail(
    detail: Mapping[str, Any],
    change: Mapping[str, Any],
) -> Any:
    platform = str(change.get("platform") or "")
    if platform == "shopee":
        tiers = detail.get("tierVariationOption")
        if not isinstance(tiers, list):
            raise MabangProtocolError("Shopee 在线详情缺少规格列表。")
        dimension_index = int(change["variation_dimension_index"])
        option_index = int(change["variation_option_index"])
        try:
            option = tiers[dimension_index].get("option_list", [])[option_index]
        except (IndexError, TypeError, AttributeError):
            raise MabangProtocolError("Shopee 回读规格索引已发生变化。") from None
        if not isinstance(option, Mapping):
            raise MabangProtocolError("Shopee 回读规格选项格式不正确。")
        return option.get("option") or option.get("variation_option_name") or ""
    if platform == "tiktokshop":
        variation = _find_variation(detail, change)
        attribute = _tiktok_attribute(
            variation,
            str(change.get("spec_name") or ""),
        )
        if attribute is None:
            raise MabangListingError(
                f"重新读取后找不到规格 {change.get('spec_name') or ''}。"
            )
        return (
            attribute.get("valueName")
            or attribute.get("customValue")
            or attribute.get("custom_value")
            or ""
        )
    raise MabangProtocolError("当前平台没有规格回读规则。")


def _current_change_value(
    detail: Mapping[str, Any],
    change: Mapping[str, Any],
) -> Any:
    if str(change.get("field") or "") == "variation":
        return _spec_value_from_detail(detail, change)
    variation = _find_variation(detail, change)
    warehouse_key = str(change.get("warehouse_key") or "")
    if str(change.get("field") or "") == "stock" and warehouse_key:
        warehouse, _ = _find_warehouse(variation, warehouse_key)
        return warehouse.get("stock")
    storage_field = str(
        change.get("storage_field")
        or _storage_field(
            str(change.get("platform") or ""),
            str(change.get("field") or ""),
        )
    )
    return variation.get(storage_field)


def _apply_change_to_variation(
    variation: dict[str, Any],
    change: Mapping[str, Any],
) -> None:
    field = str(
        change.get("storage_field")
        or _storage_field(
            str(change.get("platform") or ""),
            str(change["field"]),
        )
    )
    old_value = change["old_value"]
    new_value = change["new_value"]

    if str(change["field"]) != "stock":
        variation[field] = new_value
        if (
            str(change.get("platform") or "") == "shopee"
            and str(change.get("field") or "") == "special_price"
            and "price" in variation
        ):
            # Shopee editor detail mirrors the selling price in both fields.
            variation["price"] = new_value
        return

    warehouses = variation.get("warehouse_stock")
    if isinstance(warehouses, list) and warehouses:
        valid = [item for item in warehouses if isinstance(item, dict)]
        target_stock = int(str(new_value))
        warehouse_key = str(change.get("warehouse_key") or "")
        if warehouse_key:
            selected, _ = _find_warehouse(variation, warehouse_key)
            selected["stock"] = target_stock
        elif target_stock == 0:
            for item in valid:
                item["stock"] = 0
        elif len(valid) == 1:
            valid[0]["stock"] = target_stock
        else:
            positive = [
                item
                for item in valid
                if numeric_value(item.get("stock")) > Decimal("0")
            ]
            if len(positive) != 1:
                raise MabangListingError(
                    f"{change.get('sku') or change.get('variation_key')} has "
                    "stock in multiple warehouses. Select a warehouse before "
                    "changing the total stock; the system will not guess how "
                    "to distribute it."
                )
            positive[0]["stock"] = target_stock
        new_value = sum(
            int(str(item.get("stock") or "0"))
            for item in valid
        )

    variation[field] = new_value
    # Some stores treat an alias or warehouse quantity as authoritative.
    for alias in ("quantity", "stock_quantity"):
        if alias in variation and _values_equal(variation.get(alias), old_value):
            variation[alias] = new_value


def _apply_change_to_detail(
    detail: dict[str, Any],
    change: Mapping[str, Any],
) -> None:
    if str(change.get("field") or "") != "variation":
        _apply_change_to_variation(_find_variation(detail, change), change)
        return

    platform = str(change.get("platform") or "")
    new_value = change["new_value"]
    if platform == "shopee":
        tiers = detail.get("tierVariationOption")
        if not isinstance(tiers, list):
            raise MabangProtocolError("Shopee 在线详情缺少规格列表。")
        dimension_index = int(change["variation_dimension_index"])
        option_index = int(change["variation_option_index"])
        try:
            tier = tiers[dimension_index]
            options = tier.get("option_list")
            if not isinstance(options, list):
                options = tier.get("variation_option_list")
            option = options[option_index]
        except (IndexError, TypeError, AttributeError):
            raise MabangProtocolError("Shopee 规格索引已发生变化。") from None
        if not isinstance(option, dict):
            raise MabangProtocolError("Shopee 规格选项格式不正确。")
        option["option"] = new_value
        if "variation_option_name" in option:
            option["variation_option_name"] = new_value
        variation_options = tier.get("variation_option_list")
        if (
            isinstance(variation_options, list)
            and option_index < len(variation_options)
            and isinstance(variation_options[option_index], dict)
        ):
            variation_options[option_index]["variation_option_name"] = new_value
            variation_options[option_index]["option"] = new_value
        return

    if platform == "tiktokshop":
        affected_keys = {
            str(item)
            for item in change.get("affected_variation_keys") or []
            if str(item)
        }
        variations = detail.get("variations")
        if not isinstance(variations, list):
            raise MabangProtocolError("TikTok Shop 在线详情缺少 variations 列表。")
        changed = 0
        for variation in variations:
            if not isinstance(variation, dict):
                continue
            if affected_keys and _variation_key(variation) not in affected_keys:
                continue
            attribute = _tiktok_attribute(
                variation,
                str(change.get("spec_name") or ""),
            )
            if attribute is None:
                continue
            attribute["valueName"] = new_value
            if "customValue" in attribute:
                attribute["customValue"] = new_value
            if "custom_value" in attribute:
                attribute["custom_value"] = new_value
            changed += 1
        if not changed:
            raise MabangListingError(
                f"找不到要修改的 TikTok Shop 规格 {change.get('spec_name') or ''}。"
            )
        return

    raise ValueError("Lazada 当前账号权限不支持修改 SKU 或规格。")


def numeric_value(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _append_audit(record: Mapping[str, Any]) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
    with AUDIT_PATH.open("a", encoding="utf-8") as stream:
        stream.write(line + "\n")


def _readback_mismatches(
    detail: Mapping[str, Any],
    changes: Sequence[Mapping[str, Any]],
) -> list[tuple[Mapping[str, Any], Any]]:
    mismatches: list[tuple[Mapping[str, Any], Any]] = []
    for change in changes:
        actual = _current_change_value(detail, change)
        if not _values_equal(actual, change["new_value"]):
            mismatches.append((change, actual))
    return mismatches


def _canonicalize_shopee_price_detail(
    detail: Mapping[str, Any],
) -> dict[str, Any]:
    """Expose one stable Shopee selling-price field across Mabang contracts."""

    normalized = copy.deepcopy(dict(detail))
    variations = normalized.get("variations")
    if not isinstance(variations, list):
        return normalized
    for variation in variations:
        if not isinstance(variation, dict):
            continue
        selling_price = next(
            (
                variation.get(field)
                for field in (
                    "discount_price",
                    "price",
                    "sale_price",
                    "special_price",
                )
                if variation.get(field) not in (None, "")
            ),
            None,
        )
        if selling_price is not None:
            variation["discount_price"] = copy.deepcopy(selling_price)
    return normalized


def _batch_detail_for_listing(
    *,
    client: MabangListingClient,
    platform: str,
    internal_id: str,
    product_id: str,
    shopee_global: bool = False,
) -> dict[str, Any]:
    identifiers = [
        value
        for value in dict.fromkeys(
            [
                str(product_id or "").strip(),
                str(internal_id or "").strip(),
            ]
        )
        if value
    ]
    last_error: Exception | None = None
    for identifier in identifiers:
        try:
            details = client.get_online_batch_details(
                platform,
                [identifier],
                shopee_global=shopee_global,
            )
        except MabangListingError as exc:
            last_error = exc
            continue
        if not details:
            continue
        if len(details) == 1:
            selected = details[0]
            return (
                _canonicalize_shopee_price_detail(selected)
                if platform == "shopee"
                else selected
            )
        for detail in details:
            detail_ids = {
                str(detail.get(key) or "").strip()
                for key in ("id", "product_id", "item_id")
            }
            if identifier in detail_ids:
                return (
                    _canonicalize_shopee_price_detail(detail)
                    if platform == "shopee"
                    else detail
                )
    if last_error is not None:
        raise last_error
    mode = "Shopee multi-warehouse" if shopee_global else platform
    raise MabangProtocolError(
        f"Mabang returned no {mode} batch detail for product "
        f"{product_id or internal_id}."
    )


def _detail_has_warehouse_stock(detail: Mapping[str, Any]) -> bool:
    variations = detail.get("variations")
    return isinstance(variations, list) and any(
        isinstance(variation, Mapping)
        and isinstance(variation.get("warehouse_stock"), list)
        and bool(variation.get("warehouse_stock"))
        for variation in variations
    )


def _shopee_detail_is_global(detail: Mapping[str, Any]) -> bool:
    raw = detail.get("is_global")
    if raw is None:
        shop = detail.get("shop")
        if isinstance(shop, Mapping):
            raw = shop.get("is_global")
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return int(raw) != 0
    return str(raw or "").strip().casefold() in {"1", "true", "yes"}


def _materialize_shopee_warehouse_stock(
    detail: dict[str, Any],
) -> dict[str, Any]:
    """Expose stock_info_v2.seller_stock through the editor save contract."""

    variations = detail.get("variations")
    if not isinstance(variations, list):
        return detail
    for variation in variations:
        if not isinstance(variation, dict):
            continue
        warehouses = extract_shopee_warehouse_stock(variation)
        if warehouses:
            variation["warehouse_stock"] = warehouses
    return detail


def _merge_shopee_warehouse_stock_into_batch_detail(
    batch_detail: dict[str, Any],
    editor_detail: Mapping[str, Any],
) -> dict[str, Any]:
    """Keep Mabang's batch identity fields while using fresh editor stock."""

    batch_variations = batch_detail.get("variations")
    editor_variations = editor_detail.get("variations")
    if not isinstance(batch_variations, list) or not isinstance(
        editor_variations,
        list,
    ):
        raise MabangProtocolError(
            "Mabang's Shopee batch or editor detail is missing variations."
        )

    editor_by_sku_id = {
        str(variation.get("sku_id") or "").strip(): variation
        for variation in editor_variations
        if isinstance(variation, Mapping)
        and str(variation.get("sku_id") or "").strip()
    }
    editor_by_sku: dict[str, list[Mapping[str, Any]]] = {}
    for variation in editor_variations:
        if not isinstance(variation, Mapping):
            continue
        sku = str(variation.get("sku") or "").strip()
        if sku:
            editor_by_sku.setdefault(sku, []).append(variation)

    merged_count = 0
    for variation in batch_variations:
        if not isinstance(variation, dict):
            continue
        sku_id = str(variation.get("sku_id") or "").strip()
        source = editor_by_sku_id.get(sku_id)
        if source is None:
            sku_matches = editor_by_sku.get(
                str(variation.get("sku") or "").strip(),
                [],
            )
            if len(sku_matches) == 1:
                source = sku_matches[0]
        if source is None:
            continue
        warehouses = source.get("warehouse_stock")
        if not isinstance(warehouses, list) or not warehouses:
            continue
        variation["warehouse_stock"] = copy.deepcopy(warehouses)
        merged_count += 1

    if not merged_count:
        raise MabangProtocolError(
            "Mabang's Shopee batch detail could not be matched to the editor "
            "warehouse stock by sku_id or SKU."
        )
    return batch_detail


def _detail_shop_id(detail: Mapping[str, Any]) -> str:
    shop = detail.get("shop")
    return str(
        detail.get("shop_id")
        or detail.get("shopId")
        or (shop.get("id") if isinstance(shop, Mapping) else "")
        or ""
    ).strip()


def _attach_shopee_warehouse_labels(
    detail: dict[str, Any],
    warehouse_catalog: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Join editor warehouse names without changing Mabang's save contract."""

    catalog_by_location = {
        str(item.get("location_id") or "").strip(): item
        for item in warehouse_catalog
        if str(item.get("location_id") or "").strip()
    }
    catalog_locations = set(catalog_by_location)
    variations = detail.get("variations")
    if not isinstance(variations, list):
        return detail

    for variation in variations:
        if not isinstance(variation, dict):
            continue
        warehouses = variation.get("warehouse_stock")
        if not isinstance(warehouses, list) or not warehouses:
            continue
        variation_locations: set[str] = set()
        for warehouse in warehouses:
            if not isinstance(warehouse, dict):
                continue
            location_id = str(
                warehouse.get("location_id")
                or warehouse.get("locationId")
                or ""
            ).strip()
            if not location_id:
                continue
            warehouse["location_id"] = location_id
            variation_locations.add(location_id)
            metadata = catalog_by_location.get(location_id)
            if metadata is None:
                continue
            warehouse["_warehouse_name"] = str(
                metadata.get("warehouse_name") or ""
            ).strip()
            warehouse["_warehouse_id"] = metadata.get("warehouse_id") or ""

        missing_locations = catalog_locations - variation_locations
        if missing_locations:
            sku = str(variation.get("sku") or _variation_key(variation))
            raise MabangProtocolError(
                f"Mabang's Shopee editor detail omitted warehouse stock for "
                f"{sku}: {', '.join(sorted(missing_locations))}."
            )
    return detail


def _attach_lazada_warehouse_labels(
    detail: dict[str, Any],
    warehouse_catalog: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """Join Lazada warehouse metadata without changing the update payload."""

    catalog_by_code = {
        str(item.get("warehouse_code") or item.get("code") or "").strip(): item
        for item in warehouse_catalog
        if str(item.get("warehouse_code") or item.get("code") or "").strip()
    }
    variations = detail.get("variations")
    if not isinstance(variations, list):
        return detail

    for variation in variations:
        if not isinstance(variation, dict):
            continue
        warehouses = variation.get("warehouse_stock")
        if not isinstance(warehouses, list):
            continue
        for warehouse in warehouses:
            if not isinstance(warehouse, dict):
                continue
            warehouse_code = str(
                warehouse.get("warehouse_code")
                or warehouse.get("code")
                or ""
            ).strip()
            if not warehouse_code:
                continue
            warehouse["warehouse_code"] = warehouse_code
            metadata = catalog_by_code.get(warehouse_code)
            if metadata is None:
                continue
            warehouse["_warehouse_name"] = str(
                metadata.get("warehouse_name") or ""
            ).strip()
            warehouse["_warehouse_address"] = str(
                metadata.get("detail_address") or ""
            ).strip()
            warehouse["_warehouse_default"] = bool(
                metadata.get("default_address")
            )
    return detail


def _select_listing_detail(
    rows: Sequence[Mapping[str, Any]],
    *,
    internal_id: str,
    product_id: str,
) -> dict[str, Any] | None:
    identifiers = {
        str(internal_id or "").strip(),
        str(product_id or "").strip(),
    } - {""}
    for row in rows:
        row_ids = {
            str(row.get(field) or "").strip()
            for field in ("id", "product_id", "item_id")
        } - {""}
        if identifiers & row_ids:
            return copy.deepcopy(dict(row))
    return copy.deepcopy(dict(rows[0])) if len(rows) == 1 else None


def _lazada_warehouse_detail_for_listing(
    *,
    client: MabangListingClient,
    internal_id: str,
    product_id: str,
    detail: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Read Lazada stock from the same list contract as Mabang's editor."""

    candidates: list[dict[str, Any]] = []
    if isinstance(detail, Mapping):
        candidates.append(copy.deepcopy(dict(detail)))

    shop_id = next(
        (_detail_shop_id(item) for item in candidates if _detail_shop_id(item)),
        "",
    )
    if not shop_id:
        try:
            editor_detail = client.get_online_detail("lazada", internal_id)
            if isinstance(editor_detail, Mapping):
                candidates.append(copy.deepcopy(dict(editor_detail)))
                shop_id = _detail_shop_id(editor_detail)
        except MabangListingError:
            pass

    selected: dict[str, Any] | None = None
    try:
        response = client.get_listing_page(
            "lazada",
            state="online",
            page=1,
            page_size=100,
            shop_ids=[shop_id] if shop_id else [],
            search_type="product_id" if product_id else "",
            search_value=product_id,
        )
        rows = response.get("data")
        if isinstance(rows, list):
            selected = _select_listing_detail(
                [item for item in rows if isinstance(item, Mapping)],
                internal_id=internal_id,
                product_id=product_id,
            )
            if selected is not None and not _detail_has_warehouse_stock(selected):
                selected = None
    except MabangListingError:
        selected = None

    if selected is None:
        try:
            batch_detail = _batch_detail_for_listing(
                client=client,
                platform="lazada",
                internal_id=internal_id,
                product_id=product_id,
            )
            candidates.append(copy.deepcopy(batch_detail))
        except MabangListingError:
            pass
        selected = next(
            (item for item in candidates if _detail_has_warehouse_stock(item)),
            None,
        )

    if selected is None:
        raise MabangProtocolError(
            "Mabang returned no Lazada warehouse_stock for this online product."
        )

    shop_id = _detail_shop_id(selected) or shop_id
    if not shop_id:
        raise MabangProtocolError(
            "Mabang's Lazada online product is missing a shop ID."
        )
    warehouse_catalog = client.get_lazada_warehouse_list(shop_id)
    return _attach_lazada_warehouse_labels(selected, warehouse_catalog)


def _shopee_warehouse_detail_for_listing(
    *,
    client: MabangListingClient,
    internal_id: str,
    product_id: str,
    detail: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Read the same full detail and warehouse catalog as Mabang's editor."""

    try:
        editor_detail = (
            copy.deepcopy(dict(detail))
            if isinstance(detail, Mapping)
            else client.get_online_detail("shopee", internal_id)
        )
    except MabangListingError as exc:
        raise MabangProtocolError(
            "Mabang returned no full editor detail for this Shopee Site "
            "Product."
        ) from exc

    editor_detail = _materialize_shopee_warehouse_stock(editor_detail)
    shop_id = _detail_shop_id(editor_detail)
    if not shop_id:
        raise MabangProtocolError(
            "Mabang's Shopee editor detail did not contain a shop ID."
        )
    warehouse_catalog = client.get_shopee_warehouse_list(shop_id)
    if _detail_has_warehouse_stock(editor_detail):
        return _attach_shopee_warehouse_labels(
            editor_detail,
            warehouse_catalog,
        )

    raise MabangProtocolError(
        "Mabang returned the Shopee Site Product editor detail, but no "
        "variation contained warehouse_stock or stock_info_v2.seller_stock."
    )


def _warehouse_identity(warehouse: Mapping[str, Any], index: int) -> str:
    for field in (
        "location_id",
        "warehouse_id",
        "warehouse_code",
        "code",
        "warehouse_name",
        "name",
    ):
        value = str(warehouse.get(field) or "").strip()
        if value:
            return f"{field}:{value}"
    return f"index:{index}"


def _warehouse_label(warehouse: Mapping[str, Any], index: int) -> str:
    values: list[str] = []
    for field in (
        "_warehouse_name",
        "warehouse_name",
        "name",
        "warehouse_code",
        "code",
        "location_id",
        "_warehouse_id",
        "warehouse_id",
    ):
        value = str(warehouse.get(field) or "").strip()
        if value and value not in values:
            values.append(value)
    return " / ".join(values) if values else f"Warehouse {index + 1}"


def _warehouse_options_for_variation(
    variation: Mapping[str, Any],
) -> list[dict[str, Any]]:
    warehouses = variation.get("warehouse_stock")
    if not isinstance(warehouses, list):
        return []
    return [
        {
            "key": _warehouse_identity(warehouse, index),
            "label": _warehouse_label(warehouse, index),
            "stock": int(str(warehouse.get("stock") or "0")),
        }
        for index, warehouse in enumerate(warehouses)
        if isinstance(warehouse, Mapping)
    ]


def _summarize_warehouse_options(
    option_sets: Sequence[Sequence[Mapping[str, Any]]],
    *,
    target_count: int,
) -> dict[str, Any]:
    option_rows: dict[str, dict[str, Any]] = {}
    for options in option_sets:
        seen_for_variation: set[str] = set()
        for option in options:
            key = str(option.get("key") or "")
            if not key:
                continue
            row = option_rows.setdefault(
                key,
                {
                    "key": key,
                    "label": str(option.get("label") or key),
                    "matched_variations": 0,
                    "stocks": [],
                },
            )
            if key not in seen_for_variation:
                row["matched_variations"] += 1
                seen_for_variation.add(key)
            row["stocks"].append(int(str(option.get("stock") or "0")))

    matched_variation_count = len(option_sets)
    options: list[dict[str, Any]] = []
    for row in option_rows.values():
        stocks = list(row.pop("stocks"))
        row["available_for_all"] = (
            row["matched_variations"] == matched_variation_count
        )
        row["stock_min"] = min(stocks) if stocks else 0
        row["stock_max"] = max(stocks) if stocks else 0
        options.append(row)
    options.sort(
        key=lambda row: (
            not bool(row["available_for_all"]),
            str(row["label"]).casefold(),
        )
    )
    stocked_options = [
        row
        for row in options
        if bool(row["available_for_all"]) and int(row["stock_max"]) > 0
    ]
    available_options = [
        row for row in options if bool(row["available_for_all"])
    ]
    if len(available_options) == 1:
        recommended_warehouse_key = str(available_options[0]["key"])
    elif len(stocked_options) == 1:
        recommended_warehouse_key = str(stocked_options[0]["key"])
    else:
        recommended_warehouse_key = ""
    return {
        "warehouses": options,
        "recommended_warehouse_key": recommended_warehouse_key,
        "target_count": target_count,
        "matched_variation_count": matched_variation_count,
    }


def _find_warehouse(
    variation: Mapping[str, Any],
    warehouse_key: str,
) -> tuple[dict[str, Any], int]:
    warehouses = variation.get("warehouse_stock")
    if not isinstance(warehouses, list) or not warehouses:
        raise MabangListingError(
            f"{variation.get('sku') or _variation_key(variation)} has no "
            "multi-warehouse stock detail."
        )
    for index, warehouse in enumerate(warehouses):
        if (
            isinstance(warehouse, dict)
            and _warehouse_identity(warehouse, index) == warehouse_key
        ):
            return warehouse, index
    raise MabangListingError(
        f"{variation.get('sku') or _variation_key(variation)} no longer has "
        f"the selected warehouse ({warehouse_key}). Refresh the warehouse list."
    )


def get_warehouse_options(payload: Mapping[str, Any]) -> dict[str, Any]:
    """Read warehouse-aware detail without changing any listing."""

    client = require_client()
    if payload.get("targets"):
        targets = _validate_targets(payload.get("targets"))
    else:
        targets = _targets_from_query(client, payload.get("target_query"))
    platforms = {target["platform"] for target in targets}
    if len(platforms) != 1 or not platforms <= {"lazada", "shopee"}:
        raise ValueError(
            "Warehouse selection requires targets from one Lazada or Shopee platform."
        )
    platform = next(iter(platforms))

    match_sku = str(payload.get("match_sku") or "").strip()
    option_sets: list[list[dict[str, Any]]] = []
    for target in targets:
        if platform == "lazada":
            detail = _lazada_warehouse_detail_for_listing(
                client=client,
                internal_id=target["internal_id"],
                product_id=target["product_id"],
            )
        else:
            detail = _shopee_warehouse_detail_for_listing(
                client=client,
                internal_id=target["internal_id"],
                product_id=target["product_id"],
            )
        for variation in _matched_variations(detail, match_sku):
            options = _warehouse_options_for_variation(variation)
            if not options:
                continue
            option_sets.append(options)

    if not option_sets:
        raise ValueError(
            f"No {PLATFORMS[platform].display_name} warehouse stock was found "
            "for the selected SKU."
        )
    return _summarize_warehouse_options(
        option_sets,
        target_count=len(targets),
    )


def _warehouse_expectations(
    detail: Mapping[str, Any],
    changes: Sequence[Mapping[str, Any]],
) -> dict[str, dict[str, int]]:
    expected: dict[str, dict[str, int]] = {}
    for change in changes:
        if str(change.get("field") or "") != "stock":
            continue
        variation = _find_variation(detail, change)
        warehouses = variation.get("warehouse_stock")
        if not isinstance(warehouses, list) or not warehouses:
            continue
        expected[str(change["variation_key"])] = {
            _warehouse_identity(item, index): int(str(item.get("stock") or "0"))
            for index, item in enumerate(warehouses)
            if isinstance(item, Mapping)
        }
    return expected


def _warehouse_readback_mismatches(
    detail: Mapping[str, Any],
    changes: Sequence[Mapping[str, Any]],
    expected: Mapping[str, Mapping[str, int]],
) -> list[str]:
    mismatches: list[str] = []
    for change in changes:
        variation_key = str(change.get("variation_key") or "")
        expected_stocks = expected.get(variation_key)
        if not expected_stocks:
            continue
        variation = _find_variation(detail, change)
        warehouses = variation.get("warehouse_stock")
        if not isinstance(warehouses, list):
            mismatches.append(f"{variation_key}: warehouse stock is missing")
            continue
        actual = {
            _warehouse_identity(item, index): int(str(item.get("stock") or "0"))
            for index, item in enumerate(warehouses)
            if isinstance(item, Mapping)
        }
        if actual != dict(expected_stocks):
            mismatches.append(
                f"{variation_key}: expected warehouses {dict(expected_stocks)}, "
                f"actual {actual}"
            )
    return mismatches


def _verify_platform_refresh(
    *,
    client: MabangListingClient,
    platform: str,
    internal_id: str,
    product_id: str,
    shop_id: str,
    changes: Sequence[Mapping[str, Any]],
    job_id: str,
    label: str,
    shopee_global: bool,
    expected_warehouses: Mapping[str, Mapping[str, int]],
    retry_delays: Sequence[float] | None = None,
    allow_stale_lazada_warehouse_cache: bool = False,
) -> tuple[int, bool, str]:
    delays = (
        tuple(retry_delays)
        if retry_delays is not None
        else READBACK_RETRY_DELAYS_SECONDS
    )
    try:
        client.sync_online_product(
            platform,
            product_id=product_id,
            shop_id=shop_id,
        )
    except Exception as exc:
        if allow_stale_lazada_warehouse_cache and platform == "lazada":
            return (
                0,
                False,
                f"platform refresh request was unavailable: {exc}",
            )
        raise
    last_value_mismatches: list[tuple[Mapping[str, Any], Any]] = []
    last_warehouse_mismatches: list[str] = []
    has_shopee_price_changes = platform == "shopee" and any(
        str(change.get("field") or "") in {"price", "special_price"}
        for change in changes
    )
    for attempt, delay in enumerate(delays, start=1):
        if delay:
            _update_job(
                job_id,
                message=(
                    f"{label} has been accepted. Refreshing from the platform "
                    f"and performing verification attempt {attempt}."
                ),
            )
            time.sleep(delay)
        if platform == "lazada" and expected_warehouses:
            verified = _lazada_warehouse_detail_for_listing(
                client=client,
                internal_id=internal_id,
                product_id=product_id,
            )
        elif platform == "shopee" and (
            shopee_global or bool(expected_warehouses)
        ):
            verified = _shopee_warehouse_detail_for_listing(
                client=client,
                internal_id=internal_id,
                product_id=product_id,
            )
        elif has_shopee_price_changes:
            verified = _batch_detail_for_listing(
                client=client,
                platform=platform,
                internal_id=internal_id,
                product_id=product_id,
            )
        else:
            verified = client.get_online_detail(platform, internal_id)
        last_value_mismatches = _readback_mismatches(verified, changes)
        last_warehouse_mismatches = _warehouse_readback_mismatches(
            verified,
            changes,
            expected_warehouses,
        )
        if not last_value_mismatches and not last_warehouse_mismatches:
            return attempt, True, ""

    waited_seconds = int(sum(delays))
    if last_warehouse_mismatches:
        detail = last_warehouse_mismatches[0]
    else:
        change, actual = last_value_mismatches[0]
        detail = (
            f"{change['field_label']} is still {actual}; "
            f"expected {change['new_value']}"
        )
    if (
        allow_stale_lazada_warehouse_cache
        and platform == "lazada"
        and expected_warehouses
        and all(
            str(change.get("field") or "") == "stock"
            for change in changes
        )
    ):
        return len(delays), False, detail
    raise MabangListingError(
        f"Mabang accepted the task, but platform refresh verification still "
        f"failed after about {waited_seconds} seconds: {detail}."
    )


def _batch_id_from_response(payload: Mapping[str, Any]) -> str:
    data = payload.get("data")
    candidates: list[Any] = []
    if isinstance(data, Mapping):
        candidates.extend(
            [
                data.get("batch_id"),
                data.get("batchId"),
                data.get("task_id"),
                data.get("taskId"),
            ]
        )
    candidates.extend(
        [
            payload.get("batch_id"),
            payload.get("batchId"),
            payload.get("task_id"),
            payload.get("taskId"),
        ]
    )
    return next(
        (str(item).strip() for item in candidates if str(item or "").strip()),
        "",
    )


def _progress_number(source: Mapping[str, Any], key: str) -> int:
    try:
        return int(source.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _batch_progress_summary(payload: Mapping[str, Any]) -> dict[str, Any]:
    data = payload.get("data")
    if not isinstance(data, Mapping):
        data = {}
    counts = data.get("data_num")
    if not isinstance(counts, Mapping):
        counts = data.get("dataNum")
    if not isinstance(counts, Mapping):
        counts = {}
    total = _progress_number(counts, "total_num") or _progress_number(
        counts, "totalNum"
    )
    failed = _progress_number(counts, "fail_num") or _progress_number(
        counts, "failNum"
    )
    succeeded = _progress_number(counts, "success_num") or _progress_number(
        counts, "successNum"
    )
    errors = data.get("data_error")
    if not isinstance(errors, list):
        errors = data.get("dataError")
    if not isinstance(errors, list):
        errors = []
    return {
        "total": total,
        "failed": failed,
        "succeeded": succeeded,
        "errors": [item for item in errors if isinstance(item, Mapping)],
        "terminal": total > 0 and succeeded + failed >= total,
    }


def _batch_failure_message(summary: Mapping[str, Any]) -> str:
    errors = summary.get("errors")
    if isinstance(errors, list):
        for item in errors:
            if not isinstance(item, Mapping):
                continue
            message = (
                item.get("error_msg")
                or item.get("errorMsg")
                or item.get("message")
                or item.get("msg")
            )
            if message:
                return str(message)
    return "马帮批量任务返回失败，但未提供具体原因。"


def _wait_for_mabang_batch(
    *,
    client: MabangListingClient,
    platform: str,
    batch_id: str,
    job_id: str,
    label: str,
) -> dict[str, Any] | None:
    for attempt, delay in enumerate(BATCH_STATUS_POLL_DELAYS_SECONDS, start=1):
        if delay:
            _update_job(
                job_id,
                message=f"{label} 马帮任务处理中，正在查询第 {attempt} 次状态",
            )
            time.sleep(delay)
        payload = client.get_batch_process(batch_id, platform=platform)
        summary = _batch_progress_summary(payload)
        if not summary["terminal"]:
            continue
        if summary["failed"]:
            raise MabangListingError(
                f"马帮任务执行失败：{_batch_failure_message(summary)}"
            )
        return summary
    return None


def _verify_saved_changes(
    *,
    client: MabangListingClient,
    platform: str,
    internal_id: str,
    changes: Sequence[Mapping[str, Any]],
    job_id: str,
    label: str,
    delays: Sequence[float] | None = None,
) -> tuple[dict[str, Any], int]:
    retry_delays = (
        tuple(delays) if delays is not None else READBACK_RETRY_DELAYS_SECONDS
    )
    last_mismatches: list[tuple[Mapping[str, Any], Any]] = []
    for attempt, delay in enumerate(retry_delays, start=1):
        if delay:
            _update_job(
                job_id,
                message=(
                    f"{label} 已提交，等待店铺数据回传并进行第 {attempt} 次验证"
                ),
            )
            time.sleep(delay)
        verified = client.get_online_detail(platform, internal_id)
        last_mismatches = _readback_mismatches(verified, changes)
        if not last_mismatches:
            return verified, attempt

    change, actual = last_mismatches[0]
    waited_seconds = int(sum(retry_delays))
    raise MabangListingError(
        f"马帮已受理同步，但等待约 {waited_seconds} 秒并多次回读后，"
        f"{change['field_label']} 仍为 {actual}，期望 {change['new_value']}。"
    )


def _resubmit_changes(
    *,
    client: MabangListingClient,
    platform: str,
    internal_id: str,
    changes: Sequence[Mapping[str, Any]],
) -> None:
    detail = client.get_online_detail(platform, internal_id)
    needs_save = False
    for change in changes:
        current = _current_change_value(detail, change)
        if _values_equal(current, change["new_value"]):
            continue
        if not _values_equal(current, change["old_value"]):
            raise MabangListingError(
                f"{change['sku'] or change['variation_key']} 的"
                f"{change['field_label']}已变为 {current}，自动重试已停止以避免覆盖。"
            )
        _apply_change_to_detail(detail, change)
        needs_save = True
    for variation in detail.get("variations") or []:
        if isinstance(variation, Mapping):
            _validate_price_relationship(variation, platform)
    if needs_save:
        client.save_online_detail(platform, detail, publish=True)


def _verify_with_automatic_retry(
    *,
    client: MabangListingClient,
    platform: str,
    internal_id: str,
    changes: Sequence[Mapping[str, Any]],
    job_id: str,
    label: str,
) -> tuple[int, bool]:
    try:
        _, attempts = _verify_saved_changes(
            client=client,
            platform=platform,
            internal_id=internal_id,
            changes=changes,
            job_id=job_id,
            label=label,
        )
        return attempts, False
    except MabangListingError:
        _update_job(
            job_id,
            message=f"{label} 首次回读未生效，正在自动补交一次",
        )
        _resubmit_changes(
            client=client,
            platform=platform,
            internal_id=internal_id,
            changes=changes,
        )
        _, attempts = _verify_saved_changes(
            client=client,
            platform=platform,
            internal_id=internal_id,
            changes=changes,
            job_id=job_id,
            label=label,
            delays=RETRY_READBACK_DELAYS_SECONDS,
        )
        return attempts, True


def _execute_job(job_id: str, preview: Mapping[str, Any]) -> None:
    if not EXECUTION_LOCK.acquire(blocking=False):
        _update_job(job_id, state="failed", message="已有批量同步任务正在执行。")
        return
    try:
        client = require_client()
        _update_job(job_id, state="running", message="正在向马帮提交商品变更")
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        for change in preview["changes"]:
            grouped[(change["platform"], change["internal_id"])].append(change)

        successful = 0
        failed = 0
        processed = 0
        submitted = 0
        results: list[dict[str, Any]] = []
        pending: list[
            tuple[
                dict[str, Any],
                str,
                str,
                list[dict[str, Any]],
                str,
                dict[str, Any],
            ]
        ] = []
        for (platform, internal_id), changes in grouped.items():
            first = changes[0]
            label = first.get("shop_name") or first.get("product_id") or internal_id
            _update_job(
                job_id,
                message=f"正在提交 {label}",
                submitted_products=submitted,
                processed_products=processed,
                successful_products=successful,
                failed_products=failed,
                results=copy.deepcopy(results),
            )
            result = {
                "platform": platform,
                "internal_id": internal_id,
                "product_id": first.get("product_id", ""),
                "shop_name": first.get("shop_name", ""),
                "title": first.get("title", ""),
                "status": "submitting",
                "message": "",
                "verified_changes": 0,
                "feedback_source": "",
                "mabang_batch_id": "",
                "mabang_status": "submitting",
                "verification_status": "pending",
            }
            try:
                with CLIENT_REQUEST_LOCK:
                    if (
                        platform == "shopee"
                        and any(
                            change.get("field") == "stock"
                            and change.get("warehouse_key")
                            for change in changes
                        )
                    ):
                        detail = _shopee_warehouse_detail_for_listing(
                            client=client,
                            internal_id=internal_id,
                            product_id=str(first.get("product_id") or ""),
                        )
                    elif platform == "lazada" and any(
                        change.get("field") == "stock" for change in changes
                    ):
                        detail = _lazada_warehouse_detail_for_listing(
                            client=client,
                            internal_id=internal_id,
                            product_id=str(first.get("product_id") or ""),
                        )
                    elif platform == "shopee" and any(
                        change.get("field") in {"price", "special_price"}
                        for change in changes
                    ):
                        detail = _batch_detail_for_listing(
                            client=client,
                            platform=platform,
                            internal_id=internal_id,
                            product_id=str(first.get("product_id") or ""),
                        )
                    else:
                        detail = client.get_online_detail(platform, internal_id)
                for change in changes:
                    current = _current_change_value(detail, change)
                    if not _values_equal(current, change["old_value"]):
                        raise MabangListingError(
                            f"{change['sku'] or change['variation_key']} 的"
                            f"{change['field_label']}已从 {change['old_value']} "
                            f"变为 {current}，为避免覆盖已停止该商品。"
                        )
                    _apply_change_to_detail(detail, change)
                for variation in detail.get("variations") or []:
                    if isinstance(variation, Mapping):
                        _validate_price_relationship(variation, platform)

                product_id = str(
                    first.get("product_id")
                    or detail.get("product_id")
                    or detail.get("item_id")
                    or internal_id
                ).strip()
                shop_id = str(
                    first.get("shop_id")
                    or detail.get("shop_id")
                    or detail.get("shopId")
                    or (
                        detail.get("shop", {}).get("id")
                        if isinstance(detail.get("shop"), Mapping)
                        else ""
                    )
                    or ""
                ).strip()
                change_fields = {
                    str(change.get("field") or "") for change in changes
                }
                receipt: dict[str, Any] = {
                    "mode": "detail_save",
                    "batch_id": "",
                    "field": "",
                    "product_id": product_id,
                    "shop_id": shop_id,
                    "shopee_global": False,
                    "expected_warehouses": {},
                }
                single_change_field = (
                    next(iter(change_fields)) if len(change_fields) == 1 else ""
                )
                quick_value_edit = (
                    single_change_field in {"price", "stock"}
                    or (
                        platform == "shopee"
                        and single_change_field == "special_price"
                    )
                )
                if platform in {"lazada", "shopee"} and quick_value_edit:
                    batch_field = (
                        "price"
                        if single_change_field == "special_price"
                        else single_change_field
                    )
                    submission_detail: dict[str, Any]
                    shopee_global = False
                    with CLIENT_REQUEST_LOCK:
                        if platform == "lazada" and batch_field == "stock":
                            submission_detail = _lazada_warehouse_detail_for_listing(
                                client=client,
                                internal_id=internal_id,
                                product_id=product_id,
                            )
                        elif platform == "shopee" and batch_field == "stock":
                            try:
                                editor_detail = (
                                    _shopee_warehouse_detail_for_listing(
                                        client=client,
                                        internal_id=internal_id,
                                        product_id=product_id,
                                    )
                                )
                            except MabangListingError:
                                editor_detail = {}
                            if (
                                editor_detail
                                and _detail_has_warehouse_stock(editor_detail)
                            ):
                                shopee_global = _shopee_detail_is_global(
                                    editor_detail,
                                )
                                batch_detail = _batch_detail_for_listing(
                                    client=client,
                                    platform=platform,
                                    internal_id=internal_id,
                                    product_id=product_id,
                                    shopee_global=shopee_global,
                                )
                                submission_detail = (
                                    _merge_shopee_warehouse_stock_into_batch_detail(
                                        batch_detail,
                                        editor_detail,
                                    )
                                )
                            else:
                                submission_detail = _batch_detail_for_listing(
                                    client=client,
                                    platform=platform,
                                    internal_id=internal_id,
                                    product_id=product_id,
                                )
                        else:
                            submission_detail = _batch_detail_for_listing(
                                client=client,
                                platform=platform,
                                internal_id=internal_id,
                                product_id=product_id,
                            )

                    for change in changes:
                        current = _current_change_value(submission_detail, change)
                        if not _values_equal(current, change["old_value"]):
                            raise MabangListingError(
                                f"{change['sku'] or change['variation_key']} "
                                f"{change['field_label']} changed from "
                                f"{change['old_value']} to {current}. The update "
                                "was stopped to avoid overwriting newer data."
                            )
                        _apply_change_to_detail(submission_detail, change)
                    for variation in submission_detail.get("variations") or []:
                        if isinstance(variation, Mapping):
                            _validate_price_relationship(variation, platform)

                    expected_warehouses = _warehouse_expectations(
                        submission_detail,
                        changes,
                    )
                    with CLIENT_REQUEST_LOCK:
                        if platform == "lazada" and batch_field == "stock":
                            response = client.save_lazada_warehouse_stock(
                                [submission_detail],
                            )
                        elif platform == "shopee" and shopee_global:
                            response = client.save_shopee_online_global_stock(
                                [submission_detail],
                            )
                        elif platform == "shopee":
                            response = client.save_shopee_online_local_value(
                                batch_field,
                                [submission_detail],
                            )
                        else:
                            response = client.save_lazada_online_local_value(
                                batch_field,
                                [submission_detail],
                            )
                    batch_id = (
                        ""
                        if platform == "lazada" and batch_field == "stock"
                        else _batch_id_from_response(response)
                    )
                    if (
                        not batch_id
                        and not (
                            platform == "lazada"
                            and batch_field == "stock"
                        )
                    ):
                        raise MabangProtocolError(
                            f"马帮 {PLATFORMS[platform].display_name} "
                            f"{_field_label(single_change_field, platform=platform)}接口"
                            "未返回任务编号，已停止，未将受理响应视为成功。"
                        )
                    receipt.update(
                        mode=(
                            "lazada_warehouse_stock"
                            if platform == "lazada" and batch_field == "stock"
                            else "batch_value"
                        ),
                        batch_id=batch_id,
                        field=batch_field,
                        shopee_global=shopee_global,
                        expected_warehouses=expected_warehouses,
                    )
                else:
                    with CLIENT_REQUEST_LOCK:
                        client.save_online_detail(platform, detail, publish=True)
                result.update(
                    status="verifying",
                    message=(
                        "马帮已受理，正在读取任务状态。"
                        if receipt["batch_id"]
                        else "马帮已受理，正在后台回读验证。"
                    ),
                    feedback_source=(
                        "mabang_batch_status"
                        if receipt["batch_id"]
                        else "detail_readback"
                    ),
                    mabang_batch_id=receipt["batch_id"],
                    mabang_status="accepted",
                )
                submitted += 1
                results.append(result)
                pending.append(
                    (
                        result,
                        platform,
                        internal_id,
                        changes,
                        str(label),
                        receipt,
                    )
                )
            except Exception as exc:
                result["status"] = "failed"
                result["message"] = str(exc)
                failed += 1
                processed += 1
                results.append(result)
                log(f"批量任务 {job_id} 商品 {internal_id} 失败：{exc}")
                _append_audit(
                    {
                        "timestamp": now_text(),
                        "job_id": job_id,
                        "operator": public_session().get("username", ""),
                        **result,
                        "changes": changes,
                    }
                )
            _update_job(
                job_id,
                message=(
                    f"马帮已受理 {submitted} 个商品，"
                    f"正在提交剩余 {len(grouped) - submitted - failed} 个"
                ),
                submitted_products=submitted,
                processed_products=processed,
                successful_products=successful,
                failed_products=failed,
                results=copy.deepcopy(results),
            )

        if pending:
            _update_job(
                job_id,
                message=f"马帮已受理 {submitted} 个商品，正在并行回读验证",
                submitted_products=submitted,
                results=copy.deepcopy(results),
            )
            worker_state = threading.local()

            def verify_pending(
                item: tuple[
                    dict[str, Any],
                    str,
                    str,
                    list[dict[str, Any]],
                    str,
                    dict[str, Any],
                ],
            ) -> dict[str, Any]:
                _result, platform, internal_id, changes, label, receipt = item
                worker_client = getattr(worker_state, "client", None)
                if worker_client is None:
                    worker_client = (
                        client.clone_authenticated()
                        if client.__class__ is MabangListingClient
                        else client
                    )
                    worker_state.client = worker_client

                batch_id = receipt.get("batch_id") or ""
                if receipt.get("mode") == "lazada_warehouse_stock":
                    (
                        attempts,
                        verified,
                        verification_note,
                    ) = _verify_platform_refresh(
                        client=worker_client,
                        platform=platform,
                        internal_id=internal_id,
                        product_id=str(receipt.get("product_id") or ""),
                        shop_id=str(receipt.get("shop_id") or ""),
                        changes=changes,
                        job_id=job_id,
                        label=label,
                        shopee_global=False,
                        expected_warehouses=receipt.get(
                            "expected_warehouses"
                        )
                        or {},
                        retry_delays=LAZADA_WAREHOUSE_READBACK_DELAYS_SECONDS,
                        allow_stale_lazada_warehouse_cache=True,
                    )
                    if not verified:
                        return {
                            "verification_attempts": attempts,
                            "retried": False,
                            "mabang_status": "success",
                            "feedback_source": (
                                "lazada_warehouse_update_response"
                            ),
                            "verification_status": "accepted_cache_pending",
                            "message": (
                                "Lazada 多仓库存写入已被马帮成功受理；"
                                "马帮刊登列表缓存尚未刷新，因此本次不重复提交。"
                                f" 缓存回读：{verification_note}"
                            ),
                        }
                    return {
                        "verification_attempts": attempts,
                        "retried": False,
                        "mabang_status": "success",
                        "feedback_source": "platform_refresh_readback",
                        "verification_status": "verified",
                    }
                if batch_id:
                    summary = _wait_for_mabang_batch(
                        client=worker_client,
                        platform=platform,
                        batch_id=batch_id,
                        job_id=job_id,
                        label=label,
                    )
                    if summary is None:
                        raise MabangListingError(
                            "Mabang accepted the update but did not report a "
                            "terminal batch result. Platform success cannot be "
                            "confirmed."
                        )
                    attempts, _verified, _verification_note = _verify_platform_refresh(
                        client=worker_client,
                        platform=platform,
                        internal_id=internal_id,
                        product_id=str(receipt.get("product_id") or ""),
                        shop_id=str(receipt.get("shop_id") or ""),
                        changes=changes,
                        job_id=job_id,
                        label=label,
                        shopee_global=bool(receipt.get("shopee_global")),
                        expected_warehouses=receipt.get(
                            "expected_warehouses"
                        )
                        or {},
                    )
                    return {
                        "verification_attempts": attempts,
                        "retried": False,
                        "mabang_status": "success",
                        "feedback_source": "platform_refresh_readback",
                        "verification_status": "verified",
                    }

                attempts, retried = _verify_with_automatic_retry(
                    client=worker_client,
                    platform=platform,
                    internal_id=internal_id,
                    changes=changes,
                    job_id=job_id,
                    label=label,
                )
                return {
                    "verification_attempts": attempts,
                    "retried": retried,
                    "mabang_status": "accepted",
                    "feedback_source": "detail_readback",
                    "verification_status": "verified",
                }

            workers = min(VERIFY_WORKERS, len(pending))
            with ThreadPoolExecutor(
                max_workers=workers,
                thread_name_prefix="mabang-verify",
            ) as pool:
                future_items = {
                    pool.submit(verify_pending, item): item for item in pending
                }
                for future in as_completed(future_items):
                    (
                        result,
                        _platform,
                        internal_id,
                        changes,
                        _label,
                        _receipt,
                    ) = future_items[future]
                    try:
                        verification = future.result()
                        verification_attempts = int(
                            verification["verification_attempts"]
                        )
                        retried = bool(verification["retried"])
                        verification_status = str(
                            verification["verification_status"]
                        )
                        feedback_source = str(verification["feedback_source"])
                        mabang_status = str(verification["mabang_status"])
                        result.update(
                            status="success",
                            message=(
                                str(verification.get("message") or "")
                                or (
                                    "马帮已提交修改，并从平台重新同步验证一致。"
                                    if feedback_source
                                    == "platform_refresh_readback"
                                    else (
                                        "马帮保存成功，详情回读一致。"
                                        if verification_attempts == 1
                                        and not retried
                                        else (
                                            "自动补交后验证一致。"
                                            if retried
                                            else (
                                                "马帮保存成功，"
                                                "店铺数据延迟回传后验证一致"
                                                f"（共回读 {verification_attempts} 次）。"
                                            )
                                        )
                                    )
                                )
                            ),
                            verified_changes=(
                                len(changes)
                                if verification_status == "verified"
                                else 0
                            ),
                            feedback_source=feedback_source,
                            mabang_status=mabang_status,
                            verification_status=verification_status,
                        )
                        successful += 1
                    except Exception as exc:
                        result.update(
                            status="failed",
                            message=str(exc),
                            mabang_status=(
                                "failed"
                                if result.get("mabang_batch_id")
                                else result.get("mabang_status", "accepted")
                            ),
                            verification_status="failed",
                        )
                        failed += 1
                        log(f"批量任务 {job_id} 商品 {internal_id} 失败：{exc}")
                    processed += 1
                    _append_audit(
                        {
                            "timestamp": now_text(),
                            "job_id": job_id,
                            "operator": public_session().get("username", ""),
                            **result,
                            "changes": changes,
                        }
                    )
                    _update_job(
                        job_id,
                        message=(
                            f"已提交 {submitted} 个，已核验 {processed}/{len(grouped)} 个"
                        ),
                        submitted_products=submitted,
                        processed_products=processed,
                        successful_products=successful,
                        failed_products=failed,
                        results=copy.deepcopy(results),
                    )

        final_state = "completed" if failed == 0 else ("partial" if successful else "failed")
        final_message = (
            f"同步完成：成功 {successful} 个商品，失败 {failed} 个商品。"
        )
        _update_job(
            job_id,
            state=final_state,
            message=final_message,
            submitted_products=submitted,
            processed_products=processed,
            successful_products=successful,
            failed_products=failed,
            results=copy.deepcopy(results),
        )
        with STATE_LOCK:
            LISTING_CACHE.clear()
            TARGET_CACHE.clear()
    except Exception as exc:
        log(f"批量任务 {job_id} 终止：{exc}\n{traceback.format_exc()}")
        _update_job(job_id, state="failed", message=str(exc))
    finally:
        EXECUTION_LOCK.release()


def start_execution(
    preview_token: str,
    selected_change_ids: Any = None,
) -> dict[str, Any]:
    require_client()
    with STATE_LOCK:
        _cleanup_state_locked()
        preview = PREVIEWS.get(preview_token)
        if not preview:
            raise ValueError("变更预览不存在或已过期，请重新生成预览。")
        if time.time() > float(preview["expires_at_ts"]):
            raise ValueError("变更预览已过期，请重新生成预览。")
        if preview.get("job_id"):
            job = JOBS.get(preview["job_id"])
            if job:
                return public_job(job)
        if EXECUTION_LOCK.locked():
            raise MabangListingError("已有批量同步任务正在执行，请稍后再试。")

        preview_copy = copy.deepcopy(preview)
        if selected_change_ids is not None:
            if not isinstance(selected_change_ids, list):
                raise ValueError("selected_change_ids 必须是数组。")
            selected_ids = {
                str(item).strip()
                for item in selected_change_ids
                if str(item).strip()
            }
            if not selected_ids:
                raise ValueError("请至少勾选一个 SKU 变更后再提交。")
            available_ids = {
                str(item.get("change_id") or "")
                for item in preview_copy["changes"]
            }
            unknown_ids = selected_ids - available_ids
            if unknown_ids:
                raise ValueError("所选 SKU 变更不属于当前预览，请重新生成预览。")
            preview_copy["changes"] = [
                item
                for item in preview_copy["changes"]
                if str(item.get("change_id") or "") in selected_ids
            ]

        job_id = secrets.token_hex(12)
        product_count = len(
            {
                (item["platform"], item["internal_id"])
                for item in preview_copy["changes"]
            }
        )
        job = {
            "job_id": job_id,
            "state": "queued",
            "message": "任务已创建，等待执行",
            "created_at": now_text(),
            "updated_at": now_text(),
            "updated_ts": time.time(),
            "total_products": product_count,
            "submitted_products": 0,
            "processed_products": 0,
            "successful_products": 0,
            "failed_products": 0,
            "change_count": len(preview_copy["changes"]),
            "results": [],
        }
        JOBS[job_id] = job
        preview["job_id"] = job_id
        preview_copy["job_id"] = job_id

    threading.Thread(
        target=_execute_job,
        args=(job_id, preview_copy),
        daemon=True,
    ).start()
    return public_job(job)


def get_job(job_id: str) -> dict[str, Any]:
    with STATE_LOCK:
        _cleanup_state_locked()
        job = JOBS.get(job_id)
        if not job:
            raise KeyError("任务不存在或已过期。")
        return public_job(job)


class Handler(BaseHTTPRequestHandler):
    server_version = "MabangListingLocal/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"HTTP {self.address_string()} - {fmt % args}")

    def _origin(self) -> str:
        return self.headers.get("Origin", "").strip()

    def _origin_allowed(self) -> bool:
        origin = self._origin()
        return bool(origin and ORIGIN_PATTERN.fullmatch(origin))

    def _send_json(self, status: int, payload: Mapping[str, Any]) -> None:
        body = json.dumps(
            payload,
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", self._origin())
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            raise ValueError("请求体长度不正确。") from None
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("请求体过大。")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("请求体不是有效 JSON。") from None
        if not isinstance(payload, dict):
            raise ValueError("请求体必须是 JSON 对象。")
        return payload

    def _authorized(self) -> bool:
        return request_authorized(
            origin=self._origin(),
            local_token=self.headers.get("X-Mabang-Local-Token", ""),
            internal_token=self.headers.get(
                "X-Commerce-Ops-Internal-Token",
                "",
            ),
        )

    def _require_local_auth(self) -> bool:
        if self._authorized():
            return True
        self._send_json(
            HTTPStatus.UNAUTHORIZED,
            {"success": False, "message": "本地网页授权已失效，请刷新页面。"},
        )
        return False

    def _handle_error(self, exc: Exception) -> None:
        if isinstance(exc, AIConfigurationError):
            status = HTTPStatus.SERVICE_UNAVAILABLE
        elif isinstance(exc, AIValidationError):
            status = HTTPStatus.UNPROCESSABLE_ENTITY
        elif isinstance(exc, AIServiceError):
            status = HTTPStatus.BAD_GATEWAY
        elif isinstance(exc, MabangAuthenticationError):
            status = HTTPStatus.UNAUTHORIZED
        elif isinstance(exc, MabangPublishProtocolNotCaptured):
            status = HTTPStatus.NOT_IMPLEMENTED
        elif isinstance(exc, PublisherNotFoundError):
            status = HTTPStatus.NOT_FOUND
        elif isinstance(exc, PublisherValidationError):
            status = HTTPStatus.UNPROCESSABLE_ENTITY
        elif isinstance(exc, PublisherStateError):
            status = HTTPStatus.CONFLICT
        elif isinstance(exc, PublisherError):
            status = HTTPStatus.BAD_REQUEST
        elif isinstance(exc, KeyError):
            status = HTTPStatus.NOT_FOUND
        elif isinstance(exc, (ValueError, MabangListingError, MabangProtocolError)):
            status = HTTPStatus.BAD_REQUEST
        else:
            status = HTTPStatus.INTERNAL_SERVER_ERROR
            log(f"接口异常：{exc}\n{traceback.format_exc()}")
        self._send_json(status, {"success": False, "message": str(exc).strip("'")})

    def do_OPTIONS(self) -> None:
        if not self._origin_allowed():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", self._origin())
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Mabang-Local-Token",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            payload: dict[str, Any] = {
                "success": True,
                "service": "mabang-listing-local",
                "version": "1.0",
                "session": public_session(),
                "busy": EXECUTION_LOCK.locked(),
                "ai": ai_status(),
                "publisher": PUBLISHER_STORE.health(),
                "commerce_ops_proxy": bool(INTERNAL_TOKEN),
            }
            if self._origin_allowed():
                payload["local_token"] = LOCAL_TOKEN
            self._send_json(HTTPStatus.OK, payload)
            return
        if not self._require_local_auth():
            return
        try:
            query = parse_qs(parsed.query)
            if parsed.path == "/api/platforms":
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "session": public_session(),
                        "platforms": platform_catalog(),
                        "fields": [
                            {"key": key, "label": spec["label"]}
                            for key, spec in {
                                **FIELD_SPECS,
                                **TEXT_FIELD_SPECS,
                            }.items()
                        ],
                    },
                )
                return
            if parsed.path == "/api/ai/status":
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, "ai": ai_status()},
                )
                return
            if parsed.path == "/api/publisher/drafts":
                limit = int((query.get("limit") or ["100"])[0])
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "drafts": PUBLISHER_STORE.list_drafts(limit),
                    },
                )
                return
            if parsed.path == "/api/publisher/categories":
                client = require_client()
                platform = (query.get("platform") or ["lazada"])[0]
                shop_id = (query.get("shop_id") or [""])[0]
                site = (query.get("site") or [""])[0]
                parent_id = (query.get("parent_id") or ["-1"])[0]
                search_name = (query.get("q") or [""])[0]
                categories = client.get_categories(
                    platform,
                    shop_id=shop_id,
                    site=site,
                    parent_category_id=parent_id,
                    search_name=search_name,
                )
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, "categories": categories},
                )
                return
            if parsed.path == "/api/publisher/category-schema":
                client = require_client()
                platform = (query.get("platform") or ["lazada"])[0]
                site = (query.get("site") or [""])[0]
                category_id = (query.get("category_id") or [""])[0]
                schema = client.get_category_attributes(
                    platform,
                    site=site,
                    category_id=category_id,
                )
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, "schema": schema},
                )
                return
            publisher_parts = [
                part for part in parsed.path.split("/") if part
            ]
            if (
                len(publisher_parts) == 4
                and publisher_parts[:3] == ["api", "publisher", "drafts"]
            ):
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "draft": PUBLISHER_STORE.get_draft(publisher_parts[3]),
                    },
                )
                return
            if (
                len(publisher_parts) == 5
                and publisher_parts[:3] == ["api", "publisher", "drafts"]
                and publisher_parts[4] == "events"
            ):
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "events": PUBLISHER_STORE.list_events(publisher_parts[3]),
                    },
                )
                return
            if (
                len(publisher_parts) == 4
                and publisher_parts[:3] == ["api", "publisher", "jobs"]
            ):
                job_id = publisher_parts[3]
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "job": PUBLISHER_STORE.get_job(job_id),
                        "listing": PUBLISHER_STORE.get_listing_for_job(job_id),
                    },
                )
                return
            if parsed.path == "/api/shops":
                platform = (query.get("platform") or ["lazada"])[0]
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "platform": platform,
                        "shops": get_shops(platform),
                    },
                )
                return
            if parsed.path == "/api/listings":
                platform = (query.get("platform") or ["lazada"])[0]
                state = (query.get("state") or ["online"])[0]
                page = int((query.get("page") or ["1"])[0])
                page_size = int((query.get("page_size") or ["50"])[0])
                shops = [
                    part.strip()
                    for value in query.get("shop_id") or []
                    for part in value.split(",")
                    if part.strip()
                ]
                search_type = (query.get("search_type") or [""])[0]
                search_value = (query.get("search_value") or [""])[0]
                force_refresh = (
                    (query.get("refresh") or [""])[0].strip().lower()
                    in {"1", "true", "yes"}
                )
                result = get_listings(
                    platform,
                    state,
                    page,
                    page_size,
                    shops,
                    search_type,
                    search_value,
                    force_refresh,
                )
                self._send_json(HTTPStatus.OK, {"success": True, **result})
                return
            if parsed.path.startswith("/api/jobs/"):
                job_id = parsed.path.rsplit("/", 1)[-1]
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, **get_job(job_id)},
                )
                return
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"success": False, "message": "接口不存在。"},
            )
        except Exception as exc:
            self._handle_error(exc)

    def do_POST(self) -> None:
        if not self._require_local_auth():
            return
        try:
            payload = self._read_json()
            path = urlparse(self.path).path
            if path == "/api/session/login":
                result = connect(
                    str(payload.get("username") or ""),
                    str(payload.get("password") or ""),
                    str(payload.get("account_host") or ""),
                )
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, "message": "马帮刊登连接成功。", "session": result},
                )
                return
            if path == "/api/ai/parse":
                parsed_commands = parse_ai_commands(
                    str(payload.get("command") or "")
                )
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "provider": ai_status(),
                        "command": parsed_commands[0],
                        "commands": parsed_commands,
                        "preview": generate_ai_preview(parsed_commands[0]),
                        "previews": [
                            generate_ai_preview(item) for item in parsed_commands
                        ],
                    },
                )
                return
            if path == "/api/ai/preview":
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, **create_ai_scope_preview(payload)},
                )
                return
            if path == "/api/publisher/ai/generate":
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "success": True,
                        "material": generate_ai_listing_material(
                            str(payload.get("prompt") or "")
                        ),
                    },
                )
                return
            if path == "/api/publisher/drafts":
                require_client()
                draft = PUBLISHER.create(payload, get_shops("lazada"))
                self._send_json(
                    HTTPStatus.CREATED,
                    {"success": True, "draft": draft},
                )
                return
            if path == "/api/publisher/drafts/from-listing":
                client = require_client()
                platform = str(payload.get("platform") or "lazada").strip().lower()
                draft = PUBLISHER.from_listing(
                    client,
                    platform=platform,
                    internal_id=str(payload.get("internal_id") or "").strip(),
                    shops=get_shops(platform),
                    listing_hint=(
                        payload.get("listing_hint")
                        if isinstance(payload.get("listing_hint"), Mapping)
                        else None
                    ),
                )
                self._send_json(
                    HTTPStatus.CREATED,
                    {"success": True, "draft": draft},
                )
                return

            publisher_parts = [part for part in path.split("/") if part]
            if (
                len(publisher_parts) == 5
                and publisher_parts[:3] == ["api", "publisher", "drafts"]
            ):
                draft_id = publisher_parts[3]
                action = publisher_parts[4]
                if action == "update":
                    require_client()
                    draft = PUBLISHER.update(
                        draft_id,
                        payload,
                        get_shops("lazada"),
                    )
                    self._send_json(
                        HTTPStatus.OK,
                        {"success": True, "draft": draft},
                    )
                    return
                if action == "clone":
                    require_client()
                    draft = PUBLISHER.clone(draft_id, get_shops("lazada"))
                    self._send_json(
                        HTTPStatus.CREATED,
                        {"success": True, "draft": draft},
                    )
                    return
                if action == "validate":
                    self._send_json(
                        HTTPStatus.OK,
                        {"success": True, **PUBLISHER.validate(draft_id)},
                    )
                    return
                if action == "save-to-mabang":
                    draft = PUBLISHER.save_to_mabang(
                        require_client(),
                        draft_id,
                    )
                    self._send_json(
                        HTTPStatus.OK,
                        {"success": True, "draft": draft},
                    )
                    return
                if action == "confirm":
                    draft = PUBLISHER.confirm(
                        draft_id,
                        int(payload.get("expected_version") or 0),
                    )
                    self._send_json(
                        HTTPStatus.OK,
                        {"success": True, "draft": draft},
                    )
                    return
                if action == "publish":
                    result = PUBLISHER.publish(require_client(), draft_id)
                    self._send_json(
                        HTTPStatus.ACCEPTED,
                        {"success": True, **result},
                    )
                    return
            if (
                len(publisher_parts) == 5
                and publisher_parts[:3] == ["api", "publisher", "jobs"]
                and publisher_parts[4] == "refresh"
            ):
                result = PUBLISHER.refresh_job(
                    require_client(),
                    publisher_parts[3],
                )
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, **result},
                )
                return
            if path == "/api/batch/preview":
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, **create_preview(payload)},
                )
                return
            if path == "/api/batch/warehouse-options":
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, **get_warehouse_options(payload)},
                )
                return
            if path == "/api/batch/execute":
                job = start_execution(
                    str(payload.get("preview_token") or ""),
                    payload.get("selected_change_ids"),
                )
                self._send_json(HTTPStatus.ACCEPTED, {"success": True, **job})
                return
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"success": False, "message": "接口不存在。"},
            )
        except Exception as exc:
            self._handle_error(exc)

    def do_DELETE(self) -> None:
        if not self._require_local_auth():
            return
        try:
            if urlparse(self.path).path == "/api/session":
                disconnect()
                self._send_json(
                    HTTPStatus.OK,
                    {"success": True, "message": "马帮连接已断开。"},
                )
                return
            self._send_json(
                HTTPStatus.NOT_FOUND,
                {"success": False, "message": "接口不存在。"},
            )
        except Exception as exc:
            self._handle_error(exc)


def main() -> None:
    if HOST not in {"127.0.0.1", "localhost"}:
        raise SystemExit("为保护马帮账号，本地刊登服务只允许绑定 127.0.0.1。")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log(f"马帮刊登本地桥接服务已启动：http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
