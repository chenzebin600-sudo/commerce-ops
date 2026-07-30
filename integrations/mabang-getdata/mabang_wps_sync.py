"""
马帮 ERP -> WPS 多维表订单同步脚本

使用方式：
1. 将本文件内容复制到 WPS 多维表 PY 脚本中运行；
2. 确保 WPS 中存在【同步配置】表和【马帮数据】表；
3. 如果使用 Cookie 模式，在【同步配置】表填写 Cookie；
4. 如果需要网页登录模式，请先抓包确认下方 MABANG_* URL 和参数。

安全说明：
- 不要把账号、密码、Cookie 写死在本文件；
- 日志不会打印密码或完整 Cookie；
- 遇到验证码、短信、扫码、风控验证时，脚本会停止，不会尝试绕过。
"""

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import json
import os
import re
import time


# =========================
# 马帮网页端接口配置
# =========================
# 这些 URL 必须根据浏览器开发者工具抓包结果填写。
MABANG_LOGIN_URL = "待抓包确认"
MABANG_CHECK_LOGIN_URL = "待抓包确认"
MABANG_ORDER_LIST_URL = "待抓包确认"
MABANG_ORDER_DETAIL_URL = "待抓包确认"

# 如果公司已准备外部中转服务，可在【同步配置】表增加字段：
# 外部接口地址，例如：https://your-domain.example.com/sync-mabang-orders
DEFAULT_EXTERNAL_SERVER_URL = ""

CONFIG_TABLE = "同步配置"
TARGET_TABLE = "马帮数据"
SHOP_MAP_TABLE = "店铺映射表"

DATE_MODE_AUTO = ("自动当月截至昨日", "自动", "当月截至昨日")
DATE_MODE_MANUAL = ("手动日期", "手动")
LOGIN_MODE_ACCOUNT = ("账号密码", "账号", "密码", "username_password")
LOGIN_MODE_COOKIE = ("Cookie", "cookie")
LOGIN_MODE_EXTERNAL = ("外部服务器", "外部接口", "服务器", "server", "external")

TARGET_FIELDS = [
    "唯一键",
    "交易编号",
    "店铺名",
    "店长",
    "订单状态",
    "仓库",
    "SKU",
    "商品数量",
    "商品中文名称",
    "付款方式",
    "订单核算金额",
    "付款时间",
    "平台SKU",
    "是否测评",
]


# =========================
# 通用工具函数
# =========================
def log(message):
    print(message)


def is_blank(value):
    if value is None:
        return True
    text = str(value).strip()
    return text == "" or text.lower() in ("nan", "none", "null")


def safe_str(value, default=""):
    if is_blank(value):
        return default
    return str(value).strip()


def normalize_mode(value):
    return safe_str(value).replace(" ", "").replace("\u3000", "")


def mask_secret(value, keep_head=4, keep_tail=4):
    text = safe_str(value)
    if not text:
        return ""
    if len(text) <= keep_head + keep_tail:
        return "***"
    return text[:keep_head] + "***" + text[-keep_tail:]


def normalize_datetime(value):
    """
    将 WPS 单元格、字符串、datetime 等值统一为 YYYY-mm-dd HH:MM:SS。
    """
    if is_blank(value):
        return ""

    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")

    text = str(value).strip()
    text = text.replace("/", "-")
    text = re.sub(r"\s+", " ", text)

    # WPS / pandas 可能把日期读成 2026-07-01 00:00:00.000000
    text = re.sub(r"(\d{2}:\d{2}:\d{2})\.\d+$", r"\1", text)

    formats = [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%d",
        "%Y.%m.%d %H:%M:%S",
        "%Y.%m.%d",
    ]
    for fmt in formats:
        try:
            dt = datetime.strptime(text, fmt)
            if fmt in ("%Y-%m-%d", "%Y.%m.%d"):
                dt = datetime(dt.year, dt.month, dt.day, 0, 0, 0)
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            pass

    raise Exception("无法识别日期时间格式：{}".format(text))


