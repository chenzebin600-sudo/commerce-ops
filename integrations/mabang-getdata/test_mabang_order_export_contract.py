# -*- coding: utf-8 -*-

import unittest

import mabang_sync_no_delete as mabang


class FakeJsonResponse:
    def json(self):
        return {
            "success": True,
            "success_type": 1,
            "file_url": "https://example.invalid/orders.xlsx",
        }


class MabangOrderExportContractTests(unittest.TestCase):
    def test_export_keeps_common_and_multi_product_fields_unmerged(self):
        client = mabang.MabangClient()
        captured = {}

        client.open_export_template = lambda _order_ids: None
        client.get_export_iframe_template = lambda: (
            [("订单编号", "uq101"), ("原始商品总金额", "uq146")],
            "test-version",
        )
        client.download_excel_records = lambda _file_url: []

        def fake_post(_url, **kwargs):
            captured["payload"] = list(kwargs["data"])
            return FakeJsonResponse()

        client.session.post = fake_post
        client.export_batch_to_records(["ORDER-1"])

        payload = captured["payload"]
        self.assertIn(("hbddgyxx", "2"), payload)
        self.assertNotIn(("hbddgyxx", "1"), payload)
        self.assertFalse(any(key == "mergeShow" for key, _value in payload))

    def test_zero_amount_is_valid_but_blank_amount_remains_blocked(self):
        valid_record = {
            "订单编号": "ORDER-1",
            "交易编号": "TRADE-1",
            "SKU": "SKU-1",
            "商品总金额": 0,
            "原始商品总金额": 0.0,
        }
        mabang.validate_amount_values([valid_record])

        invalid_record = {
            **valid_record,
            "原始商品总金额": "",
        }
        with self.assertRaises(Exception):
            mabang.validate_amount_values([invalid_record])

    def test_split_order_blank_original_amount_is_zero_only_with_full_evidence(self):
        raw_record = {
            "订单编号": "20215555961095529827644658_2",
            "交易编号": "1095529827644658",
            "SKU": "T4FF1961895",
            "原始商品销售单价": "0.0000",
            "商品总金额": "0.0000",
            "原始商品总金额": "",
            "订单原始总金额": "0",
            "订单总金额": "0",
            "订单核算金额（原始货币）": "0.0000",
            "实付金额": "1867.1600000",
        }

        normalized = mabang.normalize_numeric_fields(raw_record)

        self.assertEqual(normalized["原始商品总金额"], 0.0)
        mabang.validate_amount_values([normalized])

    def test_split_order_blank_original_amount_stays_blocked_without_full_evidence(self):
        raw_record = {
            "订单编号": "ORDER-2_1",
            "交易编号": "TRADE-2",
            "SKU": "SKU-2",
            "原始商品销售单价": "10.0000",
            "商品总金额": "0.0000",
            "原始商品总金额": "",
            "订单原始总金额": "0",
            "订单总金额": "0",
            "订单核算金额（原始货币）": "0.0000",
        }

        normalized = mabang.normalize_numeric_fields(raw_record)

        self.assertEqual(normalized["原始商品总金额"], "")
        with self.assertRaises(Exception):
            mabang.validate_amount_values([normalized])


if __name__ == "__main__":
    unittest.main()
