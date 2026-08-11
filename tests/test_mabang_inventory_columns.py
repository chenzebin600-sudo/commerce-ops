import unittest
import json
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from scripts import mabang_inventory_source as runtime_inventory


ROOT = Path(__file__).resolve().parents[1]
INTEGRATION_SOURCE = ROOT / "integrations" / "mabang-getdata" / "mabang_inventory_stock_query.py"


class MabangInventoryColumnTests(unittest.TestCase):
    def test_permission_dependent_columns_are_optional(self):
        dataframe = pd.DataFrame([
            {"库存SKU编号": "SKU-1", "仓库": "A仓", "可用库存量": "12"},
        ])

        records = runtime_inventory.normalize_inventory_dataframe(dataframe)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["库存SKU编号"], "SKU-1")
        self.assertEqual(records[0]["可用库存量"], 12)
        self.assertEqual(records[0]["商品备注"], "")
        self.assertEqual(set(records[0]), set(runtime_inventory.TARGET_FIELDS))

    def test_only_inventory_sync_core_columns_are_required(self):
        with self.assertRaisesRegex(Exception, "缺少库存同步必填字段：可用库存量"):
            runtime_inventory.normalize_inventory_dataframe(pd.DataFrame([
                {"库存SKU编号": "SKU-1", "仓库": "A仓"},
            ]))

    def test_header_surrounding_whitespace_is_normalized(self):
        dataframe = pd.DataFrame([
            {" 库存SKU编号 ": "SKU-1", " 仓库": "A仓", "可用库存量 ": 3},
        ])

        records = runtime_inventory.normalize_inventory_dataframe(dataframe)
        self.assertEqual(records[0]["可用库存量"], 3)

    def test_export_integrity_uses_raw_excel_rows_not_filtered_records(self):
        dataframe = pd.DataFrame([
            {"库存SKU编号": "SKU-1", "仓库": "A仓", "可用库存量": 5},
            {"库存SKU编号": "", "仓库": "A仓", "可用库存量": 0},
        ])
        client = runtime_inventory.MabangInventoryClient()
        client.download_export_file = lambda _page=None: b"xlsx"

        with patch.object(runtime_inventory, "read_excel_content", return_value=dataframe):
            records = client.export_inventory_records(2)

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["库存SKU编号"], "SKU-1")

    def test_scoped_inventory_search_uses_the_actual_checkbox_contract(self):
        client = runtime_inventory.MabangInventoryClient()
        params = client.build_default_search_params(["101", "102"])
        self.assertEqual(params["warehouseIds[]"], ["101", "102"])
        self.assertEqual(params["warehouseIdStr"], "101,102")
        self.assertEqual(params["warehouseId"], "")

    def test_warehouse_scope_resolves_names_to_visible_ids_and_fails_closed(self):
        catalog = {"options": [{"id": "101", "name": "马来 A 仓"}, {"id": "102", "name": "马来 B 仓"}]}
        self.assertEqual(runtime_inventory.resolve_inventory_warehouse_scope(catalog, ["马来 B 仓"]), ["102"])
        with self.assertRaisesRegex(Exception, "当前马帮账号看不到已绑定仓库"):
            runtime_inventory.resolve_inventory_warehouse_scope(catalog, ["菲律宾仓"])

    def test_integration_copy_keeps_the_same_required_column_contract(self):
        source = INTEGRATION_SOURCE.read_text(encoding="utf-8")
        self.assertIn('REQUIRED_FIELDS = [\n    "库存SKU编号",\n    "仓库",\n    "可用库存量",\n]', source)
        self.assertIn("missing = [field for field in REQUIRED_FIELDS if field not in columns]", source)

    def test_warehouse_catalog_parser_reads_permission_visible_selects(self):
        catalog = runtime_inventory.parse_inventory_warehouse_catalog("""
            <form>
              <select id="warehouseId" name="warehouseId">
                <option value="">全部仓库</option>
                <option value="101">马来 A 仓</option>
                <option value="102">马来 B 仓</option>
              </select>
              <input type="hidden" name="warehouseIdArr" value="">
              <select name="status"><option value="1">正常</option></select>
            </form>
        """)
        self.assertEqual(catalog["options"], [
            {"id": "101", "name": "马来 A 仓"},
            {"id": "102", "name": "马来 B 仓"},
        ])
        self.assertTrue(catalog["supportsWarehouseId"])
        self.assertTrue(catalog["supportsWarehouseIdArr"])
        self.assertEqual(catalog["candidateSelectCount"], 1)
        self.assertIn("warehouseId", catalog["fieldNames"])

    def test_warehouse_catalog_diagnostics_are_bounded_and_drop_secrets(self):
        catalog = runtime_inventory.parse_inventory_warehouse_catalog("""
          <label><input type="checkbox" name="warehouseIds[]" class="warehouse-picker" value="101">马来 A 仓</label>
          <script>
            const endpoint = "index.php?mod=warehouse.getWarehouseList";
            const ignored = "index.php?mod=warehouse.list&token=secret";
            const ignoredToo = "index.php?mod=warehouse.list&cMKey=secret";
          </script>
        """)
        self.assertEqual(catalog["candidateElements"][0]["name"], "warehouseIds[]")
        self.assertTrue(catalog["candidateElements"][0]["hasValue"])
        self.assertEqual(catalog["endpointCandidates"], ["index.php?mod=warehouse.getWarehouseList"])
        self.assertEqual(catalog["options"], [{"id": "101", "name": "马来 A 仓"}])
        self.assertTrue(catalog["supportsWarehouseIdsArray"])

    def test_page_contract_shape_never_returns_business_or_secret_values(self):
        shape = runtime_inventory.describe_response_structure({
            "success": True,
            "token": "must-not-leak",
            "pageHtml": "<table><tr><th>库存SKU编号</th><th>可用库存量</th></tr><tr><td>SECRET-SKU</td><td>99</td></tr></table>",
            "rows": [{"sku": "SECRET-SKU", "quantity": 99}],
        })
        serialized = json.dumps(shape, ensure_ascii=False)
        self.assertNotIn("must-not-leak", serialized)
        self.assertNotIn("SECRET-SKU", serialized)
        self.assertNotIn('"quantity": 99', serialized)
        self.assertEqual(shape["omittedSensitiveKeyCount"], 1)
        self.assertEqual(shape["children"]["pageHtml"]["htmlRowCount"], 2)
        self.assertTrue(shape["children"]["pageHtml"]["hasInventorySkuLabel"])
        self.assertEqual(shape["children"]["rows"]["length"], 1)
        self.assertIn("sku", shape["children"]["rows"]["item"]["children"])

    def test_html_table_contract_returns_headers_and_counts_without_row_values(self):
        contracts = runtime_inventory.describe_html_table_contracts("""
          <table><tr><th>库存SKU编号</th><th>可用库存量</th></tr>
          <tr><td>SECRET-SKU</td><td>99</td></tr></table>
        """)
        self.assertEqual(contracts[0]["rowCount"], 2)
        self.assertEqual(contracts[0]["cellCount"], 4)
        self.assertEqual(contracts[0]["headerLabels"], ["库存SKU编号", "可用库存量"])
        self.assertNotIn("SECRET-SKU", json.dumps(contracts, ensure_ascii=False))

    def test_inventory_search_html_rows_preserve_column_token_order(self):
        rows = runtime_inventory.parse_inventory_search_html_rows("""
          <ul><li class="thumb">图</li><li class="pct30 skulabel"><p>SKU-100</p><p>中文名称</p></li>
          <li>父仓</li><li class="warehouseIds" data-id="9">A仓</li><li>A-01</li><li>7 / 28 / 42</li>
          <li><span>12</span><br><span>9</span><br><span>3.5</span></li><li>0</li><li>0</li><li>2026-08-01</li></ul>
        """)
        self.assertEqual(len(rows), 1)
        self.assertEqual(len(rows[0]), 10)
        self.assertEqual(rows[0][1]["texts"], ["SKU-100", "中文名称"])
        self.assertEqual(rows[0][3]["attributes"]["data-id"], "9")
        self.assertEqual(rows[0][6]["texts"], ["12", "9", "3.5"])
        shape = runtime_inventory.describe_inventory_search_row_tokens("<ul><li>SKU-100</li><li>12</li></ul>")
        self.assertEqual(shape[0]["tokenTypes"], ["identifier"])
        self.assertNotIn("SKU-100", json.dumps(shape, ensure_ascii=False))

    def test_scoped_full_inventory_uses_html_source_and_keeps_chinese_name(self):
        self.assertTrue(runtime_inventory.should_use_html_inventory_source(
            compact=False,
            requested_warehouse_names=["A仓"],
        ))
        records = runtime_inventory.parse_inventory_search_records("""
          <ul><li class="thumb">图</li><li class="pct30 skulabel"><p>SKU-100</p><p>人体工学椅 白色 3层</p></li>
          <li>父仓</li><li class="warehouseIds" data-id="9">A仓</li><li>A-01</li><li>7 / 28 / 42</li>
          <li><span>12</span><br><span>9</span><br><span>3.5</span></li><li>0</li><li>0</li><li>2026-08-01</li></ul>
        """)
        self.assertEqual(records, [{
            "库存SKU编号": "SKU-100",
            "中文名称": "人体工学椅 白色 3层",
            "名称来源": "inventory_search_sku_cell",
            "名称置信度": "VERIFIED",
            "商品状态": "",
            "仓库": "A仓",
            "可用库存量": 9,
        }])

    def test_inventory_sales_state_is_never_used_as_chinese_name(self):
        records = runtime_inventory.parse_inventory_search_records("""
          <ul><li class="thumb">图</li><li class="pct30 skulabel"><p>T3AA1353145</p><p>正常销售</p></li>
          <li>父仓</li><li class="warehouseIds" data-id="9">A仓</li><li>A-01</li><li>7 / 28 / 42</li>
          <li><span>12</span><br><span>9</span><br><span>3.5</span></li><li>0</li><li>0</li><li>2026-08-01</li></ul>
        """)
        self.assertEqual(records[0]["中文名称"], "")
        self.assertEqual(records[0]["名称置信度"], "MISSING")
        self.assertEqual(records[0]["商品状态"], "正常销售")

    def test_inventory_name_can_follow_an_explicit_sales_state_token(self):
        records = runtime_inventory.parse_inventory_search_records("""
          <ul><li>图</li><li class="skulabel"><p>SKU-100</p><p>正常销售</p><p>人体工学椅 白色 3层</p></li>
          <li>父仓</li><li data-id="9">A仓</li><li>A-01</li><li>7 / 28 / 42</li>
          <li><span>12</span><span>9</span></li><li>0</li><li>0</li><li>2026-08-01</li></ul>
        """)
        self.assertEqual(records[0]["中文名称"], "人体工学椅 白色 3层")
        self.assertEqual(records[0]["名称置信度"], "VERIFIED")
        self.assertEqual(records[0]["商品状态"], "正常销售")


if __name__ == "__main__":
    unittest.main()
