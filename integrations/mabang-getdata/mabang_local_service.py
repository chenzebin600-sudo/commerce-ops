# -*- coding: utf-8 -*-
"""Run the Mabang export workflow on this computer and expose paged JSON to WPS."""

import gzip
import hmac
import json
import os
import threading
import time
import traceback
import uuid
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import mabang_sync_no_delete as mabang


HOST = os.getenv("MABANG_LOCAL_HOST", "127.0.0.1")
PORT = int(os.getenv("MABANG_LOCAL_PORT", "8765"))
USERNAME = os.getenv("MABANG_USERNAME", "").strip()
PASSWORD = os.getenv("MABANG_PASSWORD", "").strip()
SERVICE_TOKEN = os.getenv("MABANG_LOCAL_TOKEN", "").strip()
AUTO_PREPARE_MODE = os.getenv("MABANG_DATE_MODE", "").strip()

# A completed job can be reused after a WPS retry, then expires from memory.
JOB_TTL_SECONDS = int(os.getenv("MABANG_JOB_TTL_SECONDS", "172800"))
MAX_ROWS_PER_RESPONSE = 5000
AUTO_PREPARE_RETRY_SECONDS = 600

JOBS = {}
JOBS_LOCK = threading.Lock()
RUN_LOCK = threading.Lock()
PREAUTH_LOCK = threading.Lock()
PREAUTH_CLIENT = None
PREAUTH_AT = 0


def log(message):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"{now} - {message}", flush=True)


def month_start_to_yesterday():
    today = datetime.now().date()
    if today.day == 1:
        raise Exception("当前为本月1号，当月1号到昨日暂无可同步数据。")

    month_start = today.replace(day=1)
    yesterday = today - timedelta(days=1)
    start = datetime(month_start.year, month_start.month, month_start.day, 0, 0, 0)
    end = datetime(yesterday.year, yesterday.month, yesterday.day, 23, 59, 59)
    return start.strftime("%Y-%m-%d %H:%M:%S"), end.strftime("%Y-%m-%d %H:%M:%S")


def resolve_time_range(payload):
    mode = str(payload.get("date_mode") or "month_to_yesterday").strip()
    if mode == "manual":
        paid_start = str(payload.get("paid_start") or "").strip()
        paid_end = str(payload.get("paid_end") or "").strip()
        if not paid_start or not paid_end:
            raise Exception("手动日期模式缺少 paid_start 或 paid_end。")
        return paid_start, paid_end
    if mode == "yesterday":
        yesterday = datetime.now().date() - timedelta(days=1)
        prefix = yesterday.strftime("%Y-%m-%d")
        return prefix + " 00:00:00", prefix + " 23:59:59"
    if mode == "month_to_yesterday":
        return month_start_to_yesterday()
    raise Exception(f"不支持的 date_mode：{mode}")


def public_job(job):
    return {
        "job_id": job["job_id"],
        "date_mode": job.get("date_mode", ""),
        "state": job["state"],
        "message": job.get("message", ""),
        "paid_start": job["paid_start"],
        "paid_end": job["paid_end"],
        "orders": job.get("orders", 0),
        "rows": job.get("row_count", 0),
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }


def update_job(job_id, **values):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return
        job.update(values)
        job["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def remove_expired_jobs():
    cutoff = time.time() - JOB_TTL_SECONDS
    with JOBS_LOCK:
        expired = [
            job_id
            for job_id, job in JOBS.items()
            if job.get("updated_ts", job.get("created_ts", 0)) < cutoff
            and job.get("state") not in ("queued", "running")
        ]
        for job_id in expired:
            JOBS.pop(job_id, None)


def validate_credentials():
    global PREAUTH_CLIENT, PREAUTH_AT

    with PREAUTH_LOCK:
        if PREAUTH_CLIENT is not None and time.time() - PREAUTH_AT < 900:
            return

        client = mabang.MabangClient()
        client.login(USERNAME, PASSWORD)
        PREAUTH_CLIENT = client
        PREAUTH_AT = time.time()


def take_preauthenticated_client():
    global PREAUTH_CLIENT, PREAUTH_AT

    with PREAUTH_LOCK:
        if PREAUTH_CLIENT is None or time.time() - PREAUTH_AT >= 900:
            PREAUTH_CLIENT = None
            PREAUTH_AT = 0
            return None

        client = PREAUTH_CLIENT
        PREAUTH_CLIENT = None
        PREAUTH_AT = 0
        return client


def run_export_job(job_id):
    if not RUN_LOCK.acquire(blocking=False):
        update_job(job_id, state="failed", message="本地服务已有同步任务正在运行。")
        return

    try:
        if not USERNAME or not PASSWORD:
            raise Exception("本地服务未设置 MABANG_USERNAME 或 MABANG_PASSWORD。")

        update_job(job_id, state="running", message="正在登录马帮")
        with JOBS_LOCK:
            job = JOBS[job_id]
            paid_start = job["paid_start"]
            paid_end = job["paid_end"]

        log(f"任务 {job_id} 开始，付款时间 {paid_start} 至 {paid_end}")
        client = take_preauthenticated_client()
        if client is None:
            client = mabang.MabangClient()
            client.login(USERNAME, PASSWORD)
        else:
            log("使用桌面助手已验证的马帮登录会话")

        update_job(job_id, message="正在查询订单")
        order_ids = client.collect_export_orders(paid_start, paid_end)
        if not order_ids:
            raise Exception("指定付款时间内没有查询到订单。")

        update_job(job_id, orders=len(order_ids), message="正在导出订单明细")
        records = client.export_orders_to_records(order_ids)
        if not records:
            raise Exception("马帮导出完成，但没有解析到明细数据。")

        now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with JOBS_LOCK:
            job = JOBS[job_id]
            job.update(
                state="ready",
                message="数据已准备完成",
                orders=len(order_ids),
                rows_data=records,
                row_count=len(records),
                updated_at=now_text,
                updated_ts=time.time(),
            )
        log(f"任务 {job_id} 完成，订单 {len(order_ids)} 个，明细 {len(records)} 行")

    except Exception as exc:
        log(f"任务 {job_id} 失败：{exc}")
        update_job(
            job_id,
            state="failed",
            message=str(exc),
            error=traceback.format_exc(),
            updated_ts=time.time(),
        )
    finally:
        RUN_LOCK.release()


def create_or_reuse_job(payload):
    date_mode = str(payload.get("date_mode") or "month_to_yesterday").strip()
    paid_start, paid_end = resolve_time_range(payload)
    remove_expired_jobs()

    with JOBS_LOCK:
        for job in JOBS.values():
            if (
                job["paid_start"] == paid_start
                and job["paid_end"] == paid_end
                and job["state"] in ("queued", "running", "ready")
            ):
                return public_job(job), True

        job_id = uuid.uuid4().hex
        now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        job = {
            "job_id": job_id,
            "date_mode": date_mode,
            "state": "queued",
            "message": "任务已创建",
            "paid_start": paid_start,
            "paid_end": paid_end,
            "orders": 0,
            "row_count": 0,
            "rows_data": [],
            "created_at": now_text,
            "updated_at": now_text,
            "created_ts": time.time(),
            "updated_ts": time.time(),
        }
        JOBS[job_id] = job

    threading.Thread(target=run_export_job, args=(job_id,), daemon=True).start()
    return public_job(job), False


def auto_prepare_loop():
    """Prepare the selected date range locally before a scheduled WPS run."""
    if not AUTO_PREPARE_MODE:
        return

    log(f"已启用每日数据预准备：{AUTO_PREPARE_MODE}")
    time.sleep(30)
    next_attempt_at = 0

    while True:
        now = time.time()
        if now >= next_attempt_at:
            try:
                payload, reused = create_or_reuse_job({"date_mode": AUTO_PREPARE_MODE})
                if not reused:
                    log(
                        f"自动预准备任务已创建：{payload['paid_start']} 至 {payload['paid_end']}，"
                        f"任务 {payload['job_id']}"
                    )
            except Exception as exc:
                log(f"自动预准备暂未启动：{exc}")
            next_attempt_at = now + AUTO_PREPARE_RETRY_SECONDS
        time.sleep(30)


class Handler(BaseHTTPRequestHandler):
    server_version = "MabangLocalService/1.0"

    def log_message(self, fmt, *args):
        log(f"HTTP {self.address_string()} - {fmt % args}")

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        use_gzip = len(body) >= 65536 and "gzip" in self.headers.get("Accept-Encoding", "").lower()
        if use_gzip:
            body = gzip.compress(body, compresslevel=5)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        if use_gzip:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + SERVICE_TOKEN
        return bool(SERVICE_TOKEN) and hmac.compare_digest(supplied, expected)

    def require_auth(self):
        if self.authorized():
            return True
        self.send_json(401, {"success": False, "message": "未授权。"})
        return False

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"success": True, "service": "mabang-local", "busy": RUN_LOCK.locked()})
            return
        if not self.require_auth():
            return

        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) == 2 and parts[0] == "jobs":
            with JOBS_LOCK:
                job = JOBS.get(parts[1])
                payload = public_job(job) if job else None
            if not payload:
                self.send_json(404, {"success": False, "message": "任务不存在或已过期。"})
                return
            self.send_json(200, {"success": True, **payload})
            return

        if len(parts) == 3 and parts[0] == "jobs" and parts[2] == "rows":
            query = parse_qs(parsed.query)
            offset = max(0, int((query.get("offset") or ["0"])[0]))
            limit = min(MAX_ROWS_PER_RESPONSE, max(1, int((query.get("limit") or ["250"])[0])))
            with JOBS_LOCK:
                job = JOBS.get(parts[1])
                if not job:
                    payload = None
                elif job["state"] != "ready":
                    payload = {"not_ready": True, "state": job["state"], "message": job.get("message", "")}
                else:
                    rows = job["rows_data"][offset:offset + limit]
                    payload = {
                        "rows": rows,
                        "offset": offset,
                        "count": len(rows),
                        "total": job["row_count"],
                        "next_offset": offset + len(rows),
                    }
            if payload is None:
                self.send_json(404, {"success": False, "message": "任务不存在或已过期。"})
            elif payload.get("not_ready"):
                self.send_json(409, {"success": False, **payload})
            else:
                self.send_json(200, {"success": True, **payload})
            return

        self.send_json(404, {"success": False, "message": "接口不存在。"})

    def do_POST(self):
        if not self.require_auth():
            return
        request_path = urlparse(self.path).path

        if request_path == "/validate":
            try:
                validate_credentials()
                self.send_json(200, {"success": True, "message": "马帮账号验证成功。"})
            except Exception as exc:
                self.send_json(400, {"success": False, "message": str(exc)})
            return

        if request_path != "/jobs":
            self.send_json(404, {"success": False, "message": "接口不存在。"})
            return
        try:
            payload, reused = create_or_reuse_job(self.read_json())
            self.send_json(200, {"success": True, "reused": reused, **payload})
        except Exception as exc:
            self.send_json(400, {"success": False, "message": str(exc)})

    def do_DELETE(self):
        if not self.require_auth():
            return
        parts = [part for part in urlparse(self.path).path.split("/") if part]
        if len(parts) != 2 or parts[0] != "jobs":
            self.send_json(404, {"success": False, "message": "接口不存在。"})
            return
        with JOBS_LOCK:
            job = JOBS.get(parts[1])
            if job and job["state"] not in ("queued", "running"):
                JOBS.pop(parts[1], None)
        self.send_json(200, {"success": True})


def main():
    if not USERNAME or not PASSWORD:
        raise SystemExit("请先设置环境变量 MABANG_USERNAME 和 MABANG_PASSWORD。")
    if len(SERVICE_TOKEN) < 20:
        raise SystemExit("请设置至少20位的环境变量 MABANG_LOCAL_TOKEN。")

    mabang.USERNAME = USERNAME
    mabang.PASSWORD = PASSWORD
    log(f"本地马帮服务已启动：http://{HOST}:{PORT}")
    log("马帮请求将从本机发出；请通过带 HTTPS 的固定隧道地址供 WPS 调用。")
    if AUTO_PREPARE_MODE:
        threading.Thread(target=auto_prepare_loop, daemon=True).start()
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