def to_int(value, default=0):
    if is_blank(value):
        return default
    try:
        return int(Decimal(str(value).strip()))
    except Exception:
        return default


def to_decimal(value, default=Decimal("0")):
    if is_blank(value):
        return default
    text = str(value).strip()
    text = text.replace(",", "")
    text = re.sub(r"[^\d\.\-]", "", text)
    if text in ("", "-", ".", "-."):
        return default
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return default


def decimal_to_number(value):
    if not isinstance(value, Decimal):
        value = to_decimal(value)
    value = value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return float(value)


def get_month_start_to_yesterday(now=None):
    """
    自动获取：当月1号 00:00:00 到 昨天 23:59:59
    """
    if now is None:
        now = datetime.now()

    today = now.date()

    if today.day == 1:
        raise Exception(
            "当前为本月1号，自动日期模式下暂无当月可同步数据。如需同步历史月份，请切换为手动日期模式。"
        )

    month_start = today.replace(day=1)

    paid_start = datetime(
        year=month_start.year,
        month=month_start.month,
        day=month_start.day,
        hour=0,
        minute=0,
        second=0,
    )

    yesterday = today - timedelta(days=1)

    paid_end = datetime(
        year=yesterday.year,
        month=yesterday.month,
        day=yesterday.day,
        hour=23,
        minute=59,
        second=59,
    )

    return (
        paid_start.strftime("%Y-%m-%d %H:%M:%S"),
        paid_end.strftime("%Y-%m-%d %H:%M:%S"),
    )


def ensure_required(value, message):
    if is_blank(value):
        raise Exception(message)
    return value


def read_secret_file(path="secrets.json"):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def get_config_secret(config, field_name, env_name=None, secret_name=None):
    value = config.get(field_name)
    if not is_blank(value):
        return safe_str(value)

    if env_name:
        value = os.environ.get(env_name)
        if not is_blank(value):
            return safe_str(value)

    if secret_name:
        secrets = read_secret_file()
        value = secrets.get(secret_name)
        if not is_blank(value):
            return safe_str(value)

    return ""


