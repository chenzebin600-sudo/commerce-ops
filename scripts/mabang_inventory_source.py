# Generated from user-provided WPS script. Credentials and auto-run block removed.
import re
import io
import json
import time
import html
import zipfile
import traceback
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from datetime import date, datetime
import requests
import pandas as pd
from requests.exceptions import ReadTimeout, RequestException
USERNAME = ''
PASSWORD = ''
TARGET_TABLE_NAME = '库存查询'
EXPORT_PAGE_SIZE = 10000
SEARCH_ROWS_PER_PAGE = 50
WPS_INSERT_BATCH_SIZE = 5000
SHOW_RMB_COLUMN = 0
REQUEST_TIMEOUT = (10, 180)
EXPORT_TIMEOUT = (10, 300)
MAX_RETRIES = 3
REQUEST_INTERVAL_SECONDS = 0.5
BASE_URL = 'https://900445.private.mabangerp.com'
PRIVATE_URL = 'https://private-amz.mabangerp.com'
INITIAL_URL = BASE_URL + '/index.php?mod=main.loginPage'
LOGIN_URL = BASE_URL + '/index.php?mod=main.doLogin'
ORDER_PAGE_URL = BASE_URL + '/index.php?mod=order.list'
INVENTORY_PAGE_URL = BASE_URL + '/index.php?mod=warehouse.inventorydetail'
STOCK_SEARCH_URL = PRIVATE_URL + '/index.php?mod=warehouse.searchwarehousestock'
STOCK_PAGE_INFO_URL = PRIVATE_URL + '/index.php?mod=warehouse.getSearchWarehouseStockPage'
STOCK_SUMMARY_URL = PRIVATE_URL + '/index.php?mod=warehouse.getStockTotalAndStockTotalCost'
STOCK_EXPORT_URL = PRIVATE_URL + '/index.php?mod=warehouse.doexportwarehousestock'
HEADERS_AJAX = {'Accept': 'application/json, text/javascript, */*; q=0.01', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'X-Requested-With': 'XMLHttpRequest', 'Origin': BASE_URL, 'Referer': ORDER_PAGE_URL}
HEADERS_PAGE = {'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Referer': INITIAL_URL}
TARGET_FIELDS = ['库存SKU编号', '商品状态', '活跃度', '是否新款', '一级目录', '二级目录', '三级目录', '一级品牌', '二级品牌', '采购员', '中文名称', '英文名称', '父级仓库', '仓库', '仓位', '销量(7/28/42)', '预测日销量(个)', '仓位库存', '当前可售天数', '在途量', '海外仓预调入量', '分仓调拨预调入量', '警戒量', '警戒天数', '未发货量', '分仓调拨未发货量', '可用库存量', '最后出库时间', '最后入库时间', '商品备注']
REQUIRED_FIELDS = ['库存SKU编号', '仓库', '可用库存量']


def should_use_html_inventory_source(compact, requested_warehouse_names):
    return bool(requested_warehouse_names)
NUMERIC_FIELDS = ['预测日销量(个)', '仓位库存', '当前可售天数', '在途量', '海外仓预调入量', '分仓调拨预调入量', '警戒量', '警戒天数', '未发货量', '分仓调拨未发货量', '可用库存量']

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


class HtmlTableContractParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables = []
        self.table_stack = []
        self.cell_stack = []

    def handle_starttag(self, tag, attrs):
        lowered = tag.lower()
        if lowered == 'table':
            table = {'rowCount': 0, 'cellCount': 0, 'headerLabels': []}
            self.tables.append(table)
            self.table_stack.append(table)
        elif lowered == 'tr' and self.table_stack:
            self.table_stack[-1]['rowCount'] += 1
        elif lowered in {'th', 'td'} and self.table_stack:
            self.table_stack[-1]['cellCount'] += 1
            self.cell_stack.append({'tag': lowered, 'parts': [], 'table': self.table_stack[-1]})

    def handle_data(self, data):
        if self.cell_stack:
            self.cell_stack[-1]['parts'].append(data)

    def handle_endtag(self, tag):
        lowered = tag.lower()
        if lowered in {'th', 'td'} and self.cell_stack:
            cell = self.cell_stack.pop()
            if cell['tag'] == 'th':
                label = re.sub(r'\s+', ' ', ''.join(cell['parts'])).strip()
                if label and not SENSITIVE_STRUCTURE_KEY.search(label):
                    cell['table']['headerLabels'].append(label[:80])
        elif lowered == 'table' and self.table_stack:
            self.table_stack.pop()


def describe_html_table_contracts(document):
    parser = HtmlTableContractParser()
    parser.feed(str(document or ''))
    return [
        {
            'index': index,
            'rowCount': int(table['rowCount']),
            'cellCount': int(table['cellCount']),
            'headerLabels': list(dict.fromkeys(table['headerLabels']))[:60],
        }
        for index, table in enumerate(parser.tables)
        if table['rowCount'] or table['cellCount'] or table['headerLabels']
    ][:60]


