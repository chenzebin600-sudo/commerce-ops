import copy
import unittest
from unittest.mock import patch

import mabang_listing_service as service


class InventorySyncPreviewTests(unittest.TestCase):
    def tearDown(self):
        with service.STATE_LOCK:
            service.PREVIEWS.clear()

    def test_stock_target_zero_remains_a_valid_numeric_operation(self):
        operations = service._validate_operations([
            {"field": "stock", "mode": "set", "value": 0}
        ])
        self.assertEqual(operations[0]["value"], "0")
        self.assertEqual(
            service._calculate_new_value(12, operations[0]),
            0,
        )

    def test_duplicate_seller_sku_is_scoped_by_variation_id(self):
        detail = {
            "variations": [
                {"variation_id": "v1", "sku": "SKU-DUP", "stock": 5},
                {"variation_id": "v2", "sku": "SKU-DUP", "stock": 5},
            ]
        }
        matched = service._matched_variations(detail, "SKU-DUP", "v2")
        self.assertEqual([item["variation_id"] for item in matched], ["v2"])

    def test_multi_warehouse_single_mode_uses_current_largest_warehouse(self):
        variation = {
            "sku": "SKU-A",
            "warehouse_stock": [
                {"warehouse_id": "w1", "stock": 3},
                {"warehouse_id": "w2", "stock": 7},
            ],
        }
        result = service._distributed_warehouse_stocks(
            variation,
            12,
            "single_largest",
        )
        self.assertEqual([item[2] for item in result], [0, 12])

    def test_multi_warehouse_proportional_mode_preserves_sum_and_ratio(self):
        variation = {
            "sku": "SKU-A",
            "warehouse_stock": [
                {"warehouse_id": "w1", "stock": 1},
                {"warehouse_id": "w2", "stock": 2},
                {"warehouse_id": "w3", "stock": 3},
            ],
        }
        result = service._distributed_warehouse_stocks(
            variation,
            11,
            "proportional",
        )
        targets = [item[2] for item in result]
        self.assertEqual(targets, [2, 4, 5])
        self.assertEqual(sum(targets), 11)

    def test_multi_warehouse_zero_target_clears_every_warehouse(self):
        variation = {
            "sku": "SKU-A",
            "warehouse_stock": [
                {"warehouse_id": "w1", "stock": 0},
                {"warehouse_id": "w2", "stock": 0},
            ],
        }
        result = service._distributed_warehouse_stocks(
            variation,
            0,
            "proportional",
        )
        self.assertEqual([item[2] for item in result], [0, 0])

    def test_proportional_mode_blocks_when_every_warehouse_is_empty(self):
        variation = {
            "sku": "SKU-A",
            "warehouse_stock": [
                {"warehouse_id": "w1", "stock": 0},
                {"warehouse_id": "w2", "stock": 0},
            ],
        }
        with self.assertRaises(service.MabangListingError):
            service._distributed_warehouse_stocks(
                variation,
                8,
                "proportional",
            )

    def test_merges_exact_per_sku_targets_into_one_single_use_preview(self):
        counter = {"value": 0}

        def fake_create_preview(payload, **_kwargs):
            counter["value"] += 1
            token = f"child-{counter['value']}"
            target = copy.deepcopy(payload["targets"][0])
            seller_sku = payload["match_sku"]
            change = {
                "change_id": f"change-{counter['value']}",
                "platform": "shopee",
                "internal_id": target["internal_id"],
                "product_id": target["product_id"],
                "variation_key": payload.get("match_variation_id") or seller_sku,
                "sku_id": payload.get("match_variation_id") or seller_sku,
                "sku": seller_sku,
                "requested_sku": seller_sku,
                "matched_sku": seller_sku,
                "sku_match_type": "exact",
                "virtual_suffix": "",
                "field": "stock",
                "old_value": 1,
                "new_value": payload["operations"][0]["value"],
            }
            with service.STATE_LOCK:
                service.PREVIEWS[token] = {
                    "preview_token": token,
                    "targets": [target],
                    "changes": [change],
                    "warnings": [],
                }
            return {"preview_token": token}

        items = [
            {"platform": "shopee", "shop_id": "s1", "internal_id": "p1", "product_id": "x1", "variation_id": "v1", "seller_sku": "SKU-DUP", "target_stock": 4},
            {"platform": "shopee", "shop_id": "s1", "internal_id": "p1", "product_id": "x1", "variation_id": "v2", "seller_sku": "SKU-DUP", "target_stock": 5},
        ]
        with patch.object(service, "create_preview", side_effect=fake_create_preview), patch.object(
            service,
            "_prefetch_inventory_details",
            return_value={},
        ) as prefetch:
            result = service.create_inventory_sync_preview({"items": items})

        self.assertEqual(result["change_count"], 2)
        self.assertEqual(result["target_count"], 1)
        self.assertEqual([item["new_value"] for item in result["changes"]], [4, 5])
        self.assertEqual([item["variation_key"] for item in result["changes"]], ["v1", "v2"])
        self.assertEqual(len(prefetch.call_args.args[0]), 1)
        with service.STATE_LOCK:
            self.assertIn(result["preview_token"], service.PREVIEWS)
            self.assertNotIn("child-1", service.PREVIEWS)
            self.assertNotIn("child-2", service.PREVIEWS)

    def test_inventory_sync_preview_accepts_lazada_and_preserves_platform(self):
        def fake_create_preview(payload, **_kwargs):
            token = "lazada-child"
            target = copy.deepcopy(payload["targets"][0])
            change = {
                "change_id": "lazada-change",
                "platform": target["platform"],
                "internal_id": target["internal_id"],
                "product_id": target["product_id"],
                "variation_key": payload["match_variation_id"],
                "sku_id": payload["match_variation_id"],
                "sku": payload["match_sku"],
                "requested_sku": payload["match_sku"],
                "matched_sku": payload["match_sku"],
                "sku_match_type": "exact",
                "virtual_suffix": "",
                "field": "stock",
                "old_value": 1,
                "new_value": payload["operations"][0]["value"],
            }
            with service.STATE_LOCK:
                service.PREVIEWS[token] = {
                    "preview_token": token,
                    "targets": [target],
                    "changes": [change],
                    "warnings": [],
                }
            return {"preview_token": token}

        items = [{
            "platform": "lazada",
            "shop_id": "s1",
            "internal_id": "p1",
            "product_id": "x1",
            "variation_id": "v1",
            "seller_sku": "SKU-1",
            "target_stock": 70,
        }]
        with patch.object(service, "create_preview", side_effect=fake_create_preview), patch.object(
            service,
            "_prefetch_inventory_details",
            return_value={},
        ):
            result = service.create_inventory_sync_preview({"items": items})

        self.assertEqual(result["changes"][0]["platform"], "lazada")
        with service.STATE_LOCK:
            self.assertEqual(service.PREVIEWS[result["preview_token"]]["targets"][0]["platform"], "lazada")

    def test_merges_exact_sku_replacements_into_one_single_use_preview(self):
        counter = {"value": 0}

        def fake_create_preview(payload):
            counter["value"] += 1
            token = f"rebind-child-{counter['value']}"
            target = copy.deepcopy(payload["targets"][0])
            from_sku = payload["match_sku"]
            to_sku = payload["operations"][0]["value"]
            change = {
                "change_id": f"rebind-change-{counter['value']}",
                "platform": "shopee",
                "internal_id": target["internal_id"],
                "product_id": target["product_id"],
                "variation_key": from_sku,
                "sku_id": from_sku,
                "sku": from_sku,
                "requested_sku": from_sku,
                "matched_sku": from_sku,
                "sku_match_type": "exact",
                "virtual_suffix": "",
                "field": "sku",
                "old_value": from_sku,
                "new_value": to_sku,
            }
            with service.STATE_LOCK:
                service.PREVIEWS[token] = {
                    "preview_token": token,
                    "targets": [target],
                    "changes": [change],
                    "warnings": [],
                }
            return {"preview_token": token}

        items = [
            {"platform": "shopee", "shop_id": "s1", "internal_id": "p1", "product_id": "x1", "from_sku": "T3AA2123973", "to_sku": "T5AA3483973"},
            {"platform": "shopee", "shop_id": "s1", "internal_id": "p1", "product_id": "x1", "from_sku": "T3BB2123974", "to_sku": "T5BB3483974"},
        ]
        with patch.object(service, "create_preview", side_effect=fake_create_preview):
            result = service.create_sku_rebind_preview({"items": items})

        self.assertEqual(result["change_count"], 2)
        self.assertEqual([item["new_value"] for item in result["changes"]], ["T5AA3483973", "T5BB3483974"])
        with service.STATE_LOCK:
            self.assertIn(result["preview_token"], service.PREVIEWS)
            self.assertNotIn("rebind-child-1", service.PREVIEWS)
            self.assertNotIn("rebind-child-2", service.PREVIEWS)


if __name__ == "__main__":
    unittest.main()
