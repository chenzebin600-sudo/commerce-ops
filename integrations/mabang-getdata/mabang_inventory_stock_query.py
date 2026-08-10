# -*- coding: utf-8 -*-

import re
import io
import json
import os
import time
import html
import zipfile
import traceback
import xml.etree.ElementTree as ET
from datetime import date, datetime

import requests
import pandas as pd
from requests.exceptions import ReadTimeout, RequestException


USERNAME = os.getenv("MABANG_USERNAME", "").strip()
PASSWORD = os.getenv("MABANG_PASSWORD", "")

TARGET_TABLE_NAME = "库存查询"

# 马帮单个导出文件最多 10000 行；超过时按官方页面规则分批下载。
EXPORT_PAGE_SIZE = 10000
SEARCH_ROWS_PER_PAGE = 50
WPS_INSERT_BATCH_SIZE = 5000

SHOW_RMB_COLUMN = 0

REQUEST_TIMEOUT = (10, 180)
EXPORT_TIMEOUT = (10, 300)
MAX_RETRIES = 3
REQUEST_INTERVAL_SECONDS = 0.5

BASE_URL = "https://900445.private.mabangerp.com"
PRIVATE_URL = "https://private-amz.mabangerp.com"

INITIAL_URL = BASE_URL + "/index.php?mod=main.loginPage"
LOGIN_URL = BASE_URL + "/index.php?mod=main.doLogin"
ORDER_PAGE_URL = BASE_URL + "/index.php?mod=order.list"

INVENTORY_PAGE_URL = BASE_URL + "/index.php?mod=warehouse.inventorydetail"
STOCK_SEARCH_URL = PRIVATE_URL + "/index.php?mod=warehouse.searchwarehousestock"
STOCK_PAGE_INFO_URL = PRIVATE_URL + "/index.php?mod=warehouse.getSearchWarehouseStockPage"
STOCK_SUMMARY_URL = PRIVATE_URL + "/index.php?mod=warehouse.getStockTotalAndStockTotalCost"
STOCK_EXPORT_URL = PRIVATE_URL + "/index.php?mod=warehouse.doexportwarehousestock"

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

TARGET_FIELDS = [
    "库存SKU编号",
    "商品状态",
    "活跃度",
    "是否新款",
    "一级目录",
    "二级目录",
    "三级目录",
    "一级品牌",
    "二级品牌",
    "采购员",
    "中文名称",
    "英文名称",
    "父级仓库",
    "仓库",
    "仓位",
    "销量(7/28/42)",
    "预测日销量(个)",
    "仓位库存",
    "当前可售天数",
    "在途量",
    "海外仓预调入量",
    "分仓调拨预调入量",
    "警戒量",
    "警戒天数",
    "未发货量",
    "分仓调拨未发货量",
    "可用库存量",
    "最后出库时间",
    "最后入库时间",
    "商品备注",
]

REQUIRED_FIELDS = [
    "库存SKU编号",
    "仓库",
    "可用库存量",
]

NUMERIC_FIELDS = [
    "预测日销量(个)",
    "仓位库存",
    "当前可售天数",
    "在途量",
    "海外仓预调入量",
    "分仓调拨预调入量",
    "警戒量",
    "警戒天数",
    "未发货量",
    "分仓调拨未发货量",
    "可用库存量",
]


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


def safe_json(response):
    try:
        return response.json()
    except Exception:
        text = response.text or ""
        raise Exception(f"接口返回不是 JSON，前500字符：{text[:500]}")


def clean_value(value):
    if value is None:
        return ""

    try:
        if pd.isna(value):
            return ""
    except Exception:
        pass

    if hasattr(value, "item") and not isinstance(value, (str, bytes)):
        try:
            value = value.item()
        except Exception:
            pass

    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")

    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value

    text = html.unescape(str(value)).strip()

    if text in ["nan", "NaN", "None", "null"]:
        return ""

    return text


def to_number(value):
    value = clean_value(value)

    if value == "":
        return ""

    if isinstance(value, bool):
        return int(value)

    if isinstance(value, int):
        return value

    if isinstance(value, float):
        return int(value) if value.is_integer() else value

    text = str(value).strip().replace(",", "")

    if text in ["", "--", "nan", "NaN", "None", "null"]:
        return ""

    if not re.fullmatch(r"-?\d+(?:\.\d+)?", text):
        return value

    try:
        number = float(text)
        return int(number) if number.is_integer() else number
    except Exception:
        return value


