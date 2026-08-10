# -*- coding: utf-8 -*-

import re
import io
import os
import json
import time
import html
import zipfile
import traceback
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta

import requests
import pandas as pd
from requests.exceptions import ReadTimeout, RequestException


USERNAME = os.getenv("MABANG_USERNAME", "")
PASSWORD = os.getenv("MABANG_PASSWORD", "")

TARGET_TABLE_NAME = "马帮数据"

START_PAGE = 1
END_PAGE = None
MAX_RUN_PAGES = 100

ROWS_PER_PAGE = 5000
EXPORT_BATCH_SIZE = 5000
WPS_INSERT_BATCH_SIZE = 5000
EXPORT_WAIT_SECONDS = 300

REQUEST_TIMEOUT = (10, 120)
MAX_RETRIES = 3
REQUEST_INTERVAL_SECONDS = 0.1

BASE_URL = "https://900445.private.mabangerp.com"
PRIVATE_URL = "https://private-amz.mabangerp.com"

INITIAL_URL = BASE_URL + "/index.php?mod=main.loginPage"
LOGIN_URL = BASE_URL + "/index.php?mod=main.doLogin"
ORDER_PAGE_URL = BASE_URL + "/index.php?mod=order.list"
ORDER_SEARCH_URL = BASE_URL + "/index.php?mod=order.oTc"
EXPORT_TEMPLATE_URL = BASE_URL + "/index.php?mod=order.gotoExportOrderTemplate"
EXPORT_PAGE_URL = BASE_URL + "/index.php?mod=order.exportOrderByTemplate"
EXPORT_DATA_URL = PRIVATE_URL + "/index.php?mod=order.doExportByTemplateData"

EXPORT_TEMPLATE_ID = "1049202"

HEADERS_AJAX = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": BASE_URL,
    "Referer": ORDER_PAGE_URL,
}

HEADERS_PAGE = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": INITIAL_URL,
}


class WPSLogger:
    def _print(self, level, message):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"{now} - [{level}] {message}", flush=True)

    def info(self, message):
        self._print("信息", message)

    def warning(self, message):
        self._print("提醒", message)

    def error(self, message):
        self._print("失败", message)


logger = WPSLogger()


TARGET_FIELDS = [
    "订单编号", "交易编号", "交运时间", "物流渠道", "店铺名", "平台", "店长", "订单状态", "仓库",
    "SKU总数量", "所属地区（省/州）", "所属城市", "SKU", "商品数量", "商品库存", "商品中文名称",
    "货运单号", "付款方式", "SKU明细", "客户账号", "客户姓名", "邮寄地址1(按逗号分隔导出2列)",
    "商品销售单价", "原始商品销售单价", "商品总金额", "原始运费金额", "运费收入", "原始商品总金额",
    "订单原始总金额", "订单总金额", "优惠金额（人民币）", "优惠金额（原始货币）",
    "订单核算金额（人民币）", "订单核算金额（原始货币）", "汇率（原始货币）", "订单商品名称",
    "采购在途量", "付款时间", "平台SKU", "买家自选物流方式", "最后发货期限", "订单自定义分类",
    "发货时间", "是否转WMS发货", "退货原因", "退货备注", "作废时间", "作废前状态",
    "电话1", "电话2", "订单备注", "平台订单仓库", "是否测评", "测评费用", "邮政编码",
    "tiktok样品订单", "签收时间", "实付金额",
]

NUMERIC_FIELDS = [
    "商品总金额",
    "原始商品总金额",
    "订单核算金额（原始货币）",
]

REQUIRED_AMOUNT_FIELDS = [
    "商品总金额",
    "原始商品总金额",
]

ORIGINAL_AMOUNT_ZERO_EVIDENCE_FIELDS = [
    "原始商品销售单价",
    "商品总金额",
    "订单原始总金额",
    "订单总金额",
    "订单核算金额（原始货币）",
]