# =========================
# WPS 多维表适配器
# =========================
class WPSAdapter:
    def read_table(self, table_name, field=None):
        return dbt(field=field, sheet_name=table_name)

    def try_read_table(self, table_name):
        try:
            return dbt(sheet_name=table_name)
        except Exception:
            return None

    def insert_rows(self, table_name, rows):
        rows = self._clean_rows(rows)
        if not rows:
            return 0
        insert_dbt(rows, sheet_name=table_name)
        return len(rows)

    def update_rows(self, table_name, rows):
        if not rows:
            return 0

        last_error = None
        try:
            update_dbt(rows, sheet_name=table_name)
            return len(rows)
        except Exception as e:
            last_error = e

        # 部分 WPS 环境要求 DataFrame 保留原始 index 才能更新。
        try:
            import pandas as pd

            index_values = []
            clean_rows = []
            for row in rows:
                record_id = row.get("_record_id")
                if record_id is None:
                    record_id = row.get("__record_id")
                if record_id is None:
                    record_id = row.get("record_id")
                index_values.append(record_id)
                clean_rows.append(self._clean_row(row, keep_record_id=False))
            df = pd.DataFrame(clean_rows, index=index_values)
            update_dbt(df, sheet_name=table_name)
            return len(rows)
        except Exception as e:
            last_error = e

        raise Exception("WPS 更新失败，请确认 update_dbt 的记录 ID / index 规则：{}".format(last_error))

    def read_enabled_config(self, table_name=CONFIG_TABLE):
        df = dbt(sheet_name=table_name)
        if df is None or getattr(df, "empty", True):
            raise Exception("同步配置表为空，请先填写同步配置。")

        if "是否启用" not in df.columns:
            raise Exception("同步配置表缺少字段【是否启用】。")

        enabled_df = df[df["是否启用"].astype(str).str.strip() == "是"]
        if enabled_df.empty:
            raise Exception("未找到启用的同步配置，请检查【同步配置】表。")

        row = enabled_df.iloc[0].to_dict()
        row["_record_id"] = enabled_df.index[0]
        return row

    def update_config_result(self, record_id, message, table_name=CONFIG_TABLE):
        now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        rows = [
            {
                "_record_id": record_id,
                "运行结果": message,
                "最后运行时间": now_text,
            }
        ]
        return self.update_rows(table_name, rows)

    def upsert_rows(self, table_name, rows, unique_key_field="唯一键", write_mode="新增并更新"):
        rows = self._clean_rows(rows)
        if not rows:
            return {"insert": 0, "update": 0}

        target_df = self.try_read_table(table_name)
        existing_map = {}

        if (
            target_df is not None
            and not getattr(target_df, "empty", True)
            and unique_key_field in target_df.columns
        ):
            for record_id, old_row in target_df.iterrows():
                key = safe_str(old_row.get(unique_key_field))
                if key:
                    existing_map[key] = record_id

        insert_rows = []
        update_rows = []
        mode = normalize_mode(write_mode or "新增并更新")

        for row in rows:
            key = safe_str(row.get(unique_key_field))
            if not key:
                continue

            if key in existing_map:
                if mode in ("新增并更新", "更新并新增", "upsert"):
                    update_row = dict(row)
                    update_row["_record_id"] = existing_map[key]
                    update_rows.append(update_row)
            else:
                insert_rows.append(row)

        insert_count = self.insert_rows(table_name, insert_rows)
        update_count = self.update_rows(table_name, update_rows)

        return {"insert": insert_count, "update": update_count}

    def _clean_rows(self, rows):
        clean = []
        for row in rows or []:
            clean.append(self._clean_row(row, keep_record_id=True))
        return clean

    def _clean_row(self, row, keep_record_id=True):
        clean = {}
        for key, value in dict(row).items():
            if key in ("_record_id", "__record_id", "record_id") and not keep_record_id:
                continue
            clean[key] = "" if value is None else value
        return clean