class HtmlLabelContextParser(HTMLParser):
    TARGETS = ('库存sku编号', '可用库存量', '库存sku', '可用库存')

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.contexts = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        descriptor = {'tag': tag.lower()}
        for key in ('id', 'class', 'name'):
            value = re.sub(r'[^a-zA-Z0-9_\-\s]', '', str(attributes.get(key) or ''))[:120].strip()
            if value and not SENSITIVE_STRUCTURE_KEY.search(value):
                descriptor[key] = value
        self.stack.append(descriptor)

    def handle_startendtag(self, tag, attrs):
        return

    def handle_endtag(self, tag):
        lowered = tag.lower()
        for index in range(len(self.stack) - 1, -1, -1):
            if self.stack[index].get('tag') == lowered:
                del self.stack[index:]
                break

    def handle_data(self, data):
        normalized = re.sub(r'\s+', '', str(data or '')).lower()
        hits = [target for target in self.TARGETS if target in normalized]
        if not hits:
            return
        context = {'labels': hits, 'path': self.stack[-8:]}
        if context not in self.contexts:
            self.contexts.append(context)


def describe_html_label_contexts(document):
    parser = HtmlLabelContextParser()
    parser.feed(str(document or ''))
    return parser.contexts[:30]


class HtmlElementCountParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.counts = {}

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        class_names = [part for part in str(attributes.get('class') or '').split() if re.fullmatch(r'[a-zA-Z0-9_-]+', part)]
        descriptor = tag.lower() + ('.' + '.'.join(sorted(class_names)) if class_names else '')
        self.counts[descriptor] = self.counts.get(descriptor, 0) + 1


def describe_repeated_html_elements(document):
    parser = HtmlElementCountParser()
    parser.feed(str(document or ''))
    return [
        {'element': descriptor, 'count': count}
        for descriptor, count in sorted(parser.counts.items(), key=lambda item: (-item[1], item[0]))
        if count >= 2
    ][:80]


class HtmlTagSequenceAfterInventoryHeaderParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.capturing = False
        self.header_hit_count = 0
        self.sequence = []

    def handle_data(self, data):
        normalized = re.sub(r'\s+', '', str(data or '')).lower()
        if not self.capturing and '库存sku编号' in normalized:
            self.header_hit_count += 1
            if self.header_hit_count >= 2:
                self.capturing = True

    def handle_starttag(self, tag, attrs):
        if not self.capturing or len(self.sequence) >= 180:
            return
        attributes = dict(attrs)
        descriptor = {'tag': tag.lower()}
        for key in ('id', 'class', 'name'):
            value = re.sub(r'[^a-zA-Z0-9_\-\s]', '', str(attributes.get(key) or ''))[:120].strip()
            if value and not SENSITIVE_STRUCTURE_KEY.search(value):
                descriptor[key] = value
        self.sequence.append(descriptor)


def describe_inventory_header_tag_sequence(document):
    parser = HtmlTagSequenceAfterInventoryHeaderParser()
    parser.feed(str(document or ''))
    return parser.sequence


class InventorySearchRowContractParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ul_depth = 0
        self.rows = []
        self.current_row = None

    def handle_starttag(self, tag, attrs):
        lowered = tag.lower()
        if lowered == 'ul':
            self.ul_depth += 1
            if self.ul_depth == 1:
                self.current_row = []
        elif lowered == 'li' and self.ul_depth == 1 and self.current_row is not None:
            attributes = dict(attrs)
            classes = [part for part in str(attributes.get('class') or '').split() if re.fullmatch(r'[a-zA-Z0-9_-]+', part)]
            safe_attribute_names = sorted(
                key for key in attributes
                if re.fullmatch(r'[a-zA-Z0-9_:-]+', str(key)) and not SENSITIVE_STRUCTURE_KEY.search(str(key))
            )
            self.current_row.append({
                'classNames': classes,
                'attributeNames': safe_attribute_names,
            })

    def handle_endtag(self, tag):
        if tag.lower() != 'ul' or self.ul_depth <= 0:
            return
        if self.ul_depth == 1 and self.current_row is not None:
            self.rows.append(self.current_row)
            self.current_row = None
        self.ul_depth -= 1


def describe_inventory_search_rows(document):
    parser = InventorySearchRowContractParser()
    parser.feed(str(document or ''))
    histogram = {}
    for row in parser.rows:
        histogram[str(len(row))] = histogram.get(str(len(row)), 0) + 1
    return {
        'rowCount': len(parser.rows),
        'columnCountHistogram': histogram,
        'firstRowColumns': parser.rows[0] if parser.rows else [],
    }


class InventorySearchHtmlParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ul_depth = 0
        self.li_depth = 0
        self.rows = []
        self.current_row = None
        self.current_column = None

    def handle_starttag(self, tag, attrs):
        lowered = tag.lower()
        if lowered == 'ul':
            self.ul_depth += 1
            if self.ul_depth == 1:
                self.current_row = []
            return
        if lowered == 'li' and self.ul_depth == 1:
            self.li_depth += 1
            if self.li_depth == 1 and self.current_row is not None:
                attributes = dict(attrs)
                self.current_column = {
                    'classNames': str(attributes.get('class') or '').split(),
                    'attributes': {
                        key: str(value or '')
                        for key, value in attributes.items()
                        if key in {'data-id'}
                    },
                    'texts': [],
                }
                self.current_row.append(self.current_column)

    def handle_data(self, data):
        if self.current_column is None:
            return
        value = re.sub(r'\s+', ' ', html.unescape(str(data or ''))).strip()
        if value:
            self.current_column['texts'].append(value)

    def handle_endtag(self, tag):
        lowered = tag.lower()
        if lowered == 'li' and self.ul_depth == 1 and self.li_depth > 0:
            self.li_depth -= 1
            if self.li_depth == 0:
                self.current_column = None
            return
        if lowered == 'ul' and self.ul_depth > 0:
            if self.ul_depth == 1 and self.current_row is not None:
                self.rows.append(self.current_row)
                self.current_row = None
                self.current_column = None
                self.li_depth = 0
            self.ul_depth -= 1


