# -*- coding: utf-8 -*-

import copy
import tempfile
import time
import unittest
from http.client import RemoteDisconnected
from pathlib import Path
from unittest.mock import patch

import requests

import mabang_listing_service as service
from mabang_listing_client import MabangListingClient


class RequestAuthorizationTest(unittest.TestCase):
    def setUp(self):
        self.original_local_token = service.LOCAL_TOKEN
        self.original_internal_token = service.INTERNAL_TOKEN
        service.LOCAL_TOKEN = "local-test-token"
        service.INTERNAL_TOKEN = "internal-test-token"

    def tearDown(self):
        service.LOCAL_TOKEN = self.original_local_token
        service.INTERNAL_TOKEN = self.original_internal_token

    def test_accepts_commerce_ops_internal_token_without_browser_origin(self):
        self.assertTrue(
            service.request_authorized(
                origin="",
                local_token="",
                internal_token="internal-test-token",
            )
        )

    def test_rejects_invalid_internal_token_without_falling_back(self):
        self.assertFalse(
            service.request_authorized(
                origin="",
                local_token="",
                internal_token="wrong-token",
            )
        )

    def test_preserves_original_loopback_browser_token_flow(self):
        self.assertTrue(
            service.request_authorized(
                origin="http://127.0.0.1:3000",
                local_token="local-test-token",
                internal_token="",
            )
        )


class FakeListingClient(MabangListingClient):
    def __init__(self):
        super().__init__()
        self.detail = {
            "id": 6480099,
            "product_id": 16222622566,
            "title": "测试商品",
            "shop_id": "shop-3c",
            "shop": {"id": "shop-3c", "name": "3C pilot"},
            "variations": [
                {
                    "sku_id": 127430020150,
                    "sku": "T3CC1270045",
                    "status": 1,
                    "price": "3117.00",
                    "special_price": "1719.00",
                    "stock": 1000,
                    "warehouse_stock": [
                        {"warehouse_code": "default", "stock": 1000}
                    ],
                    "package_length": "12.4",
                    "package_width": "43.5",
                    "package_height": "29",
                    "package_weight": "4.81",
                }
            ],
        }
        self.save_calls = 0
        self.batch_save_calls = 0
        self.batch_process_calls = 0
        self.warehouse_save_calls = 0
        self.listing_page_calls = 0
        self.sync_calls = 0

    def get_listing_page(self, platform, **kwargs):
        self.listing_page_calls += 1
        rows = (
            [copy.deepcopy(item) for item in self.details.values()]
            if hasattr(self, "details")
            else [copy.deepcopy(self.detail)]
        )
        shop_ids = {
            str(item) for item in (kwargs.get("shop_ids") or []) if str(item)
        }
        search_type = str(kwargs.get("search_type") or "")
        search_value = str(kwargs.get("search_value") or "").strip()
        if shop_ids:
            rows = [
                item
                for item in rows
                if str(item.get("shop_id") or item.get("shopId") or "")
                in shop_ids
            ]
        if search_value and search_type == "product_id":
            rows = [
                item
                for item in rows
                if search_value
                in {
                    str(item.get("product_id") or ""),
                    str(item.get("id") or ""),
                }
            ]
        return {
            "data": rows,
            "count": len(rows),
            "total": {},
        }

    def get_online_detail(self, platform, internal_id):
        self.assert_target(platform, internal_id)
        return copy.deepcopy(self.detail)

    def get_online_batch_details(
        self,
        platform,
        listing_ids,
        *,
        shopee_global=False,
    ):
        if str(platform) != "lazada":
            raise AssertionError(platform)
        identifier = str(next(iter(listing_ids)))
        if hasattr(self, "details"):
            for detail in self.details.values():
                if identifier in {
                    str(detail.get("id")),
                    str(detail.get("product_id")),
                }:
                    return [copy.deepcopy(detail)]
            return []
        return [copy.deepcopy(self.detail)]

    def sync_online_product(self, platform, *, product_id, shop_id, ean=""):
        self.sync_calls += 1
        return {"success": True}

    def save_lazada_online_detail(self, detail, *, publish=True):
        self.assert_target("lazada", detail["id"])
        self.detail = copy.deepcopy(detail)
        self.save_calls += 1
        return {"code": 200}

    def save_lazada_online_local_value(self, field, details):
        self.batch_save_calls += 1
        for detail in details:
            if hasattr(self, "details"):
                self.details[str(detail["id"])] = copy.deepcopy(detail)
            else:
                self.detail = copy.deepcopy(detail)
        return {
            "code": 200,
            "data": {"batch_id": f"batch-{self.batch_save_calls}"},
        }

    def get_lazada_warehouse_list(self, shop_id):
        return [
            {
                "warehouse_code": "default",
                "warehouse_name": "Default warehouse",
                "detail_address": "",
                "default_address": True,
                "need_to_update": False,
                "status": "ACTIVE",
            }
        ]

    def save_lazada_warehouse_stock(self, details):
        self.warehouse_save_calls += 1
        for detail in details:
            if hasattr(self, "details"):
                self.details[str(detail["id"])] = copy.deepcopy(detail)
            else:
                self.detail = copy.deepcopy(detail)
        return {"code": 200, "msg": "success", "data": {}}

    def get_batch_process(self, batch_id, *, platform="lazada"):
        self.batch_process_calls += 1
        return {
            "code": 200,
            "data": {
                "data_num": {
                    "total_num": 1,
                    "fail_num": 0,
                    "success_num": 1,
                },
                "data_error": [],
            },
        }

    def get_shops(self, platform):
        if str(platform) != "lazada":
            raise AssertionError(platform)
        return [
            {
                "id": "shop-3c",
                "name": "3C pilot",
                "amazonsite": "TH",
                "currency": "THB",
            }
        ]

    def iter_listing_pages(self, platform, **kwargs):
        if str(platform) != "lazada":
            raise AssertionError(platform)
        yield "online", {
            "data": [
                {
                    "id": 6480099,
                    "product_id": 16222622566,
                    "title": "测试商品",
                    "shop_id": "shop-3c",
                    "shop": {
                        "id": "shop-3c",
                        "name": "3C pilot",
                        "amazonsite": "TH",
                    },
                    "category_id": "1001",
                    "variations": [
                        {
                            "sku_id": 127430020150,
                            "sku": "T3CC1270045",
                            "stock": 1000,
                            "price": "3117.00",
                            "special_price": "1719.00",
                        }
                    ],
                }
            ]
        }

    @staticmethod
    def assert_target(platform, internal_id):
        if str(platform) != "lazada" or str(internal_id) != "6480099":
            raise AssertionError((platform, internal_id))


class DelayedReadbackListingClient(FakeListingClient):
    def __init__(self):
        super().__init__()
        self.pending_detail = None
        self.stale_readbacks_remaining = 2

    def get_online_detail(self, platform, internal_id):
        self.assert_target(platform, internal_id)
        if self.pending_detail is not None:
            if self.stale_readbacks_remaining > 0:
                self.stale_readbacks_remaining -= 1
            else:
                self.detail = self.pending_detail
                self.pending_detail = None
        return copy.deepcopy(self.detail)

    def save_lazada_online_detail(self, detail, *, publish=True):
        self.assert_target("lazada", detail["id"])
        self.pending_detail = copy.deepcopy(detail)
        self.save_calls += 1
        return {"code": 200}


class TransientDisconnectReadbackListingClient(FakeListingClient):
    def __init__(self):
        super().__init__()
        self.readback_started = False
        self.refresh_disconnects_remaining = 2
        self.disconnects_remaining = 2

    def sync_online_product(self, platform, *, product_id, shop_id, ean=""):
        if self.refresh_disconnects_remaining > 0:
            self.refresh_disconnects_remaining -= 1
            raise requests.exceptions.ConnectionError(
                "Connection aborted.",
                RemoteDisconnected("Remote end closed connection"),
            )
        self.readback_started = True
        return super().sync_online_product(
            platform,
            product_id=product_id,
            shop_id=shop_id,
            ean=ean,
        )

    def get_online_detail(self, platform, internal_id):
        if self.readback_started and self.disconnects_remaining > 0:
            self.disconnects_remaining -= 1
            raise requests.exceptions.ConnectionError(
                "Connection aborted.",
                RemoteDisconnected("Remote end closed connection"),
            )
        return super().get_online_detail(platform, internal_id)