# =========================
# 马帮客户端
# =========================
class MabangClient:
    def __init__(self, username=None, password=None, cookie=None, login_mode="账号密码"):
        self.username = safe_str(username)
        self.password = safe_str(password)
        self.cookie = safe_str(cookie)
        self.login_mode = normalize_mode(login_mode or "账号密码")
        self.session = None

    def _ensure_requests(self):
        try:
            import requests
        except Exception:
            raise Exception("当前 WPS PY 环境缺少 requests 库，无法访问马帮 ERP。")

        if self.session is None:
            self.session = requests.Session()
            self.session.headers.update(
                {
                    "User-Agent": (
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/120 Safari/537.36"
                    ),
                    "Accept": "application/json, text/javascript, */*; q=0.01",
                    "X-Requested-With": "XMLHttpRequest",
                }
            )
        return requests

    def login(self):
        self._ensure_requests()

        if self.login_mode in [normalize_mode(v) for v in LOGIN_MODE_COOKIE]:
            ensure_required(self.cookie, "Cookie 登录模式下，Cookie 不能为空。")
            self._load_cookie(self.cookie)
            log("[信息] 已写入 Cookie：{}".format(mask_secret(self.cookie, 8, 8)))
            return True

        if self.login_mode in [normalize_mode(v) for v in LOGIN_MODE_ACCOUNT]:
            ensure_required(self.username, "账号密码模式下，马帮账号不能为空。")
            ensure_required(self.password, "账号密码模式下，马帮密码不能为空。")
            return self._login_by_account()

        raise Exception("未知登录模式：{}".format(self.login_mode))

    def _load_cookie(self, cookie_text):
        for part in cookie_text.split(";"):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip()
            value = value.strip()
            if name:
                self.session.cookies.set(name, value)

    def _login_by_account(self):
        if self._url_not_ready(MABANG_LOGIN_URL):
            raise Exception("账号密码登录需要先抓包配置 MABANG_LOGIN_URL 和登录参数；如遇人工验证，请使用 Cookie 模式或申请官方 API。")

        resp = self.session.get(MABANG_LOGIN_URL, timeout=30)
        self._raise_if_human_verify(resp.text)

        hidden_payload = self._extract_hidden_inputs(resp.text)
        payload = dict(hidden_payload)
        # 下面字段名需要按实际马帮登录表单调整。
        payload.update(
            {
                "username": self.username,
                "password": self.password,
            }
        )

        resp = self.session.post(MABANG_LOGIN_URL, data=payload, timeout=30)
        self._raise_if_human_verify(resp.text)

        if not self._response_looks_success(resp):
            raise Exception("马帮登录失败，请检查账号密码、登录参数或是否触发人工验证。")

        return True

    def check_login(self):
        self._ensure_requests()
        if self._url_not_ready(MABANG_CHECK_LOGIN_URL):
            log("[提醒] MABANG_CHECK_LOGIN_URL 尚未配置，跳过登录态校验。")
            return True

        resp = self.session.get(MABANG_CHECK_LOGIN_URL, timeout=30)
        self._raise_if_human_verify(resp.text)
        if resp.status_code >= 400:
            raise Exception("马帮登录态校验失败，HTTP 状态码：{}".format(resp.status_code))

        text = resp.text or ""
        lowered = text.lower()
        if "login" in lowered or "登录" in text:
            raise Exception("马帮登录态已失效，请更新 Cookie 或重新登录。")
        return True

    def fetch_orders(
        self,
        paid_start,
        paid_end,
        status,
        shop_name=None,
        country=None,
        page_size=100,
        max_pages=100,
    ):
        ensure_required(status, "订单状态不能为空。")

        if self._url_not_ready(MABANG_ORDER_LIST_URL):
            raise Exception("马帮订单列表接口尚未配置，请先抓包确认 MABANG_ORDER_LIST_URL 和请求参数。")

        page_size = max(1, to_int(page_size, 100))
        max_pages = max(1, to_int(max_pages, 100))

        orders = []
        for page in range(1, max_pages + 1):
            payload = self._build_order_list_payload(
                paid_start=paid_start,
                paid_end=paid_end,
                status=status,
                shop_name=shop_name,
                country=country,
                page=page,
                page_size=page_size,
            )

            resp = self.session.post(MABANG_ORDER_LIST_URL, data=payload, timeout=60)
            self._raise_if_human_verify(resp.text)
            if resp.status_code >= 400:
                raise Exception("订单接口请求失败，HTTP 状态码：{}".format(resp.status_code))

            page_orders = self._parse_order_list_response(resp)
            log("[进度] 第 {} 页，{} 条".format(page, len(page_orders)))
            orders.extend(page_orders)

            if len(page_orders) < page_size:
                break
        else:
            log("[提醒] 分页达到最大页数 {}，已停止继续拉取。".format(max_pages))

        return orders

    def _build_order_list_payload(
        self, paid_start, paid_end, status, shop_name, country, page, page_size
    ):
        # 这里的参数名需要根据马帮订单列表真实请求调整。
        return {
            "page": page,
            "rows": page_size,
            "pageSize": page_size,
            "paidStartTime": paid_start,
            "paidEndTime": paid_end,
            "payTimeStart": paid_start,
            "payTimeEnd": paid_end,
            "orderStatus": status,
            "status": status,
            "shopName": safe_str(shop_name),
            "country": safe_str(country),
        }

    def _parse_order_list_response(self, resp):
        try:
            data = resp.json()
        except Exception:
            raise Exception("订单接口返回不是 JSON，可能登录失效或接口参数不正确。")

        if isinstance(data, list):
            return data

        if not isinstance(data, dict):
            raise Exception("订单接口返回结构异常。")

        success_value = data.get("success", data.get("status", data.get("code", True)))
        if str(success_value).lower() in ("false", "0", "fail", "failed", "error"):
            message = data.get("message") or data.get("msg") or data.get("error") or "未知错误"
            raise Exception("订单接口返回失败：{}".format(message))

        for key in ("data", "rows", "list", "orders", "result"):
            value = data.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                for sub_key in ("rows", "list", "orders", "data", "items"):
                    sub_value = value.get(sub_key)
                    if isinstance(sub_value, list):
                        return sub_value

        raise Exception("无法从订单接口返回中识别订单列表，请检查字段结构。")

    def _extract_hidden_inputs(self, html):
        result = {}
        for match in re.finditer(r'<input[^>]+type=["\']?hidden["\']?[^>]*>', html or "", re.I):
            tag = match.group(0)
            name_match = re.search(r'name=["\']([^"\']+)["\']', tag, re.I)
            value_match = re.search(r'value=["\']([^"\']*)["\']', tag, re.I)
            if name_match:
                result[name_match.group(1)] = value_match.group(1) if value_match else ""
        return result

    def _raise_if_human_verify(self, text):
        text = text or ""
        verify_words = ("验证码", "短信", "扫码", "二次验证", "安全验证", "风控", "captcha")
        lowered = text.lower()
        if any(word in text or word in lowered for word in verify_words):
            raise Exception("马帮登录需要人工验证，请使用 Cookie 模式或申请官方 API。")

    def _response_looks_success(self, resp):
        if resp.status_code >= 400:
            return False
        text = resp.text or ""
        lowered = text.lower()
        if "登录失败" in text or "password" in lowered and "error" in lowered:
            return False
        return True

    def _url_not_ready(self, url):
        return is_blank(url) or "待抓包确认" in str(url)


