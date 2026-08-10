import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from mabang_worker import normalize_order_filters


class MabangOrderFilterTests(unittest.TestCase):
    def test_more_than_one_hundred_shop_values_are_not_silently_truncated(self):
        shops = [f"Shop {index:03d}" for index in range(142)]

        conditions = normalize_order_filters({
            "orderFilters": {
                "conditions": [{
                    "field": "店铺名",
                    "operator": "equals",
                    "values": shops,
                }],
            },
        })

        self.assertEqual(conditions[0]["values"], shops)
        self.assertEqual(conditions[0]["values"][-1], "Shop 141")

    def test_filter_value_limit_fails_explicitly_instead_of_dropping_values(self):
        shops = [f"Shop {index:03d}" for index in range(501)]

        with self.assertRaisesRegex(ValueError, "最多支持 500 个值"):
            normalize_order_filters({
                "orderFilters": {
                    "conditions": [{
                        "field": "店铺名",
                        "operator": "equals",
                        "values": shops,
                    }],
                },
            })


if __name__ == "__main__":
    unittest.main()
