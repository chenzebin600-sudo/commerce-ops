# -*- coding: utf-8 -*-

import argparse
import csv
import getpass
import io
import json
import os
import re
import sys
import time
import html
import zipfile
import threading
import traceback
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from pathlib import Path

import requests
import pandas as pd
from requests.exceptions import ReadTimeout, RequestException


START_PAGE = 1
END_PAGE = None
MAX_RUN_PAGES = 10

ROWS_PER_PAGE = 500
EXPORT_BATCH_SIZE = 5000
EXPORT_WAIT_SECONDS = 300

REQUEST_TIMEOUT = (10, 120)
MAX_RETRIES = 3
REQUEST_INTERVAL_SECONDS = 0

# 并发数不宜过高，避免触发马帮限流。
SEARCH_PAGE_WORKERS = 3
EXPORT_STEP2_WORKERS = 3

# step2 已返回完整导出明细时直接解析，不再等待 step3 生成 Excel。
# 若 step2 数据缺失或校验失败，脚本会自动降级到原 Excel 流程。
USE_STEP2_DATA_FAST_PATH = True

BASE_URL = os.getenv(
    "MABANG_BASE_URL",
    "https://900445.private.mabangerp.com",
).strip().rstrip("/")
PRIVATE_URL = os.getenv(
    "MABANG_PRIVATE_URL",
    "https://private-amz.mabangerp.com",
).strip().rstrip("/")

INITIAL_URL = BASE_URL + "/index.php?mod=main.loginPage"
LOGIN_URL = BASE_URL + "/index.php?mod=main.doLogin"
ORDER_PAGE_URL = BASE_URL + "/index.php?mod=order.list"
ORDER_SEARCH_URL = BASE_URL + "/index.php?mod=order.oTc"
EXPORT_TEMPLATE_URL = BASE_URL + "/index.php?mod=order.gotoExportOrderTemplate"
EXPORT_PAGE_URL = BASE_URL + "/index.php?mod=order.exportOrderByTemplate"
EXPORT_DATA_URL = PRIVATE_URL + "/index.php?mod=order.doExportByTemplateData"

EXPORT_TEMPLATE_ID = os.getenv("MABANG_EXPORT_TEMPLATE_ID", "1049202").strip()

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


def configure_runtime(base_url, private_url, template_id):
    """Update the tenant-specific Mabang endpoints used by the exporter."""
    global BASE_URL, PRIVATE_URL
    global INITIAL_URL, LOGIN_URL, ORDER_PAGE_URL, ORDER_SEARCH_URL
    global EXPORT_TEMPLATE_URL, EXPORT_PAGE_URL, EXPORT_DATA_URL
    global EXPORT_TEMPLATE_ID

    BASE_URL = str(base_url or "").strip().rstrip("/")
    PRIVATE_URL = str(private_url or "").strip().rstrip("/")
    EXPORT_TEMPLATE_ID = str(template_id or "").strip()

    if not BASE_URL.startswith("https://"):
        raise ValueError("MABANG_BASE_URL 必须是 https:// 地址。")
    if not PRIVATE_URL.startswith("https://"):
        raise ValueError("MABANG_PRIVATE_URL 必须是 https:// 地址。")
    if not EXPORT_TEMPLATE_ID:
        raise ValueError("马帮导出模板 ID 不能为空。")

    INITIAL_URL = BASE_URL + "/index.php?mod=main.loginPage"
    LOGIN_URL = BASE_URL + "/index.php?mod=main.doLogin"
    ORDER_PAGE_URL = BASE_URL + "/index.php?mod=order.list"
    ORDER_SEARCH_URL = BASE_URL + "/index.php?mod=order.oTc"
    EXPORT_TEMPLATE_URL = BASE_URL + "/index.php?mod=order.gotoExportOrderTemplate"
    EXPORT_PAGE_URL = BASE_URL + "/index.php?mod=order.exportOrderByTemplate"
    EXPORT_DATA_URL = PRIVATE_URL + "/index.php?mod=order.doExportByTemplateData"

    HEADERS_AJAX["Origin"] = BASE_URL
    HEADERS_AJAX["Referer"] = ORDER_PAGE_URL
    HEADERS_PAGE["Referer"] = INITIAL_URL


