# Generated from user-provided WPS script. Credentials and auto-run block removed.
import re
import io
import json
import time
import html
import zipfile
import threading
import traceback
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
import requests
import pandas as pd
from requests.exceptions import ReadTimeout, RequestException
USERNAME = ''
PASSWORD = ''
TARGET_TABLE_NAME = '马帮数据'
START_PAGE = 1
END_PAGE = None
MAX_RUN_PAGES = 10
ROWS_PER_PAGE = 500
EXPORT_BATCH_SIZE = 5000
WPS_INSERT_BATCH_SIZE = 5000
EXPORT_WAIT_SECONDS = 300
REQUEST_TIMEOUT = (10, 120)
MAX_RETRIES = 3
REQUEST_INTERVAL_SECONDS = 0
SEARCH_PAGE_WORKERS = 3
EXPORT_STEP2_WORKERS = 3
USE_STEP2_DATA_FAST_PATH = True
BASE_URL = 'https://900445.private.mabangerp.com'
PRIVATE_URL = 'https://private-amz.mabangerp.com'
INITIAL_URL = BASE_URL + '/index.php?mod=main.loginPage'
LOGIN_URL = BASE_URL + '/index.php?mod=main.doLogin'
ORDER_PAGE_URL = BASE_URL + '/index.php?mod=order.list'
ORDER_SEARCH_URL = BASE_URL + '/index.php?mod=order.oTc'
EXPORT_TEMPLATE_URL = BASE_URL + '/index.php?mod=order.gotoExportOrderTemplate'
EXPORT_PAGE_URL = BASE_URL + '/index.php?mod=order.exportOrderByTemplate'
EXPORT_DATA_URL = PRIVATE_URL + '/index.php?mod=order.doExportByTemplateData'
FULFILLMENT_CHANNEL_LIST_URL = BASE_URL + '/index.php?mod=order.getOrderLogisticsD'
FULFILLMENT_REPORTING_INFO_URL = BASE_URL + '/index.php?mod=order.getReportingInformation'
FULFILLMENT_SUBMIT_URL = BASE_URL + '/index.php?mod=order.doReportingInformation'
FULFILLMENT_DISTRIBUTION_URL = BASE_URL + '/index.php?mod=order.doBatchDistribution'
FULFILLMENT_BATCH_EDIT_URL = BASE_URL + '/index.php?mod=order.all'
EXPORT_TEMPLATE_ID = '1049202'
HEADERS_AJAX = {'Accept': 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE_URL, 'Referer': ORDER_PAGE_URL}
HEADERS_PAGE = {'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': INITIAL_URL}


def extract_fulfillment_stock_flags(page_html, internal_id='', order_reference=''):
    wanted_internal_id = str(internal_id or '').strip()
    wanted_reference = str(order_reference or '').strip()
    for input_tag in re.findall(r'<input\b[^>]*>', str(page_html or ''), re.I):
        attributes = {
            name.lower(): html.unescape(value)
            for name, _, value in re.findall(r'([\w:-]+)\s*=\s*(["\'])(.*?)\2', input_tag, re.S)
        }
        if not (
            (wanted_internal_id and attributes.get('value') == wanted_internal_id)
            or (wanted_reference and attributes.get('orderid') == wanted_reference)
        ):
            continue
        return {
            'hasGoods': attributes.get('data-hasgoods'),
            'orderItemHasGoods': attributes.get('data-orderitemhasgoods'),
        }
    return {}

class WPSLogger:

    def _print(self, level, message):
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        print(f'{now} - [{level}] {message}', flush=True)

    def info(self, message):
        self._print('信息', message)

    def warning(self, message):
        self._print('提醒', message)

    def error(self, message):
        self._print('失败', message)
logger = WPSLogger()
TARGET_FIELDS = ['订单编号', '交易编号', '交运时间', '物流渠道', '店铺名', '平台', '店长', '订单状态', '仓库', 'SKU总数量', '所属地区（省/州）', '所属城市', 'SKU', '商品数量', '商品库存', '商品中文名称', '货运单号', '付款方式', 'SKU明细', '客户账号', '客户姓名', '邮寄地址1(按逗号分隔导出2列)', '商品销售单价', '原始商品销售单价', '商品总金额', '原始运费金额', '运费收入', '原始商品总金额', '订单原始总金额', '订单总金额', '优惠金额（人民币）', '优惠金额（原始货币）', '订单核算金额（人民币）', '订单核算金额（原始货币）', '汇率（原始货币）', '订单商品名称', '采购在途量', '付款时间', '平台SKU', '买家自选物流方式', '最后发货期限', '订单自定义分类', '发货时间', '是否转WMS发货', '退货原因', '退货备注', '作废时间', '作废前状态', '电话1', '电话2', '订单备注', '平台订单仓库', '是否测评', '测评费用', '邮政编码', 'tiktok样品订单', '签收时间', '实付金额']
NUMERIC_FIELDS = ['商品总金额', '原始商品总金额', '订单核算金额（原始货币）']
REQUIRED_AMOUNT_FIELDS = ['商品总金额']
ORIGINAL_AMOUNT_ZERO_EVIDENCE_FIELDS = ['原始商品销售单价', '商品总金额', '订单原始总金额', '订单总金额', '订单核算金额（原始货币）']
COMMON_FILL_FIELDS = ['订单编号', '交易编号', '交运时间', '物流渠道', '店铺名', '平台', '店长', '订单状态', 'SKU总数量', '所属地区（省/州）', '所属城市', '货运单号', '付款方式', '客户账号', '客户姓名', '邮寄地址1(按逗号分隔导出2列)', '商品总金额', '原始商品总金额', '原始运费金额', '运费收入', '订单原始总金额', '订单总金额', '优惠金额（人民币）', '优惠金额（原始货币）', '订单核算金额（人民币）', '订单核算金额（原始货币）', '汇率（原始货币）', '付款时间', '平台SKU', '买家自选物流方式', '最后发货期限', '订单自定义分类', '发货时间', '是否转WMS发货', '退货原因', '退货备注', '作废时间', '作废前状态', '电话1', '电话2', '订单备注', '平台订单仓库', '是否测评', '测评费用', '邮政编码', 'tiktok样品订单', '签收时间', '实付金额']
FALLBACK_EXPORT_FIELD_MAP = [('订单编号', 'uq101'), ('交易编号', 'uq102'), ('交运时间', 'uq219'), ('物流渠道', 'uq128'), ('店铺名', 'uq135'), ('平台', 'uq205'), ('店长', 'uq172'), ('订单状态', 'uq136'), ('仓库', 'uq137'), ('SKU总数量', 'uq202'), ('所属地区（省/州）', 'uq108'), ('所属城市', 'uq109'), ('SKU', 'uq119'), ('商品数量', 'uq121'), ('商品库存', 'uq142'), ('商品中文名称', 'uq158'), ('货运单号', 'uq130'), ('付款方式', 'uq268'), ('SKU明细', 'uq254'), ('客户账号', 'uq103'), ('客户姓名', 'uq104'), ('邮寄地址1(按逗号分隔导出2列)', 'uq257'), ('商品销售单价', 'uq122'), ('原始商品销售单价', 'uq123'), ('商品总金额', 'uq124'), ('原始运费金额', 'uq125'), ('运费收入', 'uq126'), ('原始商品总金额', 'uq146'), ('订单原始总金额', 'uq147'), ('订单总金额', 'uq148'), ('优惠金额（人民币）', 'uq244'), ('优惠金额（原始货币）', 'uq245'), ('订单核算金额（人民币）', 'uq251'), ('订单核算金额（原始货币）', 'uq252'), ('汇率（原始货币）', 'uq259'), ('订单商品名称', 'uq120'), ('采购在途量', 'uq233'), ('付款时间', 'uq115'), ('平台SKU', 'uq196'), ('买家自选物流方式', 'uq129'), ('最后发货期限', 'uq258'), ('订单自定义分类', 'uq226'), ('发货时间', 'uq149'), ('是否转WMS发货', 'uq316'), ('退货原因', 'uq174'), ('退货备注', 'uq206'), ('作废时间', 'uq241'), ('作废前状态', 'uq267'), ('电话1', 'uq105'), ('电话2', 'uq106'), ('订单备注', 'uq113'), ('平台订单仓库', 'uq365'), ('是否测评', 'uq363'), ('测评费用', 'uq340'), ('邮政编码', 'uq110'), ('tiktok样品订单', 'uq371'), ('签收时间', 'uq443'), ('实付金额', 'uq341')]

def to_number(value):
    if value is None:
        return ''
    if isinstance(value, (int, float)):
        try:
            if pd.isna(value):
                return ''
        except Exception:
            pass
        return float(value)
    text = html.unescape(str(value)).strip()
    text = text.replace(',', '')
    text = text.replace('RMB', '').replace('CNY', '')
    text = text.replace('THB', '').replace('PHP', '')
    text = text.replace('MYR', '').replace('IDR', '')
    text = text.replace('USD', '')
    text = text.strip()
    if text in ['', '--', 'nan', 'NaN', 'None', 'null', '*****']:
        return ''
    match = re.search('-?\\d+(\\.\\d+)?', text)
    if not match:
        return ''
    try:
        return float(match.group(0))
    except Exception:
        return ''

def clean_value(value):
    if value is None:
        return ''
    try:
        if pd.isna(value):
            return ''
    except Exception:
        pass
    if isinstance(value, (int, float)):
        return value
    text = html.unescape(str(value)).strip()
    if text in ['nan', 'NaN', 'None', 'null', '--']:
        return ''
    return text

def normalize_platform_sku(value):
    text = clean_value(value)
    if not text:
        return ''
    if 'S' in text:
        text = text.split('S', 1)[0]
    return text.strip()

def normalize_numeric_fields(row):
    original_amount = clean_value(row.get('原始商品总金额'))
    if not original_amount and all(
        clean_value(row.get(field)) != '' and to_number(row.get(field)) == 0
        for field in ORIGINAL_AMOUNT_ZERO_EVIDENCE_FIELDS
    ):
        row['原始商品总金额'] = 0
    for field in NUMERIC_FIELDS:
        row[field] = to_number(row.get(field))
    return row

