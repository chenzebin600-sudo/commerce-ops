from datetime import datetime

import mabang_wps_sync as sync


TABLES = {}
INSERTED = {}
UPDATED = {}


class FakeRow(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class FakeSeries:
    def __init__(self, values):
        self.values = values

    def astype(self, _):
        return self

    @property
    def str(self):
        return self

    def strip(self):
        return FakeSeries([str(value).strip() for value in self.values])

    def __eq__(self, other):
        return [value == other for value in self.values]


class FakeILoc:
    def __init__(self, df):
        self.df = df

    def __getitem__(self, index):
        return FakeRow(self.df.rows[index])


class FakeDataFrame:
    def __init__(self, rows=None, index=None):
        self.rows = rows or []
        self.index = index or list(range(len(self.rows)))
        self.columns = list(self.rows[0].keys()) if self.rows else []
        self.empty = len(self.rows) == 0
        self.iloc = FakeILoc(self)

    def copy(self):
        return FakeDataFrame([dict(row) for row in self.rows], list(self.index))

    def iterrows(self):
        for record_id, row in zip(self.index, self.rows):
            yield record_id, FakeRow(row)

    def __getitem__(self, key):
        if isinstance(key, str):
            return FakeSeries([row.get(key, "") for row in self.rows])
        if isinstance(key, list) and all(isinstance(value, bool) for value in key):
            rows = [row for row, keep in zip(self.rows, key) if keep]
            index = [idx for idx, keep in zip(self.index, key) if keep]
            return FakeDataFrame(rows, index)
        return FakeDataFrame([{column: row.get(column, "") for column in key} for row in self.rows], list(self.index))


def dbt(field=None, sheet_name="", book_url=""):
    df = TABLES.get(sheet_name, FakeDataFrame())
    if field is None:
        return df.copy()
    if isinstance(field, str):
        field = [field]
    return df[field].copy()


def insert_dbt(data, sheet_name="", new_sheet=False):
    INSERTED.setdefault(sheet_name, []).extend(data)


def update_dbt(data, sheet_name=""):
    UPDATED.setdefault(sheet_name, []).extend(data)


sync.dbt = dbt
sync.insert_dbt = insert_dbt
sync.update_dbt = update_dbt


def reset_tables():
    TABLES.clear()
    INSERTED.clear()
    UPDATED.clear()


def test_auto_date_range():
    assert sync.get_month_start_to_yesterday(datetime(2026, 7, 2, 10, 0, 0)) == (
        "2026-07-01 00:00:00",
        "2026-07-01 23:59:59",
    )
    assert sync.get_month_start_to_yesterday(datetime(2026, 6, 21, 10, 0, 0)) == (
        "2026-06-01 00:00:00",
        "2026-06-20 23:59:59",
    )
    assert sync.get_month_start_to_yesterday(datetime(2026, 7, 19, 10, 0, 0)) == (
        "2026-07-01 00:00:00",
        "2026-07-18 23:59:59",
    )

    try:
        sync.get_month_start_to_yesterday(datetime(2026, 8, 1, 10, 0, 0))
    except Exception as e:
        assert "本月1号" in str(e)
    else:
        raise AssertionError("每月1号自动模式应停止执行")


def test_transform_orders_to_rows():
    shop_map = FakeDataFrame([{"店铺名": "Suminoe TH", "店长": "张三"}])
    orders = [
        {
            "平台订单号": "1112481158296587",
            "店铺名称": "Suminoe TH",
            "订单状态": "已发货",
            "仓库": "泰国仓",
            "付款方式": "PROMPTPAY",
            "付款时间": "2026/06/28",
            "订单核算金额": "300",
            "商品明细": [
                {
                    "SKU": "T5FF1951736",
                    "平台SKU": "T5FF1951736",
                    "商品数量": 1,
                    "商品中文名称": "6J-折叠椅",
                },
                {
                    "SKU": "T4FF2162762",
                    "平台SKU": "T4FF2162762",
                    "商品数量": 2,
                    "商品中文名称": "6X-咖色长凳",
                },
            ],
        }
    ]

    rows = sync.transform_orders_to_wps_rows(orders, shop_map)
    assert len(rows) == 2
    assert rows[0]["唯一键"] == "1112481158296587_T5FF1951736_T5FF1951736"
    assert rows[0]["店长"] == "张三"
    assert rows[0]["订单核算金额"] == 100.0
    assert rows[1]["订单核算金额"] == 200.0
    assert rows[0]["是否测评"] == "否"


def test_upsert_rows_splits_insert_and_update():
    reset_tables()
    TABLES["马帮数据"] = FakeDataFrame(
        [{"唯一键": "old_key", "交易编号": "old_trade"}],
        index=[42],
    )

    wps = sync.WPSAdapter()
    result = wps.upsert_rows(
        "马帮数据",
        [
            {"唯一键": "old_key", "交易编号": "old_trade", "SKU": "A"},
            {"唯一键": "new_key", "交易编号": "new_trade", "SKU": "B"},
        ],
    )

    assert result == {"insert": 1, "update": 1}
    assert INSERTED["马帮数据"][0]["唯一键"] == "new_key"
    assert UPDATED["马帮数据"][0]["_record_id"] == 42


if __name__ == "__main__":
    test_auto_date_range()
    test_transform_orders_to_rows()
    test_upsert_rows_splits_insert_and_update()
    print("所有本地自测通过")