class ExternalMabangClient:
    def __init__(self, server_url):
        self.server_url = safe_str(server_url or DEFAULT_EXTERNAL_SERVER_URL)

    def login(self):
        ensure_required(self.server_url, "外部服务器模式下，外部接口地址不能为空。")
        return True

    def check_login(self):
        return True

    def fetch_orders(
        self,
        paid_start,
        paid_end,
        status,
        shop_name=None,
        country=None,
        page_size=100,
        max_pages=100,
    ):
        try:
            import requests
        except Exception:
            raise Exception("当前 WPS PY 环境缺少 requests 库，无法调用外部服务器接口。")

        payload = {
            "paid_start": paid_start,
            "paid_end": paid_end,
            "status": status,
            "shop_name": safe_str(shop_name),
            "country": safe_str(country),
            "page_size": page_size,
            "max_pages": max_pages,
        }
        resp = requests.post(self.server_url, json=payload, timeout=120)
        if resp.status_code >= 400:
            raise Exception("外部服务器接口请求失败，HTTP 状态码：{}".format(resp.status_code))

        try:
            data = resp.json()
        except Exception:
            raise Exception("外部服务器接口返回不是 JSON。")

        if not data.get("success", False):
            raise Exception(data.get("message") or data.get("error") or "外部服务器接口返回失败。")

        # 外部服务器可以直接返回 rows，也可以返回原始 orders。
        if isinstance(data.get("rows"), list):
            return [{"__already_wps_row__": True, **row} for row in data.get("rows")]

        if isinstance(data.get("orders"), list):
            return data.get("orders")

        raise Exception("外部服务器接口返回缺少 rows 或 orders。")


# =========================
# 订单转换
# =========================
def get_by_alias(data, aliases, default=""):
    if not isinstance(data, dict):
        return default
    for key in aliases:
        if key in data and not is_blank(data.get(key)):
            return data.get(key)
    return default