def validate_amount_values(records):
    bad_rows = []
    for index, row in enumerate(records, start=1):
        order_no = str(row.get('订单编号', '')).strip()
        trade_no = str(row.get('交易编号', '')).strip()
        sku = str(row.get('SKU', '')).strip()
        for field in REQUIRED_AMOUNT_FIELDS:
            value = row.get(field)
            if value == '' or value is None:
                bad_rows.append(f'第{index}行，订单编号={order_no}，交易编号={trade_no}，SKU={sku}，字段={field}')
    if bad_rows:
        sample = '；'.join(bad_rows[:10])
        raise Exception('金额字段存在空值，已停止导入，避免 WPS 显示为0。请检查：' + sample)

def get_yesterday_range():
    today = datetime.now().date()
    yesterday = today - timedelta(days=1)
    start = datetime(yesterday.year, yesterday.month, yesterday.day, 0, 0, 0)
    end = datetime(yesterday.year, yesterday.month, yesterday.day, 23, 59, 59)
    return (start.strftime('%Y-%m-%d %H:%M:%S'), end.strftime('%Y-%m-%d %H:%M:%S'))

def get_sync_time_range():
    return get_yesterday_range()

def validate_excel_columns(df):
    columns = [str(c).strip() for c in df.columns]
    missing = [field for field in TARGET_FIELDS if field not in columns]
    if missing:
        raise Exception('Excel 导出文件缺少以下字段，请检查马帮导出模板字段是否完整：' + '、'.join(missing))

def chunk_list(items, size):
    return [items[i:i + size] for i in range(0, len(items), size)]

def safe_json(response):
    try:
        return response.json()
    except Exception:
        text = response.text or ''
        raise Exception(f'接口返回不是 JSON，前500字符：{text[:500]}')


def response_looks_unauthenticated(response, data=None):
    url = str(getattr(response, 'url', '') or '').lower()
    text = str(getattr(response, 'text', '') or '')[:20000].lower()
    if 'mod=main.loginpage' in url:
        return True
    if 'name="username"' in text and 'name="password"' in text:
        return True
    if isinstance(data, dict) and not data.get('success', True):
        message = str(data.get('message') or '').lower()
        auth_markers = ('未登录', '请先登录', '登录失效', '登录过期', '重新登录', 'login expired', 'not logged in')
        return any(marker in message for marker in auth_markers)
    return False

def extract_po_data(page_html):
    if not page_html:
        return '{}'
    patterns = ['id=\\\\"orderalllistPageData\\\\"[^>]*>(.*?)<\\\\/span>', 'id="orderalllistPageData"[^>]*>(.*?)</span>', "id='orderalllistPageData'[^>]*>(.*?)</span>"]
    for pattern in patterns:
        match = re.search(pattern, page_html, re.S)
        if match:
            return html.unescape(match.group(1)).replace('\\/', '/').strip()
    return '{}'

def extract_order_total_count(page_html):
    if not page_html:
        return None
    decoded_html = html.unescape(str(page_html))
    patterns = ['共\\s*<span[^>]*class=["\\\'][^"\\\']*semibold[^"\\\']*["\\\'][^>]*>\\s*([\\d,]+)\\s*</span>\\s*条', '共\\s*([\\d,]+)\\s*条']
    for pattern in patterns:
        match = re.search(pattern, decoded_html, re.I | re.S)
        if match:
            return int(match.group(1).replace(',', ''))
    return None

def extract_iframe_url(export_page_html):
    match = re.search('<iframe[^>]+src="([^"]+)"', export_page_html)
    if not match:
        raise Exception('未找到导出模板 iframe。')
    return html.unescape(match.group(1)).replace('\\/', '/')

def parse_template_from_iframe(iframe_html):
    match = re.search('var\\s+template_map\\s*=\\s*(\\{.*?\\});\\s*function\\s+loadTemplate', iframe_html, re.S)
    if not match:
        logger.warning('未解析到 template_map，使用内置模板。')
        return (FALLBACK_EXPORT_FIELD_MAP, '1')
    try:
        template_map = json.loads(match.group(1))
        key = 'k' + EXPORT_TEMPLATE_ID
        template = template_map.get(key)
        if not template:
            logger.warning(f'未找到模板 {key}，使用内置模板。')
            return (FALLBACK_EXPORT_FIELD_MAP, '1')
        fields = []
        for item in template.get('map', []):
            name = clean_value(item.get('name'))
            uq = clean_value(item.get('uq'))
            if name and uq:
                fields.append((name, uq))
        version = str(template.get('v') or '1')
        return (fields or FALLBACK_EXPORT_FIELD_MAP, version)
    except Exception as e:
        logger.warning(f'解析模板失败，使用内置模板：{e}')
        return (FALLBACK_EXPORT_FIELD_MAP, '1')

def normalize_excel_dataframe(df):
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    validate_excel_columns(df)
    records = []
    last_common = {}
    last_platform_sku = ''
    last_order_key = ''
    for _, item in df.iterrows():
        row = {}
        for field in TARGET_FIELDS:
            row[field] = clean_value(item.get(field, ''))
        current_order_key = str(row.get('订单编号', '')).strip() or str(row.get('交易编号', '')).strip()
        if current_order_key and current_order_key != last_order_key:
            last_common = {}
        raw_platform_sku = row.get('平台SKU')
        if raw_platform_sku:
            last_platform_sku = raw_platform_sku
        else:
            row['平台SKU'] = last_platform_sku
        row['平台SKU'] = normalize_platform_sku(row.get('平台SKU'))
        if row.get('平台SKU'):
            last_platform_sku = row.get('平台SKU')
        for field in COMMON_FILL_FIELDS:
            if not row.get(field) and last_common.get(field):
                row[field] = last_common[field]
        row['平台SKU'] = normalize_platform_sku(row.get('平台SKU'))
        for field in COMMON_FILL_FIELDS:
            if row.get(field):
                last_common[field] = row[field]
        if current_order_key:
            last_order_key = current_order_key
        row = normalize_numeric_fields(row)
        if not str(row.get('交易编号', '')).strip():
            continue
        if not str(row.get('SKU', '')).strip():
            continue
        records.append(row)
    validate_amount_values(records)
    return records

def normalize_export_rows(raw_rows, export_fields):
    field_names = [name for name, _ in export_fields]
    result = []
    last_common = {}
    last_platform_sku = ''
    last_order_key = ''
    for raw in raw_rows:
        row = {}
        for idx, name in enumerate(field_names):
            row[name] = clean_value(raw[idx] if idx < len(raw) else '')
        current_order_key = str(row.get('订单编号', '')).strip() or str(row.get('交易编号', '')).strip()
        if current_order_key and current_order_key != last_order_key:
            last_common = {}
        raw_platform_sku = row.get('平台SKU')
        if raw_platform_sku:
            last_platform_sku = raw_platform_sku
        else:
            row['平台SKU'] = last_platform_sku
        row['平台SKU'] = normalize_platform_sku(row.get('平台SKU'))
        if row.get('平台SKU'):
            last_platform_sku = row.get('平台SKU')
        for field in COMMON_FILL_FIELDS:
            if not row.get(field) and last_common.get(field):
                row[field] = last_common[field]
        row['平台SKU'] = normalize_platform_sku(row.get('平台SKU'))
        for field in COMMON_FILL_FIELDS:
            if row.get(field):
                last_common[field] = row[field]
        if current_order_key:
            last_order_key = current_order_key
        normalized = {}
        for field in TARGET_FIELDS:
            normalized[field] = clean_value(row.get(field, ''))
        normalized['平台SKU'] = normalize_platform_sku(normalized.get('平台SKU'))
        normalized = normalize_numeric_fields(normalized)
        if not str(normalized.get('交易编号', '')).strip():
            continue
        if not str(normalized.get('SKU', '')).strip():
            continue
        result.append(normalized)
    validate_amount_values(result)
    return result

def column_name_to_index(cell_ref):
    letters = re.sub('[^A-Z]', '', cell_ref.upper())
    num = 0
    for ch in letters:
        num = num * 26 + ord(ch) - ord('A') + 1
    return num - 1

def parse_xlsx_with_stdlib(content):
    ns = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'rel': 'http://schemas.openxmlformats.org/package/2006/relationships'}
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        shared_strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall('main:si', ns):
                texts = []
                for t in si.findall('.//main:t', ns):
                    texts.append(t.text or '')
                shared_strings.append(''.join(texts))
        workbook = ET.fromstring(z.read('xl/workbook.xml'))
        first_sheet = workbook.find('main:sheets/main:sheet', ns)
        if first_sheet is None:
            return pd.DataFrame()
        rel_id = first_sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        target = None
        for rel in rels.findall('rel:Relationship', ns):
            if rel.attrib.get('Id') == rel_id:
                target = rel.attrib.get('Target')
                break
        if not target:
            return pd.DataFrame()
        if target.startswith('/'):
            sheet_path = target.lstrip('/')
        elif target.startswith('xl/'):
            sheet_path = target
        else:
            sheet_path = 'xl/' + target
        sheet_root = ET.fromstring(z.read(sheet_path))
        rows = []
        for row_el in sheet_root.findall('.//main:sheetData/main:row', ns):
            row_values = []
            for c in row_el.findall('main:c', ns):
                ref = c.attrib.get('r', '')
                col_idx = column_name_to_index(ref) if ref else len(row_values)
                while len(row_values) <= col_idx:
                    row_values.append('')
                cell_type = c.attrib.get('t')
                value_el = c.find('main:v', ns)
                inline_el = c.find('main:is/main:t', ns)
                if cell_type == 's' and value_el is not None:
                    idx = int(value_el.text or 0)
                    value = shared_strings[idx] if idx < len(shared_strings) else ''
                elif cell_type == 'inlineStr' and inline_el is not None:
                    value = inline_el.text or ''
                elif value_el is not None:
                    value = value_el.text or ''
                else:
                    value = ''
                row_values[col_idx] = value
            rows.append(row_values)
        if not rows:
            return pd.DataFrame()
        headers = [clean_value(x) for x in rows[0]]
        data_rows = rows[1:]
        max_cols = len(headers)
        normalized_rows = []
        for row in data_rows:
            row = row[:max_cols] + [''] * max(0, max_cols - len(row))
            normalized_rows.append(row)
        return pd.DataFrame(normalized_rows, columns=headers)

