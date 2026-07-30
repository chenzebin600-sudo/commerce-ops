# -*- coding: utf-8 -*-
"""Read and safely update listings through Mabang ERP's publishing module.

Read operations cover Lazada, Shopee and TikTokShop.  Online save routes for
all three platforms are reconstructed from Mabang's current publishing UI.
Callers must still perform a fresh-detail read, field-level diff confirmation
and post-write verification.
"""

from __future__ import annotations

import argparse
import copy
import csv
import getpass
import json
import os
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator, Mapping, Sequence
from urllib.parse import parse_qs, urljoin, urlsplit

import requests


DEFAULT_ACCOUNT_HOST = "900445.private.mabangerp.com"
PUBLISH_HOST = "https://publish-private.mabangerp.com"
API_HOST = "https://api.mabangerp.com"
PRIVATE_API_HOST = "https://api-private.mabangerp.com"
REQUEST_TIMEOUT = (10, 90)
SHOPEE_SITE_PRODUCT_TYPE = 3

PAGE_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
}

AJAX_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": PAGE_HEADERS["User-Agent"],
    "X-Requested-With": "XMLHttpRequest",
}


class MabangListingError(RuntimeError):
    """Base error for Mabang publishing requests."""


class MabangAuthenticationError(MabangListingError):
    """Raised when Mabang rejects the account or publishing token."""


class MabangProtocolError(MabangListingError):
    """Raised when Mabang changes an expected response or page structure."""


class MabangPublishProtocolNotCaptured(MabangProtocolError):
    """Raised when a publishing route still needs a verified browser capture."""


@dataclass(frozen=True)
class ListingState:
    key: str
    menu_type: str
    total_field: str
    online_endpoint: bool


@dataclass(frozen=True)
class PlatformConfig:
    key: str
    display_name: str
    platform_id: int
    menu_key: str
    goto_platform: str
    states: tuple[ListingState, ...]

    def state(self, state_key: str) -> ListingState:
        normalized = str(state_key or "").strip().lower()
        for item in self.states:
            if item.key == normalized:
                return item
        choices = "、".join(item.key for item in self.states)
        raise ValueError(f"{self.display_name} 不支持状态 {state_key!r}，可选：{choices}")


PLATFORMS: dict[str, PlatformConfig] = {
    "lazada": PlatformConfig(
        key="lazada",
        display_name="Lazada",
        platform_id=7,
        menu_key="M0010802",
        goto_platform="lazada",
        states=(
            ListingState("online", "6", "online_count", True),
            ListingState("examining", "11", "examine_count", False),
            ListingState("offline", "9", "offline_count", False),
            ListingState("prohibited", "8", "prohibit_count", False),
            ListingState("deleted", "10", "delete_count", False),
        ),
    ),
    "shopee": PlatformConfig(
        key="shopee",
        display_name="Shopee",
        platform_id=17,
        menu_key="M0010813",
        goto_platform="shopee",
        states=(
            ListingState("online", "6", "online_count", True),
            ListingState("sold_out", "7", "soldout_count", False),
            ListingState("offline", "9", "offline_count", False),
            ListingState("prohibited", "13", "prohibit_sell_count", False),
            ListingState("deleted", "10", "delete_count", False),
        ),
    ),
    "tiktokshop": PlatformConfig(
        key="tiktokshop",
        display_name="TikTokShop",
        platform_id=104,
        menu_key="M001089933",
        goto_platform="tiktokshop",
        states=(
            ListingState("online", "6", "online_count", True),
            ListingState("draft", "25", "draft_count", False),
            ListingState("sold_out", "7", "soldout_count", True),
            ListingState("examining", "11", "examine_count", False),
            ListingState("offline", "9", "offline_count", False),
            ListingState("pending", "20", "pending_count", False),
            ListingState("deactivated", "12", "deactive_count", False),
            ListingState("deleted", "10", "delete_count", False),
        ),
    ),
}

PLATFORM_ALIASES = {
    "lazada": "lazada",
    "7": "lazada",
    "shopee": "shopee",
    "17": "shopee",
    "tiktok": "tiktokshop",
    "tiktokshop": "tiktokshop",
    "104": "tiktokshop",
}


@dataclass
class PublishContext:
    platform: PlatformConfig
    api_base: str
    cluster_id: str
    company_id: str
    memcache_key: str
    token: str = field(repr=False)
    c_key: str = field(default="", repr=False)


class _IframeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.src = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "iframe":
            return
        values = {key.lower(): value or "" for key, value in attrs}
        if values.get("id") == "iframeContent":
            self.src = values.get("src", "")


def resolve_platform(value: str | int | PlatformConfig) -> PlatformConfig:
    if isinstance(value, PlatformConfig):
        return value
    key = PLATFORM_ALIASES.get(str(value).strip().lower())
    if not key:
        choices = "、".join(config.display_name for config in PLATFORMS.values())
        raise ValueError(f"不支持的平台 {value!r}，目前支持：{choices}")
    return PLATFORMS[key]


def _first_value(source: Mapping[str, Any], names: Sequence[str], default: Any = "") -> Any:
    for name in names:
        value = source.get(name)
        if value is not None and value != "":
            return value
    return default


def _json_payload(response: requests.Response, action: str) -> dict[str, Any]:
    try:
        payload = response.json()
    except Exception as exc:
        prefix = (response.text or "")[:300].replace("\r", " ").replace("\n", " ")
        raise MabangProtocolError(
            f"{action}未返回 JSON，HTTP {response.status_code}：{prefix}"
        ) from exc
    if not isinstance(payload, dict):
        raise MabangProtocolError(f"{action}返回了非对象 JSON。")
    return payload


