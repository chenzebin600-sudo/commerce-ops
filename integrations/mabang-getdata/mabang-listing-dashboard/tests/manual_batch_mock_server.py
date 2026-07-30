# -*- coding: utf-8 -*-
"""Local-only UI fixture for the manual bulk-edit browser regression check."""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


HOST = "127.0.0.1"
PORT = 8877
TOKEN = "manual-batch-ui-test"
SESSION = {
    "connected": True,
    "username": "测试账号",
    "account_host": "local.test",
    "connected_at": "2026-07-27 00:00:00",
}
SHOP = {
    "id": "shop-ui-test",
    "name": "UI Test Shop",
    "site": "TH",
    "currency": "THB",
    "shop_type": 1,
}
LISTING = {
    "platform": "lazada",
    "platform_name": "Lazada",
    "state": "online",
    "internal_id": "ui-test-1",
    "product_id": "16222629999",
    "product_url": "",
    "title": "手动批量修改测试商品",
    "parent_sku": "TEST-PARENT",
    "currency": "THB",
    "image": "",
    "shop_id": SHOP["id"],
    "shop_name": SHOP["name"],
    "site": "TH",
    "category_id": "1001",
    "create_time": "2026-07-27 00:00:00",
    "update_time": "2026-07-27 00:00:00",
    "publish_time": "2026-07-27 00:00:00",
    "variants": [
        {
            "variant_id": "variant-ui-test",
            "sku": "TEST-SKU",
            "stock_sku": "TEST-SKU",
            "price": "100.00",
            "sale_price": "90.00",
            "stock": 10,
            "warehouse_stock": [],
            "supply_price": "",
        }
    ],
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def _send(self, payload: dict[str, object], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "http://127.0.0.1:3000")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Mabang-Local-Token")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send({})

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self._send(
                {
                    "success": True,
                    "local_token": TOKEN,
                    "session": SESSION,
                    "busy": False,
                    "ai": {"configured": True},
                }
            )
            return
        if self.headers.get("X-Mabang-Local-Token") != TOKEN:
            self._send({"success": False, "message": "unauthorized"}, 401)
            return
        if path == "/api/platforms":
            self._send(
                {
                    "success": True,
                    "session": SESSION,
                    "platforms": [
                        {
                            "key": "lazada",
                            "name": "Lazada",
                            "states": [
                                {
                                    "key": "online",
                                    "label": "在线商品",
                                    "count_field": "online",
                                }
                            ],
                            "write_enabled": True,
                            "write_note": "测试写入能力",
                        }
                    ],
                }
            )
            return
        if path == "/api/shops":
            self._send({"success": True, "platform": "lazada", "shops": [SHOP]})
            return
        if path == "/api/listings":
            self._send(
                {
                    "success": True,
                    "items": [LISTING],
                    "page": 1,
                    "page_size": 50,
                    "total": 1,
                    "totals": {"online": 1},
                    "fetched_at": "2026-07-27 00:00:00",
                }
            )
            return
        self._send({"success": False, "message": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