COMMON_FILL_FIELDS = [
    "订单编号", "交易编号", "交运时间", "物流渠道", "店铺名", "平台", "店长", "订单状态",
    "SKU总数量", "所属地区（省/州）", "所属城市", "货运单号", "付款方式", "客户账号",
    "客户姓名", "邮寄地址1(按逗号分隔导出2列)",
    "商品总金额", "原始商品总金额",
    "原始运费金额", "运费收入", "订单原始总金额",
    "订单总金额", "优惠金额（人民币）", "优惠金额（原始货币）", "订单核算金额（人民币）",
    "订单核算金额（原始货币）", "汇率（原始货币）", "付款时间", "平台SKU", "买家自选物流方式",
    "最后发货期限", "订单自定义分类", "发货时间", "是否转WMS发货", "退货原因", "退货备注",
    "作废时间", "作废前状态", "电话1", "电话2", "订单备注", "平台订单仓库", "是否测评",
    "测评费用", "邮政编码", "tiktok样品订单", "签收时间", "实付金额",
]

FALLBACK_EXPORT_FIELD_MAP = [
    ("订单编号", "uq101"), ("交易编号", "uq102"), ("交运时间", "uq219"), ("物流渠道", "uq128"),
    ("店铺名", "uq135"), ("平台", "uq205"), ("店长", "uq172"), ("订单状态", "uq136"),
    ("仓库", "uq137"), ("SKU总数量", "uq202"), ("所属地区（省/州）", "uq108"), ("所属城市", "uq109"),
    ("SKU", "uq119"), ("商品数量", "uq121"), ("商品库存", "uq142"), ("商品中文名称", "uq158"),
    ("货运单号", "uq130"), ("付款方式", "uq268"), ("SKU明细", "uq254"), ("客户账号", "uq103"),
    ("客户姓名", "uq104"), ("邮寄地址1(按逗号分隔导出2列)", "uq257"), ("商品销售单价", "uq122"),
    ("原始商品销售单价", "uq123"), ("商品总金额", "uq124"), ("原始运费金额", "uq125"),
    ("运费收入", "uq126"), ("原始商品总金额", "uq146"), ("订单原始总金额", "uq147"),
    ("订单总金额", "uq148"), ("优惠金额（人民币）", "uq244"), ("优惠金额（原始货币）", "uq245"),
    ("订单核算金额（人民币）", "uq251"), ("订单核算金额（原始货币）", "uq252"),
    ("汇率（原始货币）", "uq259"), ("订单商品名称", "uq120"), ("采购在途量", "uq233"),
    ("付款时间", "uq115"), ("平台SKU", "uq196"), ("买家自选物流方式", "uq129"),
    ("最后发货期限", "uq258"), ("订单自定义分类", "uq226"), ("发货时间", "uq149"),
    ("是否转WMS发货", "uq316"), ("退货原因", "uq174"), ("退货备注", "uq206"),
    ("作废时间", "uq241"), ("作废前状态", "uq267"), ("电话1", "uq105"), ("电话2", "uq106"),
    ("订单备注", "uq113"), ("平台订单仓库", "uq365"), ("是否测评", "uq363"), ("测评费用", "uq340"),
    ("邮政编码", "uq110"), ("tiktok样品订单", "uq371"), ("签收时间", "uq443"), ("实付金额", "uq341"),
]


def to_number(value):
    if value is None:
        return ""

    if isinstance(value, (int, float)):
        return float(value)

    text = html.unescape(str(value)).strip()
    text = text.replace(",", "")
    text = text.replace("RMB", "").replace("CNY", "")
    text = text.replace("THB", "").replace("PHP", "")
    text = text.replace("MYR", "").replace("IDR", "")
    text = text.replace("USD", "")
    text = text.strip()

    if text in ["", "--", "nan", "NaN", "None", "null", "*****"]:
        return ""

    match = re.search(r"-?\d+(\.\d+)?", text)
    if not match:
        return ""

    try:
        return float(match.group(0))
    except Exception:
        return ""


def clean_value(value):
    if value is None:
        return ""

    try:
        if pd.isna(value):
            return ""
    except Exception:
        pass

    if isinstance(value, (int, float)):
        return value

    text = html.unescape(str(value)).strip()

    if text in ["nan", "NaN", "None", "null", "--"]:
        return ""

    return text


def normalize_platform_sku(value):
    text = clean_value(value)

    if not text:
        return ""

    return text.strip()


