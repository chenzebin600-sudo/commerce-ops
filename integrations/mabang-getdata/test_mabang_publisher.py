# -*- coding: utf-8 -*-

import copy
import tempfile
import unittest
from pathlib import Path

from mabang_publisher import (
    PublisherManager,
    PublisherStateError,
    PublisherStore,
    PublisherValidationError,
)


SHOPS = [
    {
        "id": "shop-3c",
        "name": "3C pilot",
        "site": "TH",
        "currency": "THB",
    }
]


def valid_material():
    return {
        "platform": "lazada",
        "shop_id": "shop-3c",
        "title": "65W GaN Charger",
        "category_id": "1000123",
        "category_name": "Wall Chargers",
        "brand": "No Brand",
        "description": "Three-port fast charger.",
        "attributes": {"Ports": "3"},
        "weight": "0.2",
        "package_length": "12",
        "package_width": "8",
        "package_height": "4",
        "variants": [
            {
                "sku": "GAN65-BK",
                "specification_name": "Color",
                "specification_value": "Black",
                "price": "99.90",
                "special_price": "89.90",
                "stock": 20,
            }
        ],
        "assets": [{"url": "https://img.example.test/gan65.jpg"}],
    }


class FakePublisherClient:
    def __init__(self):
        self.saved = None
        self.publish_calls = 0

    def save_publish_draft(self, draft):
        self.saved = copy.deepcopy(draft)
        return {"task_id": "task-1"}

    def get_online_detail(self, platform, internal_id):
        assert platform == "lazada"
        assert internal_id == "online-1"
        return {
            "id": internal_id,
            "title": "Online template",
            "shop_id": "shop-3c",
            "category_id": "1000123",
            "description": "Template description.",
            "weight": "0.2",
            "package_length": "12",
            "package_width": "8",
            "package_height": "4",
        }

    def get_publish_draft(self, task_id):
        assert task_id == "task-1"
        return {
            "title": self.saved["title"],
            "shop_id": self.saved["shop_id"],
            "variants": [
                {"sku": item["sku"]} for item in self.saved["variants"]
            ],
        }

    def publish_draft_task(self, task_id):
        assert task_id == "task-1"
        self.publish_calls += 1
        return {"batch_id": "batch-1"}

    def get_batch_process(self, batch_id):
        assert batch_id == "batch-1"
        return {
            "data": {
                "data_num": {
                    "total_num": 1,
                    "success_num": 1,
                    "fail_num": 0,
                }
            }
        }

    def resolve_published_listing(self, task_id, shop_id):
        assert task_id == "task-1"
        assert shop_id == "shop-3c"
        return {
            "platform_product_id": "16222622566",
            "product_url": "https://www.lazada.co.th/products/i16222622566.html",
            "platform_sku_ids": {"GAN65-BK": "sku-platform-1"},
        }


class PublisherWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = PublisherStore(Path(self.temp_dir.name) / "publisher.db")
        self.manager = PublisherManager(self.store)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_full_confirmed_single_listing_flow(self):
        client = FakePublisherClient()
        draft = self.manager.create(valid_material(), SHOPS)

        self.assertEqual(draft["status"], "LOCAL_DRAFT")
        saved = self.manager.save_to_mabang(client, draft["id"])
        self.assertEqual(saved["status"], "WAIT_CONFIRM")
        confirmed = self.manager.confirm(draft["id"], saved["version"])
        self.assertEqual(confirmed["confirmed_version"], saved["version"])

        submitted = self.manager.publish(client, draft["id"])
        self.assertEqual(submitted["draft"]["status"], "MABANG_ACCEPTED")
        completed = self.manager.refresh_job(client, submitted["job"]["id"])

        self.assertEqual(completed["draft"]["status"], "PUBLISHED")
        self.assertEqual(
            completed["listing"]["platform_product_id"],
            "16222622566",
        )
        self.assertEqual(client.publish_calls, 1)
        repeated = self.manager.publish(client, draft["id"])
        self.assertEqual(repeated["job"]["id"], submitted["job"]["id"])
        self.assertEqual(client.publish_calls, 1)

    def test_rejects_shop_outside_authenticated_scope(self):
        material = valid_material()
        material["shop_id"] = "unknown-shop"

        with self.assertRaisesRegex(PublisherValidationError, "授权范围"):
            self.manager.create(material, SHOPS)

    def test_publish_requires_same_version_human_confirmation(self):
        client = FakePublisherClient()
        draft = self.manager.create(valid_material(), SHOPS)
        saved = self.manager.save_to_mabang(client, draft["id"])

        with self.assertRaises(PublisherStateError):
            self.manager.publish(client, saved["id"])

    def test_online_row_hint_completes_missing_image_and_variant(self):
        client = FakePublisherClient()

        draft = self.manager.from_listing(
            client,
            platform="lazada",
            internal_id="online-1",
            shops=SHOPS,
            listing_hint={
                "image": "https://img.example.test/template.jpg",
                "variants": [
                    {
                        "sku": "ONLINE-SKU",
                        "price": "109.9",
                        "sale_price": "99.9",
                        "stock": 18,
                    }
                ],
            },
        )

        self.assertEqual(draft["variants"][0]["sku"], "ONLINE-SKU")
        self.assertEqual(
            draft["assets"][0]["url"],
            "https://img.example.test/template.jpg",
        )

    def test_v2_draft_preserves_model_and_platform_variant_evidence(self):
        material = valid_material()
        material["extended"] = {
            "source_mode": "product_model",
            "source_model_id": "model-1",
            "category_schema": {
                "normal": [{"name": "brand", "is_mandatory": 1}],
                "sku": [{"name": "color_family", "is_mandatory": 1}],
                "public": [],
                "logics": [],
            },
        }
        material["attributes"] = {"brand": "No Brand"}
        material["variants"][0].update({
            "product_sku_id": "product-sku-1",
            "properties": [{"name": "color_family", "value": "Black"}],
            "images": ["https://img.example.test/gan65-black.jpg"],
            "warehouse_stock": [{"warehouse_name": "TH", "stock": 20}],
        })

        draft = self.manager.create(material, SHOPS)
        validation = self.manager.validate(draft["id"])

        self.assertTrue(validation["valid"])
        self.assertEqual(draft["extended"]["source_model_id"], "model-1")
        self.assertEqual(draft["variants"][0]["product_sku_id"], "product-sku-1")
        self.assertEqual(
            draft["variants"][0]["properties"][0]["name"],
            "color_family",
        )
        self.assertEqual(self.store.health()["schema_version"], "2")

    def test_category_contract_blocks_missing_required_field(self):
        material = valid_material()
        material["extended"] = {
            "category_schema": {
                "normal": [{"name": "material", "name_zh": "材质", "is_mandatory": 1}],
                "sku": [],
                "public": [],
                "logics": [],
            }
        }
        draft = self.manager.create(material, SHOPS)

        validation = self.manager.validate(draft["id"])

        self.assertFalse(validation["valid"])
        self.assertIn("材质", validation["issues"][0]["message"])
        with self.assertRaisesRegex(PublisherValidationError, "发布前字段未完成"):
            self.manager.save_to_mabang(FakePublisherClient(), draft["id"])


if __name__ == "__main__":
    unittest.main()
