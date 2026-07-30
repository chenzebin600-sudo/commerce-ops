# -*- coding: utf-8 -*-
"""Persistent listing-draft workflow embedded in the Mabang local bridge.

This module intentionally knows nothing about HTTP handlers or browser state.
It receives the already-authenticated ``MabangListingClient`` from the main
service, persists local drafts in SQLite, enforces the confirmation gate, and
delegates every remote operation to the client boundary.
"""

from __future__ import annotations

import copy
import json
import re
import sqlite3
import threading
from contextlib import closing
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping, Sequence
from urllib.parse import urlparse
from uuid import uuid4


STATUSES = {
    "LOCAL_DRAFT",
    "SAVING_TO_MABANG",
    "MABANG_DRAFT",
    "READBACK_OK",
    "VALIDATED",
    "WAIT_CONFIRM",
    "PUBLISH_SUBMITTED",
    "MABANG_ACCEPTED",
    "PLATFORM_PROCESSING",
    "PUBLISHED",
    "FAILED",
}

SCHEMA_VERSION = "2"
SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS publisher_schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_drafts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    shop_id TEXT NOT NULL,
    shop_name TEXT NOT NULL,
    site TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    category_id TEXT NOT NULL,
    category_name TEXT NOT NULL DEFAULT '',
    brand TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL,
    attributes_json TEXT NOT NULL DEFAULT '{}',
    extended_json TEXT NOT NULL DEFAULT '{}',
    weight TEXT NOT NULL,
    package_length TEXT NOT NULL,
    package_width TEXT NOT NULL,
    package_height TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    confirmed_version INTEGER,
    mabang_task_id TEXT NOT NULL DEFAULT '',
    source_internal_id TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publisher_drafts_status