def get_items(order):
    item_aliases = [
        "sku明细",
        "SKU明细",
        "商品明细",
        "明细",
        "items",
        "itemList",
        "orderItems",
        "orderItemList",
        "skuList",
        "skus",
        "productList",
        "goodsList",
        "details",
        "detailList",
    ]
    for key in item_aliases:
        value = order.get(key) if isinstance(order, dict) else None
        if isinstance(value, list):
            return value
    return []


def build_shop_manager_map(shop_map_df):
    result = {}
    if shop_map_df is None or getattr(shop_map_df, "empty", True):
        return result
    if "店铺名" not in shop_map_df.columns or "店长" not in shop_map_df.columns:
        return result
    for _, row in shop_map_df.iterrows():
        shop = safe_str(row.get("店铺名"))
        manager = safe_str(row.get("店长"))
        if shop and shop not in result:
            result[shop] = manager
    return result


def make_unique_key(trade_no, sku, platform_sku):
    return "{}_{}_{}".format(safe_str(trade_no), safe_str(sku), safe_str(platform_sku))


def transform_orders_to_wps_rows(orders, shop_map_df=None):
    shop_manager_map = build_shop_manager_map(shop_map_df)
    rows = []

    for order in orders or []:
        if not isinstance(order, dict):
            continue

        if order.get("__already_wps_row__"):
            row = normalize_wps_row(order, shop_manager_map)
            rows.append(row)
            continue

        trade_no = get_by_alias(
            order,
            [
                "交易编号",
                "平台订单号",
                "trade_no",
                "tradeNo",
                "platformOrderId",
                "platform_order_id",
                "orderNo",
                "order_no",
                "orderId",
                "order_id",
                "salesRecordNumber",
            ],
        )
        shop_name = get_by_alias(order, ["店铺名", "店铺名称", "shopName", "shop_name", "storeName"])
        order_status = get_by_alias(order, ["订单状态", "status", "orderStatus", "order_status", "状态"])
        warehouse = get_by_alias(order, ["仓库", "warehouse", "warehouseName", "warehouse_name"])
        payment_method = get_by_alias(order, ["付款方式", "paymentMethod", "payment_method", "payMethod"])
        paid_time = normalize_paid_time(
            get_by_alias(order, ["付款时间", "paidTime", "paid_time", "payTime", "pay_time", "付款日期"])
        )
        order_amount = to_decimal(
            get_by_alias(
                order,
                [
                    "订单核算金额",
                    "核算金额",
                    "orderAmount",
                    "order_amount",
                    "amount",
                    "totalAmount",
                    "total_amount",
                ],
            )
        )

        items = get_items(order)
        if not items:
            items = [{}]

        quantities = [max(0, to_int(get_item_quantity(item), 1)) for item in items]
        total_qty = sum(quantities) or len(items) or 1
        allocated_sum = Decimal("0")

        for index, item in enumerate(items):
            if not isinstance(item, dict):
                item = {}

            sku = get_by_alias(
                item,
                ["SKU", "sku", "stockSku", "stock_sku", "erpSku", "erp_sku", "inventorySku", "商品SKU"],
                default=get_by_alias(order, ["SKU", "sku"]),
            )
            platform_sku = get_by_alias(
                item,
                ["平台SKU", "platformSku", "platform_sku", "sellerSku", "seller_sku", "itemSku"],
                default=get_by_alias(order, ["平台SKU", "platformSku", "platform_sku"]),
            )
            quantity = max(0, to_int(get_item_quantity(item), 1))
            product_name = get_by_alias(
                item,
                ["商品中文名称", "中文名称", "productName", "product_name", "title", "name", "商品标题"],
                default=get_by_alias(order, ["商品中文名称", "productName", "商品标题"]),
            )
            item_warehouse = get_by_alias(
                item,
                ["仓库", "warehouse", "warehouseName", "warehouse_name"],
                default=warehouse,
            )
            item_amount = to_decimal(
                get_by_alias(
                    item,
                    [
                        "订单核算金额",
                        "SKU金额",
                        "明细金额",
                        "amount",
                        "itemAmount",
                        "item_amount",
                        "skuAmount",
                        "sku_amount",
                    ],
                ),
                default=Decimal("-1"),
            )

            if item_amount < Decimal("0"):
                if len(items) == 1:
                    item_amount = order_amount
                elif index == len(items) - 1:
                    item_amount = order_amount - allocated_sum
                else:
                    item_amount = (order_amount * Decimal(quantity or 1) / Decimal(total_qty)).quantize(
                        Decimal("0.01"), rounding=ROUND_HALF_UP
                    )
                    allocated_sum += item_amount

            row = {
                "唯一键": make_unique_key(trade_no, sku, platform_sku),
                "交易编号": safe_str(trade_no),
                "店铺名": safe_str(shop_name),
                "店长": shop_manager_map.get(safe_str(shop_name), ""),
                "订单状态": safe_str(order_status),
                "仓库": safe_str(item_warehouse),
                "SKU": safe_str(sku),
                "商品数量": quantity,
                "商品中文名称": safe_str(product_name),
                "付款方式": safe_str(payment_method),
                "订单核算金额": decimal_to_number(item_amount),
                "付款时间": paid_time,
                "平台SKU": safe_str(platform_sku),
                "是否测评": "否",
            }
            rows.append(row)

    return [normalize_wps_row(row, shop_manager_map) for row in rows if safe_str(row.get("唯一键"))]