def parse_inventory_search_html_rows(document):
    parser = InventorySearchHtmlParser()
    parser.feed(str(document or ''))
    return parser.rows


def classify_inventory_token(value):
    text = str(value or '').strip()
    if re.fullmatch(r'-?[\d,]+(?:\.\d+)?', text):
        return 'number'
    if re.fullmatch(r'\d{4}-\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2}:\d{2})?', text):
        return 'datetime'
    if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{2,}', text) and re.search(r'[A-Za-z]', text) and re.search(r'\d', text):
        return 'identifier'
    return 'text'


def parse_inventory_search_records(document):
    parsed_rows = parse_inventory_search_html_rows(document)
    records = []
    for row_index, columns in enumerate(parsed_rows, start=1):
        if len(columns) != 10:
            raise Exception(f'库存 HTML 第 {row_index} 行列数异常：预期 10 列，实际 {len(columns)} 列')
        sku_tokens = columns[1].get('texts') or []
        warehouse_tokens = columns[3].get('texts') or []
        stock_tokens = columns[6].get('texts') or []
        if not sku_tokens or not warehouse_tokens or len(stock_tokens) < 2:
            raise Exception(f'库存 HTML 第 {row_index} 行缺少 SKU、仓库或可用库存字段')
        available_text = str(stock_tokens[1]).replace(',', '').strip()
        if not re.fullmatch(r'-?\d+(?:\.\d+)?', available_text):
            raise Exception(f'库存 HTML 第 {row_index} 行可用库存不是数字')
        available_number = float(available_text) if '.' in available_text else int(available_text)
        sales_states = {'正常销售', '停止销售', '停售', '禁售', '淘汰', '下架', '在售', '已停售'}
        trailing_tokens = [str(value).strip() for value in sku_tokens[1:] if str(value).strip()]
        sales_state = next((value for value in trailing_tokens if value in sales_states), '')
        name_tokens = [value for value in trailing_tokens if value not in sales_states]
        chinese_name = name_tokens[0] if len(name_tokens) == 1 else ''
        name_confidence = 'VERIFIED' if chinese_name else ('AMBIGUOUS' if len(name_tokens) > 1 else 'MISSING')
        records.append({
            '库存SKU编号': str(sku_tokens[0]).strip(),
            '中文名称': chinese_name,
            '名称来源': 'inventory_search_sku_cell',
            '名称置信度': name_confidence,
            '商品状态': sales_state,
            '仓库': str(warehouse_tokens[0]).strip(),
            '可用库存量': available_number,
        })
    return records


def describe_inventory_search_row_tokens(document):
    rows = parse_inventory_search_html_rows(document)
    if not rows:
        return []
    return [
        {
            'index': index,
            'classNames': column.get('classNames') or [],
            'tokenTypes': [classify_inventory_token(value) for value in column.get('texts') or []],
            'tokenLengths': [len(str(value)) for value in column.get('texts') or []],
            'tokenCount': len(column.get('texts') or []),
        }
        for index, column in enumerate(rows[0])
    ]


class InventoryHeaderLabelsParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.header_rows = []
        self.current_header = None
        self.current_cell = None

    def handle_starttag(self, tag, attrs):
        lowered = tag.lower()
        attributes = dict(attrs)
        classes = str(attributes.get('class') or '').split()
        if lowered == 'ul' and 'list-title' in classes:
            self.current_header = []
            self.header_rows.append(self.current_header)
            self.stack.append('header-ul')
            return
        self.stack.append(lowered)
        if lowered == 'li' and self.current_header is not None and self.stack.count('header-ul') == 1:
            self.current_cell = []

    def handle_data(self, data):
        if self.current_cell is not None:
            self.current_cell.append(data)

    def handle_endtag(self, tag):
        lowered = tag.lower()
        if lowered == 'li' and self.current_cell is not None and self.current_header is not None:
            label = re.sub(r'\s+', ' ', ''.join(self.current_cell)).strip()
            self.current_header.append(label[:120])
            self.current_cell = None
        if self.stack:
            marker = self.stack.pop()
            if marker == 'header-ul':
                self.current_header = None


def parse_inventory_header_labels(document):
    parser = InventoryHeaderLabelsParser()
    parser.feed(str(document or ''))
    return [row for row in parser.header_rows if row]


class InventoryHeaderRegionParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_region = False
        self.li_stack = []
        self.labels = []

    def handle_starttag(self, tag, attrs):
        lowered = tag.lower()
        attributes = dict(attrs)
        classes = str(attributes.get('class') or '').split()
        if lowered == 'ul' and 'list-title' in classes:
            self.in_region = True
        if lowered == 'ul' and str(attributes.get('id') or '') == 'warehousestocklist':
            self.in_region = False
            return
        if self.in_region and lowered == 'li':
            if self.li_stack:
                self.li_stack[-1]['hasNestedLi'] = True
            self.li_stack.append({'parts': [], 'hasNestedLi': False})

    def handle_data(self, data):
        if self.in_region and self.li_stack:
            self.li_stack[-1]['parts'].append(data)

    def handle_endtag(self, tag):
        if tag.lower() == 'li' and self.li_stack:
            cell = self.li_stack.pop()
            if not cell['hasNestedLi']:
                label = re.sub(r'\s+', ' ', ''.join(cell['parts'])).strip()
                if label:
                    self.labels.append(label[:160])