def read_excel_content(content):
    try:
        return pd.read_excel(io.BytesIO(content), dtype=str)
    except Exception as e:
        logger.warning(f'pd.read_excel 失败，改用标准库解析 xlsx：{e}')
    return parse_xlsx_with_stdlib(content)

def build_order_params(page, paid_start, paid_end):
    return {'OrderPlus.isNewOrder': '1', 'isshowordercombosku': '1', 'page': str(page), 'rowsPerPage': str(ROWS_PER_PAGE), 'Order.orderStatus': '', 'queryTime': 'paidTime', 'startTime1': paid_start, 'endTime1': paid_end, 'queryTime2': '', 'startTime2': '', 'endTime2': '', 'PrintCenterOrderIdlssql': '', 'fbaFlag': '', 'canSend': '', 'OrderCurrency.beforeStatus': '', 'printCount': '', 'labelMultipleChoiceWhere': 'cross', 'TextVal': 'weight', 'TextZx': '', 'TextZd': '', 'TextFee': 'OrderFee', 'minOrderFee': '', 'maxOrderFee': '', 'itemCount': '', 'OrderSearch.fuzzySearchKey': '', 'OrderSearch.fuzzySearchKey1': '', 'OrderSearch.batchSearch': '', 'grid': '', 'providerName': '', 'OrderItem.developerId': '', 'smtSearchVal': '', 'orderhighfastsearch': '', 'parentCategoryId': '', 'categoryId': '', 'OrderItem.stockStatus': '', 'OrderSearch.orderExtend': '', 'orderSearchHistory': '', 'goPaypalRefundStatus': '1', 'Order_isCloud': '2', 'm': 'order', 'a': 'orderalllist', 'isNewOrderPage': '1', 'post_tableBase': '1', 'showError': '', 'pageListC': '', 'isSyncVal': '', 'isSyncValisVirtual': '', 'isSyncLogisticsOrder': '', 'isPackOrder': '', 'isDeliverOrder': '', 'isWaitPickupOrder': '', 'isPendingOrder': '', 'isOutOfStockOrder': '', 'outOfStockOrderDay': '', 'isSyncLogistics': '', 'logisStatus': '', 'isExpireOrder': '', 'isWindControlOrder': '', 'isShipmentOrderC': '', 'isToDayOrder': '', 'isToDayDeliveryOrder': '', 'isResendOrderC': '', 'isLogisticsRuleNotMatch': '', 'noTrackOnlineDay': '', 'quickPickType': '', 'smtflag': '', 'platformIdFbw': '', 'shopeeAbnormal': '', 'abnormalType': '', 'cloudStatus': '', 'isTuotou': '', 'platformId': '', 'leftSearchToWms': '', 'getCompanyCloudStorageHtmlForJson': '[]', 'supplierCompanyId_v': '', 'orderBys[]': '', 'postData': '', 'title_Json': '', 'platformTracknumberSearchInput': '', 'platformTracknumberSearchtextarea': '', 'OrderLogisticsSearch': '', 'failureYiSearch': '', 'view-hidden': '', 'statusButton': ''}

def insert_records_to_wps(records, sheet_name):
    if not records:
        return 0
    total = len(records)
    logger.info(f'开始写入 WPS，新增 {total} 条')
    for start in range(0, total, WPS_INSERT_BATCH_SIZE):
        batch = records[start:start + WPS_INSERT_BATCH_SIZE]
        logger.info(f'写入第 {start + 1} - {start + len(batch)} 条')
        insert_dbt(batch, sheet_name=sheet_name, new_sheet=False)
    return total