def normalize_wps_row(row, shop_manager_map=None):
    shop_manager_map = shop_manager_map or {}
    normalized = {}
    for field in TARGET_FIELDS:
        normalized[field] = row.get(field, "")

    shop_name = safe_str(normalized.get("店铺名"))
    if not safe_str(normalized.get("店长")):
        normalized["店长"] = shop_manager_map.get(shop_name, "")

    normalized["交易编号"] = safe_str(normalized.get("交易编号"))
    normalized["店铺名"] = shop_name
    normalized["订单状态"] = safe_str(normalized.get("订单状态"))
    normalized["仓库"] = safe_str(normalized.get("仓库"))
    normalized["SKU"] = safe_str(normalized.get("SKU"))
    normalized["商品数量"] = to_int(normalized.get("商品数量"), 0)
    normalized["商品中文名称"] = safe_str(normalized.get("商品中文名称"))
    normalized["付款方式"] = safe_str(normalized.get("付款方式"))
    normalized["订单核算金额"] = decimal_to_number(normalized.get("订单核算金额"))
    normalized["付款时间"] = normalize_paid_time(normalized.get("付款时间"))
    normalized["平台SKU"] = safe_str(normalized.get("平台SKU"))
    normalized["是否测评"] = safe_str(normalized.get("是否测评"), "否") or "否"

    if not safe_str(normalized.get("唯一键")):
        normalized["唯一键"] = make_unique_key(
            normalized.get("交易编号"),
            normalized.get("SKU"),
            normalized.get("平台SKU"),
        )

    return normalized


def get_item_quantity(item):
    return get_by_alias(item, ["商品数量", "数量", "quantity", "qty", "num", "skuQuantity"], 1)


def normalize_paid_time(value):
    if is_blank(value):
        return ""
    try:
        return normalize_datetime(value)
    except Exception:
        return safe_str(value)