def parse_inventory_header_leaf_labels(document):
    parser = InventoryHeaderRegionParser()
    parser.feed(str(document or ''))
    return parser.labels[:40]


class WarehouseCatalogParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.options = []
        self.field_names = set()
        self.candidate_elements = []
        self.candidate_select_count = 0
        self._select_stack = []
        self._current_option = None

    @staticmethod
    def _attrs(attributes):
        return {str(key or '').strip(): str(value or '').strip() for key, value in attributes}

    @staticmethod
    def _warehouse_candidate(attributes):
        searchable = ' '.join([*attributes.keys(), *attributes.values()]).lower()
        return 'warehouse' in searchable or '仓库' in searchable

    def handle_starttag(self, tag, attributes):
        attrs = self._attrs(attributes)
        if tag == 'select':
            candidate = self._warehouse_candidate(attrs)
            self._select_stack.append(candidate)
            if candidate:
                self.candidate_select_count += 1
                for key in ('name', 'id'):
                    if attrs.get(key):
                        self.field_names.add(attrs[key])
                self.candidate_elements.append({
                    'tag': tag,
                    **{key: attrs[key] for key in ('name', 'id', 'class') if attrs.get(key)},
                })
            return
        if tag == 'input' and self._warehouse_candidate(attrs):
            for key in ('name', 'id'):
                if attrs.get(key):
                    self.field_names.add(attrs[key])
            self.candidate_elements.append({
                'tag': tag,
                **{key: attrs[key] for key in ('type', 'name', 'id', 'class', 'role') if attrs.get(key)},
                'hasValue': bool(attrs.get('value')),
            })
            return
        if tag == 'option' and self._select_stack and self._select_stack[-1]:
            self._current_option = {'id': attrs.get('value', ''), 'parts': []}

    def handle_data(self, data):
        if self._current_option is not None:
            self._current_option['parts'].append(data)

    def handle_endtag(self, tag):
        if tag == 'option' and self._current_option is not None:
            identifier = self._current_option['id'].strip()
            name = re.sub(r'\s+', ' ', ''.join(self._current_option['parts'])).strip()
            if identifier and name and name not in ('请选择', '全部', '全部仓库'):
                self.options.append({'id': identifier, 'name': name})
            self._current_option = None
            return
        if tag == 'select' and self._select_stack:
            self._select_stack.pop()


SAFE_INVENTORY_ENDPOINT = re.compile(
    r'^(?:https?://[A-Za-z0-9.-]+)?/?index\.php\?mod=[A-Za-z0-9_.-]+'
    r'(?:&[A-Za-z0-9_.%{}\[\]-]+=[A-Za-z0-9_.%{}\[\]-]*)*$'
)


def extract_inventory_endpoint_candidates(document):
    candidates = set()
    for quoted in re.findall(r'''["']([^"']+)["']''', str(document or '')):
        candidate = html.unescape(quoted).strip().replace('\\/', '/')
        lowered = candidate.lower()
        if SAFE_INVENTORY_ENDPOINT.fullmatch(candidate) and not any(
            secret in lowered for secret in ('token=', 'cmkey=', 'authorization', 'cookie', 'password')
        ):
            candidates.add(candidate)
    return sorted(candidates)


def parse_inventory_warehouse_catalog(*html_documents):
    parser = WarehouseCatalogParser()
    endpoint_candidates = set()
    for document in html_documents:
        source = str(document or '')
        parser.feed(source)
        checkbox_pattern = re.compile(r'''<input\b(?P<attrs>[^>]*\bname\s*=\s*["']warehouseIds\[\]["'][^>]*)>''', re.I)
        checkbox_matches = list(checkbox_pattern.finditer(source))
        for index, match in enumerate(checkbox_matches):
            attrs = {
                key.lower(): html.unescape(value)
                for key, _quote, value in re.findall(r'''([\w:-]+)\s*=\s*(["'])(.*?)\2''', match.group('attrs'), re.S)
            }
            identifier = str(attrs.get('value') or '').strip()
            if not identifier:
                continue
            name = str(attrs.get('data-name') or attrs.get('title') or attrs.get('aria-label') or '').strip()
            if not name:
                next_start = checkbox_matches[index + 1].start() if index + 1 < len(checkbox_matches) else min(len(source), match.end() + 600)
                tail = source[match.end():min(next_start, match.end() + 600)]
                tail = re.split(r'</(?:label|li|div)>', tail, maxsplit=1, flags=re.I)[0]
                name = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', tail))).strip(' :-—|')
            if identifier.lower() not in ('all', '0', '-1') and name not in ('请选择', '全部', '全部仓库') and name and len(name) <= 160:
                parser.options.append({'id': identifier, 'name': name})
        endpoint_candidates.update(extract_inventory_endpoint_candidates(source))
    deduplicated = {}
    for option in parser.options:
        key = (option['id'], option['name'])
        deduplicated[key] = option
    options = sorted(deduplicated.values(), key=lambda item: (item['name'], item['id']))
    return {
        'options': options,
        'fieldNames': sorted(parser.field_names),
        'candidateElements': parser.candidate_elements[:30],
        'endpointCandidates': sorted(endpoint_candidates)[:30],
        'candidateSelectCount': parser.candidate_select_count,
        'supportsWarehouseId': any(name.lower() == 'warehouseid' for name in parser.field_names),
        'supportsWarehouseIdArr': any(name.lower() == 'warehouseidarr' for name in parser.field_names),
        'supportsWarehouseIdsArray': any(name.lower() == 'warehouseids[]' for name in parser.field_names),
    }