class MabangClient:

    def __init__(self):
        self.session = requests.Session()
        self.session.trust_env = False
        self._username = ''
        self._password = ''
        self.last_po_data = '{}'
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
                cookie_args['domain'] = cookie.domain
            if cookie.path:
                cookie_args['path'] = cookie.path
            session.cookies.set(cookie.name, cookie.value, **cookie_args)
        return session

    def worker_session(self):
        session = getattr(self._thread_local, 'session', None)
        if session is None:
            session = self._new_worker_session()
            self._thread_local.session = session
        return session

    def cookie_header(self):
        return '; '.join([f'{c.name}={c.value}' for c in self.session.cookies])

    def private_headers(self):
        headers = {**HEADERS_AJAX, 'Origin': PRIVATE_URL, 'Referer': PRIVATE_URL + '/index.php?mod=order.exportOrderByTemplate', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}
        cookie_text = self.cookie_header()
        if cookie_text:
            headers['Cookie'] = cookie_text
        return headers

    def _reset_session(self):
        self.session = requests.Session()
        self.session.trust_env = False
        self._thread_local = threading.local()

    def _reauthenticate(self):
        if not self._username or not self._password:
            raise Exception('MABANG_AUTH_REQUIRED: 马帮登录凭据不可用，需要人工重新配置。')
        username, password = self._username, self._password
        self._reset_session()
        self.login(username, password)

    def post_json_with_reauth(self, url, *, data, headers=None, operation='只读查询'):
        for attempt in range(2):
            response = self.session.post(
                url, headers=headers or HEADERS_AJAX, data=data,
                timeout=REQUEST_TIMEOUT, allow_redirects=True,
            )
            if response_looks_unauthenticated(response):
                if attempt == 0:
                    logger.warning(f'{operation}发现登录失效，自动重新登录一次。')
                    self._reauthenticate()
                    continue
                raise Exception(f'MABANG_AUTH_EXPIRED: {operation}时马帮登录状态失效，自动重新登录后仍未恢复。')
            try:
                result = response.json()
            except Exception:
                if attempt == 0 and response_looks_unauthenticated(response):
                    self._reauthenticate()
                    continue
                raise Exception(f'MABANG_RESPONSE_INVALID: {operation}返回格式异常，已停止操作。')
            if response_looks_unauthenticated(response, result):
                if attempt == 0:
                    logger.warning(f'{operation}返回登录失效，自动重新登录一次。')
                    self._reauthenticate()
                    continue
                raise Exception(f'MABANG_AUTH_EXPIRED: {operation}时马帮登录状态失效，自动重新登录后仍未恢复。')
            return result
        raise Exception(f'MABANG_AUTH_EXPIRED: {operation}无法获得有效登录状态。')

    def get_text_with_reauth(self, url, *, headers=None, operation='只读页面查询'):
        for attempt in range(2):
            response = self.session.get(
                url, headers=headers or HEADERS_PAGE,
                timeout=REQUEST_TIMEOUT, allow_redirects=True,
            )
            if not response_looks_unauthenticated(response):
                return str(response.text or '')
            if attempt == 0:
                logger.warning(f'{operation}发现登录失效，自动重新登录一次。')
                self._reauthenticate()
                continue
            raise Exception(f'MABANG_AUTH_EXPIRED: {operation}时马帮登录状态失效，自动重新登录后仍未恢复。')
        raise Exception(f'MABANG_AUTH_EXPIRED: {operation}无法获得有效登录状态。')

    def login(self, username, password):
        if not username or not password:
            raise Exception('MABANG_AUTH_REQUIRED: 马帮账号或密码不能为空。')
        self._username, self._password = username, password
        logger.info('打开登录页')
        self.session.get(INITIAL_URL, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        logger.info('提交登录')
        files = {'isMallRpcFinds': (None, ''), 'username': (None, username), 'password': (None, password), 'verifyCode': (None, ''), 'remember': (None, '1'), 'loginEntrance': (None, '1')}
        response = self.session.post(LOGIN_URL, files=files, headers=HEADERS_AJAX, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        data = safe_json(response)
        if not data.get('success'):
            message = data.get('message') or '未知错误'
            if '验证码' in message or '验证' in message:
                raise Exception('MABANG_CAPTCHA_REQUIRED: 马帮登录需要人工验证。')
            raise Exception(f'MABANG_AUTH_FAILED: 马帮登录失败：{message}')
        verification = self.session.get(ORDER_PAGE_URL, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if response_looks_unauthenticated(verification):
            raise Exception('MABANG_AUTH_FAILED: 登录接口返回成功，但登录后的页面验证失败。')
        logger.info('马帮登录成功')

    def find_order_for_fulfillment(self, order_reference, pending_status='2'):
        reference = str(order_reference or '').strip()
        if not reference:
            raise Exception('必须指定订单编号。')
        end = datetime.now()
        start = end - timedelta(days=92)
        params = build_order_params(1, start.strftime('%Y-%m-%d 00:00:00'), end.strftime('%Y-%m-%d 23:59:59'))
        params['rowsPerPage'] = '100'
        params['Order.orderStatus'] = str(pending_status)
        params['OrderSearch.fuzzySearchKey'] = 'Order.platformOrderId'
        params['OrderSearch.fuzzySearchValue'] = reference
        data = self.post_json_with_reauth(
            ORDER_SEARCH_URL, headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
            data=params, operation='查询指定订单',
        )
        if not data.get('success'):
            raise Exception(data.get('message') or '订单查询失败。')
        page_html = str(data.get('pageHtml') or '')
        po_data = extract_po_data(page_html)
        if po_data:
            self.last_po_data = po_data
        orders = data.get('orderDataList') or []
        for order in orders:
            candidates = [order.get('id'), order.get('orderId'), order.get('platformOrderId'), order.get('salesRecordNumber')]
            if reference in [str(value or '').strip() for value in candidates]:
                matched_order = dict(order)
                internal_id = str(order.get('id') or order.get('orderId') or '').strip()
                html_flags = extract_fulfillment_stock_flags(data.get('pageHtml'), internal_id, reference)
                for name in ('hasGoods', 'orderItemHasGoods'):
                    if matched_order.get(name) is None and html_flags.get(name) is not None:
                        matched_order[name] = html_flags[name]
                matched_order['_fulfillmentStockFlagSource'] = 'page_html' if html_flags else 'order_json_or_missing'
                matched_order['_fulfillmentPageHtmlLength'] = len(str(data.get('pageHtml') or ''))
                matched_order['_fulfillmentPageContainsOrder'] = reference in str(data.get('pageHtml') or '')
                return matched_order
        raise Exception('指定订单不存在、不是待处理状态或不在最近93天。')

    def export_order_references_to_records(self, order_references, pending_status='2'):
        """精确查询并只导出指定订单，避免为了最多 10 单扫描整个日期范围。"""
        references = list(dict.fromkeys(
            str(value or '').strip() for value in (order_references or []) if str(value or '').strip()
        ))
        if not references or len(references) > 10:
            raise ValueError('指定订单数量必须为1-10单。')
        platform_order_ids = []
        missing_references = []
        for reference in references:
            try:
                order = self.find_order_for_fulfillment(reference, pending_status)
            except Exception as error:
                if '指定订单不存在、不是待处理状态或不在最近93天' in str(error):
                    missing_references.append(reference)
                    continue
                raise
            platform_order_id = str(order.get('platformOrderId') or '').strip()
            if platform_order_id and platform_order_id not in platform_order_ids:
                platform_order_ids.append(platform_order_id)
        records = self.export_orders_to_records(platform_order_ids) if platform_order_ids else []
        return records, platform_order_ids, missing_references

    def get_fulfillment_channel_data(self, internal_id):
        channel_data = self.post_json_with_reauth(
            FULFILLMENT_CHANNEL_LIST_URL,
            headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
            data={'orderIds': str(internal_id), 'adminShopIds': ''}, operation='读取订单物流渠道',
        )
        if not channel_data.get('success'):
            raise Exception(channel_data.get('message') or '读取订单物流渠道失败。')
        selected_order_markup = '\n'.join(
            str(channel_data.get(key) or '') for key in ('message', 'message1')
        )
        channel_data['_selectedOrderMatched'] = str(internal_id) in selected_order_markup
        channel_data['_orderPageHtml'] = self.get_text_with_reauth(
            f'{ORDER_PAGE_URL}&Order_orderStatus=2', headers=HEADERS_PAGE,
            operation='读取批量修改订单物流渠道缓存'
        )
        return channel_data

    @staticmethod
    def fulfillment_channel_available(channel_data, channel_id, channel_value=''):
        escaped_id = re.escape(str(channel_id or '').strip())
        if not escaped_id:
            return False

        def iter_text_values(value, depth=0):
            if depth > 6:
                return
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for nested in value.values():
                    yield from iter_text_values(nested, depth + 1)
            elif isinstance(value, (list, tuple)):
                for nested in value:
                    yield from iter_text_values(nested, depth + 1)

        exact_id_pattern = re.compile(
            rf'(?:data-id|data-mylogisticschannelid)\s*=\s*["\']{escaped_id}["\']',
            re.I,
        )
        expected_value = str(channel_value or '').strip()
        for channel_text in iter_text_values(channel_data):
            if exact_id_pattern.search(channel_text):
                return True
            if expected_value and expected_value in channel_text:
                return True
        return False

    @staticmethod
    def batch_edit_channel_values(channel_data):
        """Read channel values from UI: Batch actions -> Batch edit orders -> Set logistics channel."""
        order_page_html = str(
            channel_data.get('_orderPageHtml')
            or channel_data.get('orderPageHtml')
            or ''
        ) if isinstance(channel_data, dict) else ''
        # The server-rendered pending-order page exposes the same cache used by
        # "Batch actions -> Batch edit orders -> Set logistics channel". The
        # <ul> itself is filled by JavaScript, so raw HTTP clients must read the
        # cache rather than wait for browser-side DOM hydration.
        channel_cache = re.search(
            r'var\s+highSearch_myLogisticsChannelCache\s*=\s*(\[.*?\])\s*;',
            order_page_html,
            re.I | re.S,
        )
        if channel_cache:
            try:
                channels = json.loads(channel_cache.group(1))
            except (TypeError, ValueError, json.JSONDecodeError):
                channels = []
            values = []
            for channel in channels if isinstance(channels, list) else []:
                if not isinstance(channel, dict):
                    continue
                channel_id = str(channel.get('id') or '').strip()
                logistics_id = str(channel.get('myLogisticsId') or '').strip()
                channel_name = str(channel.get('logisticsChannelName') or '').strip()
                if channel_id and logistics_id and channel_name:
                    values.append(f'{channel_id}_{logistics_id}_{channel_name}')
            if values:
                return list(dict.fromkeys(values))

        # Compatibility with captured/hydrated browser HTML and test fixtures.
        channel_list = re.search(
            r'<ul[^>]*id=["\']BatchEdit_myLogisticsChannelModifyUl["\'][^>]*>(.*?)</ul>',
            order_page_html,
            re.I | re.S,
        )
        if not channel_list:
            return []
        values = re.findall(
            r"BatchEdit_myLogisticsChannelId[^;]{0,80}?\.val\(\s*['\"]([^'\"]+)['\"]\s*\)",
            channel_list.group(1),
            re.I | re.S,
        )
        return list(dict.fromkeys(html.unescape(value).strip() for value in values if value.strip()))

    @classmethod
    def batch_edit_channel_available(cls, channel_data, channel_id, channel_value=''):
        channel_id = str(channel_id or '').strip()
        expected = str(channel_value or '').strip()
        suffix = expected.rpartition('_')
        batch_edit_value = suffix[0] if suffix[2].isdigit() else expected
        if not channel_id or not batch_edit_value:
            return False
        return any(
            value == batch_edit_value and value.startswith(f'{channel_id}_')
            for value in cls.batch_edit_channel_values(channel_data)
        )

    @staticmethod
    def fulfillment_order_channel_selected(order, channel_id, channel_value=''):
        """Confirm the channel actually selected on the order row after submission."""
        current_logistics_html = html.unescape(str(order.get('cansend1logisticsHtml') or ''))
        channel_id = str(channel_id or '').strip()
        expected = str(channel_value or '').strip()
        suffix = expected.rpartition('_')
        if suffix[2].isdigit():
            expected = suffix[0]
        expected_name = expected.split('_', 2)[-1] if '_' in expected else expected
        if not current_logistics_html or not channel_id or not expected_name:
            return False
        return bool(
            re.search(rf'data-id\s*=\s*["\']{re.escape(channel_id)}["\']', current_logistics_html, re.I)
            and expected_name in current_logistics_html
        )

    @staticmethod
    def fulfillment_stock_status(order):
        normalized_order = {
            re.sub(r'[^a-z0-9]', '', str(key).lower()): value
            for key, value in order.items()
        }
        stock_flags = []
        for name in ('hasGoods', 'orderItemHasGoods'):
            value = normalized_order.get(name.lower())
            stock_flags.append('' if value is None else str(value).strip())
        if any(not value for value in stock_flags):
            return 'unknown'
        if any(value == '3' for value in stock_flags):
            return 'multi_warehouse'
        if any(value == '2' for value in stock_flags):
            return 'out_of_stock'
        if all(value == '0' for value in stock_flags):
            return 'in_stock'
        return 'unknown'

    @staticmethod
    def stale_multi_warehouse_flag_is_safe(order, single_warehouse_verified=False):
        """马帮人工换仓后可能保留 hasGoods=3；仅在最新 SKU 明细已确认单仓时接受 3/0 组合。"""
        if not single_warehouse_verified:
            return False
        normalized_order = {
            re.sub(r'[^a-z0-9]', '', str(key).lower()): value
            for key, value in order.items()
        }
        has_goods = normalized_order.get('hasgoods')
        order_item_has_goods = normalized_order.get('orderitemhasgoods')
        return (
            ('' if has_goods is None else str(has_goods).strip()) == '3'
            and ('' if order_item_has_goods is None else str(order_item_has_goods).strip()) == '0'
        )

    def inspect_fulfillment(self, order_reference, channel_value, channel_id):
        order = self.find_order_for_fulfillment(order_reference)
        internal_id = str(order.get('id') or order.get('orderId') or '').strip()
        platform_order_id = str(order.get('platformOrderId') or order_reference).strip()
        if not internal_id:
            raise Exception('订单缺少马帮内部ID。')
        channel_data = self.get_fulfillment_channel_data(internal_id)
        reporting = self.post_json_with_reauth(FULFILLMENT_REPORTING_INFO_URL, headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, data={
            'orderId': internal_id, 'tableBase': '1', 'myLogisticsChannelId': channel_value, 'orderLogisticsSearchId': ''
        }, operation='读取交运参数')
        property_json = reporting.get('propertyJson') if isinstance(reporting.get('propertyJson'), (list, dict)) else []
        order_page_html = str(channel_data.get('_orderPageHtml') or '')
        inventory_fields = {
            str(key): str(value)[:120]
            for key, value in order.items()
            if re.search(r'(goods|stock|inventory|kucun)', str(key), re.I)
        }
        channel_markup = '\n'.join(
            str(channel_data.get(key) or '') for key in ('message', 'message1', 'printlabelChannelDiv')
        )
        channel_candidate_ids = sorted(set(re.findall(
            r'(?:data-mylogisticschannelid|Logistics-delivery-myLogisticsChannelId-)\s*(?:=\s*["\'])?([0-9]+)',
            channel_markup,
            re.I,
        )))
        current_logistics_html = str(order.get('cansend1logisticsHtml') or '')
        expected_channel_name = str(channel_value or '').strip()
        expected_suffix = expected_channel_name.rpartition('_')
        if expected_suffix[2].isdigit():
            expected_channel_name = expected_suffix[0]
        expected_channel_name = expected_channel_name.split('_', 2)[-1] if '_' in expected_channel_name else expected_channel_name
        decoded_logistics_html = html.unescape(current_logistics_html)
        tracking_acquisition_pending = (
            not str(order.get('trackNumber') or '').strip()
            and str(order.get('isSyncLogistics') or '').strip() == '1'
            and '运单号获取中' in current_logistics_html
            and bool(re.search(rf'data-id\s*=\s*["\']{re.escape(str(channel_id))}["\']', current_logistics_html, re.I))
        )
        return {
            'internalOrderId': internal_id,
            'platformOrderId': platform_order_id,
            'orderStatus': str(order.get('orderStatus') or order.get('status') or ''),
            'trackNumber': str(order.get('trackNumber') or ''),
            'orderFieldNames': sorted(str(key) for key in order.keys() if re.search(r'(shop|platform|status|logistic|track|channel|sync)', str(key), re.I)),
            'channelMatched': self.batch_edit_channel_available(channel_data, channel_id, channel_value),
            'deliveryPanelChannelMatched': self.fulfillment_channel_available(channel_data, channel_id, channel_value),
            'batchEditChannelMatched': self.batch_edit_channel_available(channel_data, channel_id, channel_value),
            'batchEditChannelCount': len(self.batch_edit_channel_values(channel_data)),
            'channelResponseKeys': sorted(key for key in channel_data.keys() if not str(key).startswith('_')),
            'selectedOrderMatched': bool(channel_data.get('_selectedOrderMatched')),
            'channelCandidateIds': channel_candidate_ids,
            'channelMarkupLength': len(channel_markup),
            'channelContainsJtExpress': 'J&TExpress' in channel_markup,
            'reportingSuccess': bool(reporting.get('success')),
            'reportingMessage': str(reporting.get('message') or ''),
            'reportingResponseKeys': sorted(reporting.keys()),
            'notFoundPlatformOrderIds': reporting.get('notFoundPlatformOrderIds') or [],
            'autoApi': str(reporting.get('autoApi') or ''),
            'isSLogisticsChannel': str(reporting.get('isSLogisticsChannel') or ''),
            'isSyncLogistics': str(order.get('isSyncLogistics') or ''),
            'orderLogisticsMarkupLength': len(current_logistics_html),
            'orderLogisticsContainsChannelId': bool(re.search(
                rf'data-id\s*=\s*["\']{re.escape(str(channel_id))}["\']', current_logistics_html, re.I
            )),
            'orderLogisticsContainsConfiguredName': bool(
                expected_channel_name and expected_channel_name in decoded_logistics_html
            ),
            'orderLogisticsContainsJtExpress': 'J&TExpress' in decoded_logistics_html,
            'trackingAcquisitionPending': tracking_acquisition_pending,
            'propertyJson': property_json,
            'hasDeclarationRows': bool(str(reporting.get('stockHtml') or '').strip()),
            'stockStatus': self.fulfillment_stock_status(order),
            'inventoryFields': inventory_fields,
            'stockFlagSource': str(order.get('_fulfillmentStockFlagSource') or ''),
            'pageHtmlLength': int(order.get('_fulfillmentPageHtmlLength') or 0),
            'pageContainsOrder': bool(order.get('_fulfillmentPageContainsOrder')),
            'orderPageContainsFixedChannel': self.batch_edit_channel_available(
                {'orderPageHtml': order_page_html}, channel_id, channel_value
            ),
        }

    def prepare_fulfillment(self, order_reference, channel_value, channel_id, expected_shop_id='', expected_platform_id='',
                            single_warehouse_verified=False):
        order = self.find_order_for_fulfillment(order_reference, '2')
        internal_id = str(order.get('id') or order.get('orderId') or '').strip()
        if not internal_id:
            raise Exception('订单缺少马帮内部ID。')
        if expected_shop_id and str(order.get('shopId') or '') != str(expected_shop_id):
            raise Exception('订单店铺与固定店铺不一致，已停止发货。')
        if expected_platform_id and str(order.get('platformId') or '') != str(expected_platform_id):
            raise Exception('订单平台与固定平台不一致，已停止发货。')
        if str(order.get('orderStatus') or '') != '2':
            raise Exception('订单已不是待处理状态，已停止发货。')
        if str(order.get('trackNumber') or '').strip():
            raise Exception('订单已经存在运单号，已停止重复发货。')
        stock_status = self.fulfillment_stock_status(order)
        if stock_status == 'multi_warehouse' and self.stale_multi_warehouse_flag_is_safe(order, single_warehouse_verified):
            stock_status = 'in_stock'
        if stock_status == 'unknown':
            raise Exception('INVENTORY_UNKNOWN_BEFORE_SUBMIT: 马帮订单库存标志缺失或无法识别，已停止发货。')
        if stock_status == 'multi_warehouse':
            raise Exception('MULTI_WAREHOUSE_REQUIRES_REVIEW: 同一订单中的SKU分属不同仓库，请先在马帮待审核中人工换仓。')
        if stock_status == 'out_of_stock':
            raise Exception('OUT_OF_STOCK_BEFORE_SUBMIT: 马帮订单库存标志显示缺货，已停止发货。')

        channel_data = self.get_fulfillment_channel_data(internal_id)
        if not channel_data.get('_selectedOrderMatched'):
            raise Exception('ORDER_NOT_AVAILABLE_FOR_DELIVERY: 马帮物流交运列表未返回指定订单，已停止发货。')
        if not self.batch_edit_channel_available(channel_data, channel_id, channel_value):
            raise Exception('CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT: 固定物流渠道不在“批量修改订单”的物流渠道列表中，已停止发货。')

        reporting = self.post_json_with_reauth(FULFILLMENT_REPORTING_INFO_URL, headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, data={
            'orderId': internal_id, 'tableBase': '1', 'myLogisticsChannelId': channel_value, 'orderLogisticsSearchId': ''
        }, operation='读取交运参数')
        if not reporting.get('success'):
            raise Exception(reporting.get('message') or '读取交运参数失败。')
        if reporting.get('notFoundPlatformOrderIds'):
            raise Exception('马帮未找到指定平台订单，已停止发货。')
        if str(reporting.get('isSLogisticsChannel') or '') == '2':
            raise Exception('订单已有交运记录，不支持二次交运。')
        if str(reporting.get('stockHtml') or '').strip():
            raise Exception('订单需要补充申报信息，自动发货已停止。')
        property_json = reporting.get('propertyJson') or []
        if isinstance(property_json, dict):
            property_json = list(property_json.values())
        for prop in property_json if isinstance(property_json, list) else []:
            if not isinstance(prop, dict):
                continue
            name = str(prop.get('name') or '').strip()
            value = prop.get('value')
            if prop.get('require') and (value is None or str(value).strip() == ''):
                raise Exception(f'物流渠道必填参数缺失：{name or "未知参数"}。')

        return {
            'order': order,
            'internalOrderId': internal_id,
            'platformOrderId': str(order.get('platformOrderId') or order_reference).strip(),
            'stockStatus': stock_status,
            'channelMatched': True,
            'reporting': reporting,
            'propertyJson': property_json if isinstance(property_json, list) else [],
        }

    def preflight_fulfillment(self, order_reference, channel_value, channel_id, expected_shop_id='', expected_platform_id='',
                              single_warehouse_verified=False):
        prepared = self.prepare_fulfillment(
            order_reference, channel_value, channel_id, expected_shop_id, expected_platform_id,
            single_warehouse_verified
        )
        required_properties = [
            str(prop.get('name') or '').strip()
            for prop in prepared['propertyJson']
            if isinstance(prop, dict) and prop.get('require')
        ]
        return {
            'ready': True,
            'wouldSubmit': False,
            'internalOrderId': prepared['internalOrderId'],
            'platformOrderId': prepared['platformOrderId'],
            'orderStatus': str(prepared['order'].get('orderStatus') or ''),
            'hasTrackingNumber': bool(str(prepared['order'].get('trackNumber') or '').strip()),
            'stockStatus': prepared['stockStatus'],
            'channelMatched': prepared['channelMatched'],
            'reportingSuccess': bool(prepared['reporting'].get('success')),
            'hasDeclarationRows': bool(str(prepared['reporting'].get('stockHtml') or '').strip()),
            'requiredPropertyCount': len(required_properties),
            'missingRequiredPropertyCount': 0,
            'checks': [
                'shop', 'platform', 'pending_status', 'empty_tracking_number',
                'inventory', 'available_channel', 'reporting_parameters',
                'no_existing_shipping_record', 'no_declaration_rows', 'required_properties',
            ],
        }

    def distribute_existing_fulfillment(self, order_reference, expected_tracking_number, channel_value, channel_id,
                                         expected_shop_id='', expected_platform_id='', verify_timeout_seconds=90):
        order = self.find_order_for_fulfillment(order_reference, '')
        internal_id = str(order.get('id') or order.get('orderId') or '').strip()
        if not internal_id:
            raise Exception('订单缺少马帮内部ID。')
        if expected_shop_id and str(order.get('shopId') or '') != str(expected_shop_id):
            raise Exception('订单店铺与固定店铺不一致，已停止转配货。')
        if expected_platform_id and str(order.get('platformId') or '') != str(expected_platform_id):
            raise Exception('订单平台与固定平台不一致，已停止转配货。')

        tracking_number = str(order.get('trackNumber') or '').strip()
        if not tracking_number or tracking_number != str(expected_tracking_number or '').strip():
            raise Exception('TRACKING_MISMATCH_BEFORE_DISTRIBUTION: 当前运单号与确认的运单号不一致，已停止转配货。')
        current_status = str(order.get('showOrderStatusText') or order.get('orderStatus') or '')
        if '配货中' in current_status:
            return {
                'alreadyDistributed': True, 'distributionSubmitted': False, 'verified': True,
                'internalOrderId': internal_id, 'platformOrderId': str(order.get('platformOrderId') or order_reference),
                'trackingNumber': tracking_number, 'afterStatus': current_status,
            }
        if '待处理' not in current_status:
            raise Exception(f'ORDER_STATUS_NOT_PENDING_BEFORE_DISTRIBUTION: 当前订单状态为【{current_status}】，已停止转配货。')

        channel_data = self.get_fulfillment_channel_data(internal_id)
        if not channel_data.get('_selectedOrderMatched'):
            raise Exception('ORDER_NOT_AVAILABLE_FOR_DELIVERY: 马帮物流交运列表未返回指定订单，已停止转配货。')
        if not self.batch_edit_channel_available(channel_data, channel_id, channel_value):
            raise Exception('CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT: 固定物流渠道不可用，已停止转配货。')
        if not self.fulfillment_order_channel_selected(order, channel_id, channel_value):
            raise Exception('TRACKING_CHANNEL_MISMATCH_BEFORE_DISTRIBUTION: 当前订单实际物流渠道与固定渠道不一致，已停止转配货。')

        response = self.session.post(
            FULFILLMENT_DISTRIBUTION_URL,
            headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
            data={'orderIds': internal_id, 'type': '1'}, timeout=REQUEST_TIMEOUT, allow_redirects=True,
        )
        if response_looks_unauthenticated(response):
            raise Exception('MABANG_AUTH_EXPIRED_DURING_DISTRIBUTION: 转入配货中时登录状态失效；系统不会自动重试。')
        result = safe_json(response)
        if response_looks_unauthenticated(response, result):
            raise Exception('MABANG_AUTH_EXPIRED_DURING_DISTRIBUTION: 转入配货中时登录状态失效；系统不会自动重试。')
        if not result.get('success'):
            raise Exception(result.get('message') or '马帮拒绝转入配货中。')

        deadline = time.time() + max(15, min(int(verify_timeout_seconds), 300))
        latest = order
        while time.time() < deadline:
            time.sleep(3)
            try:
                latest = self.find_order_for_fulfillment(order_reference, '')
            except Exception:
                continue
            latest_tracking = str(latest.get('trackNumber') or '').strip()
            latest_status = str(latest.get('showOrderStatusText') or latest.get('orderStatus') or '')
            if latest_tracking == tracking_number and '配货中' in latest_status:
                return {
                    'alreadyDistributed': False, 'distributionSubmitted': True, 'verified': True,
                    'internalOrderId': internal_id,
                    'platformOrderId': str(latest.get('platformOrderId') or order_reference),
                    'trackingNumber': latest_tracking, 'afterStatus': latest_status,
                    'message': str(result.get('message') or '已开始配货'),
                }
        latest_status = str(latest.get('showOrderStatusText') or latest.get('orderStatus') or '')
        return {
            'alreadyDistributed': False, 'distributionSubmitted': True, 'verified': False,
            'internalOrderId': internal_id, 'platformOrderId': str(latest.get('platformOrderId') or order_reference),
            'trackingNumber': str(latest.get('trackNumber') or '').strip(), 'afterStatus': latest_status,
            'message': '马帮已接受转配货请求，但状态回查尚未变为配货中。',
        }

    def clear_pending_tracking_channel(self, order_reference, channel_value, channel_id,
                                       expected_shop_id='', expected_platform_id=''):
        """清空审批超时订单的物流渠道；只执行 UI“批量修改订单”中的空渠道动作。"""
        order = self.find_order_for_fulfillment(order_reference, '2')
        internal_id = str(order.get('id') or order.get('orderId') or '').strip()
        platform_order_id = str(order.get('platformOrderId') or order_reference).strip()
        if not internal_id:
            raise Exception('订单缺少马帮内部ID。')
        if expected_shop_id and str(order.get('shopId') or '') != str(expected_shop_id):
            raise Exception('TRACKING_RESET_SHOP_MISMATCH: 订单店铺与固定店铺不一致，已停止清空物流渠道。')
        if expected_platform_id and str(order.get('platformId') or '') != str(expected_platform_id):
            raise Exception('TRACKING_RESET_PLATFORM_MISMATCH: 订单平台与固定平台不一致，已停止清空物流渠道。')
        if str(order.get('orderStatus') or '') != '2':
            raise Exception('TRACKING_RESET_STATUS_CHANGED: 订单已不是待处理状态，已停止清空物流渠道。')
        if str(order.get('trackNumber') or '').strip():
            raise Exception('TRACKING_RESET_HAS_TRACKING: 订单已出现运单号，已停止清空物流渠道。')
        stock_status = self.fulfillment_stock_status(order)
        if stock_status != 'in_stock':
            raise Exception(f'TRACKING_RESET_INVENTORY_UNSAFE: 当前库存状态为 {stock_status}，已停止清空物流渠道。')

        reporting = self.post_json_with_reauth(
            FULFILLMENT_REPORTING_INFO_URL,
            headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
            data={'orderId': internal_id, 'tableBase': '1', 'myLogisticsChannelId': channel_value,
                  'orderLogisticsSearchId': ''}, operation='复核待审批交运记录'
        )
        if not reporting.get('success'):
            raise Exception(reporting.get('message') or '读取待审批交运记录失败。')
        current_logistics_html = str(order.get('cansend1logisticsHtml') or '')
        row_shows_tracking_pending = (
            str(order.get('isSyncLogistics') or '').strip() == '1'
            and '运单号获取中' in current_logistics_html
            and bool(re.search(rf'data-id\s*=\s*["\']{re.escape(str(channel_id))}["\']', current_logistics_html, re.I))
        )
        if str(reporting.get('isSLogisticsChannel') or '') != '2' and not row_shows_tracking_pending:
            raise Exception('TRACKING_RESET_NOT_PENDING: 当前订单没有可确认的既有交运记录，已停止清空物流渠道。')

        # 在产生外部修改前再读一次，缩小运单号恰好审批成功时的竞态窗口。
        latest = self.find_order_for_fulfillment(order_reference, '2')
        if str(latest.get('id') or latest.get('orderId') or '').strip() != internal_id:
            raise Exception('TRACKING_RESET_ORDER_CHANGED: 马帮返回的订单已变化，已停止清空物流渠道。')
        if str(latest.get('orderStatus') or '') != '2' or str(latest.get('trackNumber') or '').strip():
            raise Exception('TRACKING_RESET_ORDER_CHANGED: 订单状态或运单号已变化，已停止清空物流渠道。')

        response = self.session.post(
            FULFILLMENT_BATCH_EDIT_URL,
            headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
            data=[
                ('sourceflag', '1'), ('platformOrderIds', platform_order_id), ('order-edit[]', '2'),
                ('selChannel', ''), ('myLogisticsChannelId', ''), ('tableBase', '1'),
                ('isOrderPhz', '1'), ('issecondsyc', '2'), ('confirmActiveFlag', '0'),
            ], timeout=REQUEST_TIMEOUT, allow_redirects=True,
        )
        if response_looks_unauthenticated(response):
            raise Exception('MABANG_AUTH_EXPIRED_DURING_TRACKING_RESET: 清空物流渠道时登录状态失效；系统不会自动重试。')
        result = safe_json(response)
        if response_looks_unauthenticated(response, result):
            raise Exception('MABANG_AUTH_EXPIRED_DURING_TRACKING_RESET: 清空物流渠道时登录状态失效；系统不会自动重试。')
        if not result.get('success'):
            raise Exception(result.get('message') or '马帮拒绝清空物流渠道。')
        if result.get('platformOrderIdArr'):
            raise Exception('TRACKING_RESET_EXTRA_CONFIRMATION_REQUIRED: 马帮要求额外人工确认，已停止自动恢复。')
        if result.get('notFoundPlatformOrderIds'):
            raise Exception('TRACKING_RESET_ORDER_NOT_FOUND: 马帮未找到指定订单，已停止自动恢复。')

        verified = self.find_order_for_fulfillment(order_reference, '2')
        verified_status = str(verified.get('showOrderStatusText') or verified.get('orderStatus') or '')
        verified_tracking = str(verified.get('trackNumber') or '').strip()
        if '待处理' not in verified_status and str(verified.get('orderStatus') or '') != '2':
            raise Exception(f'TRACKING_RESET_VERIFY_FAILED: 清空后订单状态为【{verified_status}】。')
        if verified_tracking:
            return {'cleared': True, 'trackingNumber': verified_tracking, 'orderStatus': verified_status,
                    'platformOrderId': platform_order_id, 'message': str(result.get('message') or '')}
        return {'cleared': True, 'trackingNumber': '', 'orderStatus': verified_status,
                'platformOrderId': platform_order_id, 'message': str(result.get('message') or '物流渠道已清空')}

    def submit_fulfillment(self, order_reference, channel_value, channel_id, channel_source='1', expected_shop_id='', expected_platform_id='',
                           verify_timeout_seconds=90, single_warehouse_verified=False):
        total_started = time.monotonic()
        prepare_started = time.monotonic()
        prepared = self.prepare_fulfillment(
            order_reference, channel_value, channel_id, expected_shop_id, expected_platform_id,
            single_warehouse_verified
        )
        prepare_ms = round((time.monotonic() - prepare_started) * 1000)
        order = prepared['order']
        internal_id = prepared['internalOrderId']
        property_json = prepared['propertyJson']
        submit_data = [
            ('myLogisticsChannelId', channel_value), ('orderId', internal_id), ('source', str(channel_source)),
            ('tableBase', '1'), ('trackNumber', ''), ('quickaccessBol', '2'), ('dataChanges', '1'), ('isSyncLogistics', '1')
        ]
        for prop in property_json:
            if not isinstance(prop, dict):
                continue
            name = str(prop.get('name') or '').strip()
            value = prop.get('value')
            if not name or value is None or str(value).strip() == '':
                continue
            if isinstance(value, list):
                submit_data.extend((name + '[]', str(item)) for item in value)
            else:
                submit_data.append((name, str(value)))

        submit_started = time.monotonic()
        response = self.session.post(FULFILLMENT_SUBMIT_URL, headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
            data=submit_data, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        submit_request_ms = round((time.monotonic() - submit_started) * 1000)
        if response_looks_unauthenticated(response):
            raise Exception('MABANG_AUTH_EXPIRED_DURING_SUBMIT: 提交时登录状态失效；为避免重复发货，系统不会自动重试。')
        submitted = safe_json(response)
        if response_looks_unauthenticated(response, submitted):
            raise Exception('MABANG_AUTH_EXPIRED_DURING_SUBMIT: 提交时登录状态失效；为避免重复发货，系统不会自动重试。')
        if not submitted.get('success'):
            raise Exception(submitted.get('message') or '马帮交运提交失败。')

        verify_seconds = max(15, min(int(verify_timeout_seconds), 300))
        deadline = time.time() + verify_seconds
        latest = order
        channel_matched = False
        tracking_poll_count = 0
        tracking_started = time.monotonic()
        while time.time() < deadline:
            time.sleep(3)
            try:
                latest = self.find_order_for_fulfillment(order_reference, '')
            except Exception:
                continue
            tracking_poll_count += 1
            channel_matched = self.fulfillment_order_channel_selected(latest, channel_id, channel_value)
            if str(latest.get('trackNumber') or '').strip() and channel_matched:
                break
        tracking_wait_ms = round((time.monotonic() - tracking_started) * 1000)

        tracking_number = str(latest.get('trackNumber') or '').strip()
        after_status = str(latest.get('showOrderStatusText') or latest.get('orderStatus') or '')
        distribution_submitted = False
        distribution_success = False
        distribution_message = ''
        distribution_error_code = ''
        distribution_request_ms = 0
        distribution_wait_ms = 0
        distribution_poll_count = 0

        if tracking_number and channel_matched and '配货中' in after_status:
            distribution_success = True
        elif tracking_number and channel_matched:
            distribution_submitted = True
            distribution_request_started = time.monotonic()
            distribution_response = self.session.post(
                FULFILLMENT_DISTRIBUTION_URL,
                headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'},
                data={'orderIds': internal_id, 'type': '1'},
                timeout=REQUEST_TIMEOUT,
                allow_redirects=True,
            )
            distribution_request_ms = round((time.monotonic() - distribution_request_started) * 1000)
            if response_looks_unauthenticated(distribution_response):
                distribution_error_code = 'MABANG_AUTH_EXPIRED_DURING_DISTRIBUTION'
                distribution_message = '转入配货中时登录状态失效；为避免重复操作，系统不会自动重试。'
            else:
                distribution_result = safe_json(distribution_response)
                if response_looks_unauthenticated(distribution_response, distribution_result):
                    distribution_error_code = 'MABANG_AUTH_EXPIRED_DURING_DISTRIBUTION'
                    distribution_message = '转入配货中时登录状态失效；为避免重复操作，系统不会自动重试。'
                elif not distribution_result.get('success'):
                    distribution_error_code = 'DISTRIBUTION_REJECTED'
                    distribution_message = str(distribution_result.get('message') or '马帮拒绝转入配货中。')
                else:
                    distribution_message = str(distribution_result.get('message') or '已开始配货')
                    distribution_deadline = time.time() + verify_seconds
                    distribution_wait_started = time.monotonic()
                    while time.time() < distribution_deadline:
                        time.sleep(3)
                        try:
                            latest = self.find_order_for_fulfillment(order_reference, '')
                        except Exception:
                            continue
                        distribution_poll_count += 1
                        after_status = str(latest.get('showOrderStatusText') or latest.get('orderStatus') or '')
                        latest_tracking = str(latest.get('trackNumber') or '').strip()
                        if '配货中' in after_status and latest_tracking == tracking_number:
                            distribution_success = True
                            break
                    distribution_wait_ms = round((time.monotonic() - distribution_wait_started) * 1000)
                    if not distribution_success:
                        distribution_error_code = 'DISTRIBUTION_VERIFY_FAILED'
                        if not distribution_message:
                            distribution_message = '马帮已接受转配货请求，但状态回查尚未变为配货中。'

        sync_status = str(latest.get('isSyncLogistics') or '')
        verified = bool(tracking_number and channel_matched and distribution_success and '配货中' in after_status)
        return {
            'submitted': True, 'verified': verified,
            'trackingNumber': tracking_number, 'afterStatus': after_status,
            'channelVerified': channel_matched, 'syncLogisticsStatus': sync_status,
            'distributionSubmitted': distribution_submitted,
            'distributionSuccess': distribution_success,
            'distributionErrorCode': distribution_error_code,
            'distributionMessage': distribution_message,
            'message': str(submitted.get('message') or ''),
            'timingsMs': {
                'prepare': prepare_ms,
                'submitRequest': submit_request_ms,
                'trackingWait': tracking_wait_ms,
                'distributionRequest': distribution_request_ms,
                'distributionWait': distribution_wait_ms,
                'total': round((time.monotonic() - total_started) * 1000),
                'trackingPollCount': tracking_poll_count,
                'distributionPollCount': distribution_poll_count,
            },
        }

    def search_orders_page(self, page, paid_start, paid_end, use_worker_session=False, update_export_context=False):
        params = build_order_params(page, paid_start, paid_end)
        request_session = self.worker_session() if use_worker_session else self.session
        last_error = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                logger.info(f'查询订单第 {page} 页，第 {attempt}/{MAX_RETRIES} 次')
                response = request_session.post(ORDER_SEARCH_URL, headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, data=params, timeout=REQUEST_TIMEOUT, allow_redirects=True)
                data = safe_json(response)
                if not data.get('success'):
                    raise Exception(data.get('message') or '订单接口返回失败')
                orders = data.get('orderDataList') or []
                if update_export_context:
                    page_html = data.get('pageHtml', '')
                    self.last_po_data = extract_po_data(page_html)
                    total_count = extract_order_total_count(page_html)
                    try:
                        raw_page_count = int(data.get('pageCount') or 0)
                    except Exception:
                        raw_page_count = 0
                    if total_count is not None:
                        self.last_page_count = max(1, (total_count + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE)
                    elif raw_page_count >= len(orders) and raw_page_count > 0:
                        self.last_page_count = max(1, (raw_page_count + ROWS_PER_PAGE - 1) // ROWS_PER_PAGE)
                    else:
                        self.last_page_count = raw_page_count or None
                    if self.last_page_count is not None:
                        logger.info(f'接口计算总页数：{self.last_page_count}')
                logger.info(f'第 {page} 页返回订单 {len(orders)} 条')
                return orders
            except Exception as error:
                last_error = error
                logger.warning(f'第 {page} 页请求失败，第 {attempt}/{MAX_RETRIES} 次：{error}')
                if attempt < MAX_RETRIES:
                    time.sleep(attempt)
        raise Exception(f'第 {page} 页订单查询失败：{last_error}')

    @staticmethod
    def append_export_ids(orders, ids, seen):
        for order in orders:
            export_id = order.get('platformOrderId')
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
        logger.info(f'本次最大查询页码：第 {START_PAGE} 页至第 {final_page} 页')
        first_orders = self.search_orders_page(START_PAGE, paid_start, paid_end, update_export_context=True)
        if not first_orders:
            logger.info(f'第 {START_PAGE} 页无数据，停止翻页')
            return ids
        self.append_export_ids(first_orders, ids, seen)
        if self.last_page_count is not None:
            final_page = min(final_page, self.last_page_count)
        if final_page <= START_PAGE:
            logger.info(f'本次收集到可导出订单数：{len(ids)}')
            return ids
        if self.last_page_count is None and len(first_orders) < ROWS_PER_PAGE:
            logger.info(f'本次收集到可导出订单数：{len(ids)}')
            return ids
        remaining_pages = list(range(START_PAGE + 1, final_page + 1))
        page_results = {}
        workers = min(max(1, SEARCH_PAGE_WORKERS), len(remaining_pages))
        logger.info(f'并发查询剩余 {len(remaining_pages)} 页，并发数：{workers}')
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_map = {executor.submit(self.search_orders_page, page, paid_start, paid_end, True, False): page for page in remaining_pages}
            for future in as_completed(future_map):
                page = future_map[future]
                page_results[page] = future.result()
        for page in remaining_pages:
            orders = page_results.get(page) or []
            if not orders:
                continue
            self.append_export_ids(orders, ids, seen)
        logger.info(f'本次收集到可导出订单数：{len(ids)}')
        return ids

    def open_export_template(self, order_ids):
        data = []
        for oid in order_ids:
            data.append(('orders[]', oid))
        data.append(('tableBase', '1'))
        data.append(('type', '1'))
        data.append(('poData', self.last_po_data or '{}'))
        data.append(('allBol', '0'))
        response = self.session.post(EXPORT_TEMPLATE_URL, headers={**HEADERS_AJAX, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}, data=data, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        result = safe_json(response)
        if not result.get('success'):
            raise Exception(f'打开导出模板失败：{result}')

    def get_export_iframe_template(self):
        if self.cached_export_fields and self.cached_standard_version:
            logger.info('复用已解析的导出模板字段')
            return (self.cached_export_fields, self.cached_standard_version)
        response = self.session.get(EXPORT_PAGE_URL, headers=HEADERS_PAGE, params={'isCloud': '2', 'tableBase': '1', 'os': '', 'orderItemOrderBy': 'id asc,stockId asc'}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        iframe_url = extract_iframe_url(response.text or '')
        response = self.session.get(iframe_url, headers={**HEADERS_PAGE, 'Referer': EXPORT_PAGE_URL, 'Cookie': self.cookie_header()}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        export_fields, standard_version = parse_template_from_iframe(response.text or '')
        self.cached_export_fields = export_fields
        self.cached_standard_version = standard_version
        logger.info(f'导出模板字段数：{len(export_fields)}，standardVersion={standard_version}')
        return (export_fields, standard_version)

    def wait_step4_file_url(self, sn, task_id):
        start_time = time.time()
        while True:
            if time.time() - start_time > EXPORT_WAIT_SECONDS:
                raise Exception('等待导出文件超时。')
            response = self.session.post(EXPORT_DATA_URL, headers=self.private_headers(), data={'step4': '1', 'sn': sn, 'taskId': str(task_id)}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
            result = safe_json(response)
            if result.get('success') is False:
                raise Exception(f'导出 step4 失败：{result}')
            file_url = result.get('file_url') or result.get('gourl')
            if result.get('state') and file_url:
                logger.info('导出文件已生成')
                return file_url.replace('\\/', '/')
            logger.info('导出文件生成中，等待 2 秒')
            time.sleep(2)

    def download_excel_records(self, file_url, fallback_raw_rows=None, export_fields=None):
        file_url = file_url.replace('\\/', '/')
        logger.info(f'下载导出 Excel：{file_url}')
        response = self.session.get(file_url, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if response.status_code != 200:
            raise Exception(f'下载 Excel 失败，状态码：{response.status_code}')
        try:
            df = read_excel_content(response.content)
            records = normalize_excel_dataframe(df)
            logger.info(f'Excel 解析成功，明细 {len(records)} 行')
            return records
        except Exception as e:
            logger.warning(f'Excel 解析失败：{e}')
            if fallback_raw_rows and export_fields:
                logger.warning('使用 step2 返回数据兜底解析。')
                return normalize_export_rows(fallback_raw_rows, export_fields)
            raise

    def execute_step2_subtask(self, sn, sub_no, subtask_num):
        request_session = self.worker_session()
        last_error = None
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = request_session.post(EXPORT_DATA_URL, headers=self.private_headers(), data={'step2': '1', 'sn': sn, 'sub_no': str(sub_no)}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
                step2 = safe_json(response)
                if not step2.get('success'):
                    raise Exception(step2.get('message') or str(step2))
                result_data = (step2.get('res') or {}).get('res') or {}
                raw_datas = result_data.get('datas')
                has_raw_datas = isinstance(raw_datas, list)
                datas = raw_datas if has_raw_datas else []
                logger.info(f'导出 step2 完成：{sub_no}/{subtask_num}，明细 {len(datas)} 行')
                return (sub_no, datas, has_raw_datas)
            except Exception as error:
                last_error = error
                if attempt < MAX_RETRIES:
                    logger.warning(f'导出 step2 {sub_no}/{subtask_num} 失败，第 {attempt}/{MAX_RETRIES} 次：{error}')
                    time.sleep(attempt)
        raise Exception(f'导出 step2 {sub_no}/{subtask_num} 连续失败：{last_error}')

    def execute_step2_tasks(self, sn, subtask_num):
        workers = min(max(1, EXPORT_STEP2_WORKERS), subtask_num)
        results = {}
        if workers == 1:
            for sub_no in range(1, subtask_num + 1):
                result = self.execute_step2_subtask(sn, sub_no, subtask_num)
                results[sub_no] = result
        else:
            logger.info(f'并发执行 step2，并发数：{workers}')
            with ThreadPoolExecutor(max_workers=workers) as executor:
                future_map = {executor.submit(self.execute_step2_subtask, sn, sub_no, subtask_num): sub_no for sub_no in range(1, subtask_num + 1)}
                for future in as_completed(future_map):
                    sub_no = future_map[future]
                    results[sub_no] = future.result()
        all_rows = []
        all_subtasks_have_data = True
        for sub_no in range(1, subtask_num + 1):
            _, datas, has_raw_datas = results[sub_no]
            all_rows.extend(datas)
            all_subtasks_have_data = all_subtasks_have_data and has_raw_datas
        return (all_rows, all_subtasks_have_data)

    def export_batch_to_records(self, order_ids):
        logger.info(f'打开导出模板，订单数：{len(order_ids)}')
        self.open_export_template(order_ids)
        export_fields, standard_version = self.get_export_iframe_template()
        payload = [('backUrl', ''), ('orderIds', '\n'.join(order_ids)), ('templateName', ''), ('templateId', EXPORT_TEMPLATE_ID), ('standardVersion', standard_version), ('orderItemOrderBy', 'id asc,stockId asc'), ('pageSave', '1')]
        for field_name, uq in export_fields:
            payload.append(('map-name[]', field_name))
            payload.append(('map-uq[]', uq))
            payload.append(('map-text[]', ''))
        payload.append(('tableBase', '1'))
        # Match Mabang's default export UI: do not merge common order fields.
        # mergeShow is intentionally omitted so multi-product rows stay unmerged too.
        payload.append(('hbddgyxx', '2'))
        payload.append(('step1', '1'))
        logger.info('提交导出 step1')
        response = self.session.post(EXPORT_DATA_URL, headers=self.private_headers(), data=payload, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        step1 = safe_json(response)
        if not step1.get('success'):
            raise Exception(f'导出 step1 失败：{step1}')
        if step1.get('success_type') == 1 and step1.get('file_url'):
            return self.download_excel_records(step1.get('file_url'))
        sn = step1.get('sn')
        subtask_num = int(step1.get('subtask_num') or 0)
        if not sn or subtask_num <= 0:
            raise Exception(f'导出 step1 未返回有效 sn/subtask_num：{step1}')
        fallback_raw_rows, all_subtasks_have_data = self.execute_step2_tasks(sn, subtask_num)
        logger.info(f'step2 明细缓存：{len(fallback_raw_rows)} 行')
        if USE_STEP2_DATA_FAST_PATH and all_subtasks_have_data and fallback_raw_rows:
            try:
                records = normalize_export_rows(fallback_raw_rows, export_fields)
                if records:
                    logger.info('快速路径生效：直接使用 step2 明细，跳过 step3、文件生成等待和 Excel 下载')
                    return records
            except Exception as error:
                logger.warning(f'step2 明细快速解析失败，自动降级到 Excel 流程：{error}')
        logger.info('执行导出 step3')
        response = self.session.post(EXPORT_DATA_URL, headers=self.private_headers(), data={'step3': '1', 'sn': sn}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        step3 = safe_json(response)
        if not step3.get('success'):
            raise Exception(f'导出 step3 失败：{step3}')
        file_url = step3.get('file_url') or step3.get('gourl')
        if file_url:
            return self.download_excel_records(file_url, fallback_raw_rows, export_fields)
        if step3.get('async') and step3.get('taskId'):
            file_url = self.wait_step4_file_url(sn, step3.get('taskId'))
            return self.download_excel_records(file_url, fallback_raw_rows, export_fields)
        if fallback_raw_rows:
            logger.warning('没有 Excel 文件链接，使用 step2 返回数据兜底。')
            return normalize_export_rows(fallback_raw_rows, export_fields)
        raise Exception(f'导出完成但没有文件链接，也没有明细数据：{step3}')

    def export_orders_to_records(self, order_ids):
        all_records = []
        batches = chunk_list(order_ids, EXPORT_BATCH_SIZE)
        for index, batch in enumerate(batches, start=1):
            batch_started = time.monotonic()
            logger.info(f'开始导出第 {index}/{len(batches)} 批，订单数：{len(batch)}')
            try:
                records = self.export_batch_to_records(batch)
                elapsed = time.monotonic() - batch_started
                logger.info(f'第 {index} 批导出明细：{len(records)} 行，耗时 {elapsed:.2f} 秒')
                all_records.extend(records)
            except Exception as e:
                logger.error(f'第 {index} 批导出失败，已停止后续写入：{e}')
                raise
            if REQUEST_INTERVAL_SECONDS > 0 and index < len(batches):
                time.sleep(REQUEST_INTERVAL_SECONDS)
        return all_records

def run_sync():
    run_started = time.monotonic()
    paid_start, paid_end = get_sync_time_range()
    logger.info(f'本次同步付款时间：{paid_start} 至 {paid_end}')
    logger.info('订单状态：全部状态')
    logger.info(f'批量导出大小：{EXPORT_BATCH_SIZE}')
    logger.info(f"加速配置：查询并发={SEARCH_PAGE_WORKERS}，step2并发={EXPORT_STEP2_WORKERS}，step2直接解析={('开启' if USE_STEP2_DATA_FAST_PATH else '关闭')}")
    logger.info('写入方式：不删除原表数据，直接追加写入')
    client = MabangClient()
    login_started = time.monotonic()
    client.login(USERNAME, PASSWORD)
    logger.info(f'登录阶段耗时：{time.monotonic() - login_started:.2f} 秒')
    search_started = time.monotonic()
    order_ids = client.collect_export_orders(paid_start, paid_end)
    logger.info(f'订单查询阶段耗时：{time.monotonic() - search_started:.2f} 秒')
    if not order_ids:
        message = '没有查询到订单，本次不写入数据。'
        logger.info(message)
        return {'success': True, 'message': message, 'orders': 0, 'rows': 0, 'inserted': 0}
    export_started = time.monotonic()
    records = client.export_orders_to_records(order_ids)
    logger.info(f'订单导出阶段耗时：{time.monotonic() - export_started:.2f} 秒')
    logger.info(f'导出明细总行数：{len(records)}')
    if not records:
        message = '导出明细为0，本次不写入数据。'
        logger.warning(message)
        return {'success': False, 'message': message, 'orders': len(order_ids), 'rows': 0, 'inserted': 0}
    write_started = time.monotonic()
    inserted = insert_records_to_wps(records, TARGET_TABLE_NAME)
    logger.info(f'WPS 写入阶段耗时：{time.monotonic() - write_started:.2f} 秒')
    total_elapsed = time.monotonic() - run_started
    message = f'同步完成：付款时间 {paid_start} 至 {paid_end}，订单状态【全部】，订单 {len(order_ids)} 个，导出明细 {len(records)} 行，导入 {inserted} 行，总耗时 {total_elapsed:.2f} 秒。'
    logger.info(message)
    return {'success': True, 'message': message, 'orders': len(order_ids), 'rows': len(records), 'inserted': inserted, 'elapsed_seconds': round(total_elapsed, 2)}
