# -*- coding: utf-8 -*-

import unittest
import threading
import time
from datetime import datetime
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import mabang_local_service as service
import requests


class LocalServiceDateModeTests(unittest.TestCase):
    def test_yesterday_range(self):
        with patch.object(service, "datetime") as fake_datetime:
            fake_datetime.side_effect = datetime
            fake_datetime.now.return_value = datetime(2026, 7, 14, 9, 0, 0)
            paid_start, paid_end = service.resolve_time_range({"date_mode": "yesterday"})

        self.assertEqual(paid_start, "2026-07-13 00:00:00")
        self.assertEqual(paid_end, "2026-07-13 23:59:59")

    def test_month_to_yesterday_range(self):
        with patch.object(service, "datetime") as fake_datetime:
            fake_datetime.side_effect = datetime
            fake_datetime.now.return_value = datetime(2026, 7, 14, 9, 0, 0)
            paid_start, paid_end = service.resolve_time_range({"date_mode": "month_to_yesterday"})

        self.assertEqual(paid_start, "2026-07-01 00:00:00")
        self.assertEqual(paid_end, "2026-07-13 23:59:59")


class LocalServiceTransferTests(unittest.TestCase):
    def test_ready_job_is_reused_by_wps(self):
        class FakeClient:
            def collect_export_orders(self, paid_start, paid_end):
                return ["order-1", "order-2"]

            def export_orders_to_records(self, order_ids):
                return [{"交易编号": "trade-1", "SKU": "sku-1"}]

        with service.JOBS_LOCK:
            service.JOBS.clear()

        with (
            patch.object(service, "USERNAME", "test-user"),
            patch.object(service, "PASSWORD", "test-password"),
            patch.object(service, "take_preauthenticated_client", return_value=FakeClient()),
        ):
            created, reused = service.create_or_reuse_job({"date_mode": "yesterday"})
            self.assertFalse(reused)

            deadline = time.time() + 3
            while time.time() < deadline:
                with service.JOBS_LOCK:
                    state = service.JOBS[created["job_id"]]["state"]
                if state in ("ready", "failed"):
                    break
                time.sleep(0.02)

            with service.JOBS_LOCK:
                self.assertEqual(service.JOBS[created["job_id"]]["state"], "ready")

            reused_job, was_reused = service.create_or_reuse_job({"date_mode": "yesterday"})
            self.assertTrue(was_reused)
            self.assertEqual(reused_job["job_id"], created["job_id"])

        with service.JOBS_LOCK:
            service.JOBS.clear()

    def test_serves_5000_rows_with_gzip(self):
        job_id = "transfer-test"
        rows = [{"交易编号": str(index), "订单商品名称": "测试商品" * 20} for index in range(5000)]
        now_text = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        job = {
            "job_id": job_id,
            "date_mode": "yesterday",
            "state": "ready",
            "message": "数据已准备完成",
            "paid_start": "2026-07-13 00:00:00",
            "paid_end": "2026-07-13 23:59:59",
            "orders": 2500,
            "rows_data": rows,
            "row_count": len(rows),
            "created_at": now_text,
            "updated_at": now_text,
            "created_ts": time.time(),
            "updated_ts": time.time(),
        }

        with service.JOBS_LOCK:
            service.JOBS[job_id] = job

        server = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        try:
            with patch.object(service, "SERVICE_TOKEN", "transfer-token-1234567890"):
                response = requests.get(
                    f"http://127.0.0.1:{server.server_port}/jobs/{job_id}/rows",
                    params={"offset": 0, "limit": 5000},
                    headers={
                        "Authorization": "Bearer transfer-token-1234567890",
                        "Accept-Encoding": "gzip",
                    },
                    timeout=10,
                )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers.get("Content-Encoding"), "gzip")
            self.assertEqual(len(response.json()["rows"]), 5000)
        finally:
            server.shutdown()
            server.server_close()
            with service.JOBS_LOCK:
                service.JOBS.pop(job_id, None)

if __name__ == "__main__":
    unittest.main()
