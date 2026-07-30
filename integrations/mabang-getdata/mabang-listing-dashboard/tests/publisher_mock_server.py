# -*- coding: utf-8 -*-
"""Local-only connected fixture for the integrated publisher browser QA."""

from __future__ import annotations

import json
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


HOST = "127.0.0.1"
PORT = 8877
TOKEN = "publisher-ui-test"
SESSION = {
    "connected": True,
    "username": "界面测试账号",
    "account_host": "local.test",
    "connected_at": "2026-07-27T20:00:00+08:00",
}
SHOP = {
    "id": "shop-ui-test",
    "name": "3C pilot · UI Test",
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
    "product_url": "https://www.lazada.co.th/products/i16222629999.html",
    "title": "65W GaN 三口充电器测试商品",
    "parent_sku": "GAN65-PARENT",
    "currency": "THB",
    "image": "",
    "shop_id": SHOP["id"],
    "shop_name": SHOP["name"],
    "site": "TH",
    "category_id": "1000123",
    "create_time": "2026-07-27 19:00:00",
    "update_time": "2026-07-27 19:30:00",
    "publish_time": "2026-07-27 19:10:00",
    "variants": [
        {
            "variant_id": "variant-ui-test",
            "sku": "GAN65-BK",
            "stock_sku": "GAN65-BK",
            "price": "99.90",
            "sale_price": "89.90",
            "stock": 20,
            "warehouse_stock": [],
            "supply_price": "",
        }
    ],
}
DRAFT = {
    "id": "draft-ui-test",
    "platform": "lazada",
    "shop_id": SHOP["id"],
    "shop_name": SHOP["name"],
    "site": "TH",
    "title": LISTING["title"],
    "category_id": LISTING["category_id"],
    "category_name": "Wall Chargers",
    "brand": "No Brand",
    "description": "Three-port 65W GaN fast charger for UI verification.",
    "attributes": {"Ports": "3"},
    "weight": "0.2",
    "package_length": "12",
    "package_width": "8",
    "package_height": "4",
    "status": "LOCAL_DRAFT",
    "version": 1,
    "confirmed_version": None,
    "mabang_task_id": "",
    "last_error": "",
    "updated_at": "2026-07-27T20:00:00+08:00",
    "variants": [
        {
            "id": "variant-draft-ui",
            "sku": "GAN65-BK",
            "specification_name": "Color",
            "specification_value": "Black",
            "price": "99.9",
            "special_price": "89.9",
            "stock": 20,
        }
    ],
    "assets": [{"id": "asset-ui", "url": "https://img.example.test/gan65.jpg"}],
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
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, X-Mabang-Local-Token",
        )
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("X-Mabang-Local-Token") == TOKEN

    def _read_json(self) -> dict[str, object]:
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length) or b"{}")

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
                    "publisher": {"status": "ok", "schema_version": "1"},
                }
            )
            return
        if not self._authorized():
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
                            "write_fields": ["price", "special_price", "stock", "sku"],
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
                    "fetched_at": datetime.now().astimezone().isoformat(),
                }
            )
            return
        if path == "/api/publisher/drafts":
            self._send({"success": True, "drafts": [DRAFT]})
            return
        if path.endswith("/events"):
            self._send(
                {
                    "success": True,
                    "events": [
                        {
                            "id": 1,
                            "event_type": "draft_created",
                            "status": "LOCAL_DRAFT",
                            "message": "本地刊登草稿已创建。",
                            "created_at": "2026-07-27T20:00:00+08:00",
                        }
                    ],
                }
            )
            return
        self._send({"success": False, "message": "not found"}, 404)

    def do_POST(self) -> None:
        if not self._authorized():
            self._send({"success": False, "message": "unauthorized"}, 401)
            return
        path = urlparse(self.path).path
        payload = self._read_json()
        if path == "/api/publisher/drafts/from-listing":
            self._send({"success": True, "draft": DRAFT}, 201)
            return
        if path == "/api/publisher/drafts":
            created = {**DRAFT, **payload, "id": "draft-new-ui", "version": 1}
            self._send({"success": True, "draft": created}, 201)
            return
        if path.endswith("/update"):
            updated = {**DRAFT, **payload, "version": 2}
            self._send({"success": True, "draft": updated})
            return
        self._send({"success": False, "message": "not found"}, 404)


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