def extract_iframe_url(page_html):
    patterns = [
        r'<iframe[^>]+id="iframeContent"[^>]+src="([^"]+)"',
        r"<iframe[^>]+id='iframeContent'[^>]+src='([^']+)'",
        r'<iframe[^>]+src="([^"]+)"',
    ]

    for pattern in patterns:
        match = re.search(pattern, page_html or "", re.S)
        if match:
            return html.unescape(match.group(1)).replace("\\/", "/")

    raise Exception("未找到库存查询 iframe 地址。")


def parse_record_count(page_html):
    patterns = [
        r'共\s*<span[^>]*class="[^"]*semibold[^"]*"[^>]*>\s*([\d,]+)\s*</span>\s*条',
        r'共\s*<span[^>]*>\s*([\d,]+)\s*</span>\s*条',
    ]

    for pattern in patterns:
        match = re.search(pattern, page_html or "", re.I | re.S)
        if match:
            return int(match.group(1).replace(",", ""))

    raise Exception("未能从库存分页信息中解析总记录数。")


def column_name_to_index(cell_ref):
    letters = re.sub(r"[^A-Z]", "", str(cell_ref).upper())
    num = 0

    for ch in letters:
        num = num * 26 + ord(ch) - ord("A") + 1

    return num - 1


def parse_xlsx_with_stdlib(content):
    ns = {
        "main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
        "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
    }

    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()
        shared_strings = []

        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("main:si", ns):
                texts = [node.text or "" for node in item.findall(".//main:t", ns)]
                shared_strings.append("".join(texts))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        first_sheet = workbook.find("main:sheets/main:sheet", ns)

        if first_sheet is None:
            return pd.DataFrame()

        rel_id = first_sheet.attrib.get(
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        )
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
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

        sheet_root = ET.fromstring(archive.read(sheet_path))
        rows = []

        for row_el in sheet_root.findall(".//main:sheetData/main:row", ns):
            row_values = []

            for cell in row_el.findall("main:c", ns):
                ref = cell.attrib.get("r", "")
                col_idx = column_name_to_index(ref) if ref else len(row_values)

                while len(row_values) <= col_idx:
                    row_values.append("")

                cell_type = cell.attrib.get("t")
                value_el = cell.find("main:v", ns)
                inline_nodes = cell.findall("main:is//main:t", ns)

                if cell_type == "s" and value_el is not None:
                    index = int(value_el.text or 0)
                    value = shared_strings[index] if index < len(shared_strings) else ""
                elif cell_type == "inlineStr" and inline_nodes:
                    value = "".join(node.text or "" for node in inline_nodes)
                elif value_el is not None:
                    value = value_el.text or ""
                else:
                    value = ""

                row_values[col_idx] = value

            rows.append(row_values)

        if not rows:
            return pd.DataFrame()

        headers = [clean_value(value) for value in rows[0]]
        max_cols = len(headers)
        normalized_rows = []

        for row in rows[1:]:
            row = row[:max_cols] + [""] * max(0, max_cols - len(row))
            normalized_rows.append(row)

        return pd.DataFrame(normalized_rows, columns=headers)


def read_excel_content(content):
    try:
        return pd.read_excel(io.BytesIO(content), dtype=object)
    except Exception as error:
        logger.warning(f"pd.read_excel 失败，改用标准库解析 xlsx：{error}")
        return parse_xlsx_with_stdlib(content)


def validate_excel_columns(dataframe):
    columns = [str(column).strip() for column in dataframe.columns]
    missing = [field for field in REQUIRED_FIELDS if field not in columns]

    if missing:
        raise Exception("马帮库存导出文件缺少库存同步必填字段：" + "、".join(missing))


def normalize_inventory_dataframe(dataframe):
    dataframe = dataframe.copy()
    dataframe.columns = [str(column).strip() for column in dataframe.columns]
    validate_excel_columns(dataframe)

    records = []

    for _, item in dataframe.iterrows():
        record = {}

        for field in TARGET_FIELDS:
            value = clean_value(item.get(field, ""))
            record[field] = to_number(value) if field in NUMERIC_FIELDS else value

        if not str(record.get("库存SKU编号", "")).strip():
            continue

        if not str(record.get("仓库", "")).strip():
            continue

        records.append(record)

    return records


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


class MabangInventoryClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.trust_env = False
        self.inventory_iframe_url = ""

    def cookie_header(self):
        return "; ".join(f"{cookie.name}={cookie.value}" for cookie in self.session.cookies)

    def private_ajax_headers(self):
        headers = {
            **HEADERS_AJAX,
            "Origin": PRIVATE_URL,
            "Referer": self.inventory_iframe_url,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        }

        cookie_text = self.cookie_header()
        if cookie_text:
            headers["Cookie"] = cookie_text

        return headers

    def private_download_headers(self):
        headers = {
            **HEADERS_PAGE,
            "Accept": (
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,"
                "application/vnd.ms-excel,*/*"
            ),
            "Referer": self.inventory_iframe_url,
        }

        cookie_text = self.cookie_header()
        if cookie_text:
            headers["Cookie"] = cookie_text

        return headers

    def login(self, username, password):
        logger.info("打开马帮登录页")
        self.session.get(
            INITIAL_URL,
            headers=HEADERS_PAGE,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        logger.info("提交马帮登录")
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

        result = safe_json(response)

        if not result.get("success"):
            message = result.get("message") or "未知错误"
            if "验证码" in message or "验证" in message:
                raise Exception("马帮登录需要人工验证，请使用 Cookie 模式或官方 API。")
            raise Exception(f"马帮登录失败：{message}")

        self.session.get(
            ORDER_PAGE_URL,
            headers=HEADERS_PAGE,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        logger.info("马帮登录成功")

    def open_inventory_page(self):
        logger.info("打开商品 > 库存查询页面")

        response = self.session.get(
            INVENTORY_PAGE_URL,
            headers={**HEADERS_PAGE, "Referer": ORDER_PAGE_URL},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        self.inventory_iframe_url = extract_iframe_url(response.text or "")

        logger.info("初始化库存查询 iframe 会话")
        response = self.session.get(
            self.inventory_iframe_url,
            headers={
                **HEADERS_PAGE,
                "Referer": INVENTORY_PAGE_URL,
                "Cookie": self.cookie_header(),
            },
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        if response.status_code != 200:
            raise Exception(f"打开库存查询 iframe 失败，状态码：{response.status_code}")

        if "warehouse.searchwarehousestock" not in (response.text or ""):
            raise Exception("库存查询 iframe 未正确加载，可能是登录会话已过期。")

    def build_default_search_params(self):
        return {
            "search-content-text1": "",
            "page": "1",
            "rowsPerPage": str(SEARCH_ROWS_PER_PAGE),
            "warehouseId": "",
            "startTime": "",
            "endTime": "",
            "isIdn": "1",
            "warehouseIdArr": "",
            "stockQuantitylt": "",
            "stockQuantitygt": "",
            "stockWarningQuantitylt": "",
            "stockWarningQuantitygt": "",
            "saleAvailableDayslt": "",
            "saleAvailableDaysgt": "",
        }

    def initialize_default_search(self):
        logger.info("执行库存查询默认条件")
        params = self.build_default_search_params()

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = self.session.post(
                    STOCK_SEARCH_URL,
                    headers=self.private_ajax_headers(),
                    data=params,
                    timeout=REQUEST_TIMEOUT,
                    allow_redirects=True,
                )

                result = safe_json(response)

                if not result.get("success"):
                    raise Exception(result.get("message") or "库存查询接口返回失败")

                logger.info("库存查询条件初始化成功")
                return

            except (ReadTimeout, RequestException) as error:
                logger.warning(f"库存查询请求失败，第 {attempt}/{MAX_RETRIES} 次：{error}")
                time.sleep(3)

        raise Exception("库存查询条件初始化失败")

    def get_record_count(self):
        response = self.session.post(
            STOCK_PAGE_INFO_URL,
            headers=self.private_ajax_headers(),
            data={"page": "1", "rowsPerPage": str(SEARCH_ROWS_PER_PAGE)},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        result = safe_json(response)

        if not result.get("success"):
            raise Exception(f"获取库存分页信息失败：{result}")

        record_count = parse_record_count(result.get("pageHtml", ""))
        logger.info(f"库存查询总记录数：{record_count}")
        return record_count

    def get_stock_summary(self):
        response = self.session.post(
            STOCK_SUMMARY_URL,
            headers=self.private_ajax_headers(),
            data={"refreshOrderDataFlag": "0"},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )

        result = safe_json(response)

        if not result.get("success"):
            logger.warning(f"库存汇总接口失败，不影响明细导出：{result}")
            return {}

        logger.info(
            f"库存汇总：库存总量={result.get('total', '')}，"
            f"库存总值={result.get('totalCost', '')}，"
            f"更新时间={result.get('cacheUpdateTime', '')}"
        )
        return result

    def download_export_file(self, export_page=None):
        params = {
            "flag": "1",
            "showRmbColumn": str(SHOW_RMB_COLUMN),
        }

        if export_page is not None:
            params["page"] = str(export_page)

        page_text = f"第 {export_page} 批" if export_page is not None else "全部"
        logger.info(f"下载马帮官方库存 Excel：{page_text}")

        response = self.session.get(
            STOCK_EXPORT_URL,
            headers=self.private_download_headers(),
            params=params,
            timeout=EXPORT_TIMEOUT,
            allow_redirects=True,
        )

        if response.status_code != 200:
            raise Exception(f"下载库存 Excel 失败，状态码：{response.status_code}")

        content = response.content or b""

        if not content.startswith(b"PK"):
            text = content[:500].decode("utf-8", errors="replace")
            raise Exception(f"库存导出接口未返回 xlsx，前500字符：{text}")

        return content

    def export_inventory_records(self, record_count):
        if record_count <= 0:
            return []

        if record_count < EXPORT_PAGE_SIZE:
            export_pages = [None]
        else:
            page_count = (record_count + EXPORT_PAGE_SIZE - 1) // EXPORT_PAGE_SIZE
            export_pages = list(range(1, page_count + 1))

        all_records = []
        exported_row_count = 0

        for index, export_page in enumerate(export_pages, start=1):
            content = self.download_export_file(export_page)
            dataframe = read_excel_content(content)
            exported_row_count += len(dataframe.index)
            records = normalize_inventory_dataframe(dataframe)
            skipped = len(dataframe.index) - len(records)
            logger.info(
                f"第 {index}/{len(export_pages)} 批解析 {len(records)} 行，"
                f"跳过无 SKU 或仓库行 {skipped} 条"
            )
            all_records.extend(records)

            if index < len(export_pages):
                time.sleep(REQUEST_INTERVAL_SECONDS)

        if exported_row_count != record_count:
            raise Exception(
                f"库存导出行数校验失败：页面显示 {record_count} 行，"
                f"Excel 原始数据 {exported_row_count} 行。已停止写入 WPS。"
            )

        return all_records


def run_sync():
    logger.info("本次同步模块：商品 > 库存查询")
    logger.info(f"目标 WPS 表：{TARGET_TABLE_NAME}")
    logger.info("数据来源：马帮官方库存 Excel 导出接口")
    logger.info("写入方式：不删除原表数据，直接追加写入")

    client = MabangInventoryClient()
    client.login(USERNAME, PASSWORD)
    client.open_inventory_page()
    client.initialize_default_search()

    record_count = client.get_record_count()
    summary = client.get_stock_summary()

    if record_count == 0:
        message = "库存查询结果为0，本次不写入数据。"
        logger.info(message)
        return {
            "success": True,
            "message": message,
            "rows": 0,
            "inserted": 0,
        }

    records = client.export_inventory_records(record_count)
    inserted = insert_records_to_wps(records, TARGET_TABLE_NAME)

    message = (
        f"库存查询同步完成：马帮查询 {record_count} 行，"
        f"Excel 解析 {len(records)} 行，WPS 导入 {inserted} 行。"
    )

    logger.info(message)

    return {
        "success": True,
        "message": message,
        "rows": len(records),
        "inserted": inserted,
        "summary": {
            "total": summary.get("total", ""),
            "totalCost": summary.get("totalCost", ""),
            "inTransitTotal": summary.get("inTransitTotal", ""),
            "cacheUpdateTime": summary.get("cacheUpdateTime", ""),
        },
    }


try:
    result = run_sync()
    print(result, flush=True)

except Exception as error:
    result = {
        "success": False,
        "message": f"脚本运行异常：{error}",
        "traceback": traceback.format_exc(),
    }
    print(result, flush=True)