class MabangListingClient:
    """Authenticated client for Mabang's publishing module."""

    def __init__(
        self,
        account_host: str = DEFAULT_ACCOUNT_HOST,
        session: requests.Session | None = None,
        timeout: tuple[int, int] = REQUEST_TIMEOUT,
    ) -> None:
        self.account_host = account_host.strip().strip("/")
        self.base_url = f"https://{self.account_host}"
        self.session = session or requests.Session()
        self.session.trust_env = False
        self.timeout = timeout
        self._logged_in = False
        self._contexts: dict[str, PublishContext] = {}

    @property
    def login_page_url(self) -> str:
        return self.base_url + "/index.php?mod=main.loginPage"

    def clone_authenticated(self) -> "MabangListingClient":
        """Create an isolated read client that reuses the current in-memory auth."""

        self._require_login()
        session = requests.Session()
        session.trust_env = False
        session.headers.update(self.session.headers)
        session.cookies.update(self.session.cookies)
        clone = MabangListingClient(
            account_host=self.account_host,
            session=session,
            timeout=self.timeout,
        )
        clone._logged_in = True
        clone._contexts = dict(self._contexts)
        return clone

    def login(self, username: str, password: str) -> None:
        username = str(username or "").strip()
        if not username or not password:
            raise MabangAuthenticationError("马帮账号和密码不能为空。")

        self.session.get(
            self.login_page_url,
            headers=PAGE_HEADERS,
            timeout=self.timeout,
            allow_redirects=True,
        )
        files = {
            "isMallRpcFinds": (None, ""),
            "username": (None, username),
            "password": (None, password),
            "verifyCode": (None, ""),
            "remember": (None, "1"),
            "loginEntrance": (None, "1"),
        }
        response = self.session.post(
            self.base_url + "/index.php?mod=main.doLogin",
            files=files,
            headers={
                **AJAX_HEADERS,
                "Origin": self.base_url,
                "Referer": self.login_page_url,
            },
            timeout=self.timeout,
            allow_redirects=True,
        )
        payload = _json_payload(response, "马帮登录")
        if not payload.get("success"):
            message = str(payload.get("message") or "未知错误")
            if "验证" in message or "验证码" in message:
                raise MabangAuthenticationError("马帮要求人工验证，当前账号无法自动登录。")
            raise MabangAuthenticationError(f"马帮登录失败：{message}")

        self._logged_in = True
        self._contexts.clear()

    def _require_login(self) -> None:
        if not self._logged_in:
            raise MabangAuthenticationError("请先调用 login() 登录马帮。")

    def _open_publish_context(self, platform: PlatformConfig) -> PublishContext:
        self._require_login()
        cached = self._contexts.get(platform.key)
        if cached:
            return cached

        goto_url = self.base_url + "/index.php"
        goto_params = {
            "mod": "main.gotoApp",
            "v": "v3",
            "menuKey": platform.menu_key,
            "platform": platform.goto_platform,
            "version": "1",
        }
        response = self.session.get(
            goto_url,
            params=goto_params,
            headers={**PAGE_HEADERS, "Referer": self.base_url + "/index.php?mod=order.list"},
            timeout=self.timeout,
            allow_redirects=True,
        )
        parser = _IframeParser()
        parser.feed(response.text or "")
        if not parser.src:
            raise MabangProtocolError(
                f"没有在 {platform.display_name} 刊登页找到 iframeContent，"
                "账号可能没有刊登权限或马帮页面已经改版。"
            )

        iframe_url = urljoin(response.url, parser.src)
        fragment = urlsplit(iframe_url).fragment
        if "?" not in fragment:
            raise MabangProtocolError(f"{platform.display_name} 刊登地址缺少认证参数。")
        route_path, fragment_query = fragment.split("?", 1)
        if route_path.rstrip("/") != "/publishProductListV2":
            raise MabangProtocolError(
                f"{platform.display_name} 刊登入口发生变化：{route_path}"
            )

        query = parse_qs(fragment_query)
        c_key = (query.get("cKey") or [""])[0]
        memcache_key = (query.get("memcacheKey") or [""])[0]
        if not c_key:
            raise MabangProtocolError(f"{platform.display_name} 刊登地址缺少 cKey。")

        user_response = self.session.get(
            PUBLISH_HOST + "/index.php",
            params={"m": "public", "a": "getUserInfo", "cKey": c_key},
            headers={
                **AJAX_HEADERS,
                "Origin": PUBLISH_HOST,
                "Referer": iframe_url,
            },
            timeout=self.timeout,
            allow_redirects=True,
        )
        payload = _json_payload(user_response, "获取刊登令牌")
        if not payload.get("success"):
            raise MabangAuthenticationError(
                f"获取 {platform.display_name} 刊登令牌失败："
                f"{payload.get('msg') or payload.get('message') or '未知错误'}"
            )

        data = payload.get("data")
        if not isinstance(data, dict):
            raise MabangProtocolError("刊登令牌响应缺少 data。")
        token = str(data.get("token") or "")
        if not token:
            raise MabangProtocolError("刊登令牌响应缺少 token。")

        try:
            cloud = int(data.get("cloud") or 0)
        except (TypeError, ValueError):
            cloud = 0
        context = PublishContext(
            platform=platform,
            api_base=PRIVATE_API_HOST if cloud == 1 else API_HOST,
            cluster_id="2" if cloud == 1 else "1",
            company_id=str(data.get("companyId") or data.get("company_id") or ""),
            memcache_key=memcache_key,
            token=token,
            c_key=c_key,
        )
        self._contexts[platform.key] = context
        return context

    @staticmethod
    def _api_headers(context: PublishContext) -> dict[str, str]:
        headers = {
            **AJAX_HEADERS,
            "Authorization": "Bearer " + context.token,
            "ProjectId": "erp",
            "cluster-id": context.cluster_id,
            "Origin": PUBLISH_HOST,
            "Referer": PUBLISH_HOST + "/publish-ui/",
        }
        if context.memcache_key:
            headers["key"] = context.memcache_key
        return headers

    def _api_request(
        self,
        platform: PlatformConfig,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json_body: Mapping[str, Any] | Sequence[Any] | None = None,
        action: str,
    ) -> dict[str, Any]:
        for attempt in range(2):
            context = self._open_publish_context(platform)
            response = self.session.request(
                method,
                context.api_base + path,
                params=params,
                json=json_body,
                headers=self._api_headers(context),
                timeout=self.timeout,
                allow_redirects=True,
            )
            payload = _json_payload(response, action)
            code = payload.get("code")
            unauthorized = response.status_code in (401, 403) or str(code) in ("401", "403")
            if unauthorized and attempt == 0:
                self._contexts.pop(platform.key, None)
                continue
            if response.status_code >= 400:
                raise MabangListingError(
                    f"{action}失败，HTTP {response.status_code}："
                    f"{payload.get('msg') or payload.get('message') or '未知错误'}"
                )
            if code not in (None, 0, 200, "0", "200") or payload.get("success") is False:
                raise MabangListingError(
                    f"{action}失败："
                    f"{payload.get('msg') or payload.get('message') or payload}"
                )
            return payload
        raise MabangAuthenticationError(f"{action}失败：刊登登录已过期。")

    def get_shops(self, platform: str | int | PlatformConfig) -> list[dict[str, Any]]:
        config = resolve_platform(platform)
        payload = self._api_request(
            config,
            "GET",
            "/kandeng/api/v2/common/publish/shop/list",
            params={"platformId": config.platform_id},
            action=f"获取 {config.display_name} 店铺",
        )
        shops = payload.get("data") or []
        if not isinstance(shops, list):
            raise MabangProtocolError(f"{config.display_name} 店铺响应的 data 不是列表。")
        return shops

    def get_categories(
        self,
        platform: str | int | PlatformConfig,
        *,
        shop_id: str | int,
        site: str,
        parent_category_id: str | int = -1,
        search_name: str = "",
    ) -> list[dict[str, Any]]:
        """Read the category tree/search used by Mabang's new-listing form."""

        config = resolve_platform(platform)
        if config.key != "lazada":
            raise MabangProtocolError("当前只验证了Lazada新建刊登类目接口。")
        normalized_shop_id = str(shop_id or "").strip()
        normalized_site = str(site or "").strip()
        if not normalized_shop_id or not normalized_site:
            raise ValueError("查询类目需要店铺ID和站点。")
        payload = self._api_request(
            config,
            "GET",
            "/kandeng/api/v2/lazada/getCategory",
            params={
                "parent_category_id": str(parent_category_id),
                "shop_id": normalized_shop_id,
                "search_name": str(search_name or "").strip(),
                "site": normalized_site,
                "platformId": config.platform_id,
            },
            action="查询Lazada刊登类目",
        )
        data = payload.get("data")
        if isinstance(data, Mapping):
            for key in ("list", "items", "categories"):
                if isinstance(data.get(key), list):
                    data = data[key]
                    break
        if not isinstance(data, list):
            raise MabangProtocolError("Lazada类目响应的data不是列表。")
        return [dict(item) for item in data if isinstance(item, Mapping)]

    def get_category_attributes(
        self,
        platform: str | int | PlatformConfig,
        *,
        site: str,
        category_id: str | int,
    ) -> dict[str, list[dict[str, Any]]]:
        """Read ordinary, sale and logistics fields for a Lazada category."""

        config = resolve_platform(platform)
        if config.key != "lazada":
            raise MabangProtocolError("当前只验证了Lazada新建刊登属性接口。")
        normalized_site = str(site or "").strip()
        normalized_category_id = str(category_id or "").strip()
        if not normalized_site or not normalized_category_id:
            raise ValueError("查询类目属性需要站点和类目ID。")
        payload = self._api_request(
            config,
            "GET",
            "/kandeng/api/v2/lazada/getAttribute",
            params={
                "site": normalized_site,
                "category_id": normalized_category_id,
            },
            action="查询Lazada类目属性",
        )
        data = payload.get("data")
        if not isinstance(data, Mapping):
            raise MabangProtocolError("Lazada类目属性响应的data不是对象。")
        return {
            key: [dict(item) for item in data.get(key, []) if isinstance(item, Mapping)]
            for key in ("normal", "sku", "public", "logics")
        }

    def get_online_detail(
        self,
        platform: str | int | PlatformConfig,
        internal_id: str | int,
    ) -> dict[str, Any]:
        """Return the full online-listing detail used by Mabang's editor."""

        config = resolve_platform(platform)
        listing_id = str(internal_id or "").strip()
        if not listing_id:
            raise ValueError("马帮刊登内部 ID 不能为空。")
        path = (
            "/kandeng/api/v2/tiktok/online/detail"
            if config.key == "tiktokshop"
            else "/kandeng/api/v2/common/online/detail"
        )
        payload = self._api_request(
            config,
            "GET",
            path,
            params={"platformId": config.platform_id, "id": listing_id},
            action=f"获取 {config.display_name} 在线商品详情",
        )
        detail = payload.get("data")
        if not isinstance(detail, dict):
            raise MabangProtocolError(
                f"{config.display_name} 在线商品详情响应的 data 不是对象。"
            )
        return detail

    def get_shopee_warehouse_list(
        self,
        shop_id: str | int,
    ) -> list[dict[str, Any]]:
        """Return the warehouse catalog loaded by Shopee's Site Product editor."""

        normalized_shop_id = str(shop_id or "").strip()
        if not normalized_shop_id:
            raise ValueError("Shopee warehouse lookup requires a shop ID.")
        payload = self._api_request(
            PLATFORMS["shopee"],
            "GET",
            "/kandeng/api/v2/shopee/getWarehouseList",
            params={"shop_id": normalized_shop_id},
            action="get Shopee Site Product warehouse list",
        )
        warehouses = payload.get("data")
        if not isinstance(warehouses, list):
            raise MabangProtocolError(
                "Shopee warehouse-list response data is not a list."
            )

        result: list[dict[str, Any]] = []
        for raw in warehouses:
            if not isinstance(raw, Mapping):
                continue
            location_id = str(
                raw.get("locationId") or raw.get("location_id") or ""
            ).strip()
            if not location_id:
                continue
            result.append(
                {
                    "location_id": location_id,
                    "warehouse_id": raw.get("warehouseId")
                    or raw.get("warehouse_id")
                    or "",
                    "warehouse_name": str(
                        raw.get("warehouseName")
                        or raw.get("warehouse_name")
                        or ""
                    ).strip(),
                    "zipcode": str(raw.get("zipcode") or "").strip(),
                    "country": str(raw.get("country") or "").strip(),
                    "city": str(raw.get("city") or "").strip(),
                    "district": str(raw.get("district") or "").strip(),
                    "state": str(raw.get("state") or "").strip(),
                }
            )
        return result

    def get_lazada_warehouse_list(
        self,
        shop_id: str | int,
    ) -> list[dict[str, Any]]:
        """Return Lazada warehouses available to Mabang's stock editor."""

        normalized_shop_id = str(shop_id or "").strip()
        if not normalized_shop_id:
            raise ValueError("Lazada warehouse lookup requires a shop ID.")
        payload = self._api_request(
            PLATFORMS["lazada"],
            "GET",
            "/kandeng/api/v2/lazada/warehouse/list",
            params={"shop_id": normalized_shop_id},
            action="get Lazada warehouse list",
        )
        warehouses = payload.get("data")
        if not isinstance(warehouses, list):
            raise MabangProtocolError(
                "Lazada warehouse-list response data is not a list."
            )

        result: list[dict[str, Any]] = []
        for raw in warehouses:
            if not isinstance(raw, Mapping):
                continue
            warehouse_code = str(
                raw.get("code") or raw.get("warehouse_code") or ""
            ).strip()
            if not warehouse_code:
                continue
            result.append(
                {
                    "warehouse_code": warehouse_code,
                    "warehouse_name": str(
                        raw.get("name") or raw.get("warehouse_name") or ""
                    ).strip(),
                    "detail_address": str(
                        raw.get("detailAddress")
                        or raw.get("detail_address")
                        or ""
                    ).strip(),
                    "default_address": bool(
                        raw.get("defaultAddress")
                        if raw.get("defaultAddress") is not None
                        else raw.get("default_address")
                    ),
                    "need_to_update": bool(
                        raw.get("needToUpdate")
                        if raw.get("needToUpdate") is not None
                        else raw.get("need_to_update")
                    ),
                    "status": str(raw.get("status") or "").strip(),
                }
            )
        return result

    def get_online_batch_details(
        self,
        platform: str | int | PlatformConfig,
        listing_ids: Sequence[str | int],
        *,
        shopee_global: bool = False,
    ) -> list[dict[str, Any]]:
        """Return the exact detail objects used by Mabang's batch editor."""

        config = resolve_platform(platform)
        normalized_ids = [
            str(item).strip() for item in listing_ids if str(item).strip()
        ]
        if not normalized_ids:
            raise ValueError("批量在线详情至少需要一个商品 ID。")
        path = (
            "/kandeng/api/v2/shopee/online/detail/batch"
            if config.key == "shopee" and shopee_global
            else "/kandeng/api/v2/common/online/detail/batch"
        )
        payload = self._api_request(
            config,
            "GET",
            path,
            params={
                "platformId": str(config.platform_id),
                "id": ",".join(normalized_ids),
            },
            action=f"获取 {config.display_name} 批量在线详情",
        )
        details = payload.get("data")
        if not isinstance(details, list):
            raise MabangProtocolError(
                f"{config.display_name} 批量在线详情响应的 data 不是列表。"
            )
        return [dict(item) for item in details if isinstance(item, Mapping)]

    @staticmethod
    def prepare_lazada_online_save_payload(
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Prepare the full Lazada detail body expected by the online save API.

        Mabang's editor keeps a temporary ``specialTime`` range for each
        variation.  The save request sends that range as two concrete fields and
        removes the temporary value.  Other fields are kept untouched.
        """

        body = copy.deepcopy(dict(detail))
        # Mabang's Lazada editor always injects the platform identifier before
        # calling the shared online-save endpoint. Without it the endpoint can
        # return code=200 while silently leaving the listing unchanged.
        body["platformId"] = PLATFORMS["lazada"].platform_id
        variations = body.get("variations")
        if not isinstance(variations, list):
            raise MabangProtocolError("Lazada 在线商品详情缺少 variations 列表。")

        for variation in variations:
            if not isinstance(variation, dict):
                continue
            special_time = variation.pop("specialTime", None)
            if isinstance(special_time, (list, tuple)):
                if len(special_time) > 0 and special_time[0] not in (None, ""):
                    variation["special_from_time"] = special_time[0]
                if len(special_time) > 1 and special_time[1] not in (None, ""):
                    variation["special_to_time"] = special_time[1]
            elif isinstance(special_time, dict):
                start = (
                    special_time.get("start")
                    or special_time.get("from")
                    or special_time.get("special_from_time")
                )
                end = (
                    special_time.get("end")
                    or special_time.get("to")
                    or special_time.get("special_to_time")
                )
                if start not in (None, ""):
                    variation["special_from_time"] = start
                if end not in (None, ""):
                    variation["special_to_time"] = end
            else:
                variation.setdefault("special_from_time", "")
                variation.setdefault("special_to_time", "")

        body["is_save_and_publish"] = 1 if publish else 0
        return body

    def save_lazada_online_detail(
        self,
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Save a full Lazada online-product detail and sync it to the store."""

        body = self.prepare_lazada_online_save_payload(detail, publish=publish)
        return self._api_request(
            PLATFORMS["lazada"],
            "POST",
            "/kandeng/api/v2/common/online/save",
            json_body=body,
            action="保存并同步 Lazada 在线商品",
        )

    @staticmethod
    def prepare_shopee_online_save_payload(
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Prepare Shopee's local-online editor payload.

        Mabang opens ordinary Shopee online listings with ``global=3``.  The
        editor submits that state to the shared online-save route while keeping
        both ``shopId`` and ``shop_id`` in the body.
        """

        body = copy.deepcopy(dict(detail))
        body["platformId"] = PLATFORMS["shopee"].platform_id
        shop_id = body.get("shopId") or body.get("shop_id")
        if shop_id in (None, ""):
            shop = body.get("shop")
            if isinstance(shop, Mapping):
                shop_id = shop.get("id") or shop.get("shop_id")
        if shop_id in (None, ""):
            raise MabangProtocolError("Shopee 在线商品详情缺少 shopId。")
        body["shopId"] = shop_id
        body["shop_id"] = shop_id
        variations = body.get("variations")
        if not isinstance(variations, list):
            raise MabangProtocolError("Shopee 在线商品详情缺少 variations 列表。")
        tier_options = body.get("tierVariationOption")
        if not isinstance(tier_options, list):
            raise MabangProtocolError(
                "Shopee 在线商品详情缺少 tierVariationOption 规格列表。"
            )
        body["is_save_and_publish"] = 1 if publish else 0
        return body

    def save_shopee_online_detail(
        self,
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Save a Shopee local online listing and submit it to the store."""

        body = self.prepare_shopee_online_save_payload(detail, publish=publish)
        return self._api_request(
            PLATFORMS["shopee"],
            "POST",
            "/kandeng/api/v2/common/online/save",
            json_body=body,
            action="保存并同步 Shopee 在线商品",
        )

    @staticmethod
    def prepare_tiktok_online_save_payload(
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Prepare the body used by TikTok Shop's online editor."""

        body = copy.deepcopy(dict(detail))
        body["platformId"] = PLATFORMS["tiktokshop"].platform_id
        shop_id = body.get("shop_id") or body.get("shopId")
        if shop_id in (None, ""):
            shop = body.get("shop")
            if isinstance(shop, Mapping):
                shop_id = shop.get("id") or shop.get("shop_id")
        if shop_id in (None, ""):
            raise MabangProtocolError("TikTok Shop 在线商品详情缺少 shop_id。")
        body["shop_id"] = shop_id
        variations = body.get("variations")
        if not isinstance(variations, list):
            raise MabangProtocolError("TikTok Shop 在线商品详情缺少 variations 列表。")
        body["variation"] = str(body.get("variation") or "2")
        body["is_save_and_publish"] = 1 if publish else 0
        return body

    def save_tiktok_online_detail(
        self,
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Save a TikTok Shop online listing and submit it to the store."""

        body = self.prepare_tiktok_online_save_payload(detail, publish=publish)
        return self._api_request(
            PLATFORMS["tiktokshop"],
            "POST",
            "/kandeng/api/v2/tiktok/online/save",
            json_body=body,
            action="保存并同步 TikTok Shop 在线商品",
        )

    def save_online_detail(
        self,
        platform: str | int | PlatformConfig,
        detail: Mapping[str, Any],
        *,
        publish: bool = True,
    ) -> dict[str, Any]:
        """Dispatch a full online-detail save to the captured platform route."""

        config = resolve_platform(platform)
        if config.key == "lazada":
            return self.save_lazada_online_detail(detail, publish=publish)
        if config.key == "shopee":
            return self.save_shopee_online_detail(detail, publish=publish)
        if config.key == "tiktokshop":
            return self.save_tiktok_online_detail(detail, publish=publish)
        raise ValueError(f"{config.display_name} 尚未配置在线保存接口。")

    def _save_online_local_value(
        self,
        platform: str | int | PlatformConfig,
        field: str,
        details: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """Submit full online details through Mabang's quick price/stock editor."""

        config = resolve_platform(platform)
        if config.key not in {"lazada", "shopee"}:
            raise ValueError("Local-online edits only support Lazada or Shopee.")
        normalized_field = str(field or "").strip().lower()
        if normalized_field not in {"price", "stock"}:
            raise ValueError("Local-online edits only support price or stock.")
        normalized_details: list[dict[str, Any]] = []
        for detail in details:
            if not isinstance(detail, Mapping):
                continue
            item = copy.deepcopy(dict(detail))
            shop_id = item.get("shop_id") or item.get("shopId")
            if shop_id in (None, ""):
                shop = item.get("shop")
                if isinstance(shop, Mapping):
                    shop_id = shop.get("id") or shop.get("shop_id")
            if shop_id in (None, ""):
                raise MabangProtocolError(
                    f"{config.display_name} online detail is missing shop_id."
                )
            item["shop_id"] = shop_id
            if config.key == "shopee" and normalized_field == "stock":
                item = self._prepare_shopee_warehouse_stock_detail(item)
            normalized_details.append(item)
        if not normalized_details:
            raise ValueError("Local-online edit requires at least one detail.")
        return self._api_request(
            config,
            "POST",
            f"/kandeng/api/v2/{config.key}/online/local/save/{normalized_field}",
            json_body=normalized_details,
            action=f"submit {config.display_name} local-online {normalized_field} edit",
        )

    def save_lazada_online_local_value(
        self,
        field: str,
        details: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        return self._save_online_local_value("lazada", field, details)

    @staticmethod
    def prepare_lazada_warehouse_stock_payload(
        details: Sequence[Mapping[str, Any]],
    ) -> dict[str, list[dict[str, Any]]]:
        """Build Lazada's dedicated multi-warehouse stock update payload."""

        payload_items: list[dict[str, Any]] = []
        for detail in details:
            if not isinstance(detail, Mapping):
                continue
            raw_product_id = detail.get("product_id") or detail.get("item_id")
            try:
                product_id = int(str(raw_product_id))
            except (TypeError, ValueError) as exc:
                raise MabangProtocolError(
                    "Lazada warehouse stock detail is missing a numeric product_id."
                ) from exc

            shop = detail.get("shop")
            if not isinstance(shop, Mapping):
                raise MabangProtocolError(
                    "Lazada warehouse stock detail is missing the shop object."
                )
            normalized_shop = copy.deepcopy(dict(shop))
            raw_shop_id = (
                normalized_shop.get("id")
                or normalized_shop.get("shop_id")
                or detail.get("shop_id")
                or detail.get("shopId")
            )
            try:
                normalized_shop["id"] = int(str(raw_shop_id))
            except (TypeError, ValueError) as exc:
                raise MabangProtocolError(
                    "Lazada warehouse stock detail is missing a numeric shop ID."
                ) from exc

            variations = detail.get("variations")
            if not isinstance(variations, list) or not variations:
                raise MabangProtocolError(
                    "Lazada warehouse stock detail is missing variations."
                )
            normalized_variations: list[dict[str, Any]] = []
            for variation in variations:
                if not isinstance(variation, Mapping):
                    continue
                sku = str(variation.get("sku") or "").strip()
                raw_sku_id = variation.get("sku_id") or variation.get("id")
                try:
                    sku_id = int(str(raw_sku_id))
                except (TypeError, ValueError) as exc:
                    raise MabangProtocolError(
                        f"Lazada variation {sku or 'unknown'} is missing a "
                        "numeric sku_id."
                    ) from exc
                warehouses = variation.get("warehouse_stock")
                if not isinstance(warehouses, list) or not warehouses:
                    raise MabangProtocolError(
                        f"Lazada variation {sku or sku_id} has no warehouse_stock."
                    )
                normalized_warehouses: list[dict[str, Any]] = []
                for warehouse in warehouses:
                    if not isinstance(warehouse, Mapping):
                        continue
                    warehouse_code = str(
                        warehouse.get("warehouse_code")
                        or warehouse.get("code")
                        or ""
                    ).strip()
                    if not warehouse_code:
                        raise MabangProtocolError(
                            f"Lazada variation {sku or sku_id} contains a "
                            "warehouse without warehouse_code."
                        )
                    try:
                        stock = int(str(warehouse.get("stock") or "0"))
                    except (TypeError, ValueError) as exc:
                        raise MabangProtocolError(
                            f"Lazada warehouse {warehouse_code} stock must be "
                            "an integer."
                        ) from exc
                    if stock < 0:
                        raise MabangProtocolError(
                            f"Lazada warehouse {warehouse_code} stock cannot "
                            "be negative."
                        )
                    normalized_warehouses.append(
                        {
                            "warehouse_code": warehouse_code,
                            "stock": stock,
                        }
                    )
                if not normalized_warehouses:
                    raise MabangProtocolError(
                        f"Lazada variation {sku or sku_id} has no editable "
                        "warehouse stock rows."
                    )
                normalized_variations.append(
                    {
                        "sku": sku,
                        "sku_id": sku_id,
                        "warehouse_stock": normalized_warehouses,
                    }
                )

            if not normalized_variations:
                raise MabangProtocolError(
                    "Lazada warehouse stock detail has no editable variations."
                )
            payload_items.append(
                {
                    "product_id": product_id,
                    "shop": normalized_shop,
                    "variations": normalized_variations,
                }
            )

        if not payload_items:
            raise ValueError(
                "Lazada warehouse stock update requires at least one detail."
            )
        return {"list": payload_items}

    def save_lazada_warehouse_stock(
        self,
        details: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """Update Lazada stock through Mabang's warehouse-aware endpoint."""

        body = self.prepare_lazada_warehouse_stock_payload(details)
        return self._api_request(
            PLATFORMS["lazada"],
            "POST",
            "/kandeng/api/v2/lazada/warehouse/stock/update",
            json_body=body,
            action="submit Lazada multi-warehouse stock edit",
        )

    def save_shopee_online_local_value(
        self,
        field: str,
        details: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        return self._save_online_local_value("shopee", field, details)

    @staticmethod
    def _prepare_shopee_warehouse_stock_detail(
        detail: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Normalize editable warehouse rows for either Shopee stock route."""

        item = copy.deepcopy(dict(detail))
        variations = item.get("variations")
        if not isinstance(variations, list):
            raise MabangProtocolError(
                "Shopee online detail is missing variations."
            )
        for variation in variations:
            if not isinstance(variation, dict):
                continue
            warehouses = variation.get("warehouse_stock")
            if not isinstance(warehouses, list) or not warehouses:
                continue
            total = 0
            for warehouse in warehouses:
                if not isinstance(warehouse, dict):
                    continue
                for key in [
                    item
                    for item in warehouse
                    if str(item).startswith("_warehouse_")
                ]:
                    warehouse.pop(key, None)
                try:
                    stock = int(str(warehouse.get("stock") or "0"))
                except (TypeError, ValueError) as exc:
                    raise MabangProtocolError(
                        "Shopee warehouse stock must be an integer."
                    ) from exc
                if stock < 0:
                    raise MabangProtocolError(
                        "Shopee warehouse stock cannot be negative."
                    )
                total += stock
            variation["stock"] = total
        return item

    def save_shopee_online_global_stock(
        self,
        details: Sequence[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """Save Shopee stock with the warehouse-aware editor contract."""

        normalized_details: list[dict[str, Any]] = []
        for detail in details:
            if not isinstance(detail, Mapping):
                continue
            normalized_details.append(
                self._prepare_shopee_warehouse_stock_detail(detail)
            )

        if not normalized_details:
            raise ValueError("Shopee global stock edit requires at least one detail.")
        return self._api_request(
            PLATFORMS["shopee"],
            "POST",
            "/kandeng/api/v2/shopee/online/global/save/stock",
            json_body=normalized_details,
            action="submit Shopee multi-warehouse stock edit",
        )

    def sync_online_product(
        self,
        platform: str | int | PlatformConfig,
        *,
        product_id: str | int,
        shop_id: str | int,
        ean: str = "",
    ) -> dict[str, Any]:
        """Ask Mabang to refresh one listing from the actual platform."""

        config = resolve_platform(platform)
        normalized_product_id = str(product_id or "").strip()
        normalized_shop_id = str(shop_id or "").strip()
        if not normalized_product_id or not normalized_shop_id:
            raise ValueError("Platform refresh requires product_id and shop_id.")

        item: dict[str, Any] = {
            "id": normalized_product_id,
            "shopId": normalized_shop_id,
        }
        normalized_ean = str(ean or "").strip()
        if normalized_ean:
            item["ean"] = normalized_ean
        body = {
            "platformId": str(config.platform_id),
            "idAndShopId": [item],
        }
        route_platform = "tiktok" if config.key == "tiktokshop" else config.key
        return self._api_request(
            config,
            "POST",
            f"/kandeng/api/v2/{route_platform}/public/sync/product",
            json_body=body,
            action=f"refresh {config.display_name} listing",
        )

    def get_batch_process(
        self,
        batch_id: str | int,
        *,
        platform: str | int | PlatformConfig = "lazada",
    ) -> dict[str, Any]:
        """Read the task status used by Mabang's own batch progress dialog."""

        normalized_batch_id = str(batch_id or "").strip()
        if not normalized_batch_id:
            raise ValueError("马帮批量任务 ID 不能为空。")
        return self._api_request(
            resolve_platform(platform),
            "GET",
            "/kandeng/api/v2/common/public/batch/process",
            params={"batch_id": normalized_batch_id},
            action="查询马帮批量修改进度",
        )

    @staticmethod
    def prepare_lazada_publish_payload(
        draft: Mapping[str, Any],
        *,
        company_id: str = "",
    ) -> dict[str, Any]:
        """Map the local safe draft to Mabang's captured Lazada productForm."""

        extended = (
            copy.deepcopy(dict(draft.get("extended") or {}))
            if isinstance(draft.get("extended"), Mapping)
            else {}
        )
        attributes = (
            dict(draft.get("attributes") or {})
            if isinstance(draft.get("attributes"), Mapping)
            else {}
        )
        product_properties = []
        existing_properties = extended.get("product_property")
        if isinstance(existing_properties, list):
            for item in existing_properties:
                if not isinstance(item, Mapping):
                    continue
                prop = copy.deepcopy(dict(item))
                name = str(prop.get("name") or "").strip()
                if name and name in attributes:
                    prop["value"] = copy.deepcopy(attributes[name])
                prop.setdefault("type", "lazada")
                product_properties.append(prop)
        known = {
            str(item.get("name") or "").strip()
            for item in product_properties
            if isinstance(item, Mapping)
        }
        schema = extended.get("category_schema")
        schema_fields = []
        if isinstance(schema, Mapping):
            for group in ("normal", "public", "logics"):
                values = schema.get(group)
                if isinstance(values, list):
                    schema_fields.extend(
                        item for item in values if isinstance(item, Mapping)
                    )
        schema_by_name = {
            str(item.get("name") or "").strip(): item for item in schema_fields
        }
        for name, value in attributes.items():
            normalized_name = str(name or "").strip()
            if not normalized_name or normalized_name in known:
                continue
            field = schema_by_name.get(normalized_name, {})
            prop = {
                "name": normalized_name,
                "value": copy.deepcopy(value),
                "type": "lazada",
            }
            if field.get("unit") not in (None, ""):
                prop["unit"] = field["unit"]
            product_properties.append(prop)

        variations = []
        for raw in draft.get("variants") or []:
            if not isinstance(raw, Mapping):
                continue
            properties = raw.get("properties")
            if not isinstance(properties, list):
                properties = []
            if not properties:
                properties = [{
                    "name": raw.get("specification_name") or "variation",
                    "value": raw.get("specification_value") or "Default",
                }]
            images = raw.get("images")
            if not isinstance(images, list):
                images = []
            variation = {
                "company_id": company_id,
                "sku": str(raw.get("sku") or "").strip(),
                "stock": int(raw.get("stock") or 0),
                "price": str(raw.get("price") or ""),
                "special_price": str(raw.get("special_price") or ""),
                "package_weight": str(
                    raw.get("package_weight") or draft.get("weight") or ""
                ),
                "package_length": str(
                    raw.get("package_length") or draft.get("package_length") or ""
                ),
                "package_width": str(
                    raw.get("package_width") or draft.get("package_width") or ""
                ),
                "package_height": str(
                    raw.get("package_height") or draft.get("package_height") or ""
                ),
                "package_content": str(extended.get("whatisinthebox") or ""),
                "propert": copy.deepcopy(properties),
                "image": images,
                "images": images,
                "warehouse_stock": copy.deepcopy(
                    raw.get("warehouse_stock")
                    if isinstance(raw.get("warehouse_stock"), list)
                    else []
                ),
            }
            if raw.get("special_from_time"):
                variation["special_from_time"] = raw["special_from_time"]
            if raw.get("special_to_time"):
                variation["special_to_time"] = raw["special_to_time"]
            variations.append(variation)

        assets = [
            str(item.get("url") if isinstance(item, Mapping) else item).strip()
            for item in draft.get("assets") or []
        ]
        assets = [item for item in assets if item]
        shop_id = str(draft.get("shop_id") or "").strip()
        category = (
            copy.deepcopy(extended.get("category"))
            if isinstance(extended.get("category"), Mapping)
            else {}
        )
        category.setdefault("category_id", str(draft.get("category_id") or ""))
        category.setdefault("name", str(draft.get("category_name") or ""))
        return {
            "company_id": company_id,
            "id": str(draft.get("mabang_task_id") or ""),
            "platformId": PLATFORMS["lazada"].platform_id,
            "shopList": [{
                "id": shop_id,
                "name": str(draft.get("shop_name") or ""),
                "site": str(draft.get("site") or ""),
            }],
            "shop_id": shop_id,
            "site": str(draft.get("site") or ""),
            "global_site": "",
            "currency": str(extended.get("currency") or ""),
            "source_url": str(extended.get("source_url") or ""),
            "category": category,
            "category_id": str(draft.get("category_id") or ""),
            "category_id_path": copy.deepcopy(
                extended.get("category_id_path")
                if isinstance(extended.get("category_id_path"), list)
                else []
            ),
            "product_property": product_properties,
            "title": str(draft.get("title") or ""),
            "title_ms": "",
            "brand": str(draft.get("brand") or "No Brand"),
            "model": str(extended.get("source_model_name") or ""),
            "description": str(draft.get("description") or ""),
            "description_ms": "",
            "highlights": copy.deepcopy(extended.get("highlights") or []),
            "whatisinthebox": str(extended.get("whatisinthebox") or ""),
            "free_items": str(extended.get("free_items") or ""),
            "video_url": str(extended.get("video_url") or ""),
            "warranty_type": str(extended.get("warranty_type") or ""),
            "warranty_period": str(extended.get("warranty_period") or ""),
            "warranty_policy": str(extended.get("warranty_policy") or ""),
            "warranty_policy_ms": "",
            "is_global": 0,
            "product_length": str(draft.get("package_length") or ""),
            "product_width": str(draft.get("package_width") or ""),
            "product_height": str(draft.get("package_height") or ""),
            "product_weight": str(draft.get("weight") or ""),
            "tax_class": str(extended.get("tax_class") or ""),
            "thai_name": "",
            "indonesian_name": "",
            "vietnamese_name": "",
            "images": assets,
            "variations": variations,
            "auto_allocate_stock": 0,
            "is_save_and_publish": 1,
            "thumbnail_images": assets,
            "preorder_enable": int(bool(extended.get("preorder_enable"))),
            "preorder_days": int(extended.get("preorder_days") or 0),
            "video_info": copy.deepcopy(extended.get("video_info") or {}),
            "delivery_option_sof": copy.deepcopy(
                extended.get("delivery_option_sof") or []
            ),
            "size_chart": copy.deepcopy(extended.get("size_chart") or {}),
        }

    def save_publish_draft(self, draft: Mapping[str, Any]) -> dict[str, Any]:
        """Save a Lazada draft through Mabang's captured new-listing contract."""

        platform = resolve_platform(str(draft.get("platform") or "lazada"))
        if platform.key != "lazada":
            raise MabangProtocolError("当前只验证了Lazada新建刊登保存接口。")
        context = self._open_publish_context(platform)
        body = self.prepare_lazada_publish_payload(
            draft,
            company_id=context.company_id,
        )
        payload = self._api_request(
            platform,
            "POST",
            "/kandeng/api/v2/common/task/save",
            json_body=body,
            action="保存Lazada刊登草稿",
        )
        data = payload.get("data") if isinstance(payload, Mapping) else None
        candidates: list[Any] = [data, payload]
        task_id = ""
        for item in candidates:
            if isinstance(item, Mapping):
                task_id = str(
                    item.get("task_id")
                    or item.get("taskId")
                    or item.get("id")
                    or ""
                ).strip()
            elif item not in (None, ""):
                task_id = str(item).strip()
            if task_id:
                break
        if not task_id:
            raise MabangProtocolError("马帮已响应草稿保存请求，但响应中缺少任务ID。")
        return {"task_id": task_id, "raw": payload}

    def get_publish_draft(self, task_id: str | int) -> dict[str, Any]:
        """Read a saved publishing draft after its exact route is captured."""

        normalized_task_id = str(task_id or "").strip()
        if not normalized_task_id:
            raise ValueError("马帮刊登草稿任务 ID 不能为空。")
        payload = self._api_request(
            PLATFORMS["lazada"],
            "GET",
            "/kandeng/api/v2/common/task/detail",
            params={
                "platformId": PLATFORMS["lazada"].platform_id,
                "id": normalized_task_id,
            },
            action="回读Lazada刊登草稿",
        )
        data = payload.get("data") if isinstance(payload, Mapping) else None
        if not isinstance(data, Mapping):
            raise MabangProtocolError("马帮刊登草稿回读响应的data不是对象。")
        for key in ("productForm", "product_form", "detail"):
            if isinstance(data.get(key), Mapping):
                return dict(data[key])
        return dict(data)

    def publish_draft_task(self, task_id: str | int) -> dict[str, Any]:
        """Submit a verified Mabang draft to Lazada's publishing task."""

        normalized_task_id = str(task_id or "").strip()
        if not normalized_task_id:
            raise ValueError("马帮刊登草稿任务 ID 不能为空。")
        payload = self._api_request(
            PLATFORMS["lazada"],
            "POST",
            "/kandeng/api/v2/common/task/publish",
            json_body={
                "platformId": PLATFORMS["lazada"].platform_id,
                "id": normalized_task_id,
            },
            action="提交 Lazada 刊登任务",
        )
        data = payload.get("data") if isinstance(payload, Mapping) else None
        if not isinstance(data, Mapping):
            data = payload if isinstance(payload, Mapping) else {}
        batch_id = (
            data.get("batch_id")
            or data.get("batchId")
            or data.get("id")
            or payload.get("batch_id")
            or payload.get("batchId")
        )
        if not str(batch_id or "").strip():
            raise MabangProtocolError("马帮已响应刊登请求，但响应中缺少批次 ID。")
        return {"batch_id": str(batch_id), "raw": payload}

    def resolve_published_listing(
        self,
        task_id: str | int,
        shop_id: str | int,
    ) -> dict[str, Any]:
        """Resolve platform item ID/link after the exact result route is captured."""

        if not str(task_id or "").strip() or not str(shop_id or "").strip():
            raise ValueError("查询发布结果需要刊登任务 ID 和店铺 ID。")
        raise MabangPublishProtocolNotCaptured(
            "马帮发布结果中的平台商品 ID/链接查询接口尚未捕获。"
            "任务状态可以查询，但不会伪造发布成功链接。"
        )

    def get_listing_page(
        self,
        platform: str | int | PlatformConfig,
        *,
        state: str = "online",
        page: int = 1,
        page_size: int = 100,
        shop_ids: Sequence[str | int] = (),
        search_type: str = "",
        search_value: str = "",
        extra_filters: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        config = resolve_platform(platform)
        state_config = config.state(state)
        if page < 1:
            raise ValueError("page 必须大于等于 1。")
        if page_size < 1 or page_size > 500:
            raise ValueError("page_size 必须在 1 到 500 之间。")

        filters: dict[str, Any] = {
            "platformId": config.platform_id,
            "page": page,
            "page_size": page_size,
            "menu_type": state_config.menu_type,
            "shop_id": ",".join(str(item) for item in shop_ids if str(item).strip()),
            "search_type": search_type if search_value else "",
            "search_value": search_value,
            "order_by": "",
            "create_time_start": "",
            "create_time_end": "",
            "site_id": "",
            "hasRemark": 0,
            "timeType": "2" if config.key == "shopee" else "1",
        }
        if config.key in ("lazada", "shopee"):
            filters["saleOperId"] = ""
        if config.key == "shopee":
            filters.update(
                create_operate_ids="",
                remark="",
                repeated_goods=0,
                category_id="",
                product_type=SHOPEE_SITE_PRODUCT_TYPE,
            )
        elif config.key == "tiktokshop":
            filters["is_presale"] = None
        if extra_filters:
            filters.update(extra_filters)

        if config.key == "tiktokshop":
            path = (
                "/kandeng/api/v2/tiktok/online/list"
                if state_config.online_endpoint
                else "/kandeng/api/v2/tiktok/offline/list"
            )
            return self._api_request(
                config,
                "POST",
                path,
                json_body=filters,
                action=f"获取 {config.display_name} {state_config.key} 商品",
            )

        path = (
            "/kandeng/api/v2/common/online/list"
            if state_config.online_endpoint
            else "/kandeng/api/v2/common/offline/list"
        )
        payload = self._api_request(
            config,
            "GET",
            path,
            params=filters,
            action=f"获取 {config.display_name} {state_config.key} 商品",
        )
        if config.key == "shopee" and state_config.online_endpoint:
            return self._enrich_shopee_listing_prices(payload)
        return payload

    def _enrich_shopee_listing_prices(
        self,
        payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        enriched = copy.deepcopy(dict(payload))
        rows = enriched.get("data")
        if not isinstance(rows, list):
            return enriched

        listing_ids: list[str] = []
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            variations = row.get("variations")
            needs_detail = not isinstance(variations, list) or any(
                isinstance(variation, Mapping)
                and variation.get("original_price") in (None, "")
                for variation in variations
            )
            listing_id = str(row.get("id") or row.get("product_id") or "").strip()
            if needs_detail and listing_id:
                listing_ids.append(listing_id)
        if not listing_ids:
            return enriched

        details: list[dict[str, Any]] = []
        try:
            for offset in range(0, len(listing_ids), 50):
                details.extend(
                    self.get_online_batch_details(
                        "shopee",
                        listing_ids[offset : offset + 50],
                        shopee_global=False,
                    )
                )
        except MabangListingError:
            enriched["price_detail_complete"] = False
            return enriched

        details_by_id: dict[str, Mapping[str, Any]] = {}
        for detail in details:
            for key in ("id", "product_id"):
                value = str(detail.get(key) or "").strip()
                if value:
                    details_by_id[value] = detail

        for row in rows:
            if not isinstance(row, dict):
                continue
            detail = next(
                (
                    details_by_id[value]
                    for value in (
                        str(row.get("id") or "").strip(),
                        str(row.get("product_id") or "").strip(),
                    )
                    if value in details_by_id
                ),
                None,
            )
            if not isinstance(detail, Mapping):
                continue
            detail_variations = detail.get("variations")
            if not isinstance(detail_variations, list):
                continue
            row_variations = row.get("variations")
            if not isinstance(row_variations, list) or not row_variations:
                row["variations"] = copy.deepcopy(detail_variations)
                continue

            detail_by_variant: dict[tuple[str, str], Mapping[str, Any]] = {}
            for variation in detail_variations:
                if not isinstance(variation, Mapping):
                    continue
                for key in ("sku_id", "variation_id", "id"):
                    value = str(variation.get(key) or "").strip()
                    if value:
                        detail_by_variant[("id", value)] = variation
                sku = str(
                    variation.get("sku")
                    or variation.get("seller_sku")
                    or variation.get("platform_sku")
                    or ""
                ).strip()
                if sku:
                    detail_by_variant[("sku", sku.casefold())] = variation

            for variation in row_variations:
                if not isinstance(variation, dict):
                    continue
                candidates = [
                    ("id", str(variation.get(key) or "").strip())
                    for key in ("sku_id", "variation_id", "id")
                ]
                sku = str(
                    variation.get("sku")
                    or variation.get("seller_sku")
                    or variation.get("platform_sku")
                    or ""
                ).strip()
                if sku:
                    candidates.append(("sku", sku.casefold()))
                detail_variation = next(
                    (
                        detail_by_variant[key]
                        for key in candidates
                        if key[1] and key in detail_by_variant
                    ),
                    None,
                )
                if not isinstance(detail_variation, Mapping):
                    continue
                for key in (
                    "original_price",
                    "discount_price",
                    "price",
                    "is_discount",
                ):
                    if detail_variation.get(key) not in (None, ""):
                        variation[key] = copy.deepcopy(detail_variation[key])

        enriched["price_detail_complete"] = True
        return enriched

    def iter_listing_pages(
        self,
        platform: str | int | PlatformConfig,
        *,
        states: Sequence[str] | str = ("online",),
        page_size: int = 500,
        max_pages: int | None = None,
        shop_ids: Sequence[str | int] = (),
        search_type: str = "",
        search_value: str = "",
        extra_filters: Mapping[str, Any] | None = None,
        progress: Callable[[str, int, int], None] | None = None,
    ) -> Iterator[tuple[str, dict[str, Any]]]:
        config = resolve_platform(platform)
        selected_states = resolve_states(config, states)
        if max_pages is not None and max_pages < 1:
            raise ValueError("max_pages 必须大于等于 1。")

        for state in selected_states:
            page = 1
            while max_pages is None or page <= max_pages:
                payload = self.get_listing_page(
                    config,
                    state=state,
                    page=page,
                    page_size=page_size,
                    shop_ids=shop_ids,
                    search_type=search_type,
                    search_value=search_value,
                    extra_filters=extra_filters,
                )
                rows = payload.get("data") or []
                if not isinstance(rows, list):
                    raise MabangProtocolError(
                        f"{config.display_name} {state} 响应的 data 不是列表。"
                    )
                if progress:
                    progress(state, page, len(rows))
                if not rows:
                    break
                yield state, payload
                if len(rows) < page_size:
                    break
                page += 1

    def iter_listings(
        self,
        platform: str | int | PlatformConfig,
        **kwargs: Any,
    ) -> Iterator[dict[str, Any]]:
        config = resolve_platform(platform)
        for state, payload in self.iter_listing_pages(config, **kwargs):
            for raw in payload.get("data") or []:
                if isinstance(raw, dict):
                    yield normalize_listing(config, state, raw)


def resolve_states(
    platform: PlatformConfig,
    states: Sequence[str] | str,
) -> tuple[str, ...]:
    if isinstance(states, str):
        values = [item.strip().lower() for item in states.split(",") if item.strip()]
    else:
        values = [str(item).strip().lower() for item in states if str(item).strip()]
    if not values:
        return ("online",)
    if "all" in values:
        return tuple(item.key for item in platform.states)

    result: list[str] = []
    for value in values:
        platform.state(value)
        if value not in result:
            result.append(value)
    return tuple(result)


def extract_shopee_warehouse_stock(
    raw: Mapping[str, Any],
) -> list[dict[str, Any]]:
    """Return Shopee's editable warehouse rows from either detail contract."""

    warehouses = raw.get("warehouse_stock")
    if isinstance(warehouses, list) and warehouses:
        return [
            copy.deepcopy(dict(item))
            for item in warehouses
            if isinstance(item, Mapping)
        ]

    stock_info = raw.get("stock_info_v2")
    if not isinstance(stock_info, Mapping):
        return []
    seller_stock = stock_info.get("seller_stock")
    if not isinstance(seller_stock, list):
        return []

    result: list[dict[str, Any]] = []
    seen_locations: set[str] = set()
    for item in seller_stock:
        if not isinstance(item, Mapping):
            continue
        location_id = str(
            item.get("location_id") or item.get("locationId") or ""
        ).strip()
        if not location_id or location_id in seen_locations:
            continue
        try:
            stock = int(str(item.get("stock") or "0"))
        except (TypeError, ValueError):
            continue
        result.append(
            {
                "location_id": location_id,
                "stock": stock,
                "_warehouse_saleable": bool(item.get("if_saleable", True)),
            }
        )
        seen_locations.add(location_id)
    return result


def normalize_variant(
    raw: Mapping[str, Any],
    platform: str = "",
) -> dict[str, Any]:
    warehouses = extract_shopee_warehouse_stock(raw)
    if str(platform).strip().lower() == "shopee":
        price = _first_value(raw, ("original_price",))
        sale_price = _first_value(
            raw,
            ("discount_price", "price", "sale_price", "special_price"),
        )
    else:
        price = _first_value(raw, ("price", "local_price", "original_price"))
        sale_price = _first_value(
            raw,
            ("special_price", "sale_price", "discount_price"),
        )
    return {
        "variant_id": _first_value(raw, ("sku_id", "variation_id", "id")),
        "sku": _first_value(raw, ("sku", "seller_sku", "platform_sku")),
        "seller_sku": raw.get("seller_sku", ""),
        "platform_sku": raw.get("platform_sku", ""),
        "vsku": raw.get("vsku", ""),
        "stock_sku": _first_value(raw, ("stock_sku", "erp_sku")),
        "price": price,
        "sale_price": sale_price,
        "stock": _first_value(raw, ("stock", "quantity", "stock_quantity"), 0),
        "warehouse_stock": warehouses,
        "supply_price": raw.get("supply_price", ""),
        "raw": dict(raw),
    }


def normalize_listing(
    platform: str | int | PlatformConfig,
    state: str,
    raw: Mapping[str, Any],
) -> dict[str, Any]:
    config = resolve_platform(platform)
    shop = raw.get("shop") if isinstance(raw.get("shop"), dict) else {}
    source = raw.get("source") if isinstance(raw.get("source"), dict) else {}
    raw_variants = raw.get("variations")
    if not isinstance(raw_variants, list):
        raw_variants = []
    variants = [
        normalize_variant(item, config.key)
        for item in raw_variants
        if isinstance(item, dict)
    ]

    images = raw.get("images", "")
    if isinstance(images, list):
        image = images[0] if images else ""
        if isinstance(image, dict):
            image = _first_value(image, ("url", "src", "imageUrl"))
    else:
        image = images

    return {
        "platform": config.key,
        "platform_name": config.display_name,
        "platform_id": config.platform_id,
        "state": state,
        "internal_id": _first_value(raw, ("id", "task_id")),
        "product_id": _first_value(raw, ("product_id", "item_id", "platform_product_id")),
        "product_url": _first_value(raw, ("platformUrl", "platform_url"), source.get("url", "")),
        "title": _first_value(raw, ("title", "name")),
        "parent_sku": _first_value(raw, ("sku", "parent_sku")),
        "currency": raw.get("currency") or shop.get("currency") or "",
        "image": image,
        "shop_id": raw.get("shop_id") or shop.get("id") or "",
        "shop_name": _first_value(shop, ("name", "shopName")),
        "site": _first_value(shop, ("amazonsite", "site", "site_name")),
        "category_id": raw.get("category_id", ""),
        "create_time": raw.get("create_time", ""),
        "update_time": raw.get("update_time", ""),
        "publish_time": raw.get("publish_time", ""),
        "variants": variants,
        "raw": dict(raw),
    }


CSV_COLUMNS = [
    "平台",
    "状态",
    "店铺ID",
    "店铺名称",
    "站点",
    "马帮内部ID",
    "平台商品ID",
    "商品链接",
    "标题",
    "父SKU",
    "币种",
    "变体ID",
    "变体SKU",
    "库存SKU",
    "价格",
    "促销价",
    "库存",
    "仓库库存",
    "供货价",
    "主图",
    "创建时间",
    "更新时间",
    "发布时间",
]


def flatten_listing_rows(listings: Iterable[Mapping[str, Any]]) -> Iterator[dict[str, Any]]:
    for listing in listings:
        variants = listing.get("variants")
        if not isinstance(variants, list) or not variants:
            variants = [{}]
        for variant in variants:
            warehouse_stock = variant.get("warehouse_stock") if isinstance(variant, dict) else []
            warehouse_text = json.dumps(
                warehouse_stock or [],
                ensure_ascii=False,
                separators=(",", ":"),
            )
            yield {
                "平台": listing.get("platform_name", ""),
                "状态": listing.get("state", ""),
                "店铺ID": listing.get("shop_id", ""),
                "店铺名称": listing.get("shop_name", ""),
                "站点": listing.get("site", ""),
                "马帮内部ID": listing.get("internal_id", ""),
                "平台商品ID": listing.get("product_id", ""),
                "商品链接": listing.get("product_url", ""),
                "标题": listing.get("title", ""),
                "父SKU": listing.get("parent_sku", ""),
                "币种": listing.get("currency", ""),
                "变体ID": variant.get("variant_id", ""),
                "变体SKU": variant.get("sku", ""),
                "库存SKU": variant.get("stock_sku", ""),
                "价格": variant.get("price", ""),
                "促销价": variant.get("sale_price", ""),
                "库存": variant.get("stock", ""),
                "仓库库存": warehouse_text,
                "供货价": variant.get("supply_price", ""),
                "主图": listing.get("image", ""),
                "创建时间": listing.get("create_time", ""),
                "更新时间": listing.get("update_time", ""),
                "发布时间": listing.get("publish_time", ""),
            }


def export_listings(
    listings: Iterable[Mapping[str, Any]],
    output_path: str | os.PathLike[str],
) -> int:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    records = list(listings)
    suffix = path.suffix.lower()
    if suffix == ".json":
        path.write_text(
            json.dumps(records, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return len(records)
    if suffix != ".csv":
        raise ValueError("输出文件只支持 .json 或 .csv。")

    rows = list(flatten_listing_rows(records))
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
    return len(records)


def export_shops(
    shops: Iterable[Mapping[str, Any]],
    output_path: str | os.PathLike[str],
) -> int:
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    records = [dict(item) for item in shops]
    if path.suffix.lower() == ".json":
        path.write_text(
            json.dumps(records, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    elif path.suffix.lower() == ".csv":
        columns: list[str] = []
        for record in records:
            for key in record:
                if key not in columns:
                    columns.append(key)
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=columns)
            writer.writeheader()
            writer.writerows(records)
    else:
        raise ValueError("输出文件只支持 .json 或 .csv。")
    return len(records)


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="通过马帮 ERP 刊登模块获取店铺和商品链接（只读）。"
    )
    parser.add_argument(
        "--account-host",
        default=os.getenv("MABANG_ACCOUNT_HOST", DEFAULT_ACCOUNT_HOST),
        help="马帮账号域名，例如 900445.private.mabangerp.com",
    )
    parser.add_argument("--username", default=os.getenv("MABANG_USERNAME", ""))
    parser.add_argument("--password", default=os.getenv("MABANG_PASSWORD", ""))
    parser.add_argument(
        "--platform",
        default="lazada",
        choices=tuple(PLATFORMS),
        help="要读取的刊登平台。",
    )
    parser.add_argument(
        "--state",
        default="all",
        help="商品状态；可用逗号分隔多个状态，all 表示平台全部状态。",
    )
    parser.add_argument(
        "--shop-id",
        action="append",
        default=[],
        help="只读取指定店铺，可重复传入。",
    )
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="每个状态最多读取页数；不设置则读完。",
    )
    parser.add_argument(
        "--shops-only",
        action="store_true",
        help="只导出账号可管理的店铺。",
    )
    parser.add_argument(
        "--output",
        default="",
        help="输出 .json 或 .csv；默认按平台生成文件名。",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_argument_parser().parse_args(argv)
    username = str(args.username or "").strip()
    if not username:
        raise SystemExit("请通过 --username 或 MABANG_USERNAME 提供马帮账号。")
    password = args.password or getpass.getpass("马帮密码：")
    if not password:
        raise SystemExit("马帮密码不能为空。")

    config = resolve_platform(args.platform)
    output = args.output
    if not output:
        output = (
            f"mabang_{config.key}_shops.json"
            if args.shops_only
            else f"mabang_{config.key}_listings.csv"
        )

    client = MabangListingClient(account_host=args.account_host)
    print("正在登录马帮……", flush=True)
    client.login(username, password)

    if args.shops_only:
        shops = client.get_shops(config)
        count = export_shops(shops, output)
        print(f"已导出 {count} 个店铺：{Path(output).resolve()}", flush=True)
        return 0

    def show_progress(state: str, page: int, count: int) -> None:
        print(f"{config.display_name} / {state} / 第 {page} 页：{count} 条", flush=True)

    listings = list(
        client.iter_listings(
            config,
            states=args.state,
            page_size=args.page_size,
            max_pages=args.max_pages,
            shop_ids=args.shop_id,
            progress=show_progress,
        )
    )
    count = export_listings(listings, output)
    variant_count = sum(len(item.get("variants") or []) for item in listings)
    print(
        f"已导出 {count} 个商品、{variant_count} 个变体：{Path(output).resolve()}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