ON listing_drafts(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS draft_variants (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    specification_name TEXT NOT NULL,
    specification_value TEXT NOT NULL,
    price TEXT NOT NULL,
    special_price TEXT,
    stock INTEGER NOT NULL,
    product_sku_id TEXT NOT NULL DEFAULT '',
    properties_json TEXT NOT NULL DEFAULT '[]',
    images_json TEXT NOT NULL DEFAULT '[]',
    warehouse_stock_json TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(draft_id, sku)
);

CREATE TABLE IF NOT EXISTS draft_assets (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES listing_drafts(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS publish_jobs (
    id TEXT PRIMARY KEY,
    draft_id TEXT NOT NULL REFERENCES listing_drafts(id),
    draft_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    mabang_batch_id TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publisher_jobs_draft
ON publish_jobs(draft_id, created_at DESC);

CREATE TABLE IF NOT EXISTS publish_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    draft_id TEXT NOT NULL REFERENCES listing_drafts(id),
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_publisher_events_draft
ON publish_events(draft_id, created_at);

CREATE TABLE IF NOT EXISTS platform_listings (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES publish_jobs(id),
    draft_id TEXT NOT NULL REFERENCES listing_drafts(id),
    platform TEXT NOT NULL,
    shop_id TEXT NOT NULL,
    platform_product_id TEXT NOT NULL,
    platform_sku_ids_json TEXT NOT NULL DEFAULT '{}',
    product_url TEXT NOT NULL,
    resolved_at TEXT NOT NULL,
    UNIQUE(platform, shop_id, platform_product_id)
);

CREATE TABLE IF NOT EXISTS publisher_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator TEXT NOT NULL DEFAULT 'local',
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


class PublisherError(RuntimeError):
    """Base publisher workflow error."""


class PublisherValidationError(PublisherError):
    """Draft material is invalid."""


class PublisherStateError(PublisherError):
    """An unsafe workflow transition was requested."""


class PublisherNotFoundError(PublisherError):
    """A local publisher record does not exist."""


def now_text() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def _text(value: Any, *, maximum: int = 100_000) -> str:
    return str(value or "").strip()[:maximum]


def _first(source: Mapping[str, Any], names: Sequence[str], default: Any = "") -> Any:
    for name in names:
        value = source.get(name)
        if value not in (None, ""):
            return value
    return default


def _decimal(value: Any, label: str, *, positive: bool = False) -> str:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise PublisherValidationError(f"{label}必须是有效数字。") from None
    if not parsed.is_finite() or (positive and parsed <= 0) or (not positive and parsed < 0):
        relation = "大于0" if positive else "大于等于0"
        raise PublisherValidationError(f"{label}必须{relation}。")
    normalized = format(parsed.normalize(), "f")
    return "0" if normalized in {"-0", ""} else normalized


def _integer(value: Any, label: str) -> int:
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        raise PublisherValidationError(f"{label}必须是整数。") from None
    if parsed < 0 or parsed > 9_999_999:
        raise PublisherValidationError(f"{label}必须在0到9999999之间。")
    return parsed


def _normalize_url(value: Any) -> str:
    url = _text(value, maximum=2000)
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise PublisherValidationError("图片地址必须是完整的HTTP或HTTPS URL。")
    return url


def _json_mapping(value: Any, label: str) -> dict[str, Any]:
    if value in (None, ""):
        return {}
    if not isinstance(value, Mapping):
        raise PublisherValidationError(f"{label}必须是JSON对象。")
    return copy.deepcopy(dict(value))


def _json_list(value: Any, label: str) -> list[Any]:
    if value in (None, ""):
        return []
    if not isinstance(value, list):
        raise PublisherValidationError(f"{label}必须是JSON数组。")
    return copy.deepcopy(value)


def _normalize_authorized_shop(
    shop_id: str,
    shops: Sequence[Mapping[str, Any]],
) -> dict[str, str]:
    normalized = str(shop_id or "").strip()
    if not normalized:
        raise PublisherValidationError("请选择当前马帮账号授权的店铺。")
    for shop in shops:
        candidate = str(shop.get("id") or shop.get("shop_id") or "").strip()
        if candidate == normalized:
            return {
                "id": candidate,
                "name": _text(shop.get("name") or shop.get("shopName"), maximum=200),
                "site": _text(
                    shop.get("site")
                    or shop.get("amazonsite")
                    or shop.get("site_name"),
                    maximum=30,
                ),
            }
    raise PublisherValidationError("所选店铺不在当前马帮登录账号的授权范围内。")


def normalize_draft(
    payload: Mapping[str, Any],
    shops: Sequence[Mapping[str, Any]],
    *,
    source_internal_id: str = "",
) -> dict[str, Any]:
    """Validate browser material against the current authenticated shop scope."""

    platform = _text(payload.get("platform") or "lazada", maximum=30).lower()
    if platform != "lazada":
        raise PublisherValidationError("第一阶段只开放Lazada新建刊登。")
    shop = _normalize_authorized_shop(_text(payload.get("shop_id")), shops)
    title = _text(payload.get("title"), maximum=500)
    category_id = _text(payload.get("category_id"), maximum=100)
    description = _text(payload.get("description"), maximum=100_000)
    if not title:
        raise PublisherValidationError("商品标题不能为空。")
    if not category_id:
        raise PublisherValidationError("类目ID不能为空。")
    if not description:
        raise PublisherValidationError("商品描述不能为空。")

    attributes = _json_mapping(payload.get("attributes"), "商品属性")
    extended = _json_mapping(payload.get("extended"), "刊登扩展资料")

    raw_variants = payload.get("variants")
    if not isinstance(raw_variants, list) or not raw_variants:
        raise PublisherValidationError("至少需要一个SKU变体。")
    variants: list[dict[str, Any]] = []
    seen_skus: set[str] = set()
    for index, raw in enumerate(raw_variants):
        if not isinstance(raw, Mapping):
            raise PublisherValidationError(f"第{index + 1}个变体格式不正确。")
        sku = _text(raw.get("sku"), maximum=100)
        if not sku:
            raise PublisherValidationError(f"第{index + 1}个变体缺少SKU。")
        folded = sku.casefold()
        if folded in seen_skus:
            raise PublisherValidationError(f"SKU {sku}在同一草稿中重复。")
        seen_skus.add(folded)
        price = _decimal(raw.get("price"), f"SKU {sku}售价", positive=True)
        special_value = raw.get("special_price")
        special_price = (
            None
            if special_value in (None, "")
            else _decimal(special_value, f"SKU {sku}促销价")
        )
        if special_price is not None and Decimal(special_price) > Decimal(price):
            raise PublisherValidationError(f"SKU {sku}促销价不能高于售价。")
        variants.append(
            {
                "id": _text(raw.get("id"), maximum=100) or new_id("var"),
                "sku": sku,
                "specification_name": _text(
                    raw.get("specification_name") or "规格",
                    maximum=100,
                ),
                "specification_value": _text(
                    raw.get("specification_value") or "默认",
                    maximum=200,
                ),
                "price": price,
                "special_price": special_price,
                "stock": _integer(raw.get("stock"), f"SKU {sku}库存"),
                "product_sku_id": _text(raw.get("product_sku_id"), maximum=100),
                "properties": _json_list(
                    raw.get("properties") or raw.get("propert"),
                    f"SKU {sku}平台属性",
                ),
                "images": [
                    _normalize_url(item.get("url") if isinstance(item, Mapping) else item)
                    for item in _json_list(raw.get("images"), f"SKU {sku}图片")
                    if (item.get("url") if isinstance(item, Mapping) else item)
                ],
                "warehouse_stock": _json_list(
                    raw.get("warehouse_stock"),
                    f"SKU {sku}仓库库存",
                ),
                "sort_order": index,
            }
        )

    raw_assets = payload.get("assets")
    if not isinstance(raw_assets, list) or not raw_assets:
        raise PublisherValidationError("至少需要一张商品图片。")
    assets: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_assets):
        item = raw if isinstance(raw, Mapping) else {"url": raw}
        assets.append(
            {
                "id": _text(item.get("id"), maximum=100) or new_id("asset"),
                "asset_type": "main_image" if index == 0 else "image",
                "url": _normalize_url(item.get("url")),
                "sort_order": index,
            }
        )

    return {
        "platform": platform,
        "shop_id": shop["id"],
        "shop_name": shop["name"],
        "site": _text(payload.get("site") or shop["site"], maximum=30),
        "title": title,
        "category_id": category_id,
        "category_name": _text(payload.get("category_name"), maximum=300),
        "brand": _text(payload.get("brand") or "No Brand", maximum=200),
        "description": description,
        "attributes": attributes,
        "extended": extended,
        "weight": _decimal(payload.get("weight"), "重量", positive=True),
        "package_length": _decimal(
            payload.get("package_length"),
            "包裹长度",
            positive=True,
        ),
        "package_width": _decimal(
            payload.get("package_width"),
            "包裹宽度",
            positive=True,
        ),
        "package_height": _decimal(
            payload.get("package_height"),
            "包裹高度",
            positive=True,
        ),
        "variants": variants,
        "assets": assets,
        "source_internal_id": _text(
            payload.get("source_internal_id") or source_internal_id,
            maximum=100,
        ),
    }


def _flatten_description(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, Mapping):
        for key in ("description", "value", "content", "text"):
            text = _flatten_description(value.get(key))
            if text:
                return text
        return "\n".join(
            text
            for text in (_flatten_description(item) for item in value.values())
            if text
        )
    if isinstance(value, list):
        return "\n".join(
            text
            for text in (_flatten_description(item) for item in value)
            if text
        )
    return ""


def _extract_images(detail: Mapping[str, Any]) -> list[str]:
    candidates: list[Any] = []
    for key in (
        "images",
        "image_list",
        "product_images",
        "main_images",
        "main_image",
        "image",
        "image_url",
    ):
        value = detail.get(key)
        if isinstance(value, list):
            candidates.extend(value)
        elif value not in (None, ""):
            candidates.append(value)
    result: list[str] = []
    for item in candidates:
        if isinstance(item, Mapping):
            value = _first(item, ("url", "image", "src", "image_url"))
        else:
            value = item
        for part in str(value or "").split(","):
            url = part.strip()
            parsed = urlparse(url)
            if parsed.scheme in {"http", "https"} and parsed.netloc and url not in result:
                result.append(url)
    return result


def draft_payload_from_listing(
    detail: Mapping[str, Any],
    shops: Sequence[Mapping[str, Any]],
    *,
    platform: str,
    internal_id: str,
) -> dict[str, Any]:
    """Map an authenticated Mabang online detail into editable local material."""

    shop = detail.get("shop") if isinstance(detail.get("shop"), Mapping) else {}
    shop_id = _text(
        _first(detail, ("shop_id", "shopId"), _first(shop, ("id", "shop_id")))
    )
    variants_raw = detail.get("variations") or detail.get("skus") or []
    if not isinstance(variants_raw, list):
        variants_raw = []
    variants: list[dict[str, Any]] = []
    for index, raw in enumerate(variants_raw):
        if not isinstance(raw, Mapping):
            continue
        properties = raw.get("propert") or raw.get("properties") or []
        if not isinstance(properties, list):
            properties = []
        first_property = next(
            (item for item in properties if isinstance(item, Mapping)),
            {},
        )
        variant_images = raw.get("images") or raw.get("image") or []
        if not isinstance(variant_images, list):
            variant_images = [variant_images] if variant_images else []
        variants.append(
            {
                "sku": _text(
                    _first(raw, ("sku", "vsku", "seller_sku", "stock_sku")),
                    maximum=100,
                )
                or f"SKU-{index + 1}",
                "specification_name": _text(
                    _first(
                        raw,
                        ("specification_name", "spec_name"),
                        _first(first_property, ("name", "label"), "规格"),
                    ),
                    maximum=100,
                ),
                "specification_value": _text(
                    _first(
                        raw,
                        ("specification_value", "spec_value", "variation_name"),
                        _first(first_property, ("value", "value_name"), "默认"),
                    ),
                    maximum=200,
                ),
                "price": _first(raw, ("price", "original_price"), "0"),
                "special_price": _first(
                    raw,
                    ("special_price", "discount_price", "sale_price"),
                    None,
                ),
                "stock": _first(raw, ("stock", "quantity"), 0),
                "properties": copy.deepcopy(properties),
                "images": [
                    item.get("url") if isinstance(item, Mapping) else item
                    for item in variant_images
                    if item
                ],
                "warehouse_stock": copy.deepcopy(
                    raw.get("warehouse_stock")
                    if isinstance(raw.get("warehouse_stock"), list)
                    else []
                ),
            }
        )
    first_variant = variants_raw[0] if variants_raw and isinstance(variants_raw[0], Mapping) else {}
    description = _flatten_description(
        _first(
            detail,
            ("description", "product_description", "desc", "short_description"),
        )
    )
    attributes = detail.get("attributes")
    if not isinstance(attributes, Mapping):
        attributes = {}
    product_properties = detail.get("product_property")
    if isinstance(product_properties, list):
        attributes = {
            _text(item.get("name"), maximum=200): copy.deepcopy(item.get("value"))
            for item in product_properties
            if isinstance(item, Mapping) and _text(item.get("name"), maximum=200)
        }
    brand_value = detail.get("brand")
    if isinstance(brand_value, Mapping):
        brand_value = _first(brand_value, ("name", "brand_name", "value"))
    images = _extract_images(detail)
    payload = {
        "platform": platform,
        "shop_id": shop_id,
        "site": _first(detail, ("site", "amazonsite"), _first(shop, ("site", "amazonsite"))),
        "title": _first(detail, ("title", "name")),
        "category_id": _first(detail, ("category_id", "categoryId")),
        "category_name": _first(detail, ("category_name", "categoryName")),
        "brand": brand_value or "No Brand",
        "description": description or "请补充商品描述后再保存草稿。",
        "attributes": attributes,
        "extended": {
            "source_mode": "mabang_listing",
            "source_listing_id": internal_id,
            "category": copy.deepcopy(
                detail.get("category")
                if isinstance(detail.get("category"), Mapping)
                else {}
            ),
            "category_id_path": copy.deepcopy(detail.get("category_id_path") or []),
            "product_property": copy.deepcopy(
                product_properties if isinstance(product_properties, list) else []
            ),
            "highlights": copy.deepcopy(detail.get("highlights") or []),
            "whatisinthebox": _text(detail.get("whatisinthebox"), maximum=20_000),
            "warranty_type": _text(detail.get("warranty_type"), maximum=200),
            "warranty_period": _text(detail.get("warranty_period"), maximum=200),
            "warranty_policy": _text(detail.get("warranty_policy"), maximum=20_000),
            "tax_class": _text(detail.get("tax_class"), maximum=200),
            "preorder_enable": int(bool(detail.get("preorder_enable"))),
            "preorder_days": int(detail.get("preorder_days") or 0),
        },
        "weight": _first(
            detail,
            ("package_weight", "weight"),
            _first(first_variant, ("package_weight", "weight"), "0.001"),
        ),
        "package_length": _first(
            detail,
            ("package_length", "length"),
            _first(first_variant, ("package_length", "length"), "0.01"),
        ),
        "package_width": _first(
            detail,
            ("package_width", "width"),
            _first(first_variant, ("package_width", "width"), "0.01"),
        ),
        "package_height": _first(
            detail,
            ("package_height", "height"),
            _first(first_variant, ("package_height", "height"), "0.01"),
        ),
        "variants": variants,
        "assets": [{"url": url} for url in images],
        "source_internal_id": internal_id,
    }
    return normalize_draft(payload, shops, source_internal_id=internal_id)


class PublisherStore:
    """Small SQLite repository safe for the threaded local HTTP service."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = Path(database_path).resolve()
        self._lock = threading.RLock()
        self.initialize()

    def _connect(self) -> sqlite3.Connection:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def initialize(self) -> None:
        with self._lock, closing(self._connect()) as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.executescript(SCHEMA_SQL)
            self._upgrade_schema(connection)
            connection.execute(
                """
                INSERT INTO publisher_schema_meta (key, value, updated_at)
                VALUES ('schema_version', ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
                """,
                (SCHEMA_VERSION, now_text()),
            )
            connection.commit()

    @staticmethod
    def _upgrade_schema(connection: sqlite3.Connection) -> None:
        """Upgrade the local sidecar store without touching Commerce Ops data."""

        draft_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(listing_drafts)").fetchall()
        }
        if "extended_json" not in draft_columns:
            connection.execute(
                "ALTER TABLE listing_drafts ADD COLUMN extended_json TEXT NOT NULL DEFAULT '{}'"
            )
        variant_columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(draft_variants)").fetchall()
        }
        additions = {
            "product_sku_id": "TEXT NOT NULL DEFAULT ''",
            "properties_json": "TEXT NOT NULL DEFAULT '[]'",
            "images_json": "TEXT NOT NULL DEFAULT '[]'",
            "warehouse_stock_json": "TEXT NOT NULL DEFAULT '[]'",
        }
        for column, definition in additions.items():
            if column not in variant_columns:
                connection.execute(
                    f"ALTER TABLE draft_variants ADD COLUMN {column} {definition}"
                )

    def health(self) -> dict[str, str]:
        try:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT value FROM publisher_schema_meta WHERE key = 'schema_version'"
                ).fetchone()
            return {
                "status": "ok" if row else "error",
                "schema_version": str(row["value"]) if row else "",
            }
        except sqlite3.Error:
            return {"status": "error", "schema_version": ""}

    @staticmethod
    def _replace_children(
        connection: sqlite3.Connection,
        draft_id: str,
        draft: Mapping[str, Any],
    ) -> None:
        connection.execute("DELETE FROM draft_variants WHERE draft_id = ?", (draft_id,))
        connection.execute("DELETE FROM draft_assets WHERE draft_id = ?", (draft_id,))
        for variant in draft["variants"]:
            connection.execute(
                """
                INSERT INTO draft_variants (
                    id, draft_id, sku, specification_name, specification_value,
                    price, special_price, stock, product_sku_id, properties_json,
                    images_json, warehouse_stock_json, sort_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    variant["id"],
                    draft_id,
                    variant["sku"],
                    variant["specification_name"],
                    variant["specification_value"],
                    variant["price"],
                    variant["special_price"],
                    variant["stock"],
                    variant.get("product_sku_id", ""),
                    json.dumps(variant.get("properties") or [], ensure_ascii=False),
                    json.dumps(variant.get("images") or [], ensure_ascii=False),
                    json.dumps(
                        variant.get("warehouse_stock") or [],
                        ensure_ascii=False,
                    ),
                    variant["sort_order"],
                ),
            )
        for asset in draft["assets"]:
            connection.execute(
                """
                INSERT INTO draft_assets (
                    id, draft_id, asset_type, url, sort_order
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    asset["id"],
                    draft_id,
                    asset["asset_type"],
                    asset["url"],
                    asset["sort_order"],
                ),
            )

    def _draft_from_row(
        self,
        connection: sqlite3.Connection,
        row: sqlite3.Row,
    ) -> dict[str, Any]:
        variants = [
            dict(item)
            for item in connection.execute(
                "SELECT * FROM draft_variants WHERE draft_id = ? ORDER BY sort_order, id",
                (row["id"],),
            ).fetchall()
        ]
        assets = [
            dict(item)
            for item in connection.execute(
                "SELECT * FROM draft_assets WHERE draft_id = ? ORDER BY sort_order, id",
                (row["id"],),
            ).fetchall()
        ]
        result = dict(row)
        result["attributes"] = json.loads(result.pop("attributes_json") or "{}")
        result["extended"] = json.loads(result.pop("extended_json") or "{}")
        for variant in variants:
            variant["properties"] = json.loads(
                variant.pop("properties_json", "[]") or "[]"
            )
            variant["images"] = json.loads(
                variant.pop("images_json", "[]") or "[]"
            )
            variant["warehouse_stock"] = json.loads(
                variant.pop("warehouse_stock_json", "[]") or "[]"
            )
        result["variants"] = variants
        result["assets"] = assets
        return result

    def create_draft(self, draft: Mapping[str, Any]) -> dict[str, Any]:
        draft_id = new_id("draft")
        stamp = now_text()
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO listing_drafts (
                    id, platform, shop_id, shop_name, site, title, category_id,
                    category_name, brand, description, attributes_json, extended_json, weight,
                    package_length, package_width, package_height, status, version,
                    confirmed_version, mabang_task_id, source_internal_id, last_error,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                          'LOCAL_DRAFT', 1, NULL, '', ?, '', ?, ?)
                """,
                (
                    draft_id,
                    draft["platform"],
                    draft["shop_id"],
                    draft["shop_name"],
                    draft["site"],
                    draft["title"],
                    draft["category_id"],
                    draft["category_name"],
                    draft["brand"],
                    draft["description"],
                    json.dumps(draft["attributes"], ensure_ascii=False),
                    json.dumps(draft.get("extended") or {}, ensure_ascii=False),
                    draft["weight"],
                    draft["package_length"],
                    draft["package_width"],
                    draft["package_height"],
                    draft.get("source_internal_id", ""),
                    stamp,
                    stamp,
                ),
            )
            self._replace_children(connection, draft_id, draft)
            connection.commit()
        self.add_event(draft_id, "draft_created", "LOCAL_DRAFT", "本地刊登草稿已创建。")
        return self.get_draft(draft_id)

    def update_draft(self, draft_id: str, draft: Mapping[str, Any]) -> dict[str, Any]:
        current = self.get_draft(draft_id)
        if current["status"] == "PUBLISHED":
            raise PublisherStateError("已发布草稿不能直接覆盖，请复制后再修改。")
        stamp = now_text()
        with self._lock, closing(self._connect()) as connection:
            cursor = connection.execute(
                """
                UPDATE listing_drafts
                SET platform=?, shop_id=?, shop_name=?, site=?, title=?,
                    category_id=?, category_name=?, brand=?, description=?,
                    attributes_json=?, extended_json=?, weight=?, package_length=?, package_width=?,
                    package_height=?, status='LOCAL_DRAFT', version=version+1,
                    confirmed_version=NULL, mabang_task_id='', source_internal_id=?,
                    last_error='', updated_at=?
                WHERE id=?
                """,
                (
                    draft["platform"],
                    draft["shop_id"],
                    draft["shop_name"],
                    draft["site"],
                    draft["title"],
                    draft["category_id"],
                    draft["category_name"],
                    draft["brand"],
                    draft["description"],
                    json.dumps(draft["attributes"], ensure_ascii=False),
                    json.dumps(draft.get("extended") or {}, ensure_ascii=False),
                    draft["weight"],
                    draft["package_length"],
                    draft["package_width"],
                    draft["package_height"],
                    draft.get("source_internal_id", ""),
                    stamp,
                    draft_id,
                ),
            )
            if cursor.rowcount != 1:
                raise PublisherNotFoundError("刊登草稿不存在。")
            self._replace_children(connection, draft_id, draft)
            connection.commit()
        self.add_event(
            draft_id,
            "draft_updated",
            "LOCAL_DRAFT",
            "本地草稿已更新，需要重新保存到马帮并确认。",
        )
        return self.get_draft(draft_id)

    def get_draft(self, draft_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM listing_drafts WHERE id = ?",
                (str(draft_id),),
            ).fetchone()
            if row is None:
                raise PublisherNotFoundError("刊登草稿不存在。")
            return self._draft_from_row(connection, row)

    def list_drafts(self, limit: int = 100) -> list[dict[str, Any]]:
        safe_limit = min(500, max(1, int(limit)))
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM listing_drafts ORDER BY updated_at DESC LIMIT ?",
                (safe_limit,),
            ).fetchall()
            return [self._draft_from_row(connection, row) for row in rows]

    def set_state(
        self,
        draft_id: str,
        status: str,
        *,
        task_id: str | None = None,
        last_error: str | None = None,
    ) -> dict[str, Any]:
        if status not in STATUSES:
            raise PublisherStateError(f"未知刊登状态：{status}")
        fields = ["status = ?", "updated_at = ?"]
        values: list[Any] = [status, now_text()]
        if task_id is not None:
            fields.append("mabang_task_id = ?")
            values.append(str(task_id))
        if last_error is not None:
            fields.append("last_error = ?")
            values.append(str(last_error))
        values.append(draft_id)
        with self._lock, closing(self._connect()) as connection:
            cursor = connection.execute(
                f"UPDATE listing_drafts SET {', '.join(fields)} WHERE id = ?",
                values,
            )
            connection.commit()
        if cursor.rowcount != 1:
            raise PublisherNotFoundError("刊登草稿不存在。")
        return self.get_draft(draft_id)

    def confirm(self, draft_id: str, expected_version: int) -> dict[str, Any]:
        draft = self.get_draft(draft_id)
        if draft["status"] != "WAIT_CONFIRM":
            raise PublisherStateError("草稿尚未完成马帮回读和字段校验。")
        if draft["version"] != int(expected_version):
            raise PublisherStateError("草稿版本已经变化，请重新检查后确认。")
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """
                UPDATE listing_drafts
                SET confirmed_version=?, updated_at=?
                WHERE id=?
                """,
                (draft["version"], now_text(), draft_id),
            )
            connection.commit()
        self.add_event(
            draft_id,
            "human_confirmed",
            "WAIT_CONFIRM",
            f"已人工确认草稿版本{draft['version']}。",
        )
        return self.get_draft(draft_id)

    def add_event(
        self,
        draft_id: str,
        event_type: str,
        status: str,
        message: str,
        *,
        job_id: str = "",
        payload: Mapping[str, Any] | None = None,
    ) -> None:
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO publish_events (
                    job_id, draft_id, event_type, status, message,
                    payload_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id or None,
                    draft_id,
                    event_type,
                    status,
                    message,
                    json.dumps(dict(payload or {}), ensure_ascii=False),
                    now_text(),
                ),
            )
            connection.commit()

    def list_events(self, draft_id: str) -> list[dict[str, Any]]:
        self.get_draft(draft_id)
        with closing(self._connect()) as connection:
            rows = connection.execute(
                """
                SELECT * FROM publish_events
                WHERE draft_id=?
                ORDER BY id
                """,
                (draft_id,),
            ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["payload"] = json.loads(item.pop("payload_json") or "{}")
            result.append(item)
        return result

    def create_job(
        self,
        draft: Mapping[str, Any],
        *,
        idempotency_key: str,
        batch_id: str,
    ) -> dict[str, Any]:
        existing = self.get_job_by_key(idempotency_key)
        if existing:
            return existing
        job_id = new_id("job")
        stamp = now_text()
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO publish_jobs (
                    id, draft_id, draft_version, idempotency_key,
                    mabang_batch_id, status, message, error, attempts,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'MABANG_ACCEPTED', ?, '', 1, ?, ?)
                """,
                (
                    job_id,
                    draft["id"],
                    draft["version"],
                    idempotency_key,
                    batch_id,
                    "马帮已受理发布任务。",
                    stamp,
                    stamp,
                ),
            )
            connection.commit()
        return self.get_job(job_id)

    def get_job_by_key(self, idempotency_key: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM publish_jobs WHERE idempotency_key=?",
                (idempotency_key,),
            ).fetchone()
        return dict(row) if row else None

    def get_job(self, job_id: str) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM publish_jobs WHERE id=?",
                (job_id,),
            ).fetchone()
        if row is None:
            raise PublisherNotFoundError("刊登发布任务不存在。")
        return dict(row)

    def update_job(
        self,
        job_id: str,
        *,
        status: str,
        message: str,
        error: str = "",
    ) -> dict[str, Any]:
        with self._lock, closing(self._connect()) as connection:
            cursor = connection.execute(
                """
                UPDATE publish_jobs
                SET status=?, message=?, error=?, updated_at=?
                WHERE id=?
                """,
                (status, message, error, now_text(), job_id),
            )
            connection.commit()
        if cursor.rowcount != 1:
            raise PublisherNotFoundError("刊登发布任务不存在。")
        return self.get_job(job_id)

    def save_listing(
        self,
        job: Mapping[str, Any],
        draft: Mapping[str, Any],
        listing: Mapping[str, Any],
    ) -> dict[str, Any]:
        platform_product_id = _text(
            _first(listing, ("platform_product_id", "product_id", "item_id")),
            maximum=100,
        )
        product_url = _text(
            _first(listing, ("product_url", "platform_url", "url")),
            maximum=2000,
        )
        if not platform_product_id or not product_url:
            raise PublisherValidationError("平台结果缺少商品ID或链接。")
        record = {
            "id": new_id("listing"),
            "job_id": job["id"],
            "draft_id": draft["id"],
            "platform": draft["platform"],
            "shop_id": draft["shop_id"],
            "platform_product_id": platform_product_id,
            "platform_sku_ids": dict(listing.get("platform_sku_ids") or {}),
            "product_url": product_url,
            "resolved_at": now_text(),
        }
        with self._lock, closing(self._connect()) as connection:
            connection.execute(
                """
                INSERT INTO platform_listings (
                    id, job_id, draft_id, platform, shop_id,
                    platform_product_id, platform_sku_ids_json,
                    product_url, resolved_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record["id"],
                    record["job_id"],
                    record["draft_id"],
                    record["platform"],
                    record["shop_id"],
                    record["platform_product_id"],
                    json.dumps(record["platform_sku_ids"], ensure_ascii=False),
                    record["product_url"],
                    record["resolved_at"],
                ),
            )
            connection.commit()
        return record

    def get_listing_for_job(self, job_id: str) -> dict[str, Any] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM platform_listings WHERE job_id=?",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        result = dict(row)
        result["platform_sku_ids"] = json.loads(
            result.pop("platform_sku_ids_json") or "{}"
        )
        return result