# =========================
# 主流程
# =========================
def build_client_from_config(config):
    login_mode = normalize_mode(config.get("登录模式", "账号密码"))
    if login_mode in [normalize_mode(v) for v in LOGIN_MODE_EXTERNAL]:
        server_url = config.get("外部接口地址") or config.get("服务器接口") or DEFAULT_EXTERNAL_SERVER_URL
        return ExternalMabangClient(server_url)

    username = get_config_secret(config, "马帮账号", env_name="MABANG_USERNAME", secret_name="mabang_username")
    password = get_config_secret(config, "马帮密码", env_name="MABANG_PASSWORD", secret_name="mabang_password")
    cookie = get_config_secret(config, "Cookie", env_name="MABANG_COOKIE", secret_name="mabang_cookie")
    return MabangClient(username=username, password=password, cookie=cookie, login_mode=login_mode)


def get_paid_time_range(config):
    date_mode = normalize_mode(config.get("日期模式", "自动当月截至昨日"))

    if date_mode in [normalize_mode(v) for v in DATE_MODE_AUTO]:
        return get_month_start_to_yesterday()

    if date_mode in [normalize_mode(v) for v in DATE_MODE_MANUAL]:
        paid_start = normalize_datetime(config.get("付款开始时间"))
        paid_end = normalize_datetime(config.get("付款结束时间"))
        if not paid_start or not paid_end:
            raise Exception("手动日期模式下，付款开始时间和付款结束时间不能为空。")
        return paid_start, paid_end

    raise Exception("未知日期模式：{}".format(config.get("日期模式")))


def main():
    wps = WPSAdapter()
    config = None

    try:
        log("[开始] 读取同步配置")
        config = wps.read_enabled_config(CONFIG_TABLE)
        log("[成功] 配置读取完成")

        log("[开始] 计算付款时间")
        date_mode = safe_str(config.get("日期模式", "自动当月截至昨日"))
        paid_start, paid_end = get_paid_time_range(config)
        log("[成功] 付款时间：{} 至 {}".format(paid_start, paid_end))

        status = safe_str(config.get("订单状态"))
        ensure_required(status, "订单状态不能为空。")

        page_size = to_int(config.get("每页数量"), 100) or 100
        max_pages = to_int(config.get("最大页数"), 100) or 100

        log("[开始] 初始化马帮客户端")
        client = build_client_from_config(config)

        log("[开始] 登录马帮 ERP")
        client.login()
        client.check_login()
        log("[成功] 登录成功")

        log("[开始] 拉取订单")
        orders = client.fetch_orders(
            paid_start=paid_start,
            paid_end=paid_end,
            status=status,
            shop_name=config.get("店铺名称"),
            country=config.get("国家"),
            page_size=page_size,
            max_pages=max_pages,
        )
        log("[成功] 订单拉取完成，共 {} 条".format(len(orders)))

        log("[开始] 读取店铺映射表")
        shop_map = wps.try_read_table(SHOP_MAP_TABLE)

        log("[开始] 转换订单为 WPS 行")
        rows = transform_orders_to_wps_rows(orders, shop_map)
        log("[成功] 转换完成，共 {} 行".format(len(rows)))

        if not rows:
            raise Exception("订单数据为空或未能生成 SKU 明细。")

        log("[开始] 写入 WPS【{}】表".format(TARGET_TABLE))
        result = wps.upsert_rows(
            table_name=TARGET_TABLE,
            rows=rows,
            unique_key_field="唯一键",
            write_mode=config.get("写入模式", "新增并更新"),
        )

        message = (
            "同步成功：日期模式【{}】，付款时间 {} 至 {}，订单状态【{}】，"
            "拉取订单 {} 条，生成 SKU 明细 {} 行，新增 {} 行，更新 {} 行。"
        ).format(
            date_mode,
            paid_start,
            paid_end,
            status,
            len(orders),
            len(rows),
            result["insert"],
            result["update"],
        )

        wps.update_config_result(config["_record_id"], message)
        log("[结束] " + message)
        return message

    except Exception as e:
        error_message = "同步失败：{}".format(str(e))
        log(error_message)

        if config:
            try:
                wps.update_config_result(config["_record_id"], error_message)
            except Exception:
                pass

        raise


if __name__ == "__main__":
    main()