def normalize_numeric_fields(row):
    original_amount = clean_value(row.get("原始商品总金额"))
    if not original_amount and all(
        clean_value(row.get(field)) != "" and to_number(row.get(field)) == 0
        for field in ORIGINAL_AMOUNT_ZERO_EVIDENCE_FIELDS
    ):
        row["原始商品总金额"] = 0

    for field in NUMERIC_FIELDS:
        row[field] = to_number(row.get(field))
    return row


def validate_amount_values(records):
    bad_rows = []

    for index, row in enumerate(records, start=1):
        order_no = str(row.get("订单编号", "")).strip()
        trade_no = str(row.get("交易编号", "")).strip()
        sku = str(row.get("SKU", "")).strip()

        for field in REQUIRED_AMOUNT_FIELDS:
            value = row.get(field)

            if value == "" or value is None:
                bad_rows.append(
                    f"第{index}行，订单编号={order_no}，交易编号={trade_no}，SKU={sku}，字段={field}"
                )

    if bad_rows:
        sample = "；".join(bad_rows[:10])
        raise Exception(
            "金额字段存在空值，已停止导入，避免 WPS 显示为0。请检查：" + sample
        )


def get_yesterday_range():
    today = datetime.now().date()
    yesterday = today - timedelta(days=1)

    start = datetime(yesterday.year, yesterday.month, yesterday.day, 0, 0, 0)
    end = datetime(yesterday.year, yesterday.month, yesterday.day, 23, 59, 59)

    return start.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S")


def get_sync_time_range():
    return get_yesterday_range()


def validate_excel_columns(df):
    columns = [str(c).strip() for c in df.columns]
    missing = [field for field in TARGET_FIELDS if field not in columns]

    if missing:
        raise Exception(
            "Excel 导出文件缺少以下字段，请检查马帮导出模板字段是否完整：" + "、".join(missing)
        )


def chunk_list(items, size):
    return [items[i:i + size] for i in range(0, len(items), size)]


def safe_json(response):
    try:
        return response.json()
    except Exception:
        text = response.text or ""
        raise Exception(f"接口返回不是 JSON，前500字符：{text[:500]}")


def extract_po_data(page_html):
    if not page_html:
        return "{}"

    patterns = [
        r'id=\\"orderalllistPageData\\"[^>]*>(.*?)<\\/span>',
        r'id="orderalllistPageData"[^>]*>(.*?)</span>',
        r"id='orderalllistPageData'[^>]*>(.*?)</span>",
    ]

    for pattern in patterns:
        match = re.search(pattern, page_html, re.S)
        if match:
            return html.unescape(match.group(1)).replace("\\/", "/").strip()

    return "{}"


def extract_iframe_url(export_page_html):
    match = re.search(r'<iframe[^>]+src="([^"]+)"', export_page_html)
    if not match:
        raise Exception("未找到导出模板 iframe。")
    return html.unescape(match.group(1)).replace("\\/", "/")


def parse_template_from_iframe(iframe_html):
    match = re.search(r"var\s+template_map\s*=\s*(\{.*?\});\s*function\s+loadTemplate", iframe_html, re.S)

    if not match:
        logger.warning("未解析到 template_map，使用内置模板。")
        return FALLBACK_EXPORT_FIELD_MAP, "1"

    try:
        template_map = json.loads(match.group(1))
        key = "k" + EXPORT_TEMPLATE_ID
        template = template_map.get(key)

        if not template:
            logger.warning(f"未找到模板 {key}，使用内置模板。")
            return FALLBACK_EXPORT_FIELD_MAP, "1"

        fields = []

        for item in template.get("map", []):
            name = clean_value(item.get("name"))
            uq = clean_value(item.get("uq"))
            if name and uq:
                fields.append((name, uq))

        version = str(template.get("v") or "1")
        return fields or FALLBACK_EXPORT_FIELD_MAP, version

    except Exception as e:
        logger.warning(f"解析模板失败，使用内置模板：{e}")
        return FALLBACK_EXPORT_FIELD_MAP, "1"