class PublisherManager:
    """Application workflow using the main service's authenticated client."""

    def __init__(self, store: PublisherStore) -> None:
        self.store = store

    def create(
        self,
        payload: Mapping[str, Any],
        shops: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        return self.store.create_draft(normalize_draft(payload, shops))

    def update(
        self,
        draft_id: str,
        payload: Mapping[str, Any],
        shops: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        current = self.store.get_draft(draft_id)
        normalized = normalize_draft(
            payload,
            shops,
            source_internal_id=current.get("source_internal_id", ""),
        )
        return self.store.update_draft(draft_id, normalized)

    def clone(self, draft_id: str, shops: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        source = self.store.get_draft(draft_id)
        payload = {
            key: copy.deepcopy(source[key])
            for key in (
                "platform",
                "shop_id",
                "site",
                "title",
                "category_id",
                "category_name",
                "brand",
                "description",
                "attributes",
                "extended",
                "weight",
                "package_length",
                "package_width",
                "package_height",
                "variants",
                "assets",
                "source_internal_id",
            )
        }
        payload["title"] = f"{source['title']}（副本）"[:500]
        return self.create(payload, shops)

    def from_listing(
        self,
        client: Any,
        *,
        platform: str,
        internal_id: str,
        shops: Sequence[Mapping[str, Any]],
        listing_hint: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if platform != "lazada":
            raise PublisherValidationError("第一阶段只支持复制Lazada商品模板。")
        detail = copy.deepcopy(client.get_online_detail(platform, internal_id))
        if not isinstance(detail, Mapping):
            raise PublisherValidationError("马帮在线商品详情格式不正确。")
        detail = dict(detail)
        hint = listing_hint if isinstance(listing_hint, Mapping) else {}
        fallback_fields = {
            "title": hint.get("title"),
            "shop_id": hint.get("shop_id"),
            "site": hint.get("site"),
            "category_id": hint.get("category_id"),
            "image": hint.get("image"),
        }
        for key, value in fallback_fields.items():
            if detail.get(key) in (None, "", []):
                detail[key] = copy.deepcopy(value)
        if not (detail.get("variations") or detail.get("skus")):
            hint_variants = hint.get("variants")
            if isinstance(hint_variants, list):
                detail["variations"] = [
                    {
                        "sku": item.get("sku") or item.get("stock_sku"),
                        "price": item.get("price"),
                        "special_price": item.get("sale_price"),
                        "stock": item.get("stock"),
                    }
                    for item in hint_variants
                    if isinstance(item, Mapping)
                ]
        draft = draft_payload_from_listing(
            detail,
            shops,
            platform=platform,
            internal_id=internal_id,
        )
        return self.store.create_draft(draft)

    @staticmethod
    def _validation_issues(draft: Mapping[str, Any]) -> list[dict[str, str]]:
        issues: list[dict[str, str]] = []
        extended = draft.get("extended")
        if not isinstance(extended, Mapping):
            extended = {}
        schema = extended.get("category_schema")
        attributes = (
            draft.get("attributes")
            if isinstance(draft.get("attributes"), Mapping)
            else {}
        )
        if isinstance(schema, Mapping):
            for group in ("normal", "public", "logics"):
                fields = schema.get(group)
                if not isinstance(fields, list):
                    continue
                for field in fields:
                    if not isinstance(field, Mapping):
                        continue
                    mandatory = field.get("is_mandatory") in {
                        True, 1, "1", "true", "yes", "required",
                    }
                    name = _text(field.get("name"), maximum=200)
                    if mandatory and name and attributes.get(name) in (None, "", []):
                        issues.append({
                            "field": name,
                            "message": f"{_text(field.get('name_zh') or field.get('label') or name)}为平台必填项。",
                        })
            sku_fields = schema.get("sku")
            if isinstance(sku_fields, list):
                required_sale_fields = [
                    _text(field.get("name"), maximum=200)
                    for field in sku_fields
                    if isinstance(field, Mapping)
                    and field.get("is_mandatory") in {
                        True, 1, "1", "true", "yes", "required",
                    }
                    and _text(field.get("name"), maximum=200)
                ]
                for variant in draft.get("variants") or []:
                    properties = (
                        variant.get("properties")
                        if isinstance(variant, Mapping)
                        and isinstance(variant.get("properties"), list)
                        else []
                    )
                    values = {
                        _text(item.get("name"), maximum=200): item.get("value")
                        for item in properties
                        if isinstance(item, Mapping)
                    }
                    for name in required_sale_fields:
                        if values.get(name) in (None, "", []):
                            issues.append({
                                "field": f"variants.{variant.get('sku')}.{name}",
                                "message": f"SKU {variant.get('sku')}缺少必填销售属性{name}。",
                            })
        return issues

    def validate(self, draft_id: str) -> dict[str, Any]:
        draft = self.store.get_draft(draft_id)
        issues = self._validation_issues(draft)
        return {
            "valid": not issues,
            "issues": issues,
            "draft_id": draft_id,
            "version": draft["version"],
        }

    @staticmethod
    def _readback_matches(local: Mapping[str, Any], remote: Mapping[str, Any]) -> bool:
        remote_title = _text(_first(remote, ("title", "name")))
        remote_shop = _text(_first(remote, ("shop_id", "shopId")))
        remote_variants = remote.get("variants") or remote.get("variations") or []
        remote_skus = {
            _text(_first(item, ("sku", "vsku", "seller_sku"))).casefold()
            for item in remote_variants
            if isinstance(item, Mapping)
        }
        local_skus = {str(item["sku"]).casefold() for item in local["variants"]}
        return (
            remote_title == local["title"]
            and remote_shop == str(local["shop_id"])
            and remote_skus == local_skus
        )

    def save_to_mabang(self, client: Any, draft_id: str) -> dict[str, Any]:
        draft = self.store.get_draft(draft_id)
        if draft["status"] not in {"LOCAL_DRAFT", "FAILED"}:
            raise PublisherStateError("当前草稿状态不允许重复保存到马帮。")
        issues = self._validation_issues(draft)
        if issues:
            raise PublisherValidationError(
                "发布前字段未完成：" + "；".join(item["message"] for item in issues[:5])
            )
        self.store.set_state(draft_id, "SAVING_TO_MABANG", last_error="")
        self.store.add_event(
            draft_id,
            "mabang_save_started",
            "SAVING_TO_MABANG",
            "正在使用当前登录会话保存马帮草稿。",
        )
        try:
            receipt = client.save_publish_draft(copy.deepcopy(draft))
            task_id = _text(
                _first(receipt, ("task_id", "id", "draft_id"))
                if isinstance(receipt, Mapping)
                else receipt
            )
            if not task_id:
                raise PublisherValidationError("马帮草稿保存响应缺少任务ID。")
            self.store.set_state(draft_id, "MABANG_DRAFT", task_id=task_id)
            self.store.add_event(
                draft_id,
                "mabang_draft_saved",
                "MABANG_DRAFT",
                f"马帮草稿任务ID：{task_id}",
            )
            remote = client.get_publish_draft(task_id)
            if not isinstance(remote, Mapping) or not self._readback_matches(draft, remote):
                raise PublisherValidationError("马帮草稿回读字段与本地草稿不一致。")
            self.store.set_state(draft_id, "READBACK_OK")
            self.store.add_event(
                draft_id,
                "readback_ok",
                "READBACK_OK",
                "马帮草稿标题、店铺和SKU回读一致。",
            )
            self.store.set_state(draft_id, "VALIDATED")
            self.store.add_event(
                draft_id,
                "validated",
                "VALIDATED",
                "刊登必填字段校验通过。",
            )
            result = self.store.set_state(draft_id, "WAIT_CONFIRM")
            self.store.add_event(
                draft_id,
                "wait_confirm",
                "WAIT_CONFIRM",
                "等待人工确认当前草稿版本。",
            )
            return result
        except Exception as exc:
            self.store.set_state(draft_id, "FAILED", last_error=str(exc))
            self.store.add_event(
                draft_id,
                "mabang_save_failed",
                "FAILED",
                str(exc),
            )
            raise

    def confirm(self, draft_id: str, expected_version: int) -> dict[str, Any]:
        return self.store.confirm(draft_id, expected_version)

    def publish(self, client: Any, draft_id: str) -> dict[str, Any]:
        draft = self.store.get_draft(draft_id)
        idempotency_key = f"publish:{draft_id}:v{draft['version']}"
        existing = self.store.get_job_by_key(idempotency_key)
        if existing:
            return {
                "draft": draft,
                "job": existing,
                "listing": self.store.get_listing_for_job(existing["id"]),
            }
        if draft["status"] != "WAIT_CONFIRM":
            raise PublisherStateError("草稿尚未进入人工确认阶段。")
        if draft["confirmed_version"] != draft["version"]:
            raise PublisherStateError("请先人工确认当前草稿版本。")
        if not draft["mabang_task_id"]:
            raise PublisherStateError("草稿缺少马帮任务ID，不能发布。")
        self.store.set_state(draft_id, "PUBLISH_SUBMITTED")
        self.store.add_event(
            draft_id,
            "publish_submitted",
            "PUBLISH_SUBMITTED",
            "已提交刊登发布任务。",
        )
        try:
            receipt = client.publish_draft_task(draft["mabang_task_id"])
            batch_id = _text(
                _first(receipt, ("batch_id", "batchId", "id"))
                if isinstance(receipt, Mapping)
                else receipt
            )
            if not batch_id:
                raise PublisherValidationError("发布响应缺少批次ID。")
            job = self.store.create_job(
                draft,
                idempotency_key=idempotency_key,
                batch_id=batch_id,
            )
            result = self.store.set_state(draft_id, "MABANG_ACCEPTED")
            self.store.add_event(
                draft_id,
                "mabang_accepted",
                "MABANG_ACCEPTED",
                f"马帮已受理，批次ID：{batch_id}",
                job_id=job["id"],
            )
            return {"draft": result, "job": job, "listing": None}
        except Exception as exc:
            self.store.set_state(draft_id, "FAILED", last_error=str(exc))
            self.store.add_event(
                draft_id,
                "publish_failed",
                "FAILED",
                str(exc),
            )
            raise

    @staticmethod
    def _progress(payload: Mapping[str, Any]) -> tuple[int, int, int]:
        data = payload.get("data") if isinstance(payload.get("data"), Mapping) else {}
        counts = (
            data.get("data_num")
            if isinstance(data.get("data_num"), Mapping)
            else {}
        )
        return (
            int(counts.get("total_num") or 0),
            int(counts.get("success_num") or 0),
            int(counts.get("fail_num") or 0),
        )

    def refresh_job(self, client: Any, job_id: str) -> dict[str, Any]:
        job = self.store.get_job(job_id)
        draft = self.store.get_draft(job["draft_id"])
        status_payload = client.get_batch_process(job["mabang_batch_id"])
        total, success, failed = self._progress(status_payload)
        if failed:
            message = "马帮发布任务失败，请查看马帮错误明细。"
            updated = self.store.update_job(
                job_id,
                status="FAILED",
                message=message,
                error=message,
            )
            self.store.set_state(draft["id"], "FAILED", last_error=message)
            self.store.add_event(
                draft["id"],
                "platform_failed",
                "FAILED",
                message,
                job_id=job_id,
                payload=status_payload,
            )
            return {"draft": self.store.get_draft(draft["id"]), "job": updated, "listing": None}
        if not total or success < total:
            updated = self.store.update_job(
                job_id,
                status="PLATFORM_PROCESSING",
                message="平台正在处理刊登任务。",
            )
            self.store.set_state(draft["id"], "PLATFORM_PROCESSING")
            return {"draft": self.store.get_draft(draft["id"]), "job": updated, "listing": None}

        self.store.set_state(draft["id"], "PLATFORM_PROCESSING")
        try:
            resolved = client.resolve_published_listing(
                draft["mabang_task_id"],
                draft["shop_id"],
            )
        except Exception as exc:
            updated = self.store.update_job(
                job_id,
                status="PLATFORM_PROCESSING",
                message=(
                    "马帮已完成发布；等待平台商品ID和链接解析。"
                    f" 当前原因：{exc}"
                ),
            )
            self.store.add_event(
                draft["id"],
                "resolution_pending",
                "PLATFORM_PROCESSING",
                updated["message"],
                job_id=job_id,
            )
            return {"draft": self.store.get_draft(draft["id"]), "job": updated, "listing": None}

        listing = self.store.save_listing(job, draft, resolved)
        updated = self.store.update_job(
            job_id,
            status="PUBLISHED",
            message="平台发布成功，已取得商品ID和链接。",
        )
        published_draft = self.store.set_state(draft["id"], "PUBLISHED")
        self.store.add_event(
            draft["id"],
            "published",
            "PUBLISHED",
            f"平台商品ID：{listing['platform_product_id']}",
            job_id=job_id,
            payload=listing,
        )
        return {"draft": published_draft, "job": updated, "listing": listing}
