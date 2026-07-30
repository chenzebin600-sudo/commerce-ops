# -*- coding: utf-8 -*-
"""Copy this entire file into the WPS multi-dimensional table Python script."""

import time
import traceback
from datetime import datetime

import requests


# Replace with the fixed HTTPS address that forwards to local port 8765.
LOCAL_SERVICE_URL = "https://你的固定HTTPS地址"

# Must exactly match MABANG_LOCAL_TOKEN on the local computer.
SERVICE_TOKEN = "请填写至少20位随机令牌"

TARGET_TABLE_NAME = "马帮数据"
DATE_MODE = "month_to_yesterday"
DELETE_BEFORE_IMPORT = True

# 马帮、本地服务和 WPS 每批均按 5000 行处理，减少网络与写表调用次数。
PULL_PAGE_SIZE = 5000
WPS_INSERT_BATCH_SIZE = 5000
POLL_INTERVAL_SECONDS = 2

# 桌面助手会提前准备数据。若尚未准备好，WPS 最多等待 120 秒后给出提示，
# 避免占满 WPS 单次 5 分钟运行时间。
MAX_WAIT_SECONDS = 120
REQUEST_TIMEOUT = (10, 120)
NETWORK_RETRIES = 8
NETWORK_RETRY_DELAY_SECONDS = 2


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


def log(level, message):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{now} - [{level}] {message}", flush=True)


def headers():
    return {
        "Authorization": "Bearer " + SERVICE_TOKEN,
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "Connection": "keep-alive",
    }


HTTP_SESSION = requests.Session()
HTTP_SESSION.headers.update(headers())


def parse_response(response, action):
    try:
        data = response.json()
    except Exception:
        raise Exception(f"{action}返回的不是 JSON，HTTP {response.status_code}。")
    if response.status_code >= 400 or not data.get("success"):
        raise Exception(f"{action}失败：{data.get('message') or data}")
    return data


def request_api(method, url, action, **kwargs):
    last_error = None

    for attempt in range(1, NETWORK_RETRIES + 1):
        try:
            response = HTTP_SESSION.request(
                method=method,
                url=url,
                timeout=REQUEST_TIMEOUT,
                **kwargs,
            )

            if response.status_code == 429 or response.status_code >= 500:
                raise requests.exceptions.ConnectionError(
                    f"Cloudflare temporary HTTP {response.status_code}"
                )

            return parse_response(response, action)

        except requests.exceptions.RequestException as error:
            last_error = error

            if attempt >= NETWORK_RETRIES:
                break

            wait_seconds = min(
                NETWORK_RETRY_DELAY_SECONDS * attempt,
                10,
            )
            log(
                "提醒",
                f"{action}网络连接失败，第 {attempt}/{NETWORK_RETRIES} 次，"
                f"{wait_seconds} 秒后重试：{error}",
            )
            time.sleep(wait_seconds)

    raise Exception(
        f"{action}连续 {NETWORK_RETRIES} 次无法连接本地服务：{last_error}。"
        "请确认两个 PowerShell 窗口仍在运行，并检查 LOCAL_SERVICE_URL 是否为本次生成的新地址。"
    )


def create_job():
    url = LOCAL_SERVICE_URL.rstrip("/") + "/jobs"
    return request_api(
        "POST",
        url,
        "创建本地导出任务",
        json={"date_mode": DATE_MODE},
    )


def wait_for_job(job_id):
    url = LOCAL_SERVICE_URL.rstrip("/") + "/jobs/" + job_id
    started = time.time()
    last_message = ""

    while True:
        if time.time() - started > MAX_WAIT_SECONDS:
            raise Exception(
                "本地数据仍在准备中。请保持桌面助手运行，等待界面显示“数据已准备”后再次运行 WPS。"
            )

        data = request_api("GET", url, "查询本地任务")
        state = data.get("state")
        message = str(data.get("message") or "")

        if message != last_message:
            log("信息", message)
            last_message = message

        if state == "ready":
            return data
        if state == "failed":
            raise Exception(message or "本地导出任务失败。")

        time.sleep(POLL_INTERVAL_SECONDS)


def fetch_all_rows(job_id, expected_total):
    rows = []
    offset = 0
    base_url = LOCAL_SERVICE_URL.rstrip("/") + "/jobs/" + job_id + "/rows"

    while offset < expected_total:
        data = request_api(
            "GET",
            base_url,
            "读取本地明细",
            params={"offset": offset, "limit": PULL_PAGE_SIZE},
        )
        page_rows = data.get("rows") or []
        if not page_rows:
            raise Exception(f"明细在第 {offset + 1} 行中断，未完整取回。")
        rows.extend(page_rows)
        offset += len(page_rows)
        log("信息", f"已从本地取回 {offset}/{expected_total} 行")

    if len(rows) != expected_total:
        raise Exception(f"明细数量校验失败：应为 {expected_total} 行，实际 {len(rows)} 行。")
    return rows


def adapt_rows(rows):
    result = []
    for row in rows:
        result.append({field: row.get(field, "") for field in TARGET_FIELDS})
    return result


def write_wps_table(rows):
    if not rows:
        raise Exception("没有可写入的数据。")

    rows = adapt_rows(rows)
    log("信息", f"数据已完整取回，共 {len(rows)} 行")

    if DELETE_BEFORE_IMPORT:
        log("信息", "开始删除原表数据")
        delete_dbt(sheet_name=TARGET_TABLE_NAME)
        log("信息", "原表数据删除完成")
    else:
        log("信息", "昨天模式：保留原表数据并追加写入")

    inserted = 0
    for start in range(0, len(rows), WPS_INSERT_BATCH_SIZE):
        batch = rows[start:start + WPS_INSERT_BATCH_SIZE]
        insert_dbt(batch, sheet_name=TARGET_TABLE_NAME, new_sheet=False)
        inserted += len(batch)
        log("信息", f"已写入 WPS：{inserted}/{len(rows)} 行")
    return inserted


def run_sync():
    if "你的固定HTTPS地址" in LOCAL_SERVICE_URL:
        raise Exception("请先填写 LOCAL_SERVICE_URL。")
    if SERVICE_TOKEN.startswith("请填写"):
        raise Exception("请先填写 SERVICE_TOKEN。")

    log("信息", "创建本地马帮导出任务")
    created = create_job()
    job_id = created["job_id"]
    log("信息", f"本地任务编号：{job_id}")

    status = wait_for_job(job_id)
    expected_total = int(status.get("rows") or 0)
    if expected_total <= 0:
        raise Exception("本地任务完成，但明细行为 0；不会删除原表。")

    rows = fetch_all_rows(job_id, expected_total)
    inserted = write_wps_table(rows)
    write_action = "重建导入" if DELETE_BEFORE_IMPORT else "追加导入"
    message = (
        f"同步完成：付款时间 {status.get('paid_start')} 至 {status.get('paid_end')}，"
        f"订单 {status.get('orders')} 个，{write_action} {inserted} 行。"
    )
    log("信息", message)
    return {"success": True, "message": message, "orders": status.get("orders"), "inserted": inserted}


try:
    print(run_sync(), flush=True)
except Exception as exc:
    print(
        {
            "success": False,
            "message": f"脚本运行异常：{exc}",
            "traceback": traceback.format_exc(),
        },
        flush=True,
    )
