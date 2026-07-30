# -*- coding: utf-8 -*-

import importlib.util
from decimal import Decimal
from pathlib import Path
import sys
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATH = PROJECT_ROOT / "scripts" / "mabang_order_source.py"
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))
import mabang_worker as web_worker

SPEC = importlib.util.spec_from_file_location("web_mabang_order_source", SOURCE_PATH)
web_orders = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(web_orders)


class MabangWebOrderAmountContractTests(unittest.TestCase):
    def test_worker_recognizes_all_json_missing_value_shapes(self):
        self.assertTrue(web_worker.is_missing_source_value(None))
        self.assertTrue(web_worker.is_missing_source_value(""))
        self.assertTrue(web_worker.is_missing_source_value(float("nan")))
        self.assertTrue(web_worker.is_missing_source_value(Decimal("NaN")))
        self.assertFalse(web_worker.is_missing_source_value(0))

    def test_nan_is_normalized_to_missing_instead_of_leaking_into_json(self):
        self.assertEqual(web_orders.to_number(float("nan")), "")

    def test_missing_original_item_amount_is_preserved_when_source_evidence_is_nonzero(self):
        raw_record = {
            "订单编号": "ORDER-1",
            "交易编号": "TRADE-1",
            "SKU": "SKU-1",
            "商品数量": "1",
            "原始商品销售单价": "105.5881",
            "商品总金额": "407.6853",
            "原始商品总金额": float("nan"),
            "订单原始总金额": "4093",
            "订单总金额": "451.11",
            "订单核算金额（原始货币）": "3943",
        }

        normalized = web_orders.normalize_numeric_fields(raw_record)

        self.assertEqual(normalized["原始商品总金额"], "")
        web_orders.validate_amount_values([normalized])

    def test_missing_required_item_amount_still_blocks_web_collection(self):
        record = {
            "订单编号": "ORDER-2",
            "交易编号": "TRADE-2",
            "SKU": "SKU-2",
            "商品总金额": "",
            "原始商品总金额": "",
        }

        with self.assertRaises(Exception):
            web_orders.validate_amount_values([record])


if __name__ == "__main__":
    unittest.main()