def normalize_excel_dataframe(df):
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]

    validate_excel_columns(df)

    records = []
    last_common = {}
    last_platform_sku = ""
    last_order_key = ""

    for _, item in df.iterrows():
        row = {}

        for field in TARGET_FIELDS:
            row[field] = clean_value(item.get(field, ""))

        current_order_key = (
            str(row.get("订单编号", "")).strip()
            or str(row.get("交易编号", "")).strip()
        )

        if current_order_key and current_order_key != last_order_key:
            last_common = {}

        raw_platform_sku = row.get("平台SKU")

        if raw_platform_sku:
            last_platform_sku = raw_platform_sku
        else:
            row["平台SKU"] = last_platform_sku

        row["平台SKU"] = normalize_platform_sku(row.get("平台SKU"))

        if row.get("平台SKU"):
            last_platform_sku = row.get("平台SKU")

        for field in COMMON_FILL_FIELDS:
            if not row.get(field) and last_common.get(field):
                row[field] = last_common[field]

        row["平台SKU"] = normalize_platform_sku(row.get("平台SKU"))

        for field in COMMON_FILL_FIELDS:
            if row.get(field):
                last_common[field] = row[field]

        if current_order_key:
            last_order_key = current_order_key

        row = normalize_numeric_fields(row)

        if not str(row.get("交易编号", "")).strip():
            continue

        if not str(row.get("SKU", "")).strip():
            continue

        records.append(row)

    validate_amount_values(records)

    return records


def normalize_export_rows(raw_rows, export_fields):
    field_names = [name for name, _ in export_fields]
    result = []
    last_common = {}
    last_platform_sku = ""
    last_order_key = ""

    for raw in raw_rows:
        row = {}

        for idx, name in enumerate(field_names):
            row[name] = clean_value(raw[idx] if idx < len(raw) else "")

        current_order_key = (
            str(row.get("订单编号", "")).strip()
            or str(row.get("交易编号", "")).strip()
        )

        if current_order_key and current_order_key != last_order_key:
            last_common = {}

        raw_platform_sku = row.get("平台SKU")

        if raw_platform_sku:
            last_platform_sku = raw_platform_sku
        else:
            row["平台SKU"] = last_platform_sku

        row["平台SKU"] = normalize_platform_sku(row.get("平台SKU"))

        if row.get("平台SKU"):
            last_platform_sku = row.get("平台SKU")

        for field in COMMON_FILL_FIELDS:
            if not row.get(field) and last_common.get(field):
                row[field] = last_common[field]

        row["平台SKU"] = normalize_platform_sku(row.get("平台SKU"))

        for field in COMMON_FILL_FIELDS:
            if row.get(field):
                last_common[field] = row[field]

        if current_order_key:
            last_order_key = current_order_key

        normalized = {}

        for field in TARGET_FIELDS:
            normalized[field] = clean_value(row.get(field, ""))

        normalized["平台SKU"] = normalize_platform_sku(normalized.get("平台SKU"))
        normalized = normalize_numeric_fields(normalized)

        if not str(normalized.get("交易编号", "")).strip():
            continue

        if not str(normalized.get("SKU", "")).strip():
            continue

        result.append(normalized)

    validate_amount_values(result)

    return result


def column_name_to_index(cell_ref):
    letters = re.sub(r"[^A-Z]", "", cell_ref.upper())
    num = 0

    for ch in letters:
        num = num * 26 + ord(ch) - ord("A") + 1

    return num - 1


def parse_xlsx_with_stdlib(content):
    ns = {
        "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    }

    with zipfile.ZipFile(io.BytesIO(content)) as z:
        shared_strings = []

        if "xl/sharedStrings.xml" in z.namelist():
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.findall("main:si", ns):
                texts = []
                for t in si.findall(".//main:t", ns):
                    texts.append(t.text or "")
                shared_strings.append("".join(texts))

        workbook = ET.fromstring(z.read("xl/workbook.xml"))
        first_sheet = workbook.find("main:sheets/main:sheet", ns)

        if first_sheet is None:
            return pd.DataFrame()

        rel_id = first_sheet.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))

        target = None

        for rel in rels.findall("rel:Relationship", ns):
            if rel.attrib.get("Id") == rel_id:
                target = rel.attrib.get("Target")
                break

        if not target:
            return pd.DataFrame()

        if target.startswith("/"):
            sheet_path = target.lstrip("/")
        elif target.startswith("xl/"):
            sheet_path = target
        else:
            sheet_path = "xl/" + target

        sheet_root = ET.fromstring(z.read(sheet_path))
        rows = []

        for row_el in sheet_root.findall(".//main:sheetData/main:row", ns):
            row_values = []

            for c in row_el.findall("main:c", ns):
                ref = c.attrib.get("r", "")
                col_idx = column_name_to_index(ref) if ref else len(row_values)

                while len(row_values) <= col_idx:
                    row_values.append("")

                cell_type = c.attrib.get("t")
                value_el = c.find("main:v", ns)
                inline_el = c.find("main:is/main:t", ns)

                if cell_type == "s" and value_el is not None:
                    idx = int(value_el.text or 0)
                    value = shared_strings[idx] if idx < len(shared_strings) else ""
                elif cell_type == "inlineStr" and inline_el is not None:
                    value = inline_el.text or ""
                elif value_el is not None:
                    value = value_el.text or ""
                else:
                    value = ""

                row_values[col_idx] = value

            rows.append(row_values)

        if not rows:
            return pd.DataFrame()

        headers = [clean_value(x) for x in rows[0]]
        data_rows = rows[1:]
        max_cols = len(headers)
        normalized_rows = []

        for row in data_rows:
            row = row[:max_cols] + [""] * max(0, max_cols - len(row))
            normalized_rows.append(row)

        return pd.DataFrame(normalized_rows, columns=headers)