class ManyListingClient(FakeListingClient):
    def __init__(self, count):
        super().__init__()
        self.count = count
        self.details = {}
        for index in range(count):
            internal_id = 6480099 + index
            detail = copy.deepcopy(self.detail)
            detail["id"] = internal_id
            detail["product_id"] = 16222622566 + index
            self.details[str(internal_id)] = detail

    def iter_listing_pages(self, platform, **kwargs):
        midpoint = max(1, self.count // 2)
        for start, end in ((0, midpoint), (midpoint, self.count)):
            if start >= end:
                continue
            rows = []
            for index in range(start, end):
                internal_id = 6480099 + index
                rows.append(
                    {
                        "id": internal_id,
                        "product_id": 16222622566 + index,
                        "title": f"测试商品 {index + 1}",
                        "shop_id": "shop-3c",
                        "shop": {
                            "id": "shop-3c",
                            "name": "3C pilot",
                            "amazonsite": "TH",
                        },
                        "category_id": "1001",
                        "variations": [
                            {
                                "sku_id": 127430020150 + index,
                                "sku": "T3CC1270045",
                                "stock": 1000,
                                "price": "3117.00",
                                "special_price": "1719.00",
                            }
                        ],
                    }
                )
            yield "online", {"data": rows}

    def get_online_detail(self, platform, internal_id):
        if str(platform) != "lazada":
            raise AssertionError(platform)
        return copy.deepcopy(self.details[str(internal_id)])

    def save_lazada_online_detail(self, detail, *, publish=True):
        self.details[str(detail["id"])] = copy.deepcopy(detail)
        self.save_calls += 1
        return {"code": 200}


class MultiShopListingClient(FakeListingClient):
    def __init__(self):
        super().__init__()
        self.details = {}
        rows = [
            (
                6480201,
                16222623001,
                "shop-imii",
                "imii",
                "MY",
                127430021001,
                "T5CC2561011",
                12,
            ),
            (
                6480202,
                16222623002,
                "shop-combo",
                "3C COMBO",
                "TH",
                127430021002,
                "T3CC1970671",
                33,
            ),
        ]
        for (
            internal_id,
            product_id,
            shop_id,
            shop_name,
            site,
            sku_id,
            sku,
            stock,
        ) in rows:
            detail = copy.deepcopy(self.detail)
            detail.update(
                id=internal_id,
                product_id=product_id,
                shop_id=shop_id,
                shop={"id": shop_id, "name": shop_name, "amazonsite": site},
            )
            detail["variations"][0].update(
                sku_id=sku_id,
                sku=sku,
                stock=stock,
                warehouse_stock=[
                    {"warehouse_code": "default", "stock": stock}
                ],
            )
            self.details[str(internal_id)] = detail

    def get_shops(self, platform):
        return [
            {
                "id": "shop-imii",
                "name": "imii",
                "amazonsite": "MY",
                "currency": "MYR",
            },
            {
                "id": "shop-combo",
                "name": "3C COMBO",
                "amazonsite": "TH",
                "currency": "THB",
            },
            {
                "id": "shop-imii-brand",
                "name": "imii Brand",
                "amazonsite": "MY",
                "currency": "MYR",
            },
        ]

    def iter_listing_pages(self, platform, **kwargs):
        shop_ids = {str(item) for item in kwargs.get("shop_ids") or []}
        search_value = str(kwargs.get("search_value") or "").casefold()
        rows = []
        for detail in self.details.values():
            sku = str(detail["variations"][0]["sku"])
            if shop_ids and str(detail["shop_id"]) not in shop_ids:
                continue
            if search_value and search_value not in sku.casefold():
                continue
            rows.append(copy.deepcopy(detail))
        yield "online", {"data": rows}

    def get_online_detail(self, platform, internal_id):
        return copy.deepcopy(self.details[str(internal_id)])


class SelectiveBatchFailureClient(ManyListingClient):
    def __init__(self):
        super().__init__(2)
        self.batch_outcomes = {}

    def save_lazada_online_local_value(self, field, details):
        self.batch_save_calls += 1
        batch_id = f"batch-{self.batch_save_calls}"
        detail = details[0]
        should_fail = str(detail["product_id"]) == str(16222622567)
        self.batch_outcomes[batch_id] = should_fail
        if not should_fail:
            self.details[str(detail["id"])] = copy.deepcopy(detail)
        return {"code": 200, "data": {"batch_id": batch_id}}

    def save_lazada_warehouse_stock(self, details):
        detail = details[0]
        if str(detail["product_id"]) == str(16222622567):
            raise service.MabangListingError("店铺拒绝库存更新")
        self.warehouse_save_calls += 1
        self.details[str(detail["id"])] = copy.deepcopy(detail)
        return {"code": 200, "msg": "success", "data": {}}

    def get_batch_process(self, batch_id, *, platform="lazada"):
        self.batch_process_calls += 1
        failed = self.batch_outcomes[batch_id]
        return {
            "code": 200,
            "data": {
                "data_num": {
                    "total_num": 1,
                    "fail_num": 1 if failed else 0,
                    "success_num": 0 if failed else 1,
                },
                "data_error": (
                    [{"product_id": 16222622567, "error_msg": "店铺拒绝库存更新"}]
                    if failed
                    else []
                ),
            },
        }


class MultiWarehouseLazadaListingClient(FakeListingClient):
    def __init__(self, warehouse_stocks=None):
        super().__init__()
        stocks = warehouse_stocks or [0, 989]
        self.detail.update(
            product_id=16166846539,
            shop_id=2021623263,
            shop={
                "id": 2021623263,
                "name": "FPS Official Store.TH",
                "amazonsite": "th",
                "extend2": "1",
                "shop_type": 2,
                "currency": "THB",
            },
        )
        self.detail["variations"][0].update(
            sku_id=127191223199,
            sku="T3CC1970671",
            stock=sum(stocks),
            warehouse_stock=[
                {"warehouse_code": "dropshipping", "stock": stocks[0]},
                {
                    "warehouse_code": "TH1K75WWF3-WH-10003",
                    "stock": stocks[1],
                },
            ],
        )
        self.lazada_warehouse_list_calls = 0

    def get_lazada_warehouse_list(self, shop_id):
        self.lazada_warehouse_list_calls += 1
        if str(shop_id) != "2021623263":
            raise AssertionError(shop_id)
        return [
            {
                "warehouse_code": "dropshipping",
                "warehouse_name": "",
                "detail_address": "Hong Kong",
                "default_address": True,
                "need_to_update": False,
                "status": "ACTIVE",
            },
            {
                "warehouse_code": "TH1K75WWF3-WH-10003",
                "warehouse_name": "泰国TLS3C仓-1308",
                "detail_address": "Samut Prakan",
                "default_address": False,
                "need_to_update": False,
                "status": "ACTIVE",
            },
        ]


class StaleWarehouseListLazadaClient(MultiWarehouseLazadaListingClient):
    """Accept the warehouse update while keeping Mabang's list cache stale."""

    def __init__(self):
        super().__init__([0, 909])
        self.accepted_details = []

    def save_lazada_warehouse_stock(self, details):
        self.warehouse_save_calls += 1
        self.accepted_details = copy.deepcopy(list(details))
        return {"code": 200, "msg": "success", "data": {}}


class ShopeeTikTokListingClient(MabangListingClient):
    def __init__(self):
        super().__init__()
        self.details = {
            ("shopee", "7001"): {
                "id": 7001,
                "product_id": 57001,
                "title": "Shopee 测试商品",
                "shopId": "shop-shopee",
                "shop_id": "shop-shopee",
                "shop": {"id": "shop-shopee", "name": "AbbyMall"},
                "tierVariationOption": [
                    {
                        "name": "Color",
                        "option_list": [
                            {"option": "Red", "variation_option_name": "Red"},
                            {"option": "Blue", "variation_option_name": "Blue"},
                        ],
                    }
                ],
                "variations": [
                    {
                        "sku_id": 7101,
                        "sku": "SKU-A",
                        "tier_index": [0],
                        "original_price": "100.00",
                        "price": "90.00",
                        "discount_price": "90.00",
                        "stock": 10,
                    },
                    {
                        "sku_id": 7102,
                        "sku": "SKU-A2",
                        "tier_index": [0],
                        "original_price": "100.00",
                        "price": "90.00",
                        "discount_price": "90.00",
                        "stock": 10,
                    },
                    {
                        "sku_id": 7103,
                        "sku": "SKU-B",
                        "tier_index": [1],
                        "original_price": "100.00",
                        "price": "90.00",
                        "discount_price": "90.00",
                        "stock": 10,
                    },
                ],
            },
            ("tiktokshop", "8001"): {
                "id": 8001,
                "product_id": "58001",
                "title": "TikTok 测试商品",
                "shop_id": "shop-tiktok",
                "shop": {"id": "shop-tiktok", "name": "Handy Tools"},
                "variation": 2,
                "variations": [
                    {
                        "id": 8101,
                        "sku_id": "8201",
                        "sku": "TT-A",
                        "price": "200.00",
                        "sale_price": "180.00",
                        "stock": 20,
                        "attributes": [
                            {
                                "id": "100000",
                                "name": "Color",
                                "valueId": "red-id",
                                "valueName": "Red",
                            }
                        ],
                    },
                    {
                        "id": 8102,
                        "sku_id": "8202",
                        "sku": "TT-A2",
                        "price": "200.00",
                        "sale_price": "180.00",
                        "stock": 20,
                        "attributes": [
                            {
                                "id": "100000",
                                "name": "Color",
                                "valueId": "red-id",
                                "valueName": "Red",
                            }
                        ],
                    },
                ],
            },
        }
        self.save_calls = []
        self.batch_save_calls = []
        self.batch_process_calls = 0
        self.sync_calls = 0

    def get_online_detail(self, platform, internal_id):
        return copy.deepcopy(self.details[(str(platform), str(internal_id))])

    def get_online_batch_details(
        self,
        platform,
        listing_ids,
        *,
        shopee_global=False,
    ):
        platform = str(platform)
        identifier = str(next(iter(listing_ids)))
        for (item_platform, _internal_id), detail in self.details.items():
            if item_platform != platform:
                continue
            if identifier in {
                str(detail.get("id")),
                str(detail.get("product_id")),
            }:
                return [copy.deepcopy(detail)]
        return []

    def save_online_detail(self, platform, detail, *, publish=True):
        self.details[(str(platform), str(detail["id"]))] = copy.deepcopy(detail)
        self.save_calls.append((str(platform), copy.deepcopy(detail), publish))
        return {"code": 200, "msg": "success"}

    def save_shopee_online_local_value(self, field, details):
        self.batch_save_calls.append((field, copy.deepcopy(details)))
        for detail in details:
            self.details[("shopee", str(detail["id"]))] = copy.deepcopy(detail)
        return {
            "code": 200,
            "data": {"batch_id": f"shopee-batch-{len(self.batch_save_calls)}"},
        }

    def sync_online_product(self, platform, *, product_id, shop_id, ean=""):
        self.sync_calls += 1
        return {"success": True}

    def get_batch_process(self, batch_id, *, platform="lazada"):
        self.batch_process_calls += 1
        return {
            "code": 200,
            "data": {
                "data_num": {
                    "total_num": 1,
                    "fail_num": 0,
                    "success_num": 1,
                },
                "data_error": [],
            },
        }

    def get_shops(self, platform):
        if str(platform) == "shopee":
            return [{"id": "shop-shopee", "name": "AbbyMall", "site": "TH"}]
        if str(platform) == "tiktokshop":
            return [{"id": "shop-tiktok", "name": "Handy Tools", "site": "TH"}]
        return []

    def iter_listing_pages(self, platform, **kwargs):
        platform = str(platform)
        rows = []
        for (item_platform, _internal_id), detail in self.details.items():
            if item_platform != platform:
                continue
            rows.append(copy.deepcopy(detail))
        yield "online", {"data": rows}


class DivergentShopeePriceClient(ShopeeTikTokListingClient):
    def __init__(self):
        super().__init__()
        stale = self.details[("shopee", "7001")]
        stale["variations"] = [
            {
                "sku_id": 285058480420,
                "sku": "T3CC2150516",
                "original_price": "2398.00",
                "price": "1299.00",
                "discount_price": "1299.00",
                "stock": 999,
            },
            {
                "sku_id": 446251716725,
                "sku": "T3CC2150516",
                "original_price": "2598.00",
                "price": "1459.00",
                "discount_price": "1459.00",
                "stock": 999,
            },
        ]
        self.batch_detail = copy.deepcopy(stale)
        self.batch_detail["variations"][0]["price"] = "1359.00"
        self.batch_detail["variations"][0]["discount_price"] = "1359.00"
        self.batch_detail["variations"][1]["price"] = "1399.00"
        self.batch_detail["variations"][1].pop("discount_price")

    def get_online_batch_details(
        self,
        platform,
        listing_ids,
        *,
        shopee_global=False,
    ):
        if str(platform) != "shopee":
            return super().get_online_batch_details(
                platform,
                listing_ids,
                shopee_global=shopee_global,
            )
        return [copy.deepcopy(self.batch_detail)]

    def save_shopee_online_local_value(self, field, details):
        self.batch_save_calls.append((field, copy.deepcopy(details)))
        self.batch_detail = copy.deepcopy(details[0])
        self.details[("shopee", "7001")] = copy.deepcopy(details[0])
        return {
            "code": 200,
            "data": {"batch_id": f"shopee-batch-{len(self.batch_save_calls)}"},
        }


class MultiWarehouseShopeeListingClient(ShopeeTikTokListingClient):
    def __init__(self, warehouse_stocks=None):
        super().__init__()
        stocks = warehouse_stocks or [0, 999, 0]
        self.global_detail = copy.deepcopy(self.details[("shopee", "7001")])
        self.global_detail["is_global"] = 1
        self.global_detail["shop"]["is_global"] = 1
        self.global_detail["variations"][0]["stock"] = sum(stocks)
        self.global_detail["variations"][0]["stock_info_v2"] = {
            "seller_stock": [
                {
                    "if_saleable": True,
                    "location_id": f"WH-{index + 1}",
                    "stock": stock,
                }
                for index, stock in enumerate(stocks)
            ],
            "summary_info": {
                "total_available_stock": sum(stocks),
                "total_reserved_stock": 0,
            },
        }
        self.details[("shopee", "7001")]["variations"][0]["stock"] = sum(stocks)
        self.global_batch_detail = copy.deepcopy(self.global_detail)
        self.global_batch_detail["merchant_id"] = 123456
        self.global_batch_detail["variations"][0].pop("stock_info_v2", None)
        self.global_save_calls = []
        self.full_detail_calls = 0
        self.warehouse_list_calls = 0
        self.warehouse_catalog = [
            {
                "location_id": f"WH-{index + 1}",
                "warehouse_id": 1000 + index,
                "warehouse_name": f"Warehouse {index + 1}",
            }
            for index in range(len(stocks))
        ]

    def get_online_detail(self, platform, internal_id):
        if str(platform) == "shopee" and str(internal_id) == "7001":
            self.full_detail_calls += 1
            return copy.deepcopy(self.global_detail)
        return super().get_online_detail(platform, internal_id)

    def get_shopee_warehouse_list(self, shop_id):
        self.warehouse_list_calls += 1
        if str(shop_id) != "shop-shopee":
            raise AssertionError(shop_id)
        return copy.deepcopy(self.warehouse_catalog)

    def get_online_batch_details(
        self,
        platform,
        listing_ids,
        *,
        shopee_global=False,
    ):
        if str(platform) == "shopee":
            identifier = str(next(iter(listing_ids)))
            if shopee_global:
                if identifier in {
                    str(self.global_batch_detail["id"]),
                    str(self.global_batch_detail["product_id"]),
                }:
                    return [copy.deepcopy(self.global_batch_detail)]
                return []
            if identifier in {
                str(self.global_detail["id"]),
                str(self.global_detail["product_id"]),
            }:
                return [copy.deepcopy(self.global_detail)]
            return []
        return super().get_online_batch_details(
            platform,
            listing_ids,
            shopee_global=shopee_global,
        )

    def save_shopee_online_global_stock(self, details):
        self.global_save_calls.append(copy.deepcopy(details))
        self.global_detail = copy.deepcopy(details[0])
        return {
            "code": 200,
            "data": {"batch_id": f"shopee-global-{len(self.global_save_calls)}"},
        }


class NormalShopMultiWarehouseShopeeListingClient(
    MultiWarehouseShopeeListingClient
):
    def __init__(self, warehouse_stocks=None):
        super().__init__(warehouse_stocks)
        self.global_detail["is_global"] = 0
        self.global_detail["shop"]["is_global"] = 0
        self.batch_detail_modes = []

    def get_online_batch_details(
        self,
        platform,
        listing_ids,
        *,
        shopee_global=False,
    ):
        if str(platform) == "shopee":
            self.batch_detail_modes.append(shopee_global)
            identifier = str(next(iter(listing_ids)))
            if shopee_global:
                return []
            if identifier in {
                str(self.global_detail["id"]),
                str(self.global_detail["product_id"]),
            }:
                return [copy.deepcopy(self.global_detail)]
            return []
        return super().get_online_batch_details(
            platform,
            listing_ids,
            shopee_global=shopee_global,
        )

    def save_shopee_online_local_value(self, field, details):
        self.batch_save_calls.append((field, copy.deepcopy(details)))
        submitted = copy.deepcopy(details[0])
        submitted_variations = {
            str(item.get("sku_id") or ""): item
            for item in submitted.get("variations") or []
            if isinstance(item, dict)
        }
        refreshed = copy.deepcopy(self.global_detail)
        for variation in refreshed.get("variations") or []:
            if not isinstance(variation, dict):
                continue
            source = submitted_variations.get(
                str(variation.get("sku_id") or "")
            )
            if not isinstance(source, dict):
                continue
            variation["stock"] = source.get("stock")
            source_warehouses = {
                str(item.get("location_id") or ""): item
                for item in source.get("warehouse_stock") or []
                if isinstance(item, dict)
            }
            stock_info = variation.get("stock_info_v2")
            seller_stock = (
                stock_info.get("seller_stock")
                if isinstance(stock_info, dict)
                else None
            )
            if isinstance(seller_stock, list):
                for warehouse in seller_stock:
                    if not isinstance(warehouse, dict):
                        continue
                    source_warehouse = source_warehouses.get(
                        str(warehouse.get("location_id") or "")
                    )
                    if isinstance(source_warehouse, dict):
                        warehouse["stock"] = source_warehouse.get("stock")
        self.global_detail = refreshed
        self.details[("shopee", str(submitted["id"]))] = copy.deepcopy(
            refreshed
        )
        return {
            "code": 200,
            "data": {
                "batch_id": f"shopee-batch-{len(self.batch_save_calls)}",
            },
        }


class StalePlatformShopeeListingClient(MultiWarehouseShopeeListingClient):
    def __init__(self):
        super().__init__()
        self.platform_detail = copy.deepcopy(self.global_detail)

    def sync_online_product(self, platform, *, product_id, shop_id, ean=""):
        self.sync_calls += 1
        self.global_detail = copy.deepcopy(self.platform_detail)
        return {"success": True}


class ListingServiceTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeListingClient()
        with service.SESSION_LOCK:
            service.SESSION.update(
                client=self.client,
                username="陈泽彬",
                connected_at=service.now_text(),
            )
        with service.STATE_LOCK:
            service.PREVIEWS.clear()
            service.JOBS.clear()
            service.SHOP_CACHE.clear()
            service.LISTING_CACHE.clear()
            service.TARGET_CACHE.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.original_audit_path = service.AUDIT_PATH
        service.AUDIT_PATH = Path(self.temp.name) / "audit.jsonl"

    def tearDown(self):
        deadline = time.time() + 2
        while service.EXECUTION_LOCK.locked() and time.time() < deadline:
            time.sleep(0.02)
        service.AUDIT_PATH = self.original_audit_path
        with service.SESSION_LOCK:
            service.SESSION.update(client=None, username="", connected_at="")
        self.temp.cleanup()

    def test_listing_reads_are_cached_until_an_explicit_refresh(self):
        first = service.get_listings("lazada", "online", 1, 50, [], "", "")
        second = service.get_listings("lazada", "online", 1, 50, [], "", "")
        refreshed = service.get_listings(
            "lazada",
            "online",
            1,
            50,
            [],
            "",
            "",
            force_refresh=True,
        )

        self.assertEqual(self.client.listing_page_calls, 2)
        self.assertFalse(first["cached"])
        self.assertTrue(second["cached"])
        self.assertFalse(refreshed["cached"])
        self.assertEqual(first["items"], second["items"])

    def test_preview_execute_and_verify_lazada_changes(self):
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                        "product_id": 16222622566,
                        "shop_name": "3C pilot",
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "price", "mode": "add", "value": "1"},
                    {"field": "stock", "mode": "set", "value": "1001"},
                ],
            }
        )

        self.assertEqual(preview["change_count"], 2)
        self.assertEqual(preview["changes"][0]["new_value"], "3118.00")
        self.assertEqual(preview["changes"][1]["new_value"], 1001)

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["successful_products"], 1)
        self.assertEqual(self.client.save_calls, 1)
        variation = self.client.detail["variations"][0]
        self.assertEqual(variation["price"], "3118.00")
        self.assertEqual(variation["stock"], 1001)
        self.assertTrue(service.AUDIT_PATH.exists())

    def test_execute_only_selected_preview_changes(self):
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "price", "mode": "add", "value": "1"},
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        stock_change = next(
            change
            for change in preview["changes"]
            if change["field"] == "stock"
        )

        job = service.start_execution(
            preview["preview_token"],
            [stock_change["change_id"]],
        )
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["change_count"], 1)
        self.assertEqual(self.client.detail["variations"][0]["stock"], 99)
        self.assertEqual(
            self.client.detail["variations"][0]["price"],
            "3117.00",
        )

    def test_execute_rejects_unknown_preview_change_id(self):
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        with self.assertRaisesRegex(ValueError, "不属于当前预览"):
            service.start_execution(
                preview["preview_token"],
                ["forged-change-id"],
            )

    def test_rejects_online_sku_replacement(self):
        with self.assertRaisesRegex(ValueError, "不能安全修改 SKU"):
            service.create_preview(
                {
                    "targets": [
                        {
                            "platform": "lazada",
                            "internal_id": 6480099,
                        }
                    ],
                    "match_sku": "T3CC1270045",
                    "operations": [
                        {"field": "sku", "mode": "set", "value": "NEW-SKU"},
                    ],
                }
            )

    def test_shopee_sku_replacement_preview_execute_and_readback(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "shop_name": "AbbyMall",
                    }
                ],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "sku",
                        "mode": "replace",
                        "value": "SKU-NEW",
                    }
                ],
            }
        )
        self.assertEqual(preview["change_count"], 1)
        self.assertEqual(preview["changes"][0]["new_value"], "SKU-NEW")

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(
            self.client.details[("shopee", "7001")]["variations"][0]["sku"],
            "SKU-NEW",
        )
        self.assertEqual(self.client.save_calls[0][0], "shopee")

    def test_shopee_allows_duplicate_variant_skus_within_one_listing(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client

        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "shop_name": "KAMPEON Digital Galaxy",
                    }
                ],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "sku",
                        "mode": "replace",
                        "value": "SKU-B",
                    }
                ],
            }
        )

        self.assertEqual(preview["change_count"], 1)
        self.assertEqual(preview["changes"][0]["new_value"], "SKU-B")

    def test_shopee_original_and_selling_prices_use_distinct_source_fields(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "shopee",
            "internal_id": 7001,
            "shop_name": "AbbyMall",
        }

        original_preview = service.create_preview(
            {
                "targets": [target],
                "match_sku": "SKU-A",
                "operations": [
                    {"field": "price", "mode": "set", "value": "95"},
                ],
            }
        )
        original_change = original_preview["changes"][0]
        self.assertEqual(original_change["field_label"], "原价")
        self.assertEqual(original_change["storage_field"], "original_price")
        self.assertEqual(original_change["old_value"], "100.00")

        original_job = service.start_execution(original_preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            original_job = service.get_job(original_job["job_id"])
            if original_job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        self.assertEqual(original_job["state"], "completed")
        submitted_original = self.client.batch_save_calls[0][1][0]["variations"][0]
        self.assertEqual(self.client.batch_save_calls[0][0], "price")
        self.assertEqual(submitted_original["original_price"], "95.00")
        self.assertEqual(submitted_original["discount_price"], "90.00")

        selling_preview = service.create_preview(
            {
                "targets": [target],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "special_price",
                        "mode": "set",
                        "value": "85",
                    },
                ],
            }
        )
        selling_change = selling_preview["changes"][0]
        self.assertEqual(selling_change["field_label"], "售价")
        self.assertEqual(selling_change["storage_field"], "discount_price")
        self.assertEqual(selling_change["old_value"], "90.00")

        selling_job = service.start_execution(selling_preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            selling_job = service.get_job(selling_job["job_id"])
            if selling_job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        self.assertEqual(selling_job["state"], "completed")
        submitted_selling = self.client.batch_save_calls[1][1][0]["variations"][0]
        self.assertEqual(self.client.batch_save_calls[1][0], "price")
        self.assertEqual(submitted_selling["original_price"], "95.00")
        self.assertEqual(submitted_selling["discount_price"], "85.00")
        self.assertEqual(submitted_selling["price"], "85.00")

    def test_shopee_selling_price_can_exceed_original_price(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client

        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "shop_name": "AbbyMall",
                    }
                ],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "special_price",
                        "mode": "set",
                        "value": "101",
                    },
                ],
            }
        )

        self.assertEqual(preview["change_count"], 1)
        self.assertEqual(preview["changes"][0]["field_label"], "售价")
        self.assertEqual(preview["changes"][0]["new_value"], "101.00")

    def test_shopee_selling_price_preview_uses_batch_detail_by_variant_id(self):
        self.client = DivergentShopeePriceClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client

        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "product_id": 57001,
                        "shop_name": "KAMPEON Digital Galaxy",
                    }
                ],
                "match_sku": "T3CC2150516",
                "operations": [
                    {
                        "field": "special_price",
                        "mode": "set",
                        "value": "1360",
                    },
                ],
            }
        )

        self.assertEqual(preview["change_count"], 2)
        self.assertEqual(
            {
                (change["sku_id"], change["old_value"])
                for change in preview["changes"]
            },
            {
                ("285058480420", "1359.00"),
                ("446251716725", "1399.00"),
            },
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(
            [
                variation["discount_price"]
                for variation in self.client.batch_detail["variations"]
            ],
            ["1360.00", "1360.00"],
        )

    def test_shopee_stock_uses_local_endpoint_and_accepts_zero(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "shop_name": "AbbyMall",
                    }
                ],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "stock",
                        "mode": "set",
                        "value": "0",
                    }
                ],
            }
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(
            self.client.details[("shopee", "7001")]["variations"][0]["stock"],
            0,
        )
        self.assertEqual(len(self.client.batch_save_calls), 1)
        self.assertEqual(self.client.batch_save_calls[0][0], "stock")
        self.assertEqual(
            self.client.batch_save_calls[0][1][0]["variations"][0]["stock"],
            0,
        )
        self.assertEqual(self.client.save_calls, [])
        self.assertEqual(self.client.batch_process_calls, 1)
        self.assertEqual(
            job["results"][0]["feedback_source"],
            "platform_refresh_readback",
        )
        self.assertEqual(self.client.sync_calls, 1)

    def test_shopee_multi_warehouse_stock_uses_global_endpoint(self):
        self.client = MultiWarehouseShopeeListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "product_id": 57001,
                        "shop_name": "AbbyMall",
                    }
                ],
                "match_sku": "SKU-A",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "10"},
                ],
            }
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(len(self.client.global_save_calls), 1)
        variation = self.client.global_save_calls[0][0]["variations"][0]
        self.assertEqual(variation["stock"], 10)
        self.assertEqual(
            [item["stock"] for item in variation["warehouse_stock"]],
            [0, 10, 0],
        )
        self.assertEqual(self.client.batch_save_calls, [])
        self.assertEqual(self.client.sync_calls, 1)
        self.assertEqual(
            job["results"][0]["feedback_source"],
            "platform_refresh_readback",
        )

    def test_shopee_multi_warehouse_stock_refuses_ambiguous_distribution(self):
        self.client = MultiWarehouseShopeeListingClient([400, 599, 0])
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "shopee",
                        "internal_id": 7001,
                        "product_id": 57001,
                        "shop_name": "AbbyMall",
                    }
                ],
                "match_sku": "SKU-A",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "10"},
                ],
            }
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "failed")
        self.assertIn("multiple warehouses", job["results"][0]["message"])
        self.assertEqual(self.client.global_save_calls, [])
        self.assertEqual(self.client.batch_save_calls, [])

    def test_shopee_multi_warehouse_stock_can_target_one_warehouse(self):
        self.client = MultiWarehouseShopeeListingClient([400, 599, 0])
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "shopee",
            "internal_id": 7001,
            "product_id": 57001,
            "shop_name": "AbbyMall",
        }

        options = service.get_warehouse_options(
            {
                "targets": [target],
                "match_sku": "SKU-A",
            }
        )
        self.assertEqual(
            [item["key"] for item in options["warehouses"]],
            [
                "location_id:WH-1",
                "location_id:WH-2",
                "location_id:WH-3",
            ],
        )
        self.assertEqual(options["recommended_warehouse_key"], "")

        preview = service.create_preview(
            {
                "targets": [target],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "stock",
                        "mode": "set",
                        "value": "10",
                        "warehouse_key": "location_id:WH-2",
                    },
                ],
            }
        )
        self.assertEqual(preview["changes"][0]["old_value"], 599)
        self.assertEqual(preview["changes"][0]["new_value"], 10)
        self.assertEqual(
            preview["changes"][0]["warehouse_label"],
            "Warehouse 2 / WH-2 / 1001",
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        variation = self.client.global_save_calls[0][0]["variations"][0]
        self.assertEqual(variation["stock"], 410)
        self.assertEqual(
            [item["stock"] for item in variation["warehouse_stock"]],
            [400, 10, 0],
        )
        self.assertEqual(
            self.client.global_save_calls[0][0]["merchant_id"],
            123456,
        )

    def test_normal_shopee_shop_reads_full_editor_detail_and_warehouse_catalog(self):
        self.client = NormalShopMultiWarehouseShopeeListingClient([0, 10, 0])
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "shopee",
            "internal_id": 7001,
            "product_id": 57001,
            "shop_name": "Toko Penguin",
        }

        options = service.get_warehouse_options(
            {
                "targets": [target],
                "match_sku": "SKU-A",
            }
        )

        self.assertEqual(
            [item["stock_min"] for item in options["warehouses"]],
            [0, 10, 0],
        )
        self.assertEqual(
            options["recommended_warehouse_key"],
            "location_id:WH-2",
        )
        self.assertGreaterEqual(self.client.full_detail_calls, 1)
        self.assertGreaterEqual(self.client.warehouse_list_calls, 1)
        self.assertEqual(self.client.batch_detail_modes, [])
        self.assertEqual(
            [item["label"] for item in options["warehouses"]],
            [
                "Warehouse 1 / WH-1 / 1000",
                "Warehouse 2 / WH-2 / 1001",
                "Warehouse 3 / WH-3 / 1002",
            ],
        )

        preview = service.create_preview(
            {
                "targets": [target],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "stock",
                        "mode": "set",
                        "value": "24",
                        "warehouse_key": "location_id:WH-2",
                    }
                ],
            }
        )
        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(self.client.global_save_calls, [])
        self.assertEqual(len(self.client.batch_save_calls), 1)
        self.assertEqual(self.client.batch_save_calls[0][0], "stock")
        variation = self.client.batch_save_calls[0][1][0]["variations"][0]
        self.assertEqual(variation["stock"], 24)
        self.assertEqual(
            [item["stock"] for item in variation["warehouse_stock"]],
            [0, 24, 0],
        )
        self.assertEqual(self.client.batch_detail_modes, [False])
        self.assertGreaterEqual(self.client.warehouse_list_calls, 2)

    def test_shopee_batch_success_is_not_platform_success_without_fresh_readback(self):
        self.client = StalePlatformShopeeListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        original_delays = service.READBACK_RETRY_DELAYS_SECONDS
        service.READBACK_RETRY_DELAYS_SECONDS = (0.0, 0.0)
        try:
            preview = service.create_preview(
                {
                    "targets": [
                        {
                            "platform": "shopee",
                            "internal_id": 7001,
                            "product_id": 57001,
                            "shop_name": "AbbyMall",
                        }
                    ],
                    "match_sku": "SKU-A",
                    "operations": [
                        {"field": "stock", "mode": "set", "value": "10"},
                    ],
                }
            )
            job = service.start_execution(preview["preview_token"])
            deadline = time.time() + 3
            while time.time() < deadline:
                job = service.get_job(job["job_id"])
                if job["state"] not in {"queued", "running"}:
                    break
                time.sleep(0.02)
        finally:
            service.READBACK_RETRY_DELAYS_SECONDS = original_delays

        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["successful_products"], 0)
        self.assertIn("platform refresh verification", job["results"][0]["message"])

    def test_shopee_spec_preview_groups_every_affected_sku(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "targets": [{"platform": "shopee", "internal_id": 7001}],
                "match_sku": "SKU-A",
                "operations": [
                    {
                        "field": "variation",
                        "mode": "replace",
                        "spec_name": "Color",
                        "value": "Crimson",
                    }
                ],
            }
        )

        self.assertEqual(preview["change_count"], 1)
        self.assertEqual(
            preview["changes"][0]["affected_skus"],
            ["SKU-A", "SKU-A2"],
        )
        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        self.assertEqual(job["state"], "completed")
        self.assertEqual(
            self.client.details[("shopee", "7001")]["tierVariationOption"][0][
                "option_list"
            ][0]["option"],
            "Crimson",
        )

    def test_tiktok_spec_preview_execute_updates_shared_option(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "targets": [{"platform": "tiktokshop", "internal_id": 8001}],
                "match_sku": "TT-A",
                "operations": [
                    {
                        "field": "variation",
                        "mode": "replace",
                        "spec_name": "Color",
                        "value": "Ruby",
                    }
                ],
            }
        )
        self.assertEqual(preview["changes"][0]["affected_skus"], ["TT-A", "TT-A2"])

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        self.assertEqual(job["state"], "completed")
        values = [
            variation["attributes"][0]["valueName"]
            for variation in self.client.details[("tiktokshop", "8001")][
                "variations"
            ]
        ]
        self.assertEqual(values, ["Ruby", "Ruby"])

    def test_preview_can_execute_without_confirmation_text(self):
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "price", "mode": "add", "value": "1"},
                ],
            }
        )
        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        self.assertEqual(job["state"], "completed")
        self.assertEqual(self.client.batch_save_calls, 1)
        self.assertEqual(self.client.batch_process_calls, 1)

    def test_lazada_warehouse_stock_does_not_require_a_batch_id(self):
        self.client.save_lazada_warehouse_stock = (
            lambda details: (
                setattr(self.client, "detail", copy.deepcopy(details[0]))
                or {"code": 200, "msg": "success", "data": {}}
            )
        )
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["successful_products"], 1)
        self.assertEqual(self.client.batch_process_calls, 0)

    def test_preview_keeps_every_exact_duplicate_sku_variation(self):
        duplicate = copy.deepcopy(self.client.detail["variations"][0])
        duplicate["sku_id"] = 127430020151
        duplicate["stock"] = 800
        self.client.detail["variations"].append(duplicate)
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        self.assertEqual(preview["target_count"], 1)
        self.assertEqual(preview["change_count"], 2)
        self.assertEqual(
            {change["sku_id"] for change in preview["changes"]},
            {"127430020150", "127430020151"},
        )

    def test_stock_execution_updates_authoritative_warehouse_quantity(self):
        self.client.detail["variations"][0]["warehouse_stock"] = [
            {"warehouse_code": "dropshipping", "stock": 1000}
        ]
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        variation = self.client.detail["variations"][0]
        self.assertEqual(job["state"], "completed")
        self.assertEqual(variation["stock"], 99)
        self.assertEqual(variation["warehouse_stock"][0]["stock"], 99)
        self.assertEqual(self.client.warehouse_save_calls, 1)
        self.assertEqual(self.client.batch_save_calls, 0)

    def test_lazada_single_warehouse_is_selected_automatically(self):
        options = service.get_warehouse_options(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                        "product_id": 16222622566,
                    }
                ],
                "match_sku": "T3CC1270045",
            }
        )

        self.assertEqual(len(options["warehouses"]), 1)
        self.assertEqual(
            options["recommended_warehouse_key"],
            "warehouse_code:default",
        )

    def test_lazada_cross_border_stock_defaults_to_only_stocked_warehouse(self):
        self.client = MultiWarehouseLazadaListingClient([0, 989])
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "lazada",
            "internal_id": 6480099,
            "product_id": 16166846539,
            "shop_name": "FPS Official Store.TH",
        }

        options = service.get_warehouse_options(
            {
                "targets": [target],
                "match_sku": "T3CC1970671",
            }
        )

        self.assertEqual(
            [item["stock_min"] for item in options["warehouses"]],
            [0, 989],
        )
        self.assertEqual(
            options["recommended_warehouse_key"],
            "warehouse_code:TH1K75WWF3-WH-10003",
        )
        self.assertIn("泰国TLS3C仓-1308", options["warehouses"][1]["label"])

        preview = service.create_preview(
            {
                "targets": [target],
                "match_sku": "T3CC1970671",
                "operations": [
                    {
                        "field": "stock",
                        "mode": "set",
                        "value": "988",
                        "warehouse_key": "warehouse_code:TH1K75WWF3-WH-10003",
                    }
                ],
            }
        )
        self.assertEqual(preview["changes"][0]["old_value"], 989)
        self.assertEqual(preview["changes"][0]["new_value"], 988)

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        variation = self.client.detail["variations"][0]
        self.assertEqual(variation["stock"], 988)
        self.assertEqual(
            [item["stock"] for item in variation["warehouse_stock"]],
            [0, 988],
        )
        self.assertEqual(self.client.warehouse_save_calls, 1)
        self.assertEqual(self.client.batch_save_calls, 0)
        self.assertEqual(
            job["results"][0]["feedback_source"],
            "platform_refresh_readback",
        )

    def test_lazada_stale_list_cache_does_not_turn_accepted_write_into_failure(self):
        self.client = StaleWarehouseListLazadaClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "lazada",
            "internal_id": 6480099,
            "product_id": 16166846539,
            "shop_name": "FPS Official Store.TH",
        }
        preview = service.create_preview(
            {
                "targets": [target],
                "match_sku": "T3CC1970671",
                "operations": [
                    {
                        "field": "stock",
                        "mode": "set",
                        "value": "8888",
                        "warehouse_key": (
                            "warehouse_code:TH1K75WWF3-WH-10003"
                        ),
                    }
                ],
            }
        )

        original_delays = service.LAZADA_WAREHOUSE_READBACK_DELAYS_SECONDS
        service.LAZADA_WAREHOUSE_READBACK_DELAYS_SECONDS = (0.0, 0.0)
        try:
            job = service.start_execution(preview["preview_token"])
            deadline = time.time() + 3
            while time.time() < deadline:
                job = service.get_job(job["job_id"])
                if job["state"] not in {"queued", "running"}:
                    break
                time.sleep(0.02)
        finally:
            service.LAZADA_WAREHOUSE_READBACK_DELAYS_SECONDS = original_delays

        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["successful_products"], 1)
        self.assertEqual(job["failed_products"], 0)
        self.assertEqual(self.client.warehouse_save_calls, 1)
        self.assertEqual(
            self.client.accepted_details[0]["variations"][0][
                "warehouse_stock"
            ][1]["stock"],
            8888,
        )
        self.assertEqual(
            self.client.detail["variations"][0]["warehouse_stock"][1]["stock"],
            909,
        )
        result = job["results"][0]
        self.assertEqual(
            result["feedback_source"],
            "lazada_warehouse_update_response",
        )
        self.assertEqual(
            result["verification_status"],
            "accepted_cache_pending",
        )
        self.assertEqual(result["verified_changes"], 0)
        self.assertIn("缓存尚未刷新", result["message"])

    def test_sku_query_includes_s1_to_s9_virtual_skus_for_confirmation(self):
        def iter_pages(platform, **kwargs):
            exact = {
                "id": 6480099,
                "product_id": 16222622566,
                "title": "精确 SKU",
                "shop_id": "shop-3c",
                "shop": {"id": "shop-3c", "name": "3C pilot", "amazonsite": "TH"},
                "variations": [{"sku_id": 1, "sku": "T3CC1270045"}],
            }
            suffix = {
                "id": 6480100,
                "product_id": 16222622567,
                "title": "后缀 SKU",
                "shop_id": "shop-3c",
                "shop": {"id": "shop-3c", "name": "3C pilot", "amazonsite": "TH"},
                "variations": [{"sku_id": 2, "sku": "T3CC1270045S9"}],
            }
            yield "online", {"data": [exact, suffix]}

        self.client.iter_listing_pages = iter_pages
        exact_detail = copy.deepcopy(self.client.detail)
        suffix_detail = copy.deepcopy(self.client.detail)
        suffix_detail["id"] = 6480100
        suffix_detail["product_id"] = 16222622567
        suffix_detail["variations"][0]["sku_id"] = 2
        suffix_detail["variations"][0]["sku"] = "T3CC1270045S9"

        def get_detail(platform, internal_id):
            return copy.deepcopy(
                exact_detail if str(internal_id) == "6480099" else suffix_detail
            )

        self.client.get_online_detail = get_detail
        preview = service.create_preview(
            {
                "target_query": {
                    "platform": "lazada",
                    "state": "online",
                    "shop_ids": ["shop-3c"],
                    "search_type": "variation_sku",
                    "search_value": "T3CC1270045",
                },
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "price", "mode": "add", "value": "1"},
                ],
            }
        )
        self.assertEqual(preview["target_count"], 2)
        self.assertEqual(preview["change_count"], 2)
        self.assertEqual(preview["virtual_sku_count"], 1)
        virtual_change = next(
            change
            for change in preview["changes"]
            if change["sku_match_type"] == "virtual"
        )
        self.assertEqual(virtual_change["matched_sku"], "T3CC1270045S9")
        self.assertEqual(virtual_change["requested_sku"], "T3CC1270045")
        self.assertEqual(virtual_change["virtual_suffix"], "S9")
        self.assertIn("人工确认", preview["warnings"][0])

    def test_sku_query_checks_detail_aliases_before_dropping_candidate(self):
        def iter_pages(platform, **kwargs):
            yield "online", {
                "data": [
                    {
                        "id": 6480100,
                        "product_id": 16222622567,
                        "shop_id": "shop-3c",
                        "shop": {"id": "shop-3c", "name": "3C pilot"},
                        "variations": [
                            {"sku_id": 2, "sku": "T3CC1270045S9"}
                        ],
                    }
                ]
            }

        self.client.iter_listing_pages = iter_pages
        alias_detail = copy.deepcopy(self.client.detail)
        alias_detail["id"] = 6480100
        alias_detail["product_id"] = 16222622567
        alias_detail["variations"][0].update(
            sku_id=2,
            sku="T3CC1270045S9",
            seller_sku="T3CC1270045",
        )
        self.client.get_online_detail = (
            lambda platform, internal_id: copy.deepcopy(alias_detail)
        )
        preview = service.create_preview(
            {
                "target_query": {
                    "platform": "lazada",
                    "state": "online",
                    "shop_ids": ["shop-3c"],
                    "search_type": "sku",
                    "search_value": "T3CC1270045",
                },
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        self.assertEqual(preview["target_count"], 1)
        self.assertEqual(preview["change_count"], 1)
        self.assertEqual(preview["virtual_sku_count"], 1)
        self.assertEqual(preview["changes"][0]["sku_match_type"], "virtual")

    def test_virtual_sku_rule_is_limited_to_s1_through_s9(self):
        base = "T3CC1270045"
        for suffix in range(1, 10):
            matched = service._variation_sku_match(
                {"sku": f"{base}S{suffix}"},
                base,
            )
            self.assertIsNotNone(matched)
            self.assertEqual(matched["match_type"], "virtual")
        for invalid in ("S0", "S10", "SX", "S"):
            self.assertIsNone(
                service._variation_sku_match(
                    {"sku": f"{base}{invalid}"},
                    base,
                )
            )

    def test_target_query_resolves_filtered_results_without_visible_page_targets(self):
        self.client = ManyListingClient(2)
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "target_query": {
                    "platform": "lazada",
                    "state": "online",
                    "shop_ids": ["shop-3c"],
                    "search_type": "variation_sku",
                    "search_value": "T3CC1270045",
                },
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "price", "mode": "percent", "value": "10"},
                ],
            }
        )
        self.assertEqual(preview["target_count"], 2)
        self.assertEqual(preview["change_count"], 2)
        self.assertTrue(
            all(change["new_value"] == "3428.70" for change in preview["changes"])
        )

    def test_multi_product_execution_submits_all_then_verifies_each_result(self):
        self.client = ManyListingClient(2)
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "target_query": {
                    "platform": "lazada",
                    "state": "online",
                    "shop_ids": ["shop-3c"],
                    "search_type": "sku",
                    "search_value": "T3CC1270045",
                },
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["submitted_products"], 2)
        self.assertEqual(job["processed_products"], 2)
        self.assertEqual(job["successful_products"], 2)
        self.assertTrue(all(item["status"] == "success" for item in job["results"]))

    def test_one_store_batch_failure_does_not_hide_other_success(self):
        self.client = SelectiveBatchFailureClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_preview(
            {
                "target_query": {
                    "platform": "lazada",
                    "state": "online",
                    "shop_ids": ["shop-3c"],
                    "search_type": "sku",
                    "search_value": "T3CC1270045",
                },
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "stock", "mode": "set", "value": "99"},
                ],
            }
        )
        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "partial")
        self.assertEqual(job["successful_products"], 1)
        self.assertEqual(job["failed_products"], 1)
        failed = next(item for item in job["results"] if item["status"] == "failed")
        self.assertIn("店铺拒绝库存更新", failed["message"])
        succeeded = next(
            item for item in job["results"] if item["status"] == "success"
        )
        self.assertEqual(
            succeeded["feedback_source"],
            "platform_refresh_readback",
        )

    def test_target_query_never_silently_truncates_over_safety_limit(self):
        self.client = ManyListingClient(service.MAX_BATCH_TARGETS + 1)
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        with self.assertRaisesRegex(ValueError, "超过 100 个商品"):
            service.create_preview(
                {
                    "target_query": {
                        "platform": "lazada",
                        "state": "online",
                    },
                    "operations": [
                        {"field": "stock", "mode": "set", "value": "100"},
                    ],
                }
            )

    def test_ai_scope_preview_resolves_country_shop_and_sku(self):
        preview = service.create_ai_scope_preview(
            {
                "parsed_command": {
                    "action": "promotion_update",
                    "target": {
                        "sku": "T3CC1270045",
                        "parent_sku": "",
                        "category": "",
                    },
                    "scope": {
                        "platforms": ["lazada"],
                        "countries": ["TH"],
                        "shop_ids": [],
                        "shop_names": ["3C pilot"],
                        "categories": [],
                    },
                    "operation": {
                        "field": "special_price",
                        "mode": "decrease_percent",
                        "value": 5,
                        "unit": "percent",
                    },
                    "need_confirm": True,
                    "risks": [],
                    "clarifications": [],
                    "confidence": 0.98,
                }
            }
        )
        self.assertEqual(preview["resolved_scope"]["countries"], ["TH"])
        self.assertEqual(
            preview["resolved_scope"]["shops"][0]["name"],
            "3C pilot",
        )
        self.assertEqual(preview["batch_preview"]["target_count"], 1)
        self.assertEqual(
            preview["batch_preview"]["changes"][0]["new_value"],
            "1633.05",
        )

    def test_ai_shopee_stock_preview_auto_selects_the_only_stocked_warehouse(self):
        self.client = NormalShopMultiWarehouseShopeeListingClient([0, 10, 0])
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "shopee",
            "internal_id": 7001,
            "product_id": 57001,
            "shop_name": "Toko Penguin",
            "title": "Shopee 测试商品",
        }
        resolved_scope = {
            "platform": "shopee",
            "countries": ["ID"],
            "shops": [{"id": "shop-shopee", "name": "Toko Penguin", "site": "ID"}],
            "sku": "SKU-A",
            "parent_sku": "",
            "category_ids": [],
        }
        command = {
            "action": "stock_update",
            "target": {"sku": "SKU-A", "parent_sku": "", "category": ""},
            "scope": {
                "platforms": ["shopee"],
                "countries": ["ID"],
                "shop_ids": [],
                "shop_names": ["Toko Penguin"],
                "categories": [],
            },
            "operation": {
                "field": "stock",
                "mode": "set",
                "value": 24,
                "unit": "quantity",
            },
            "need_confirm": True,
            "risks": [],
            "clarifications": [],
            "confidence": 0.99,
        }

        with (
            patch.object(
                service,
                "_restore_authorized_shop_scopes",
                side_effect=lambda _client, commands, _source: list(commands),
            ),
            patch.object(
                service,
                "_resolve_ai_target_query",
                return_value=(
                    {"platform": "shopee", "state": "online"},
                    resolved_scope,
                ),
            ),
            patch.object(
                service,
                "_targets_from_query",
                return_value=[target],
            ),
        ):
            result = service.create_ai_scope_preview(
                {"parsed_command": command}
            )

        self.assertFalse(result["warehouse_selection_required"])
        self.assertEqual(
            result["batch_preview"]["changes"][0]["warehouse_key"],
            "location_id:WH-2",
        )
        self.assertEqual(result["batch_preview"]["changes"][0]["old_value"], 10)
        self.assertEqual(result["batch_preview"]["changes"][0]["new_value"], 24)

    def test_ai_lazada_stock_preview_auto_selects_the_only_stocked_warehouse(self):
        self.client = MultiWarehouseLazadaListingClient([0, 989])
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        target = {
            "platform": "lazada",
            "internal_id": 6480099,
            "product_id": 16166846539,
            "shop_name": "FPS Official Store.TH",
            "title": "Lazada 测试商品",
        }
        resolved_scope = {
            "platform": "lazada",
            "countries": ["TH"],
            "shops": [
                {
                    "id": "2021623263",
                    "name": "FPS Official Store.TH",
                    "site": "TH",
                }
            ],
            "sku": "T3CC1970671",
            "parent_sku": "",
            "category_ids": [],
        }
        command = {
            "action": "stock_update",
            "target": {
                "sku": "T3CC1970671",
                "parent_sku": "",
                "category": "",
            },
            "scope": {
                "platforms": ["lazada"],
                "countries": ["TH"],
                "shop_ids": [],
                "shop_names": ["FPS Official Store.TH"],
                "categories": [],
            },
            "operation": {
                "field": "stock",
                "mode": "set",
                "value": 988,
                "unit": "quantity",
            },
            "need_confirm": True,
            "risks": [],
            "clarifications": [],
            "confidence": 0.99,
        }

        with (
            patch.object(
                service,
                "_restore_authorized_shop_scopes",
                side_effect=lambda _client, commands, _source: list(commands),
            ),
            patch.object(
                service,
                "_resolve_ai_target_query",
                return_value=(
                    {"platform": "lazada", "state": "online"},
                    resolved_scope,
                ),
            ),
            patch.object(
                service,
                "_targets_from_query",
                return_value=[target],
            ),
        ):
            result = service.create_ai_scope_preview(
                {"parsed_command": command}
            )

        self.assertFalse(result["warehouse_selection_required"])
        self.assertEqual(
            result["batch_preview"]["changes"][0]["warehouse_key"],
            "warehouse_code:TH1K75WWF3-WH-10003",
        )
        self.assertEqual(result["batch_preview"]["changes"][0]["old_value"], 989)
        self.assertEqual(result["batch_preview"]["changes"][0]["new_value"], 988)
        self.assertEqual(self.client.listing_page_calls, 1)
        self.assertEqual(self.client.lazada_warehouse_list_calls, 1)

    def test_ai_shop_scope_requires_exact_authorized_name(self):
        original_get_shops = self.client.get_shops

        def get_shops(platform):
            return [
                *original_get_shops(platform),
                {
                    "id": "shop-3c-brand",
                    "name": "3C pilot Brand",
                    "amazonsite": "TH",
                    "currency": "THB",
                },
            ]

        self.client.get_shops = get_shops
        with service.STATE_LOCK:
            service.SHOP_CACHE.clear()
        command = service.validate_ai_command(
            {
                "action": "stock_update",
                "target": {"sku": "T3CC1270045"},
                "scope": {
                    "platforms": ["lazada"],
                    "shop_names": ["3C pilot"],
                },
                "operation": {
                    "mode": "set",
                    "value": 99,
                    "unit": "quantity",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        query, resolved = service._resolve_ai_target_query(self.client, command)

        self.assertEqual(query["shop_ids"], ["shop-3c"])
        self.assertEqual(
            [shop["name"] for shop in resolved["shops"]],
            ["3C pilot"],
        )

    def test_ai_shop_scope_ignores_case_and_whitespace(self):
        original_get_shops = self.client.get_shops

        def get_shops(platform):
            return [
                *original_get_shops(platform),
                {
                    "id": "shop-jojo",
                    "name": "JOJOMall",
                    "amazonsite": "PH",
                    "currency": "PHP",
                },
            ]

        self.client.get_shops = get_shops
        with service.STATE_LOCK:
            service.SHOP_CACHE.clear()
        command = service.validate_ai_command(
            {
                "action": "stock_update",
                "target": {"sku": "T3CC1270045"},
                "scope": {
                    "platforms": ["lazada"],
                    "shop_names": ["jojo　 mall"],
                },
                "operation": {
                    "mode": "set",
                    "value": 99,
                    "unit": "quantity",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        query, resolved = service._resolve_ai_target_query(self.client, command)

        self.assertEqual(query["shop_ids"], ["shop-jojo"])
        self.assertEqual([shop["name"] for shop in resolved["shops"]], ["JOJOMall"])

    def test_ai_shop_scope_rejects_ambiguous_whitespace_normalization(self):
        original_get_shops = self.client.get_shops

        def get_shops(platform):
            return [
                *original_get_shops(platform),
                {
                    "id": "shop-jojo-a",
                    "name": "JOJO Mall",
                    "amazonsite": "PH",
                    "currency": "PHP",
                },
                {
                    "id": "shop-jojo-b",
                    "name": "JOJOMall",
                    "amazonsite": "PH",
                    "currency": "PHP",
                },
            ]

        self.client.get_shops = get_shops
        with service.STATE_LOCK:
            service.SHOP_CACHE.clear()
        command = service.validate_ai_command(
            {
                "action": "stock_update",
                "target": {"sku": "T3CC1270045"},
                "scope": {
                    "platforms": ["lazada"],
                    "shop_names": ["jojo mall"],
                },
                "operation": {
                    "mode": "set",
                    "value": 99,
                    "unit": "quantity",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        with self.assertRaisesRegex(ValueError, "匹配到多个授权店铺"):
            service._resolve_ai_target_query(self.client, command)

    def test_ai_shop_scope_rejects_partial_name_instead_of_fuzzy_matching(self):
        command = service.validate_ai_command(
            {
                "action": "stock_update",
                "target": {"sku": "T3CC1270045"},
                "scope": {
                    "platforms": ["lazada"],
                    "shop_names": ["3C"],
                },
                "operation": {
                    "mode": "set",
                    "value": 99,
                    "unit": "quantity",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        with self.assertRaisesRegex(ValueError, "没有找到授权店铺"):
            service._resolve_ai_target_query(self.client, command)

    def test_ai_scope_uses_active_shopee_platform_when_command_omits_platform(self):
        self.client = ShopeeTikTokListingClient()
        shopee_detail = self.client.details[("shopee", "7001")]
        shopee_detail["shopId"] = "shop-arca"
        shopee_detail["shop_id"] = "shop-arca"
        shopee_detail["shop"] = {"id": "shop-arca", "name": "Arca Woods"}

        original_get_shops = self.client.get_shops

        def get_shops(platform):
            if str(platform) == "shopee":
                return [
                    {
                        "id": "shop-arca",
                        "name": "Arca Woods",
                        "site": "ID",
                    }
                ]
            return original_get_shops(platform)

        self.client.get_shops = get_shops
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client

        preview = service.create_ai_scope_preview(
            {
                "active_platform": "shopee",
                "parsed_command": {
                    "action": "stock_update",
                    "target": {"sku": "SKU-A"},
                    "scope": {
                        "platforms": [],
                        "shop_names": ["arca woods"],
                    },
                    "operation": {
                        "mode": "set",
                        "value": 99,
                        "unit": "quantity",
                    },
                    "need_confirm": True,
                    "risks": [],
                    "clarifications": [],
                    "confidence": 0.99,
                },
            }
        )

        self.assertEqual(preview["command"]["scope"]["platforms"], ["shopee"])
        self.assertEqual(
            preview["resolved_scope"]["shops"],
            [{"id": "shop-arca", "name": "Arca Woods", "site": "ID"}],
        )
        self.assertEqual(preview["batch_preview"]["target_count"], 1)

    def test_ai_scope_clears_resolved_model_scope_question(self):
        self.client = ShopeeTikTokListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client

        preview = service.create_ai_scope_preview(
            {
                "active_platform": "shopee",
                "parsed_command": {
                    "action": "stock_update",
                    "target": {"sku": "SKU-A"},
                    "scope": {"platforms": []},
                    "operation": {
                        "mode": "set",
                        "value": 99,
                        "unit": "quantity",
                    },
                    "need_confirm": True,
                    "risks": [],
                    "clarifications": [
                        "未指定具体平台、店铺或国家，请确认范围。",
                    ],
                    "confidence": 0.99,
                },
            }
        )

        self.assertEqual(preview["command"]["scope"]["platforms"], ["shopee"])
        self.assertEqual(preview["command"]["clarifications"], [])
        self.assertEqual(preview["batch_preview"]["target_count"], 1)

    def test_ai_scope_keeps_non_scope_clarifications(self):
        command = service.validate_ai_command(
            {
                "action": "stock_update",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": []},
                "operation": {
                    "mode": "set",
                    "value": 99,
                    "unit": "quantity",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": ["请确认目标仓库。"],
                "confidence": 0.99,
            }
        )

        contextualized = service._apply_ai_platform_context([command], "shopee")

        self.assertEqual(contextualized[0]["scope"]["platforms"], ["shopee"])
        self.assertEqual(contextualized[0]["clarifications"], ["请确认目标仓库。"])

    def test_ai_scope_keeps_explicit_platform_over_page_context(self):
        command = service.validate_ai_command(
            {
                "action": "stock_update",
                "target": {"sku": "T3CC1270045"},
                "scope": {
                    "platforms": ["lazada"],
                    "shop_names": ["3C pilot"],
                },
                "operation": {
                    "mode": "set",
                    "value": 99,
                    "unit": "quantity",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        contextualized = service._apply_ai_platform_context(
            [command],
            "shopee",
        )

        self.assertEqual(contextualized[0]["scope"]["platforms"], ["lazada"])

    def test_ai_generic_price_defaults_to_shopee_selling_price(self):
        command = service.validate_ai_command(
            {
                "action": "price_update",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": ["shopee"]},
                "operation": {
                    "mode": "set",
                    "value": 100,
                    "unit": "currency",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        adjusted = service._apply_ai_default_price_fields(
            [command],
            "Shopee SKU-A 价格修改为100",
        )[0]

        self.assertEqual(adjusted["action"], "promotion_update")
        self.assertEqual(adjusted["operation"]["field"], "special_price")

    def test_ai_generic_price_defaults_to_lazada_promotion_price(self):
        command = service.validate_ai_command(
            {
                "action": "price_update",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": ["lazada"]},
                "operation": {
                    "mode": "set",
                    "value": 100,
                    "unit": "currency",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        adjusted = service._apply_ai_default_price_fields(
            [command],
            "Lazada SKU-A 价格修改为100",
        )[0]

        self.assertEqual(adjusted["action"], "promotion_update")
        self.assertEqual(adjusted["operation"]["field"], "special_price")

    def test_ai_explicit_shopee_original_price_keeps_price_field(self):
        command = service.validate_ai_command(
            {
                "action": "promotion_update",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": ["shopee"]},
                "operation": {
                    "mode": "set",
                    "value": 120,
                    "unit": "currency",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        adjusted = service._apply_ai_default_price_fields(
            [command],
            "Shopee SKU-A 原价修改为120",
        )[0]

        self.assertEqual(adjusted["action"], "price_update")
        self.assertEqual(adjusted["operation"]["field"], "price")

    def test_ai_explicit_lazada_selling_price_keeps_price_field(self):
        command = service.validate_ai_command(
            {
                "action": "promotion_update",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": ["lazada"]},
                "operation": {
                    "mode": "set",
                    "value": 120,
                    "unit": "currency",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.99,
            }
        )

        adjusted = service._apply_ai_default_price_fields(
            [command],
            "Lazada SKU-A 售价修改为120",
        )[0]

        self.assertEqual(adjusted["action"], "price_update")
        self.assertEqual(adjusted["operation"]["field"], "price")

    def test_ai_scope_preview_keeps_two_store_sku_instructions_independent(self):
        self.client = MultiShopListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        preview = service.create_ai_scope_preview(
            {
                "parsed_commands": [
                    {
                        "action": "stock_update",
                        "target": {"sku": "T5CC2561011"},
                        "scope": {
                            "platforms": ["lazada"],
                            "shop_names": ["imii"],
                        },
                        "operation": {
                            "mode": "set",
                            "value": 0,
                            "unit": "quantity",
                        },
                        "need_confirm": True,
                        "risks": [],
                        "clarifications": [],
                        "confidence": 0.99,
                    },
                    {
                        "action": "stock_update",
                        "target": {"sku": "T3CC1970671"},
                        "scope": {
                            "platforms": ["lazada"],
                            "shop_names": ["3C COMBO"],
                        },
                        "operation": {
                            "mode": "set",
                            "value": 99,
                            "unit": "quantity",
                        },
                        "need_confirm": True,
                        "risks": [],
                        "clarifications": [],
                        "confidence": 0.99,
                    },
                ]
            }
        )

        self.assertEqual(len(preview["commands"]), 2)
        self.assertEqual(
            [
                scope["shops"][0]["name"]
                for scope in preview["resolved_scopes"]
            ],
            ["imii", "3C COMBO"],
        )
        self.assertEqual(preview["batch_preview"]["command_count"], 2)
        self.assertEqual(preview["batch_preview"]["target_count"], 2)
        self.assertEqual(preview["batch_preview"]["change_count"], 2)
        self.assertEqual(
            {
                (change["shop_name"], change["matched_sku"], change["new_value"])
                for change in preview["batch_preview"]["changes"]
            },
            {
                ("imii", "T5CC2561011", 0),
                ("3C COMBO", "T3CC1970671", 99),
            },
        )

    def test_ai_scope_preview_restores_explicit_shop_names_omitted_by_model(self):
        self.client = MultiShopListingClient()
        with service.SESSION_LOCK:
            service.SESSION["client"] = self.client
        model_commands = [
            service.validate_ai_command(
                {
                    "action": "stock_update",
                    "target": {"sku": "T5CC2561011"},
                    "scope": {
                        "platforms": ["lazada"],
                        "shop_names": ["imii店铺"],
                    },
                    "operation": {
                        "mode": "set",
                        "value": 0,
                        "unit": "quantity",
                    },
                    "need_confirm": True,
                    "risks": [],
                    "clarifications": [],
                    "confidence": 0.99,
                }
            ),
            service.validate_ai_command(
                {
                    "action": "stock_update",
                    "target": {"sku": "T3CC1970671"},
                    "scope": {
                        "platforms": ["lazada"],
                        "shop_names": ["3C COMBO店铺"],
                    },
                    "operation": {
                        "mode": "set",
                        "value": 99,
                        "unit": "quantity",
                    },
                    "need_confirm": True,
                    "risks": [],
                    "clarifications": [],
                    "confidence": 0.99,
                }
            ),
        ]
        raw_command = (
            "把imii店铺中的T5CC2561011库存数量修改为0\n"
            "把3C COMBO店铺中的T3CC1970671库存数量修改为99"
        )

        with patch.object(
            service,
            "parse_ai_commands",
            return_value=model_commands,
        ):
            preview = service.create_ai_scope_preview({"command": raw_command})

        self.assertEqual(
            [command["scope"]["shop_names"] for command in preview["commands"]],
            [["imii"], ["3C COMBO"]],
        )
        self.assertEqual(
            [
                scope["shops"][0]["name"]
                for scope in preview["resolved_scopes"]
            ],
            ["imii", "3C COMBO"],
        )


class DelayedReadbackTests(unittest.TestCase):
    def setUp(self):
        self.client = DelayedReadbackListingClient()
        with service.SESSION_LOCK:
            service.SESSION.update(
                client=self.client,
                username="陈泽彬",
                connected_at=service.now_text(),
            )
        with service.STATE_LOCK:
            service.PREVIEWS.clear()
            service.JOBS.clear()
            service.SHOP_CACHE.clear()
            service.LISTING_CACHE.clear()
            service.TARGET_CACHE.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.original_audit_path = service.AUDIT_PATH
        self.original_retry_delays = service.READBACK_RETRY_DELAYS_SECONDS
        service.AUDIT_PATH = Path(self.temp.name) / "audit.jsonl"
        service.READBACK_RETRY_DELAYS_SECONDS = (0.0, 0.0, 0.0)

    def tearDown(self):
        deadline = time.time() + 2
        while service.EXECUTION_LOCK.locked() and time.time() < deadline:
            time.sleep(0.02)
        service.AUDIT_PATH = self.original_audit_path
        service.READBACK_RETRY_DELAYS_SECONDS = self.original_retry_delays
        with service.SESSION_LOCK:
            service.SESSION.update(client=None, username="", connected_at="")
        self.temp.cleanup()

    def test_eventually_consistent_readback_is_not_reported_as_failed(self):
        preview = service.create_preview(
            {
                "targets": [
                    {
                        "platform": "lazada",
                        "internal_id": 6480099,
                        "product_id": 16222622566,
                        "shop_name": "3C pilot",
                    }
                ],
                "match_sku": "T3CC1270045",
                "operations": [
                    {"field": "special_price", "mode": "set", "value": "1729"},
                ],
            }
        )

        job = service.start_execution(preview["preview_token"])
        deadline = time.time() + 3
        while time.time() < deadline:
            job = service.get_job(job["job_id"])
            if job["state"] not in {"queued", "running"}:
                break
            time.sleep(0.02)

        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["successful_products"], 1)
        self.assertEqual(job["failed_products"], 0)
        self.assertIn("共回读 3 次", job["results"][0]["message"])
        self.assertEqual(
            self.client.detail["variations"][0]["special_price"],
            "1729.00",
        )

    def test_transient_remote_disconnect_is_retried_during_readback(self):
        self.client = TransientDisconnectReadbackListingClient()
        change = {
            "variation_key": "127430020150",
            "sku": "T3CC1270045",
            "field": "special_price",
            "storage_field": "special_price",
            "field_label": "促销价",
            "new_value": "1729.00",
        }
        self.client.detail["variations"][0]["special_price"] = "1729.00"

        attempts, verified, note = service._verify_platform_refresh(
            client=self.client,
            platform="lazada",
            internal_id="6480099",
            product_id="16222622566",
            shop_id="shop-3c",
            changes=[change],
            job_id="readback-test",
            label="3C pilot",
            shopee_global=False,
            expected_warehouses={},
        )

        self.assertEqual(self.client.refresh_disconnects_remaining, 0)
        self.assertEqual(self.client.disconnects_remaining, 0)
        self.assertEqual(attempts, 3)
        self.assertTrue(verified)
        self.assertEqual(note, "")


if __name__ == "__main__":
    unittest.main()