def resolve_inventory_warehouse_scope(catalog, warehouse_names):
    requested = [re.sub(r'\s+', ' ', str(name or '')).strip() for name in (warehouse_names or []) if str(name or '').strip()]
    if not requested:
        return []
    ids_by_name = {}
    for option in catalog.get('options') or []:
        name = re.sub(r'\s+', ' ', str(option.get('name') or '')).strip()
        identifier = str(option.get('id') or '').strip()
        if name and identifier:
            ids_by_name.setdefault(name, []).append(identifier)
    missing = [name for name in requested if name not in ids_by_name]
    ambiguous = [name for name in requested if len(ids_by_name.get(name) or []) != 1]
    if missing:
        raise Exception('当前马帮账号看不到已绑定仓库：' + '、'.join(missing))
    if ambiguous:
        raise Exception('马帮仓库名称不唯一，无法安全按名称筛选：' + '、'.join(ambiguous))
    return [ids_by_name[name][0] for name in requested]

def safe_json(response):
    try:
        return response.json()
    except Exception:
        text = response.text or ''
        raise Exception(f'接口返回不是 JSON，前500字符：{text[:500]}')


SENSITIVE_STRUCTURE_KEY = re.compile(r'(token|cookie|password|passwd|secret|authorization|cmkey)', re.I)


def describe_response_structure(value, depth=0, max_depth=5):
    """Describe response shape without returning business or authentication values."""
    if depth >= max_depth:
        return {'type': type(value).__name__, 'truncated': True}
    if isinstance(value, dict):
        children = {}
        omitted_sensitive_keys = 0
        for key in sorted(value, key=lambda item: str(item))[:80]:
            key_text = str(key)
            if SENSITIVE_STRUCTURE_KEY.search(key_text):
                omitted_sensitive_keys += 1
                continue
            children[key_text] = describe_response_structure(value[key], depth + 1, max_depth)
        return {
            'type': 'object',
            'keyCount': len(value),
            'children': children,
            'omittedSensitiveKeyCount': omitted_sensitive_keys,
        }
    if isinstance(value, (list, tuple)):
        return {
            'type': 'array',
            'length': len(value),
            'item': describe_response_structure(value[0], depth + 1, max_depth) if value else None,
        }
    if isinstance(value, str):
        stripped = value.lstrip()
        lowered = value.lower()
        return {
            'type': 'string',
            'length': len(value),
            'looksLikeHtml': stripped.startswith('<'),
            'looksLikeJson': stripped.startswith('{') or stripped.startswith('['),
            'htmlTableCount': len(re.findall(r'<table\b', lowered)),
            'htmlRowCount': len(re.findall(r'<tr\b', lowered)),
            'htmlCellCount': len(re.findall(r'<t[dh]\b', lowered)),
            'hasInventorySkuLabel': '库存sku' in lowered or '库存sku编号' in lowered,
            'hasAvailableQuantityLabel': '可用库存' in lowered,
        }
    if value is None:
        return {'type': 'null'}
    if isinstance(value, bool):
        return {'type': 'boolean'}
    if isinstance(value, (int, float)):
        return {'type': 'number'}
    return {'type': type(value).__name__}

def clean_value(value):
    if value is None:
        return ''
    try:
        if pd.isna(value):
            return ''
    except Exception:
        pass
    if hasattr(value, 'item') and (not isinstance(value, (str, bytes))):
        try:
            value = value.item()
        except Exception:
            pass
    if isinstance(value, datetime):
        return value.strftime('%Y-%m-%d %H:%M:%S')
    if isinstance(value, date):
        return value.strftime('%Y-%m-%d')
    if isinstance(value, (int, float)) and (not isinstance(value, bool)):
        return value
    text = html.unescape(str(value)).strip()
    if text in ['nan', 'NaN', 'None', 'null']:
        return ''
    return text

def to_number(value):
    value = clean_value(value)
    if value == '':
        return ''
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    text = str(value).strip().replace(',', '')
    if text in ['', '--', 'nan', 'NaN', 'None', 'null']:
        return ''
    if not re.fullmatch('-?\\d+(?:\\.\\d+)?', text):
        return value
    try:
        number = float(text)
        return int(number) if number.is_integer() else number
    except Exception:
        return value

def extract_iframe_url(page_html):
    patterns = ['<iframe[^>]+id="iframeContent"[^>]+src="([^"]+)"', "<iframe[^>]+id='iframeContent'[^>]+src='([^']+)'", '<iframe[^>]+src="([^"]+)"']
    for pattern in patterns:
        match = re.search(pattern, page_html or '', re.S)
        if match:
            return html.unescape(match.group(1)).replace('\\/', '/')
    raise Exception('未找到库存查询 iframe 地址。')