def read_excel_content(content):
    try:
        return pd.read_excel(io.BytesIO(content), dtype=str)
    except Exception as e:
        logger.warning(f"pd.read_excel 失败，改用标准库解析 xlsx：{e}")

    return parse_xlsx_with_stdlib(content)


def build_order_params(page, paid_start, paid_end):
    return {
        "OrderPlus.isNewOrder": "1",
        "isshowordercombosku": "1",
        "page": str(page),
        "rowsPerPage": str(ROWS_PER_PAGE),
        "Order.orderStatus": "",
        "queryTime": "paidTime",
        "startTime1": paid_start,
        "endTime1": paid_end,
        "queryTime2": "",
        "startTime2": "",
        "endTime2": "",
        "PrintCenterOrderIdlssql": "",
        "fbaFlag": "",
        "canSend": "",
        "OrderCurrency.beforeStatus": "",
        "printCount": "",
        "labelMultipleChoiceWhere": "cross",
        "TextVal": "weight",
        "TextZx": "",
        "TextZd": "",
        "TextFee": "OrderFee",
        "minOrderFee": "",
        "maxOrderFee": "",
        "itemCount": "",
        "OrderSearch.fuzzySearchKey": "",
        "OrderSearch.fuzzySearchKey1": "",
        "OrderSearch.batchSearch": "",
        "grid": "",
        "providerName": "",
        "OrderItem.developerId": "",
        "smtSearchVal": "",
        "orderhighfastsearch": "",
        "parentCategoryId": "",
        "categoryId": "",
        "OrderItem.stockStatus": "",
        "OrderSearch.orderExtend": "",
        "orderSearchHistory": "",
        "goPaypalRefundStatus": "1",
        "Order_isCloud": "2",
        "m": "order",
        "a": "orderalllist",
        "isNewOrderPage": "1",
        "post_tableBase": "1",
        "showError": "",
        "pageListC": "",
        "isSyncVal": "",
        "isSyncValisVirtual": "",
        "isSyncLogisticsOrder": "",
        "isPackOrder": "",
        "isDeliverOrder": "",
        "isWaitPickupOrder": "",
        "isPendingOrder": "",
        "isOutOfStockOrder": "",
        "outOfStockOrderDay": "",
        "isSyncLogistics": "",
        "logisStatus": "",
        "isExpireOrder": "",
        "isWindControlOrder": "",
        "isShipmentOrderC": "",
        "isToDayOrder": "",
        "isToDayDeliveryOrder": "",
        "isResendOrderC": "",
        "isLogisticsRuleNotMatch": "",
        "noTrackOnlineDay": "",
        "quickPickType": "",
        "smtflag": "",
        "platformIdFbw": "",
        "shopeeAbnormal": "",
        "abnormalType": "",
        "cloudStatus": "",
        "isTuotou": "",
        "platformId": "",
        "leftSearchToWms": "",
        "getCompanyCloudStorageHtmlForJson": "[]",
        "supplierCompanyId_v": "",
        "orderBys[]": "",
        "postData": "",
        "title_Json": "",
        "platformTracknumberSearchInput": "",
        "platformTracknumberSearchtextarea": "",
        "OrderLogisticsSearch": "",
        "failureYiSearch": "",
        "view-hidden": "",
        "statusButton": "",
    }