class ConsoleLogger:
    def _print(self, level, message):
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        print(f"{now} - [{level}] {message}", file=sys.stderr, flush=True)

    def info(self, message):
        self._print("信息", message)

    def warning(self, message):
        self._print("提醒", message)

    def error(self, message):
        self._print("失败", message)


logger = ConsoleLogger()


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

    if "S" in text:
        text = text.split("S", 1)[0]

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
            "金额字段存在空值，已停止导出，避免空值被误认为0。请检查：" + sample
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


def extract_order_total_count(page_html):
    if not page_html:
        return None

    decoded_html = html.unescape(str(page_html))
    patterns = [
        r'共\s*<span[^>]*class=["\'][^"\']*semibold[^"\']*["\'][^>]*>\s*([\d,]+)\s*</span>\s*条',
        r'共\s*([\d,]+)\s*条',
    ]

    for pattern in patterns:
        match = re.search(pattern, decoded_html, re.I | re.S)
        if match:
            return int(match.group(1).replace(",", ""))

    return None


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


class MabangClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.trust_env = False
        self.last_po_data = "{}"
        self.last_page_count = None
        self.cached_export_fields = None
        self.cached_standard_version = None
        self._thread_local = threading.local()

    def _new_worker_session(self):
        session = requests.Session()
        session.trust_env = False
        session.headers.update(self.session.headers)

        for cookie in self.session.cookies:
            cookie_args = {}
            if cookie.domain:
                cookie_args["domain"] = cookie.domain
            if cookie.path:
                cookie_args["path"] = cookie.path
            session.cookies.set(cookie.name, cookie.value, **cookie_args)

        return session

    def worker_session(self):
        session = getattr(self._thread_local, "session", None)
        if session is None:
            session = self._new_worker_session()
            self._thread_local.session = session
        return session

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
            raise Exception("马帮账号或密码不能为空。")

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

    def search_orders_page(
        self,
        page,
        paid_start,
        paid_end,
        use_worker_session=False,
        update_export_context=False,
    ):
        params = build_order_params(page, paid_start, paid_end)
        request_session = self.worker_session() if use_worker_session else self.session
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                logger.info(f"查询订单第 {page} 页，第 {attempt}/{MAX_RETRIES} 次")

                response = request_session.post(
                    ORDER_SEARCH_URL,
                    headers={**HEADERS_AJAX, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
                    data=params,
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=True,
                )

                data = safe_json(response)

                if not data.get("success"):
                    raise Exception(data.get("message") or "订单接口返回失败")

                orders = data.get("orderDataList") or []

                if update_export_context:
                    page_html = data.get("pageHtml", "")
                    self.last_po_data = extract_po_data(page_html)
                    total_count = extract_order_total_count(page_html)

                    try:
                        raw_page_count = int(data.get("pageCount") or 0)
                    except Exception:
                        raw_page_count = 0

                    if total_count is not None:
                        self.last_page_count = max(
                            1,
                            (total_count + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE,
                        )
                    elif raw_page_count >= len(orders) and raw_page_count > 0:
                        # 马帮当前接口的 pageCount 实际返回总记录数。
                        self.last_page_count = max(
                            1,
                            (raw_page_count + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE,
                        )
                    else:
                        # 兼容少数旧接口直接返回总页数的情况。
                        self.last_page_count = raw_page_count or None

                    if self.last_page_count is not None:
                        logger.info(f"接口计算总页数：{self.last_page_count}")

                logger.info(f"第 {page} 页返回订单 {len(orders)} 条")
                return orders

            except Exception as error:
                last_error = error
                logger.warning(
                    f"第 {page} 页请求失败，第 {attempt}/{MAX_RETRIES} 次：{error}"
                )
                if attempt < MAX_RETRIES:
                    time.sleep(attempt)

        raise Exception(f"第 {page} 页订单查询失败：{last_error}")

    @staticmethod
    def append_export_ids(orders, ids, seen):
        for order in orders:
            export_id = order.get("platformOrderId")
            if not export_id:
                continue

            export_id = str(export_id).strip()

            if export_id and export_id not in seen:
                seen.add(export_id)
                ids.append(export_id)

    def collect_export_orders(self, paid_start, paid_end):
        ids = []
        seen = set()

        if END_PAGE is not None:
            final_page = min(END_PAGE, START_PAGE + MAX_RUN_PAGES - 1)
        else:
            final_page = START_PAGE + MAX_RUN_PAGES - 1

        logger.info(f"本次最大查询页码：第 {START_PAGE} 页至第 {final_page} 页")

        first_orders = self.search_orders_page(
            START_PAGE,
            paid_start,
            paid_end,
            update_export_context=True,
        )

        if not first_orders:
            logger.info(f"第 {START_PAGE} 页无数据，停止翻页")
            return ids

        self.append_export_ids(first_orders, ids, seen)

        if self.last_page_count is not None:
            if self.last_page_count > final_page:
                raise Exception(
                    f"查询共有 {self.last_page_count} 页，当前 --max-pages 只允许到第 "
                    f"{final_page} 页。请提高 --max-pages 后重试，避免导出不完整。"
                )
            final_page = min(final_page, self.last_page_count)

        if final_page <= START_PAGE:
            logger.info(f"本次收集到可导出订单数：{len(ids)}")
            return ids

        if self.last_page_count is None and len(first_orders) < ROWS_PER_PAGE:
            logger.info(f"本次收集到可导出订单数：{len(ids)}")
            return ids

        remaining_pages = list(range(START_PAGE + 1, final_page + 1))
        page_results = {}
        workers = min(max(1, SEARCH_PAGE_WORKERS), len(remaining_pages))

        logger.info(f"并发查询剩余 {len(remaining_pages)} 页，并发数：{workers}")

        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {
                executor.submit(
                    self.search_orders_page,
                    page,
                    paid_start,
                    paid_end,
                    True,
                    False,
                ): page
                for page in remaining_pages
            }

            for future in as_completed(future_map):
                page = future_map[future]
                page_results[page] = future.result()

        for page in remaining_pages:
            orders = page_results.get(page) or []
            if not orders:
                continue
            self.append_export_ids(orders, ids, seen)

        if (
            self.last_page_count is None
            and page_results.get(final_page)
            and len(page_results[final_page]) >= ROWS_PER_PAGE
        ):
            raise Exception(
                f"第 {final_page} 页仍返回 {len(page_results[final_page])} 条订单，"
                "可能还有后续页。请提高 --max-pages 后重试，避免导出不完整。"
            )

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
        if self.cached_export_fields and self.cached_standard_version:
            logger.info("复用已解析的导出模板字段")
            return self.cached_export_fields, self.cached_standard_version

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
        self.cached_export_fields = export_fields
        self.cached_standard_version = standard_version
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

    def execute_step2_subtask(self, sn, sub_no, subtask_num):
        request_session = self.worker_session()
        last_error = None

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = request_session.post(
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
                    raise Exception(step2.get("message") or str(step2))

                result_data = ((step2.get("res") or {}).get("res") or {})
                raw_datas = result_data.get("datas")
                has_raw_datas = isinstance(raw_datas, list)
                datas = raw_datas if has_raw_datas else []

                logger.info(
                    f"导出 step2 完成：{sub_no}/{subtask_num}，"
                    f"明细 {len(datas)} 行"
                )
                return sub_no, datas, has_raw_datas

            except Exception as error:
                last_error = error
                if attempt < MAX_RETRIES:
                    logger.warning(
                        f"导出 step2 {sub_no}/{subtask_num} 失败，"
                        f"第 {attempt}/{MAX_RETRIES} 次：{error}"
                    )
                    time.sleep(attempt)

        raise Exception(
            f"导出 step2 {sub_no}/{subtask_num} 连续失败：{last_error}"
        )

    def execute_step2_tasks(self, sn, subtask_num):
        workers = min(max(1, EXPORT_STEP2_WORKERS), subtask_num)
        results = {}

        if workers == 1:
            for sub_no in range(1, subtask_num + 1):
                result = self.execute_step2_subtask(sn, sub_no, subtask_num)
                results[sub_no] = result
        else:
            logger.info(f"并发执行 step2，并发数：{workers}")

            with ThreadPoolExecutor(max_workers=workers) as executor:
                future_map = {
                    executor.submit(
                        self.execute_step2_subtask,
                        sn,
                        sub_no,
                        subtask_num,
                    ): sub_no
                    for sub_no in range(1, subtask_num + 1)
                }

                for future in as_completed(future_map):
                    sub_no = future_map[future]
                    results[sub_no] = future.result()

        all_rows = []
        all_subtasks_have_data = True

        for sub_no in range(1, subtask_num + 1):
            _, datas, has_raw_datas = results[sub_no]
            all_rows.extend(datas)
            all_subtasks_have_data = all_subtasks_have_data and has_raw_datas

        return all_rows, all_subtasks_have_data

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

        if step1.get("success_type") == 1 and step1.get("file_url"):
            return self.download_excel_records(step1.get("file_url"))

        sn = step1.get("sn")
        subtask_num = int(step1.get("subtask_num") or 0)

        if not sn or subtask_num <= 0:
            raise Exception(f"导出 step1 未返回有效 sn/subtask_num：{step1}")

        fallback_raw_rows, all_subtasks_have_data = self.execute_step2_tasks(
            sn,
            subtask_num,
        )
        logger.info(f"step2 明细缓存：{len(fallback_raw_rows)} 行")

        if (
            USE_STEP2_DATA_FAST_PATH
            and all_subtasks_have_data
            and fallback_raw_rows
        ):
            try:
                records = normalize_export_rows(fallback_raw_rows, export_fields)
                if records:
                    logger.info(
                        "快速路径生效：直接使用 step2 明细，"
                        "跳过 step3、文件生成等待和 Excel 下载"
                    )
                    return records
            except Exception as error:
                logger.warning(
                    f"step2 明细快速解析失败，自动降级到 Excel 流程：{error}"
                )

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
            batch_started = time.monotonic()
            logger.info(f"开始导出第 {index}/{len(batches)} 批，订单数：{len(batch)}")

            try:
                records = self.export_batch_to_records(batch)
                elapsed = time.monotonic() - batch_started
                logger.info(
                    f"第 {index} 批导出明细：{len(records)} 行，耗时 {elapsed:.2f} 秒"
                )
                all_records.extend(records)

            except Exception as e:
                logger.error(f"第 {index} 批导出失败，已停止后续导出：{e}")
                raise

            if REQUEST_INTERVAL_SECONDS > 0 and index < len(batches):
                time.sleep(REQUEST_INTERVAL_SECONDS)

        return all_records


def parse_datetime(value, field_name):
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError as error:
        raise ValueError(
            f"{field_name} 格式必须是 YYYY-MM-DD HH:MM:SS，当前值：{value}"
        ) from error


def resolve_paid_range(date_value=None, paid_start=None, paid_end=None):
    if date_value and (paid_start or paid_end):
        raise ValueError("--date 不能与 --paid-start/--paid-end 同时使用。")

    if date_value:
        try:
            day = datetime.strptime(date_value, "%Y-%m-%d")
        except ValueError as error:
            raise ValueError("--date 格式必须是 YYYY-MM-DD。") from error
        return (
            day.strftime("%Y-%m-%d 00:00:00"),
            day.strftime("%Y-%m-%d 23:59:59"),
        )

    if bool(paid_start) != bool(paid_end):
        raise ValueError("--paid-start 与 --paid-end 必须成对提供。")

    if not paid_start:
        return get_yesterday_range()

    start_dt = parse_datetime(paid_start, "--paid-start")
    end_dt = parse_datetime(paid_end, "--paid-end")
    if start_dt > end_dt:
        raise ValueError("--paid-start 不能晚于 --paid-end。")
    return paid_start, paid_end


def spreadsheet_safe_value(value):
    if not isinstance(value, str):
        return value
    stripped = value.lstrip()
    if stripped.startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def ordered_records(records, spreadsheet_safe=False):
    rows = []
    for record in records:
        row = {}
        for field in TARGET_FIELDS:
            value = record.get(field, "")
            row[field] = spreadsheet_safe_value(value) if spreadsheet_safe else value
        rows.append(row)
    return rows


def write_records(records, output_path):
    output_path = Path(output_path).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    suffix = output_path.suffix.lower()

    if suffix == ".xlsx":
        rows = ordered_records(records, spreadsheet_safe=True)
        pd.DataFrame(rows, columns=TARGET_FIELDS).to_excel(
            output_path,
            index=False,
            engine="openpyxl",
        )
    elif suffix == ".csv":
        rows = ordered_records(records, spreadsheet_safe=True)
        with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=TARGET_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
    elif suffix == ".json":
        rows = ordered_records(records, spreadsheet_safe=False)
        with output_path.open("w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
    else:
        raise ValueError("输出文件仅支持 .xlsx、.csv 或 .json。")

    return output_path


def default_output_path(paid_start, paid_end):
    start_label = paid_start[:10].replace("-", "")
    end_label = paid_end[:10].replace("-", "")
    generated_at = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path.cwd() / f"mabang-orders-{start_label}-{end_label}-{generated_at}.xlsx"


def export_order_records(username, password, paid_start, paid_end):
    logger.info(f"本次导出付款时间：{paid_start} 至 {paid_end}")
    logger.info("订单状态：全部状态")
    logger.info(f"批量导出大小：{EXPORT_BATCH_SIZE}")
    logger.info(
        f"加速配置：查询并发={SEARCH_PAGE_WORKERS}，"
        f"step2并发={EXPORT_STEP2_WORKERS}，"
        f"step2直接解析={'开启' if USE_STEP2_DATA_FAST_PATH else '关闭'}"
    )

    client = MabangClient()
    login_started = time.monotonic()
    client.login(username, password)
    logger.info(f"登录阶段耗时：{time.monotonic() - login_started:.2f} 秒")

    search_started = time.monotonic()
    order_ids = client.collect_export_orders(paid_start, paid_end)
    logger.info(f"订单查询阶段耗时：{time.monotonic() - search_started:.2f} 秒")

    if not order_ids:
        return [], []

    export_started = time.monotonic()
    records = client.export_orders_to_records(order_ids)
    logger.info(f"订单导出阶段耗时：{time.monotonic() - export_started:.2f} 秒")
    logger.info(f"导出明细总行数：{len(records)}")
    return order_ids, records


def build_parser():
    parser = argparse.ArgumentParser(
        description="按付款时间从马帮导出订单明细到 XLSX、CSV 或 JSON。"
    )
    parser.add_argument(
        "--username",
        default=os.getenv("MABANG_USERNAME", "").strip(),
        help="马帮账号；默认读取 MABANG_USERNAME。",
    )
    date_group = parser.add_argument_group("付款时间")
    date_group.add_argument("--date", help="导出某一天，格式 YYYY-MM-DD。")
    date_group.add_argument(
        "--paid-start",
        help="付款开始时间，格式 YYYY-MM-DD HH:MM:SS。",
    )
    date_group.add_argument(
        "--paid-end",
        help="付款结束时间，格式 YYYY-MM-DD HH:MM:SS。",
    )
    parser.add_argument(
        "--output",
        help="输出文件路径；扩展名必须是 .xlsx、.csv 或 .json，默认写入当前目录。",
    )
    parser.add_argument(
        "--base-url",
        default=BASE_URL,
        help="马帮租户站点地址；默认读取 MABANG_BASE_URL。",
    )
    parser.add_argument(
        "--private-url",
        default=PRIVATE_URL,
        help="马帮导出服务地址；默认读取 MABANG_PRIVATE_URL。",
    )
    parser.add_argument(
        "--template-id",
        default=EXPORT_TEMPLATE_ID,
        help="马帮订单导出模板 ID；默认读取 MABANG_EXPORT_TEMPLATE_ID。",
    )
    parser.add_argument("--max-pages", type=int, default=MAX_RUN_PAGES)
    parser.add_argument("--rows-per-page", type=int, default=ROWS_PER_PAGE)
    parser.add_argument("--batch-size", type=int, default=EXPORT_BATCH_SIZE)
    parser.add_argument("--search-workers", type=int, default=SEARCH_PAGE_WORKERS)
    parser.add_argument("--export-workers", type=int, default=EXPORT_STEP2_WORKERS)
    parser.add_argument(
        "--debug",
        action="store_true",
        help="失败时输出完整 Python traceback；其中可能包含接口上下文。",
    )
    return parser


def apply_cli_limits(args):
    global MAX_RUN_PAGES, ROWS_PER_PAGE, EXPORT_BATCH_SIZE
    global SEARCH_PAGE_WORKERS, EXPORT_STEP2_WORKERS

    values = {
        "--max-pages": args.max_pages,
        "--rows-per-page": args.rows_per_page,
        "--batch-size": args.batch_size,
        "--search-workers": args.search_workers,
        "--export-workers": args.export_workers,
    }
    for name, value in values.items():
        if value < 1:
            raise ValueError(f"{name} 必须大于等于 1。")

    MAX_RUN_PAGES = args.max_pages
    ROWS_PER_PAGE = args.rows_per_page
    EXPORT_BATCH_SIZE = args.batch_size
    SEARCH_PAGE_WORKERS = args.search_workers
    EXPORT_STEP2_WORKERS = args.export_workers


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    started = time.monotonic()

    try:
        paid_start, paid_end = resolve_paid_range(
            date_value=args.date,
            paid_start=args.paid_start,
            paid_end=args.paid_end,
        )
        configure_runtime(args.base_url, args.private_url, args.template_id)
        apply_cli_limits(args)

        username = args.username.strip()
        if not username:
            raise ValueError("请通过 --username 或 MABANG_USERNAME 提供马帮账号。")

        password = os.getenv("MABANG_PASSWORD", "")
        if not password and sys.stdin.isatty():
            password = getpass.getpass("马帮密码（不会回显）: ")
        if not password:
            raise ValueError("请通过 MABANG_PASSWORD 提供马帮密码。")

        order_ids, records = export_order_records(
            username,
            password,
            paid_start,
            paid_end,
        )
        output_path = args.output or default_output_path(paid_start, paid_end)
        output_path = write_records(records, output_path)

        summary = {
            "success": True,
            "paid_start": paid_start,
            "paid_end": paid_end,
            "orders": len(order_ids),
            "rows": len(records),
            "output": str(output_path),
            "elapsed_seconds": round(time.monotonic() - started, 2),
        }
        print(json.dumps(summary, ensure_ascii=False), flush=True)
        return 0
    except Exception as error:
        payload = {
            "success": False,
            "message": str(error),
        }
        if args.debug:
            payload["traceback"] = traceback.format_exc()
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