def parse_record_count(page_html):
    patterns = ['共\\s*<span[^>]*class="[^"]*semibold[^"]*"[^>]*>\\s*([\\d,]+)\\s*</span>\\s*条', '共\\s*<span[^>]*>\\s*([\\d,]+)\\s*</span>\\s*条']
    for pattern in patterns:
        match = re.search(pattern, page_html or '', re.I | re.S)
        if match:
            return int(match.group(1).replace(',', ''))
    raise Exception('未能从库存分页信息中解析总记录数。')

def column_name_to_index(cell_ref):
    letters = re.sub('[^A-Z]', '', str(cell_ref).upper())
    num = 0
    for ch in letters:
        num = num * 26 + ord(ch) - ord('A') + 1
    return num - 1

def parse_xlsx_with_stdlib(content):
    ns = {'main': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'rel': 'http://schemas.openxmlformats.org/package/2006/relationships'}
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        names = archive.namelist()
        shared_strings = []
        if 'xl/sharedStrings.xml' in names:
            root = ET.fromstring(archive.read('xl/sharedStrings.xml'))
            for item in root.findall('main:si', ns):
                texts = [node.text or '' for node in item.findall('.//main:t', ns)]
                shared_strings.append(''.join(texts))
        workbook = ET.fromstring(archive.read('xl/workbook.xml'))
        first_sheet = workbook.find('main:sheets/main:sheet', ns)
        if first_sheet is None:
            return pd.DataFrame()
        rel_id = first_sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
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
        sheet_root = ET.fromstring(archive.read(sheet_path))
        rows = []
        for row_el in sheet_root.findall('.//main:sheetData/main:row', ns):
            row_values = []
            for cell in row_el.findall('main:c', ns):
                ref = cell.attrib.get('r', '')
                col_idx = column_name_to_index(ref) if ref else len(row_values)
                while len(row_values) <= col_idx:
                    row_values.append('')
                cell_type = cell.attrib.get('t')
                value_el = cell.find('main:v', ns)
                inline_nodes = cell.findall('main:is//main:t', ns)
                if cell_type == 's' and value_el is not None:
                    index = int(value_el.text or 0)
                    value = shared_strings[index] if index < len(shared_strings) else ''
                elif cell_type == 'inlineStr' and inline_nodes:
                    value = ''.join((node.text or '' for node in inline_nodes))
                elif value_el is not None:
                    value = value_el.text or ''
                else:
                    value = ''
                row_values[col_idx] = value
            rows.append(row_values)
        if not rows:
            return pd.DataFrame()
        headers = [clean_value(value) for value in rows[0]]
        max_cols = len(headers)
        normalized_rows = []
        for row in rows[1:]:
            row = row[:max_cols] + [''] * max(0, max_cols - len(row))
            normalized_rows.append(row)
        return pd.DataFrame(normalized_rows, columns=headers)

def read_excel_content(content):
    try:
        return pd.read_excel(io.BytesIO(content), dtype=object)
    except Exception as error:
        logger.warning(f'pd.read_excel 失败，改用标准库解析 xlsx：{error}')
        return parse_xlsx_with_stdlib(content)

def validate_excel_columns(dataframe):
    columns = [str(column).strip() for column in dataframe.columns]
    missing = [field for field in REQUIRED_FIELDS if field not in columns]
    if missing:
        raise Exception('马帮库存导出文件缺少库存同步必填字段：' + '、'.join(missing))

def normalize_inventory_dataframe(dataframe, target_fields=None):
    dataframe = dataframe.copy()
    dataframe.columns = [str(column).strip() for column in dataframe.columns]
    validate_excel_columns(dataframe)
    selected_fields = list(target_fields or TARGET_FIELDS)
    records = []
    for _, item in dataframe.iterrows():
        record = {}
        for field in selected_fields:
            value = clean_value(item.get(field, ''))
            record[field] = to_number(value) if field in NUMERIC_FIELDS else value
        if not str(record.get('库存SKU编号', '')).strip():
            continue
        if not str(record.get('仓库', '')).strip():
            continue
        records.append(record)
    return records

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