def insert_records_to_wps(records, sheet_name):
    if not records:
        return 0

    total = len(records)
    logger.info(f"开始写入 WPS，新增 {total} 条")

    for start in range(0, total, WPS_INSERT_BATCH_SIZE):
        batch = records[start:start + WPS_INSERT_BATCH_SIZE]
        logger.info(f"写入第 {start + 1} - {start + len(batch)} 条")
        insert_dbt(batch, sheet_name=sheet_name, new_sheet=False)

    return total


class MabangClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.trust_env = False
        self.last_po_data = "{}"

    def cookie_header(self):
        return "; ".join([f"{c.name}={c.value}" for c in self.session.cookies])

    def private_headers(self):
        headers = {
            **HEADERS_AJAX,
            "Origin": PRIVATE_URL,
            "Referer": PRIVATE_URL + "/index.php?mod=order.exportOrderByTemplate",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }
        cookie_text = self.cookie_header()
        if cookie_text:
            headers["Cookie"] = cookie_text
        return headers

    def login(self, username, password):
        if not username or not password:
            raise Exception("请先设置环境变量 MABANG_USERNAME 和 MABANG_PASSWORD。")

        logger.info("打开登录页")
        self.session.get(INITIAL_URL, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)

        logger.info("提交登录")
        files = {
            "isMallRpcFinds": (None, ""),
            "username": (None, username),
            "password": (None, password),
            "verifyCode": (None, ""),
            "remember": (None, "1"),
            "loginEntrance": (None, "1"),
        }

        response = self.session.post(
            LOGIN_URL,
            files=files,
            headers=HEADERS_AJAX,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        data = safe_json(response)

        if not data.get("success"):
            message = data.get("message") or "未知错误"
            if "验证码" in message or "验证" in message:
                raise Exception("马帮登录需要人工验证，请使用 Cookie 模式或官方 API。")
            raise Exception(f"马帮登录失败：{message}")

        self.session.get(ORDER_PAGE_URL, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        logger.info("马帮登录成功")

    def search_orders_page(self, page, paid_start, paid_end):
        params = build_order_params(page, paid_start, paid_end)

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                logger.info(f"查询订单第 {page} 页，第 {attempt}/{MAX_RETRIES} 次")

                response = self.session.post(
                    ORDER_SEARCH_URL,
                    headers={**HEADERS_AJAX, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
                    data=params,
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=True,
                )

                data = safe_json(response)

                if not data.get("success"):
                    raise Exception(data.get("message") or "订单接口返回失败")

                self.last_po_data = extract_po_data(data.get("pageHtml", ""))
                orders = data.get("orderDataList") or []
                logger.info(f"第 {page} 页返回订单 {len(orders)} 条")
                return orders

            except (ReadTimeout, RequestException) as e:
                logger.warning(f"第 {page} 页请求失败：{e}")
                time.sleep(3)

        raise Exception(f"第 {page} 页订单查询失败")

    def collect_export_orders(self, paid_start, paid_end):
        ids = []
        seen = set()

        if END_PAGE is not None:
            final_page = min(END_PAGE, START_PAGE + MAX_RUN_PAGES - 1)
        else:
            final_page = START_PAGE + MAX_RUN_PAGES - 1

        logger.info(f"本次查询页码：第 {START_PAGE} 页至第 {final_page} 页")

        for page in range(START_PAGE, final_page + 1):
            orders = self.search_orders_page(page, paid_start, paid_end)

            if not orders:
                logger.info(f"第 {page} 页无数据，停止翻页")
                break

            for order in orders:
                export_id = order.get("platformOrderId")
                if not export_id:
                    continue

                export_id = str(export_id).strip()

                if export_id and export_id not in seen:
                    seen.add(export_id)
                    ids.append(export_id)

            time.sleep(REQUEST_INTERVAL_SECONDS)

        logger.info(f"本次收集到可导出订单数：{len(ids)}")
        return ids

    def open_export_template(self, order_ids):
        data = []

        for oid in order_ids:
            data.append(("orders[]", oid))

        data.append(("tableBase", "1"))
        data.append(("type", "1"))
        data.append(("poData", self.last_po_data or "{}"))
        data.append(("allBol", "0"))

        response = self.session.post(
            EXPORT_TEMPLATE_URL,
            headers={**HEADERS_AJAX, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
            data=data,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        result = safe_json(response)

        if not result.get("success"):
            raise Exception(f"打开导出模板失败：{result}")

    def get_export_iframe_template(self):
        response = self.session.get(
            EXPORT_PAGE_URL,
            headers=HEADERS_PAGE,
            params={
                "isCloud": "2",
                "tableBase": "1",
                "os": "",
                "orderItemOrderBy": "id asc,stockId asc",
            },
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        iframe_url = extract_iframe_url(response.text or "")

        response = self.session.get(
            iframe_url,
            headers={**HEADERS_PAGE, "Referer": EXPORT_PAGE_URL, "Cookie": self.cookie_header()},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        export_fields, standard_version = parse_template_from_iframe(response.text or "")
        logger.info(f"导出模板字段数：{len(export_fields)}，standardVersion={standard_version}")
        return export_fields, standard_version

    def wait_step4_file_url(self, sn, task_id):
        start_time = time.time()

        while True:
            if time.time() - start_time > EXPORT_WAIT_SECONDS:
                raise Exception("等待导出文件超时。")

            response = self.session.post(
                EXPORT_DATA_URL,
                headers=self.private_headers(),
                data={
                    "step4": "1",
                    "sn": sn,
                    "taskId": str(task_id),
                },
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True,
            )

            result = safe_json(response)

            if result.get("success") is False:
                raise Exception(f"导出 step4 失败：{result}")

            file_url = result.get("file_url") or result.get("gourl")

            if result.get("state") and file_url:
                logger.info("导出文件已生成")
                return file_url.replace("\\/", "/")

            logger.info("导出文件生成中，等待 2 秒")
            time.sleep(2)

    def download_excel_records(self, file_url, fallback_raw_rows=None, export_fields=None):
        file_url = file_url.replace("\\/", "/")
        logger.info(f"下载导出 Excel：{file_url}")

        response = self.session.get(
            file_url,
            headers=HEADERS_PAGE,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        if response.status_code != 200:
            raise Exception(f"下载 Excel 失败，状态码：{response.status_code}")

        try:
            df = read_excel_content(response.content)
            records = normalize_excel_dataframe(df)
            logger.info(f"Excel 解析成功，明细 {len(records)} 行")
            return records

        except Exception as e:
            logger.warning(f"Excel 解析失败：{e}")

            if fallback_raw_rows and export_fields:
                logger.warning("使用 step2 返回数据兜底解析。")
                return normalize_export_rows(fallback_raw_rows, export_fields)

            raise

    def export_batch_to_records(self, order_ids):
        logger.info(f"打开导出模板，订单数：{len(order_ids)}")
        self.open_export_template(order_ids)

        export_fields, standard_version = self.get_export_iframe_template()

        payload = [
            ("backUrl", ""),
            ("orderIds", "\n".join(order_ids)),
            ("templateName", ""),
            ("templateId", EXPORT_TEMPLATE_ID),
            ("standardVersion", standard_version),
            ("orderItemOrderBy", "id asc,stockId asc"),
            ("pageSave", "1"),
        ]

        for field_name, uq in export_fields:
            payload.append(("map-name[]", field_name))
            payload.append(("map-uq[]", uq))
            payload.append(("map-text[]", ""))

        payload.append(("tableBase", "1"))
        # Match Mabang's default export UI: do not merge common order fields.
        # mergeShow is intentionally omitted so multi-product rows stay unmerged too.
        payload.append(("hbddgyxx", "2"))
        payload.append(("step1", "1"))

        logger.info("提交导出 step1")

        response = self.session.post(
            EXPORT_DATA_URL,
            headers=self.private_headers(),
            data=payload,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        step1 = safe_json(response)

        if not step1.get("success"):
            raise Exception(f"导出 step1 失败：{step1}")

        fallback_raw_rows = []

        if step1.get("success_type") == 1 and step1.get("file_url"):
            return self.download_excel_records(step1.get("file_url"))

        sn = step1.get("sn")
        subtask_num = int(step1.get("subtask_num") or 0)

        if not sn or subtask_num <= 0:
            raise Exception(f"导出 step1 未返回有效 sn/subtask_num：{step1}")

        for sub_no in range(1, subtask_num + 1):
            logger.info(f"执行导出 step2：{sub_no}/{subtask_num}")

            response = self.session.post(
                EXPORT_DATA_URL,
                headers=self.private_headers(),
                data={
                    "step2": "1",
                    "sn": sn,
                    "sub_no": str(sub_no),
                },
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True,
            )

            step2 = safe_json(response)

            if not step2.get("success"):
                raise Exception(f"导出 step2 失败：{step2}")

            datas = (((step2.get("res") or {}).get("res") or {}).get("datas")) or []

            if datas:
                fallback_raw_rows.extend(datas)

        logger.info(f"step2 兜底明细缓存：{len(fallback_raw_rows)} 行")
        logger.info("执行导出 step3")

        response = self.session.post(
            EXPORT_DATA_URL,
            headers=self.private_headers(),
            data={
                "step3": "1",
                "sn": sn,
            },
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        step3 = safe_json(response)

        if not step3.get("success"):
            raise Exception(f"导出 step3 失败：{step3}")

        file_url = step3.get("file_url") or step3.get("gourl")

        if file_url:
            return self.download_excel_records(file_url, fallback_raw_rows, export_fields)

        if step3.get("async") and step3.get("taskId"):
            file_url = self.wait_step4_file_url(sn, step3.get("taskId"))
            return self.download_excel_records(file_url, fallback_raw_rows, export_fields)

        if fallback_raw_rows:
            logger.warning("没有 Excel 文件链接，使用 step2 返回数据兜底。")
            return normalize_export_rows(fallback_raw_rows, export_fields)

        raise Exception(f"导出完成但没有文件链接，也没有明细数据：{step3}")

    def export_orders_to_records(self, order_ids):
        all_records = []
        batches = chunk_list(order_ids, EXPORT_BATCH_SIZE)

        for index, batch in enumerate(batches, start=1):
            logger.info(f"开始导出第 {index}/{len(batches)} 批，订单数：{len(batch)}")

            try:
                records = self.export_batch_to_records(batch)
                logger.info(f"第 {index} 批导出明细：{len(records)} 行")
                all_records.extend(records)

            except Exception as e:
                logger.error(f"第 {index} 批导出失败，跳过本批：{e}")

            time.sleep(REQUEST_INTERVAL_SECONDS)

        return all_records


def run_sync():
    paid_start, paid_end = get_sync_time_range()

    logger.info(f"本次同步付款时间：{paid_start} 至 {paid_end}")
    logger.info("订单状态：全部状态")
    logger.info(f"批量导出大小：{EXPORT_BATCH_SIZE}")
    logger.info("写入方式：不删除原表数据，直接追加写入")

    client = MabangClient()
    client.login(USERNAME, PASSWORD)

    order_ids = client.collect_export_orders(paid_start, paid_end)

    if not order_ids:
        message = "没有查询到订单，本次不写入数据。"
        logger.info(message)
        return {"success": True, "message": message, "orders": 0, "rows": 0, "inserted": 0}

    records = client.export_orders_to_records(order_ids)
    logger.info(f"导出明细总行数：{len(records)}")

    if not records:
        message = "导出明细为0，本次不写入数据。"
        logger.warning(message)
        return {"success": False, "message": message, "orders": len(order_ids), "rows": 0, "inserted": 0}

    inserted = insert_records_to_wps(records, TARGET_TABLE_NAME)

    message = (
        f"同步完成：付款时间 {paid_start} 至 {paid_end}，"
        f"订单状态【全部】，订单 {len(order_ids)} 个，"
        f"导出明细 {len(records)} 行，导入 {inserted} 行。"
    )

    logger.info(message)

    return {
        "success": True,
        "message": message,
        "orders": len(order_ids),
        "rows": len(records),
        "inserted": inserted,
    }


if __name__ == "__main__":
    try:
        result = run_sync()
        print(result, flush=True)

    except Exception as e:
        error = {
            "success": False,
            "message": f"脚本运行异常：{e}",
            "traceback": traceback.format_exc(),
        }
        print(error, flush=True)
