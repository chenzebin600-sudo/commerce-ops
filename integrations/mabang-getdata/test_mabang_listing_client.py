# -*- coding: utf-8 -*-

import unittest
from typing import Any

import mabang_listing_client as listing


class FakeResponse:
    def __init__(
        self,
        payload: dict[str, Any] | None = None,
        *,
        text: str = "",
        url: str = "https://example.test/",
        status_code: int = 200,
    ) -> None:
        self.payload = payload
        self.text = text
        self.url = url
        self.status_code = status_code

    def json(self):
        if self.payload is None:
            raise ValueError("not json")
        return self.payload


class FakeSession:
    def __init__(self) -> None:
        self.trust_env = True
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.handlers: list[tuple[str, str, FakeResponse]] = []

    def add(self, method: str, contains: str, response: FakeResponse) -> None:
        self.handlers.append((method.upper(), contains, response))

    def request(self, method: str, url: str, **kwargs):
        method = method.upper()
        self.calls.append((method, url, kwargs))
        for expected_method, contains, response in self.handlers:
            if expected_method == method and contains in url:
                return response
        raise AssertionError(f"unexpected request: {method} {url}")

    def get(self, url: str, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url: str, **kwargs):
        return self.request("POST", url, **kwargs)


class MabangListingClientTests(unittest.TestCase):
    @staticmethod
    def authenticated_client(fake):
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["lazada"] = listing.PublishContext(
            platform=listing.PLATFORMS["lazada"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )
        return client

    def test_login_discovers_token_and_reads_shops(self):
        fake = FakeSession()
        fake.add("GET", "main.loginPage", FakeResponse(text="login"))
        fake.add("POST", "main.doLogin", FakeResponse({"success": True}))
        fake.add(
            "GET",
            "tenant.private.mabangerp.com/index.php",
            FakeResponse(
                text=(
                    '<iframe id="iframeContent" '
                    'src="https://publish-private.mabangerp.com/publish-ui/'
                    '#/publishProductListV2?cKey=test-key&amp;memcacheKey=cache-key">'
                    "</iframe>"
                ),
                url="https://tenant.private.mabangerp.com/index.php",
            ),
        )
        fake.add(
            "GET",
            "publish-private.mabangerp.com/index.php",
            FakeResponse(
                {
                    "success": True,
                    "data": {
                        "token": "secret-token",
                        "cloud": 1,
                        "companyId": 123,
                    },
                }
            ),
        )
        fake.add(
            "GET",
            "/common/publish/shop/list",
            FakeResponse({"code": 200, "data": [{"id": 1, "name": "店铺A"}]}),
        )

        client = listing.MabangListingClient(
            account_host="tenant.private.mabangerp.com",
            session=fake,
        )
        client.login("user", "password")
        shops = client.get_shops("lazada")

        self.assertEqual(shops, [{"id": 1, "name": "店铺A"}])
        api_call = next(call for call in fake.calls if "/common/publish/shop/list" in call[1])
        self.assertTrue(api_call[1].startswith(listing.PRIVATE_API_HOST))
        self.assertEqual(api_call[2]["headers"]["Authorization"], "Bearer secret-token")
        self.assertEqual(api_call[2]["headers"]["key"], "cache-key")
        self.assertEqual(api_call[2]["headers"]["cluster-id"], "2")

    def test_lazada_online_list_uses_get_and_normalizes_variants(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/common/online/list",
            FakeResponse(
                {
                    "code": 200,
                    "data": [
                        {
                            "id": 100,
                            "shop_id": 20,
                            "product_id": 300,
                            "title": "测试商品",
                            "sku": "PARENT",
                            "currency": "THB",
                            "platformUrl": "https://example.test/product/300",
                            "shop": {"id": 20, "name": "店铺A", "amazonsite": "th"},
                            "variations": [
                                {
                                    "sku_id": 400,
                                    "sku": "SKU-1",
                                    "price": "99.00",
                                    "stock": 8,
                                    "warehouse_stock": [
                                        {"warehouse_code": "TH", "stock": 8}
                                    ],
                                }
                            ],
                        }
                    ],
                    "total": {"online_count": 1},
                }
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["lazada"] = listing.PublishContext(
            platform=listing.PLATFORMS["lazada"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        rows = list(
            client.iter_listings(
                "lazada",
                states="online",
                page_size=10,
                max_pages=1,
            )
        )

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["product_url"], "https://example.test/product/300")
        self.assertEqual(rows[0]["variants"][0]["sku"], "SKU-1")
        self.assertEqual(rows[0]["variants"][0]["stock"], 8)
        request = fake.calls[-1]
        self.assertEqual(request[0], "GET")
        self.assertEqual(request[2]["params"]["platformId"], 7)
        self.assertEqual(request[2]["params"]["menu_type"], "6")

    def test_shopee_online_list_explicitly_selects_site_products(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/common/online/list",
            FakeResponse({"code": 200, "data": [], "total": {"online_count": 0}}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        payload = client.get_listing_page(
            "shopee",
            state="online",
            page=1,
            page_size=100,
        )

        self.assertEqual(payload["code"], 200)
        request = fake.calls[-1]
        self.assertEqual(request[0], "GET")
        self.assertEqual(request[2]["params"]["menu_type"], "6")
        self.assertEqual(
            request[2]["params"]["product_type"],
            listing.SHOPEE_SITE_PRODUCT_TYPE,
        )

    def test_shopee_online_list_enriches_original_and_selling_prices(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/common/online/list",
            FakeResponse(
                {
                    "code": 200,
                    "data": [
                        {
                            "id": 55506074533,
                            "product_id": 55506074533,
                            "title": "Shopee product",
                            "variations": [
                                {
                                    "sku_id": 380553892679,
                                    "sku": "T3AA1863489",
                                    "price": "365000.00",
                                    "discount_price": "365000.00",
                                }
                            ],
                        }
                    ],
                    "total": {"online_count": 1},
                }
            ),
        )
        fake.add(
            "GET",
            "/common/online/detail/batch",
            FakeResponse(
                {
                    "code": 200,
                    "data": [
                        {
                            "id": 55506074533,
                            "product_id": 55506074533,
                            "variations": [
                                {
                                    "sku_id": 380553892679,
                                    "sku": "T3AA1863489",
                                    "original_price": "900000",
                                    "price": "365000.00",
                                    "discount_price": "365000.00",
                                }
                            ],
                        }
                    ],
                }
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        payload = client.get_listing_page(
            "shopee",
            state="online",
            page=1,
            page_size=50,
        )
        normalized = listing.normalize_listing(
            "shopee",
            "online",
            payload["data"][0],
        )

        self.assertTrue(payload["price_detail_complete"])
        self.assertEqual(normalized["variants"][0]["price"], "900000")
        self.assertEqual(normalized["variants"][0]["sale_price"], "365000.00")
        self.assertTrue(
            any("/common/online/detail/batch" in call[1] for call in fake.calls)
        )

    def test_tiktok_online_list_uses_json_post(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/tiktok/online/list",
            FakeResponse({"code": 200, "data": [], "total": {"online_count": 0}}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["tiktokshop"] = listing.PublishContext(
            platform=listing.PLATFORMS["tiktokshop"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        payload = client.get_listing_page(
            "tiktokshop",
            state="online",
            page=1,
            page_size=100,
        )

        self.assertEqual(payload["code"], 200)
        request = fake.calls[-1]
        self.assertEqual(request[0], "POST")
        self.assertEqual(request[2]["json"]["platformId"], 104)
        self.assertEqual(request[2]["json"]["menu_type"], "6")

    def test_lazada_detail_and_save_use_verified_online_endpoints(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/common/online/detail",
            FakeResponse(
                {
                    "code": 200,
                    "data": {
                        "id": 6480099,
                        "variations": [
                            {
                                "sku_id": 127430020150,
                                "sku": "T3CC1270045",
                                "price": "3117.00",
                                "specialTime": ["2026-07-01", "2026-07-31"],
                            }
                        ],
                    },
                }
            ),
        )
        fake.add(
            "POST",
            "/common/online/save",
            FakeResponse({"code": 200, "message": "ok"}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["lazada"] = listing.PublishContext(
            platform=listing.PLATFORMS["lazada"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        detail = client.get_online_detail("lazada", 6480099)
        detail["variations"][0]["price"] = "3118.00"
        response = client.save_lazada_online_detail(detail)

        self.assertEqual(response["code"], 200)
        detail_request = next(call for call in fake.calls if "/online/detail" in call[1])
        self.assertEqual(detail_request[2]["params"], {"platformId": 7, "id": "6480099"})
        save_request = next(call for call in fake.calls if "/online/save" in call[1])
        body = save_request[2]["json"]
        self.assertEqual(body["platformId"], 7)
        self.assertEqual(body["is_save_and_publish"], 1)
        self.assertEqual(
            body["variations"][0]["special_from_time"],
            "2026-07-01",
        )
        self.assertEqual(
            body["variations"][0]["special_to_time"],
            "2026-07-31",
        )
        self.assertNotIn("specialTime", body["variations"][0])

    def test_lazada_local_stock_and_progress_use_console_endpoints(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/lazada/online/local/save/stock",
            FakeResponse({"code": 200, "data": {"batch_id": "batch-123"}}),
        )
        fake.add(
            "GET",
            "/common/public/batch/process",
            FakeResponse(
                {
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
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["lazada"] = listing.PublishContext(
            platform=listing.PLATFORMS["lazada"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        response = client.save_lazada_online_local_value(
            "stock",
            [
                {
                    "id": 6480099,
                    "product_id": 5831798601,
                    "shop_id": 69343360,
                    "title": "Lazada product",
                    "variations": [
                        {
                            "sku_id": 24826711066,
                            "sku": "T3CC1970380",
                            "status": 1,
                            "stock": 200,
                        }
                    ],
                }
            ],
        )
        progress = client.get_batch_process(response["data"]["batch_id"])

        self.assertEqual(progress["data"]["data_num"]["success_num"], 1)
        save_request = next(
            call for call in fake.calls if "/online/local/save/stock" in call[1]
        )
        self.assertEqual(save_request[0], "POST")
        self.assertEqual(
            save_request[2]["json"][0]["variations"][0]["stock"],
            200,
        )
        progress_request = next(
            call for call in fake.calls if "/common/public/batch/process" in call[1]
        )
        self.assertEqual(
            progress_request[2]["params"],
            {"batch_id": "batch-123"},
        )

    def test_lazada_warehouse_catalog_and_stock_update_use_dedicated_endpoints(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/lazada/warehouse/list",
            FakeResponse(
                {
                    "code": 200,
                    "msg": "success",
                    "data": [
                        {
                            "code": "dropshipping",
                            "name": None,
                            "detailAddress": "Hong Kong",
                            "defaultAddress": True,
                            "needToUpdate": False,
                            "status": "ACTIVE",
                        },
                        {
                            "code": "TH1K75WWF3-WH-10003",
                            "name": "泰国TLS3C仓-1308",
                            "detailAddress": "Samut Prakan",
                            "defaultAddress": False,
                            "needToUpdate": False,
                            "status": "ACTIVE",
                        },
                    ],
                }
            ),
        )
        fake.add(
            "POST",
            "/lazada/warehouse/stock/update",
            FakeResponse({"code": 200, "msg": "success", "data": {}}),
        )
        client = self.authenticated_client(fake)

        warehouses = client.get_lazada_warehouse_list(2021623263)
        response = client.save_lazada_warehouse_stock(
            [
                {
                    "id": 6477511,
                    "product_id": 16166846539,
                    "shop_id": 2021623263,
                    "shop": {
                        "id": 2021623263,
                        "name": "FPS Official Store.TH",
                        "amazonsite": "th",
                        "extend2": "1",
                        "shop_type": 2,
                        "currency": "THB",
                    },
                    "variations": [
                        {
                            "sku": "T3CC1970671",
                            "sku_id": 127191223199,
                            "warehouse_stock": [
                                {
                                    "warehouse_code": "dropshipping",
                                    "stock": 0,
                                    "_warehouse_name": "Hong Kong",
                                },
                                {
                                    "warehouse_code": "TH1K75WWF3-WH-10003",
                                    "stock": "989",
                                    "_warehouse_name": "泰国TLS3C仓-1308",
                                },
                            ],
                        }
                    ],
                }
            ]
        )

        self.assertEqual(response["code"], 200)
        self.assertEqual(
            [item["warehouse_code"] for item in warehouses],
            ["dropshipping", "TH1K75WWF3-WH-10003"],
        )
        self.assertEqual(warehouses[1]["warehouse_name"], "泰国TLS3C仓-1308")
        list_request = next(
            call for call in fake.calls if "/lazada/warehouse/list" in call[1]
        )
        self.assertEqual(list_request[2]["params"], {"shop_id": "2021623263"})
        save_request = next(
            call for call in fake.calls if "/lazada/warehouse/stock/update" in call[1]
        )
        self.assertEqual(
            save_request[2]["json"],
            {
                "list": [
                    {
                        "product_id": 16166846539,
                        "shop": {
                            "id": 2021623263,
                            "name": "FPS Official Store.TH",
                            "amazonsite": "th",
                            "extend2": "1",
                            "shop_type": 2,
                            "currency": "THB",
                        },
                        "variations": [
                            {
                                "sku": "T3CC1970671",
                                "sku_id": 127191223199,
                                "warehouse_stock": [
                                    {
                                        "warehouse_code": "dropshipping",
                                        "stock": 0,
                                    },
                                    {
                                        "warehouse_code": "TH1K75WWF3-WH-10003",
                                        "stock": 989,
                                    },
                                ],
                            }
                        ],
                    }
                ]
            },
        )

    def test_shopee_local_stock_accepts_zero_and_uses_console_endpoint(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/shopee/online/local/save/stock",
            FakeResponse({"code": 200, "data": {"batch_id": "shopee-batch-1"}}),
        )
        fake.add(
            "GET",
            "/common/public/batch/process",
            FakeResponse(
                {
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
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        response = client.save_shopee_online_local_value(
            "stock",
            [
                {
                    "id": 7001,
                    "product_id": 51651028712,
                    "shop_id": 2021578358,
                    "title": "Shopee product",
                    "variations": [
                        {
                            "sku_id": 267136528499,
                            "sku": "T3AA1054888",
                            "status": 1,
                            "stock": 0,
                        }
                    ],
                }
            ],
        )
        progress = client.get_batch_process(
            response["data"]["batch_id"],
            platform="shopee",
        )

        self.assertEqual(progress["data"]["data_num"]["success_num"], 1)
        save_request = next(
            call for call in fake.calls if "/shopee/online/local/save/stock" in call[1]
        )
        self.assertEqual(
            save_request[2]["json"],
            [
                {
                    "id": 7001,
                    "product_id": 51651028712,
                    "shop_id": 2021578358,
                    "title": "Shopee product",
                    "variations": [
                        {
                            "sku_id": 267136528499,
                            "sku": "T3AA1054888",
                            "status": 1,
                            "stock": 0,
                        }
                    ],
                }
            ],
        )

    def test_shopee_site_product_warehouse_list_uses_editor_endpoint(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/shopee/getWarehouseList",
            FakeResponse(
                {
                    "code": 200,
                    "data": [
                        {
                            "zipcode": "60184",
                            "country": None,
                            "warehouseName": "泗水云雀+YS0460",
                            "city": "KOTA SURABAYA",
                            "district": "TANDES",
                            "state": "JAWA TIMUR",
                            "locationId": "IDZ",
                            "warehouseId": 100495857,
                        },
                        {
                            "zipcode": "60187",
                            "country": None,
                            "warehouseName": "泗水环亚+YS0460",
                            "city": "KOTA SURABAYA",
                            "district": "SUKOMANUNGGAL",
                            "state": "JAWA TIMUR",
                            "locationId": "ID019A6UZ",
                            "warehouseId": 100496667,
                        },
                        {
                            "zipcode": "15570",
                            "country": None,
                            "warehouseName": "顺丰+YS0460",
                            "city": "KAB. TANGERANG",
                            "district": "PAKUHAJI",
                            "state": "BANTEN",
                            "locationId": "ID019CLQZ",
                            "warehouseId": 100513699,
                        },
                    ],
                    "msg": "",
                }
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        warehouses = client.get_shopee_warehouse_list(2021557966)

        self.assertEqual(
            [item["location_id"] for item in warehouses],
            ["IDZ", "ID019A6UZ", "ID019CLQZ"],
        )
        self.assertEqual(
            [item["warehouse_name"] for item in warehouses],
            ["泗水云雀+YS0460", "泗水环亚+YS0460", "顺丰+YS0460"],
        )
        request = next(
            call for call in fake.calls if "/shopee/getWarehouseList" in call[1]
        )
        self.assertEqual(request[2]["params"], {"shop_id": "2021557966"})

    def test_shopee_local_stock_preserves_warehouse_rows_and_total(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/shopee/online/local/save/stock",
            FakeResponse(
                {"code": 200, "data": {"batch_id": "local-stock-batch-1"}}
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        response = client.save_shopee_online_local_value(
            "stock",
            [
                {
                    "id": 55506074533,
                    "product_id": 55506074533,
                    "shopId": 2021557966,
                    "variations": [
                        {
                            "sku_id": 380553892679,
                            "sku": "T3AA1863489",
                            "stock": 999,
                            "warehouse_stock": [
                                {
                                    "location_id": "IDZ",
                                    "stock": 0,
                                    "_warehouse_name": "泗水云雀+YS0460",
                                },
                                {
                                    "location_id": "ID019A6UZ",
                                    "stock": 10,
                                    "_warehouse_id": 100496667,
                                },
                                {
                                    "location_id": "ID019CLQZ",
                                    "stock": 0,
                                },
                            ],
                        }
                    ],
                }
            ],
        )

        self.assertEqual(response["data"]["batch_id"], "local-stock-batch-1")
        save_request = next(
            call
            for call in fake.calls
            if "/shopee/online/local/save/stock" in call[1]
        )
        submitted = save_request[2]["json"][0]
        self.assertEqual(submitted["shop_id"], 2021557966)
        variation = submitted["variations"][0]
        self.assertEqual(variation["stock"], 10)
        self.assertEqual(
            [item["stock"] for item in variation["warehouse_stock"]],
            [0, 10, 0],
        )
        self.assertTrue(
            all(
                not any(key.startswith("_warehouse_") for key in item)
                for item in variation["warehouse_stock"]
            )
        )

    def test_shopee_global_stock_sums_warehouse_values_and_uses_global_endpoint(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/shopee/online/detail/batch",
            FakeResponse(
                {
                    "code": 200,
                    "data": [
                        {
                            "id": 7001,
                            "product_id": 51651028712,
                            "shopId": 2021578358,
                            "variations": [
                                {
                                    "sku_id": 267136528499,
                                    "sku": "T3AA1863489",
                                    "stock": 999,
                                    "warehouse_stock": [
                                        {
                                            "location_id": "WH-A",
                                            "stock": 0,
                                            "_warehouse_name": "Warehouse A",
                                            "_warehouse_id": 1001,
                                        },
                                        {"location_id": "WH-B", "stock": 10},
                                        {"location_id": "WH-C", "stock": 0},
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ),
        )
        fake.add(
            "POST",
            "/shopee/online/global/save/stock",
            FakeResponse({"code": 200, "data": {"batch_id": "global-batch-1"}}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        details = client.get_online_batch_details(
            "shopee",
            [51651028712],
            shopee_global=True,
        )
        response = client.save_shopee_online_global_stock(details)

        self.assertEqual(response["data"]["batch_id"], "global-batch-1")
        detail_request = next(
            call for call in fake.calls if "/shopee/online/detail/batch" in call[1]
        )
        self.assertEqual(
            detail_request[2]["params"],
            {"platformId": "17", "id": "51651028712"},
        )
        save_request = next(
            call
            for call in fake.calls
            if "/shopee/online/global/save/stock" in call[1]
        )
        self.assertEqual(
            save_request[2]["json"][0]["variations"][0]["stock"],
            10,
        )
        submitted_warehouses = save_request[2]["json"][0]["variations"][0][
            "warehouse_stock"
        ]
        self.assertTrue(
            all(
                not any(key.startswith("_warehouse_") for key in item)
                for item in submitted_warehouses
            )
        )

    def test_normal_shopee_batch_detail_preserves_zero_stock_warehouses(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/common/online/detail/batch",
            FakeResponse(
                {
                    "code": 200,
                    "data": [
                        {
                            "id": 55506074533,
                            "product_id": 55506074533,
                            "shopId": 2021557966,
                            "variations": [
                                {
                                    "sku_id": 380553892679,
                                    "sku": "T3AA1863489",
                                    "stock": 10,
                                    "warehouse_stock": [
                                        {"location_id": "WH-A", "stock": 0},
                                        {"location_id": "WH-B", "stock": 10},
                                        {"location_id": "WH-C", "stock": 0},
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        details = client.get_online_batch_details(
            "shopee",
            [55506074533],
            shopee_global=False,
        )

        self.assertEqual(
            [item["stock"] for item in details[0]["variations"][0]["warehouse_stock"]],
            [0, 10, 0],
        )
        self.assertTrue(
            any("/common/online/detail/batch" in call[1] for call in fake.calls)
        )
        self.assertFalse(
            any("/shopee/online/detail/batch" in call[1] for call in fake.calls)
        )

    def test_normalize_variant_reads_real_shopee_stock_info_v2_contract(self):
        variant = listing.normalize_variant(
            {
                "sku_id": 380553892679,
                "sku": "T3AA1863489",
                "stock": 10,
                "stock_info_v2": {
                    "seller_stock": [
                        {
                            "if_saleable": True,
                            "location_id": "IDZ",
                            "stock": 0,
                        },
                        {
                            "if_saleable": True,
                            "location_id": "ID019A6UZ",
                            "stock": 999,
                        },
                        {
                            "if_saleable": True,
                            "location_id": "ID019CLQZ",
                            "stock": 0,
                        },
                    ],
                    "summary_info": {
                        "total_available_stock": 999,
                        "total_reserved_stock": 0,
                    },
                },
            }
        )

        self.assertEqual(
            [
                (item["location_id"], item["stock"])
                for item in variant["warehouse_stock"]
            ],
            [
                ("IDZ", 0),
                ("ID019A6UZ", 999),
                ("ID019CLQZ", 0),
            ],
        )

    def test_normalize_variant_separates_shopee_original_and_selling_prices(self):
        variant = listing.normalize_variant(
            {
                "sku_id": 380553892679,
                "sku": "T3AA1863489",
                "original_price": "1000000",
                "price": "436000.00",
                "discount_price": "436000.00",
            },
            "shopee",
        )

        self.assertEqual(variant["price"], "1000000")
        self.assertEqual(variant["sale_price"], "436000.00")

    def test_normalize_variant_does_not_invent_shopee_original_price(self):
        variant = listing.normalize_variant(
            {
                "sku_id": 380553892679,
                "sku": "T3AA1863489",
                "price": "436000.00",
                "discount_price": "436000.00",
            },
            "shopee",
        )

        self.assertEqual(variant["price"], "")
        self.assertEqual(variant["sale_price"], "436000.00")

    def test_sync_online_product_uses_mabang_online_refresh_contract(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/shopee/public/sync/product",
            FakeResponse({"code": 200, "data": {"batch_id": "sync-1"}}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["shopee"] = listing.PublishContext(
            platform=listing.PLATFORMS["shopee"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
            c_key="publish-key",
        )

        response = client.sync_online_product(
            "shopee",
            product_id=51651028712,
            shop_id=2021578358,
        )

        self.assertEqual(response["data"]["batch_id"], "sync-1")
        request = fake.calls[-1]
        self.assertIn("/kandeng/api/v2/shopee/public/sync/product", request[1])
        self.assertEqual(
            request[2]["params"],
            None,
        )
        self.assertEqual(
            request[2]["json"],
            {
                "platformId": "17",
                "idAndShopId": [
                    {"id": "51651028712", "shopId": "2021578358"}
                ],
            },
        )

    def test_tiktok_detail_uses_platform_specific_endpoint(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/tiktok/online/detail",
            FakeResponse(
                {
                    "code": 200,
                    "data": {
                        "id": 319729,
                        "shop_id": 2021571640,
                        "variation": 2,
                        "variations": [{"id": 1, "sku_id": "2", "sku": "SKU-A"}],
                    },
                }
            ),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["tiktokshop"] = listing.PublishContext(
            platform=listing.PLATFORMS["tiktokshop"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        detail = client.get_online_detail("tiktokshop", 319729)

        self.assertEqual(detail["id"], 319729)
        request = fake.calls[-1]
        self.assertIn("/tiktok/online/detail", request[1])
        self.assertEqual(request[2]["params"]["platformId"], 104)

    def test_shopee_and_tiktok_full_save_dispatch_to_captured_routes(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/common/online/save",
            FakeResponse({"code": 200, "msg": "success"}),
        )
        fake.add(
            "POST",
            "/tiktok/online/save",
            FakeResponse({"code": 200, "msg": "success"}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        for platform in ("shopee", "tiktokshop"):
            client._contexts[platform] = listing.PublishContext(
                platform=listing.PLATFORMS[platform],
                api_base=listing.API_HOST,
                cluster_id="1",
                company_id="123",
                memcache_key="cache",
                token="token",
            )

        client.save_online_detail(
            "shopee",
            {
                "id": 56863559704,
                "shopId": 2021631814,
                "tierVariationOption": [{"name": "Color", "option_list": []}],
                "variations": [{"sku_id": 371174308123, "sku": "SKU-B"}],
            },
        )
        client.save_online_detail(
            "tiktokshop",
            {
                "id": 319729,
                "shop_id": 2021571640,
                "variation": 2,
                "variations": [{"id": 1, "sku_id": "2", "sku": "SKU-C"}],
            },
        )

        shopee_request = next(
            call for call in fake.calls if "/common/online/save" in call[1]
        )
        self.assertEqual(shopee_request[2]["json"]["platformId"], 17)
        self.assertEqual(shopee_request[2]["json"]["shop_id"], 2021631814)
        self.assertEqual(shopee_request[2]["json"]["is_save_and_publish"], 1)
        tiktok_request = next(
            call for call in fake.calls if "/tiktok/online/save" in call[1]
        )
        self.assertEqual(tiktok_request[2]["json"]["platformId"], 104)
        self.assertEqual(tiktok_request[2]["json"]["variation"], "2")
        self.assertEqual(tiktok_request[2]["json"]["is_save_and_publish"], 1)

    def test_all_states_expand_in_platform_order(self):
        states = listing.resolve_states(listing.PLATFORMS["lazada"], "all")
        self.assertEqual(
            states,
            ("online", "examining", "offline", "prohibited", "deleted"),
        )

    def test_publish_draft_uses_captured_task_endpoint(self):
        fake = FakeSession()
        fake.add(
            "POST",
            "/common/task/publish",
            FakeResponse({"code": 200, "data": {"batch_id": "publish-123"}}),
        )
        client = listing.MabangListingClient(session=fake)
        client._logged_in = True
        client._contexts["lazada"] = listing.PublishContext(
            platform=listing.PLATFORMS["lazada"],
            api_base=listing.API_HOST,
            cluster_id="1",
            company_id="123",
            memcache_key="cache",
            token="token",
        )

        result = client.publish_draft_task("task-99")

        self.assertEqual(result["batch_id"], "publish-123")
        request = fake.calls[-1]
        self.assertEqual(request[0], "POST")
        self.assertEqual(
            request[2]["json"],
            {"platformId": 7, "id": "task-99"},
        )

    def test_uncaptured_publish_result_contract_fails_explicitly(self):
        client = listing.MabangListingClient(session=FakeSession())

        with self.assertRaises(listing.MabangPublishProtocolNotCaptured):
            client.resolve_published_listing("task-1", "shop-1")

    def test_csv_flattens_each_variant(self):
        rows = list(
            listing.flatten_listing_rows(
                [
                    {
                        "platform_name": "Lazada",
                        "state": "online",
                        "shop_id": 1,
                        "shop_name": "店铺A",
                        "product_id": 2,
                        "product_url": "https://example.test/2",
                        "variants": [
                            {"variant_id": 3, "sku": "A", "price": "10", "stock": 5},
                            {"variant_id": 4, "sku": "B", "price": "11", "stock": 6},
                        ],
                    }
                ]
            )
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["变体SKU"], "A")
        self.assertEqual(rows[1]["变体SKU"], "B")


    def test_new_listing_category_schema_and_draft_contract(self):
        fake = FakeSession()
        fake.add(
            "GET",
            "/lazada/getCategory",
            FakeResponse({"code": 200, "data": [{"category_id": 22489, "name": "Flowers"}]}),
        )
        fake.add(
            "GET",
            "/lazada/getAttribute",
            FakeResponse({
                "code": 200,
                "data": {
                    "normal": [{"name": "brand", "is_mandatory": 1}],
                    "sku": [{"name": "color_family", "is_mandatory": 1}],
                    "public": [],
                    "logics": [],
                },
            }),
        )
        fake.add(
            "POST",
            "/common/task/save",
            FakeResponse({"code": 200, "data": {"id": "task-88"}}),
        )
        fake.add(
            "GET",
            "/common/task/detail",
            FakeResponse({
                "code": 200,
                "data": {
                    "productForm": {
                        "title": "Flower set",
                        "shop_id": "shop-1",
                        "variations": [{"sku": "FLOWER-RED"}],
                    }
                },
            }),
        )
        client = self.authenticated_client(fake)

        categories = client.get_categories(
            "lazada",
            shop_id="shop-1",
            site="TH",
            search_name="Flower",
        )
        schema = client.get_category_attributes(
            "lazada",
            site="TH",
            category_id="22489",
        )
        receipt = client.save_publish_draft({
            "platform": "lazada",
            "shop_id": "shop-1",
            "site": "TH",
            "title": "Flower set",
            "category_id": "22489",
            "category_name": "Flowers",
            "brand": "No Brand",
            "description": "Artificial flowers",
            "attributes": {"brand": "No Brand"},
            "extended": {
                "category_schema": schema,
                "source_model_name": "Flower Set",
            },
            "weight": "0.2",
            "package_length": "20",
            "package_width": "10",
            "package_height": "8",
            "assets": [{"url": "https://img.example.test/flower.jpg"}],
            "variants": [{
                "sku": "FLOWER-RED",
                "price": "99",
                "special_price": "",
                "stock": 12,
                "specification_name": "Color",
                "specification_value": "Red",
                "properties": [{"name": "color_family", "value": "Red"}],
                "images": ["https://img.example.test/flower-red.jpg"],
            }],
        })
        readback = client.get_publish_draft(receipt["task_id"])

        self.assertEqual(categories[0]["category_id"], 22489)
        self.assertEqual(schema["sku"][0]["name"], "color_family")
        self.assertEqual(receipt["task_id"], "task-88")
        self.assertEqual(readback["variations"][0]["sku"], "FLOWER-RED")
        save_call = next(call for call in fake.calls if "/common/task/save" in call[1])
        product_form = save_call[2]["json"]
        self.assertEqual(product_form["platformId"], 7)
        self.assertEqual(product_form["shop_id"], "shop-1")
        self.assertEqual(product_form["category_id"], "22489")
        self.assertEqual(
            product_form["variations"][0]["propert"][0]["name"],
            "color_family",
        )
        self.assertEqual(product_form["is_save_and_publish"], 1)


if __name__ == "__main__":
    unittest.main()