class MabangInventoryClient:

    def __init__(self):
        self.session = requests.Session()
        self.session.trust_env = False
        self.inventory_iframe_url = ''
        self.inventory_page_html = ''
        self.inventory_iframe_html = ''
        self.last_search_response = {}

    def cookie_header(self):
        return '; '.join((f'{cookie.name}={cookie.value}' for cookie in self.session.cookies))

    def private_ajax_headers(self):
        headers = {**HEADERS_AJAX, 'Origin': PRIVATE_URL, 'Referer': self.inventory_iframe_url, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'}
        cookie_text = self.cookie_header()
        if cookie_text:
            headers['Cookie'] = cookie_text
        return headers

    def private_download_headers(self):
        headers = {**HEADERS_PAGE, 'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,*/*', 'Referer': self.inventory_iframe_url}
        cookie_text = self.cookie_header()
        if cookie_text:
            headers['Cookie'] = cookie_text
        return headers

    def login(self, username, password):
        logger.info('打开马帮登录页')
        self.session.get(INITIAL_URL, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        logger.info('提交马帮登录')
        files = {'isMallRpcFinds': (None, ''), 'username': (None, username), 'password': (None, password), 'verifyCode': (None, ''), 'remember': (None, '1'), 'loginEntrance': (None, '1')}
        response = self.session.post(LOGIN_URL, files=files, headers=HEADERS_AJAX, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        result = safe_json(response)
        if not result.get('success'):
            message = result.get('message') or '未知错误'
            if '验证码' in message or '验证' in message:
                raise Exception('马帮登录需要人工验证，请使用 Cookie 模式或官方 API。')
            raise Exception(f'马帮登录失败：{message}')
        self.session.get(ORDER_PAGE_URL, headers=HEADERS_PAGE, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        logger.info('马帮登录成功')

    def open_inventory_page(self):
        logger.info('打开商品 > 库存查询页面')
        response = self.session.get(INVENTORY_PAGE_URL, headers={**HEADERS_PAGE, 'Referer': ORDER_PAGE_URL}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        self.inventory_page_html = response.text or ''
        self.inventory_iframe_url = extract_iframe_url(self.inventory_page_html)
        logger.info('初始化库存查询 iframe 会话')
        response = self.session.get(self.inventory_iframe_url, headers={**HEADERS_PAGE, 'Referer': INVENTORY_PAGE_URL, 'Cookie': self.cookie_header()}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        if response.status_code != 200:
            raise Exception(f'打开库存查询 iframe 失败，状态码：{response.status_code}')
        if 'warehouse.searchwarehousestock' not in (response.text or ''):
            raise Exception('库存查询 iframe 未正确加载，可能是登录会话已过期。')
        self.inventory_iframe_html = response.text or ''

    def get_warehouse_catalog(self):
        catalog = parse_inventory_warehouse_catalog(self.inventory_page_html, self.inventory_iframe_html)
        logger.info(f"库存页仓库目录探测：字段 {catalog['fieldNames']}，仓库选项 {len(catalog['options'])} 个")
        return catalog

    def build_default_search_params(self, warehouse_ids=None):
        selected_ids = [str(value).strip() for value in (warehouse_ids or []) if str(value).strip()]
        params = {'search-content-text1': '', 'page': '1', 'rowsPerPage': str(SEARCH_ROWS_PER_PAGE), 'warehouseId': '', 'startTime': '', 'endTime': '', 'isIdn': '1', 'warehouseIdArr': '', 'stockQuantitylt': '', 'stockQuantitygt': '', 'stockWarningQuantitylt': '', 'stockWarningQuantitygt': '', 'saleAvailableDayslt': '', 'saleAvailableDaysgt': ''}
        if selected_ids:
            params['warehouseIds[]'] = selected_ids
            params['warehouseIdStr'] = ','.join(selected_ids)
        return params

    def search_inventory_page(self, warehouse_ids=None, page=1, rows_per_page=None):
        page_number = max(1, int(page or 1))
        page_size = max(1, min(200, int(rows_per_page or SEARCH_ROWS_PER_PAGE)))
        params = self.build_default_search_params(warehouse_ids=warehouse_ids)
        params['page'] = str(page_number)
        params['rowsPerPage'] = str(page_size)
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                response = self.session.post(STOCK_SEARCH_URL, headers=self.private_ajax_headers(), data=params, timeout=REQUEST_TIMEOUT, allow_redirects=True)
                result = safe_json(response)
                if not result.get('success'):
                    raise Exception(result.get('message') or '库存查询接口返回失败')
                self.last_search_response = result
                return result
            except (ReadTimeout, RequestException) as error:
                logger.warning(f'库存查询第 {page_number} 页请求失败，第 {attempt}/{MAX_RETRIES} 次：{error}')
                time.sleep(3)
        raise Exception(f'库存查询第 {page_number} 页失败')

    def initialize_default_search(self, warehouse_ids=None, rows_per_page=None):
        logger.info('执行库存查询条件')
        result = self.search_inventory_page(warehouse_ids=warehouse_ids, page=1, rows_per_page=rows_per_page or SEARCH_ROWS_PER_PAGE)
        logger.info('库存查询条件初始化成功')
        return result

    def get_record_count(self):
        response = self.session.post(STOCK_PAGE_INFO_URL, headers=self.private_ajax_headers(), data={'page': '1', 'rowsPerPage': str(SEARCH_ROWS_PER_PAGE)}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        result = safe_json(response)
        if not result.get('success'):
            raise Exception(f'获取库存分页信息失败：{result}')
        record_count = parse_record_count(result.get('pageHtml', ''))
        logger.info(f'库存查询总记录数：{record_count}')
        return record_count

    def get_page_response_contract(self, page=1, rows_per_page=None):
        page_number = max(1, int(page or 1))
        page_size = max(1, min(200, int(rows_per_page or SEARCH_ROWS_PER_PAGE)))
        response = self.session.post(
            STOCK_PAGE_INFO_URL,
            headers=self.private_ajax_headers(),
            data={'page': str(page_number), 'rowsPerPage': str(page_size)},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        result = safe_json(response)
        return {
            'httpStatus': int(response.status_code),
            'contentType': str(response.headers.get('content-type') or '').split(';', 1)[0].strip().lower(),
            'bodyBytes': len(response.content or b''),
            'requestedPage': page_number,
            'requestedRowsPerPage': page_size,
            'structure': describe_response_structure(result),
        }

    def get_inventory_iframe_contract(self):
        if not self.inventory_iframe_url:
            raise Exception('库存 iframe 地址尚未初始化')
        response = self.session.get(
            self.inventory_iframe_url,
            headers={**HEADERS_PAGE, 'Referer': INVENTORY_PAGE_URL, 'Cookie': self.cookie_header()},
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True,
        )
        response.raise_for_status()
        return {
            'httpStatus': int(response.status_code),
            'contentType': str(response.headers.get('content-type') or '').split(';', 1)[0].strip().lower(),
            'bodyBytes': len(response.content or b''),
            'structure': describe_response_structure(response.text or ''),
            'tables': describe_html_table_contracts(response.text or ''),
            'labelContexts': describe_html_label_contexts(response.text or ''),
            'repeatedElements': describe_repeated_html_elements(response.text or ''),
            'endpointCandidates': extract_inventory_endpoint_candidates(response.text or '')[:60],
            'inventoryHeaderTagSequence': describe_inventory_header_tag_sequence(response.text or ''),
            'inventoryHeaderLabels': parse_inventory_header_leaf_labels(response.text or ''),
        }

    def get_stock_summary(self):
        response = self.session.post(STOCK_SUMMARY_URL, headers=self.private_ajax_headers(), data={'refreshOrderDataFlag': '0'}, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        result = safe_json(response)
        if not result.get('success'):
            logger.warning(f'库存汇总接口失败，不影响明细导出：{result}')
            return {}
        logger.info(f"库存汇总：库存总量={result.get('total', '')}，库存总值={result.get('totalCost', '')}，更新时间={result.get('cacheUpdateTime', '')}")
        return result

    def download_export_file(self, export_page=None):
        params = {'flag': '1', 'showRmbColumn': str(SHOW_RMB_COLUMN)}
        if export_page is not None:
            params['page'] = str(export_page)
        page_text = f'第 {export_page} 批' if export_page is not None else '全部'
        logger.info(f'下载马帮官方库存 Excel：{page_text}')
        response = self.session.get(STOCK_EXPORT_URL, headers=self.private_download_headers(), params=params, timeout=EXPORT_TIMEOUT, allow_redirects=True)
        if response.status_code != 200:
            raise Exception(f'下载库存 Excel 失败，状态码：{response.status_code}')
        content = response.content or b''
        if not content.startswith(b'PK'):
            text = content[:500].decode('utf-8', errors='replace')
            raise Exception(f'库存导出接口未返回 xlsx，前500字符：{text}')
        return content

    def export_inventory_records(self, record_count, target_fields=None):
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
            records = normalize_inventory_dataframe(dataframe, target_fields=target_fields)
            skipped = len(dataframe.index) - len(records)
            logger.info(f'第 {index}/{len(export_pages)} 批解析 {len(records)} 行，跳过无 SKU 或仓库行 {skipped} 条')
            all_records.extend(records)
            if index < len(export_pages):
                time.sleep(REQUEST_INTERVAL_SECONDS)
        if exported_row_count != record_count:
            raise Exception(f'库存导出行数校验失败：页面显示 {record_count} 行，Excel 原始数据 {exported_row_count} 行。已停止写入 WPS。')
        return all_records

    def read_inventory_html_records(self, record_count, warehouse_ids=None, rows_per_page=200):
        if record_count <= 0:
            return []
        page_size = max(1, min(200, int(rows_per_page or 200)))
        page_count = (record_count + page_size - 1) // page_size
        all_records = []
        for page in range(1, page_count + 1):
            if page == 1 and self.last_search_response:
                result = self.last_search_response
            else:
                result = self.search_inventory_page(warehouse_ids=warehouse_ids, page=page, rows_per_page=page_size)
            message = str(result.get('message') or '')
            records = parse_inventory_search_records(message)
            expected_rows = min(page_size, record_count - len(all_records))
            if len(records) != expected_rows:
                raise Exception(f'库存 HTML 第 {page}/{page_count} 页行数校验失败：预期 {expected_rows}，实际 {len(records)}')
            all_records.extend(records)
            logger.info(f'库存 HTML 第 {page}/{page_count} 页解析 {len(records)} 行')
        if len(all_records) != record_count:
            raise Exception(f'库存 HTML 总行数校验失败：页面显示 {record_count} 行，实际解析 {len(all_records)} 行')
        return all_records

def run_sync():
    logger.info('本次同步模块：商品 > 库存查询')
    logger.info(f'目标 WPS 表：{TARGET_TABLE_NAME}')
    logger.info('数据来源：马帮官方库存 Excel 导出接口')
    logger.info('写入方式：不删除原表数据，直接追加写入')
    client = MabangInventoryClient()
    client.login(USERNAME, PASSWORD)
    client.open_inventory_page()
    client.initialize_default_search()
    record_count = client.get_record_count()
    summary = client.get_stock_summary()
    if record_count == 0:
        message = '库存查询结果为0，本次不写入数据。'
        logger.info(message)
        return {'success': True, 'message': message, 'rows': 0, 'inserted': 0}
    records = client.export_inventory_records(record_count)
    inserted = insert_records_to_wps(records, TARGET_TABLE_NAME)
    message = f'库存查询同步完成：马帮查询 {record_count} 行，Excel 解析 {len(records)} 行，WPS 导入 {inserted} 行。'
    logger.info(message)
    return {'success': True, 'message': message, 'rows': len(records), 'inserted': inserted, 'summary': {'total': summary.get('total', ''), 'totalCost': summary.get('totalCost', ''), 'inTransitTotal': summary.get('inTransitTotal', ''), 'cacheUpdateTime': summary.get('cacheUpdateTime', '')}}
