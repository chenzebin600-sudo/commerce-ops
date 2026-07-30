# -*- coding: utf-8 -*-

import os
import unittest
from unittest.mock import patch

from ai_service import (
    AIConfigurationError,
    AIValidationError,
    DeepSeekAIService,
    ai_status,
    generate_preview,
    validate_command,
    validate_listing_material,
)


class FakeResponse:
    def __init__(self, status_code, payload, headers=None):
        self.status_code = status_code
        self.payload = payload
        self.headers = headers or {}

    def json(self):
        return self.payload


class FakeSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if not self.responses:
            raise AssertionError("unexpected DeepSeek request")
        return self.responses.pop(0)


def completion(command):
    import json

    return {
        "choices": [
            {
                "message": {
                    "content": json.dumps(command, ensure_ascii=False),
                }
            }
        ]
    }


class AIServiceTests(unittest.TestCase):
    def test_legacy_v4_model_alias_resolves_to_supported_flash_model(self):
        service = DeepSeekAIService(api_key="test-key", model="deepseek-v4")

        self.assertEqual(service.model, "deepseek-v4-flash")

    def test_supported_pro_model_is_preserved(self):
        service = DeepSeekAIService(api_key="test-key", model="deepseek-v4-pro")

        self.assertEqual(service.model, "deepseek-v4-pro")

    def test_unsupported_model_fails_before_an_http_request(self):
        with self.assertRaisesRegex(AIConfigurationError, "deepseek-v4-flash"):
            DeepSeekAIService(api_key="test-key", model="deepseek-unknown")

    def test_ai_status_reports_effective_model_for_legacy_environment_value(self):
        with patch.dict(os.environ, {"DEEPSEEK_MODEL": "deepseek-v4"}, clear=False):
            status = ai_status()

        self.assertEqual(status["model"], "deepseek-v4-flash")

    def test_parses_price_percent_command_as_strict_json(self):
        session = FakeSession(
            [
                FakeResponse(
                    200,
                    completion(
                        {
                            "action": "price_update",
                            "target": {
                                "sku": "A",
                                "parent_sku": "",
                                "category": "",
                            },
                            "scope": {
                                "platforms": ["Lazada"],
                                "countries": ["泰国"],
                                "shop_ids": [],
                                "shop_names": [],
                                "categories": [],
                            },
                            "operation": {
                                "field": "price",
                                "mode": "increase_percent",
                                "value": 10,
                                "unit": "percent",
                            },
                            "need_confirm": False,
                            "risks": [],
                            "clarifications": [],
                            "confidence": 0.98,
                        }
                    ),
                )
            ]
        )
        service = DeepSeekAIService(
            api_key="test-key",
            session=session,
            sleep=lambda _: None,
        )

        parsed = service.parse_command("SKU A 泰国 Lazada 售价上涨10%")

        self.assertEqual(parsed["action"], "price_update")
        self.assertEqual(parsed["target"]["sku"], "A")
        self.assertEqual(parsed["scope"]["platforms"], ["lazada"])
        self.assertEqual(parsed["scope"]["countries"], ["TH"])
        self.assertEqual(parsed["operation"]["mode"], "increase_percent")
        self.assertEqual(parsed["operation"]["value"], 10)
        self.assertTrue(parsed["need_confirm"])
        url, request = session.calls[0]
        self.assertEqual(url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(
            request["json"]["response_format"],
            {"type": "json_object"},
        )
        self.assertEqual(
            request["headers"]["Authorization"],
            "Bearer test-key",
        )

    def test_parses_multiple_independent_store_sku_commands(self):
        session = FakeSession(
            [
                FakeResponse(
                    200,
                    completion(
                        {
                            "commands": [
                                {
                                    "action": "stock_update",
                                    "target": {"sku": "T5CC2561011"},
                                    "scope": {"shop_names": ["imii"]},
                                    "operation": {
                                        "mode": "set",
                                        "value": 0,
                                        "unit": "quantity",
                                    },
                                    "need_confirm": True,
                                    "risks": [],
                                    "clarifications": [],
                                    "confidence": 0.99,
                                },
                                {
                                    "action": "stock_update",
                                    "target": {"sku": "T3CC1970671"},
                                    "scope": {"shop_names": ["3C COMBO"]},
                                    "operation": {
                                        "mode": "set",
                                        "value": 99,
                                        "unit": "quantity",
                                    },
                                    "need_confirm": True,
                                    "risks": [],
                                    "clarifications": [],
                                    "confidence": 0.99,
                                },
                            ]
                        }
                    ),
                )
            ]
        )
        service = DeepSeekAIService(
            api_key="test-key",
            session=session,
            sleep=lambda _: None,
        )

        commands = service.parse_commands(
            "把imii店铺中的T5CC2561011库存数量修改为0\n"
            "把3C COMBO店铺中的T3CC1970671库存数量修改为99"
        )

        self.assertEqual(len(commands), 2)
        self.assertEqual(commands[0]["scope"]["shop_names"], ["imii"])
        self.assertEqual(commands[0]["target"]["sku"], "T5CC2561011")
        self.assertEqual(commands[0]["operation"]["value"], 0)
        self.assertEqual(commands[1]["scope"]["shop_names"], ["3C COMBO"])
        self.assertEqual(commands[1]["target"]["sku"], "T3CC1970671")
        self.assertEqual(commands[1]["operation"]["value"], 99)
        self.assertEqual(len(session.calls), 1)

    def test_retries_transient_provider_error(self):
        sleeps = []
        session = FakeSession(
            [
                FakeResponse(429, {"error": {"message": "busy"}}, {"Retry-After": "0"}),
                FakeResponse(
                    200,
                    completion(
                        {
                            "action": "stock_update",
                            "target": {"sku": "SKU001"},
                            "scope": {},
                            "operation": {
                                "mode": "set",
                                "value": 100,
                                "unit": "quantity",
                            },
                            "need_confirm": True,
                            "risks": [],
                            "clarifications": [],
                            "confidence": 0.9,
                        }
                    ),
                ),
            ]
        )
        service = DeepSeekAIService(
            api_key="test-key",
            session=session,
            max_retries=2,
            sleep=sleeps.append,
        )

        parsed = service.parse_command("SKU001库存调整100")

        self.assertEqual(parsed["action"], "stock_update")
        self.assertEqual(parsed["operation"]["value"], 100)
        self.assertEqual(len(session.calls), 2)
        self.assertEqual(sleeps, [0.0])

    def test_sku_replacement_always_has_risk_and_confirmation(self):
        parsed = validate_command(
            {
                "action": "replace_sku",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": ["lazada"]},
                "operation": {
                    "mode": "replace",
                    "value": "SKU-B",
                    "unit": "text",
                },
                "need_confirm": False,
                "risks": [],
                "clarifications": [],
                "confidence": 1,
            }
        )

        self.assertEqual(parsed["action"], "sku_replace")
        self.assertTrue(parsed["need_confirm"])
        self.assertTrue(parsed["risks"])
        self.assertEqual(parsed["operation"]["value"], "SKU-B")

    def test_variation_replacement_requires_name_and_value_object(self):
        parsed = validate_command(
            {
                "action": "variation_update",
                "target": {"sku": "SKU-A"},
                "scope": {"platforms": ["tiktok"]},
                "operation": {
                    "mode": "replace",
                    "value": {"name": "Color", "value": "Blue"},
                    "unit": "text",
                },
                "confidence": 0.95,
            }
        )

        self.assertEqual(parsed["scope"]["platforms"], ["tiktokshop"])
        self.assertEqual(
            parsed["operation"]["value"],
            {"name": "Color", "value": "Blue"},
        )
        self.assertTrue(parsed["risks"])

    def test_missing_target_adds_clarification(self):
        parsed = validate_command(
            {
                "action": "promotion_update",
                "target": {},
                "scope": {"countries": ["TH"]},
                "operation": {
                    "mode": "decrease_percent",
                    "value": 5,
                    "unit": "percent",
                },
                "need_confirm": True,
                "risks": [],
                "clarifications": [],
                "confidence": 0.6,
            }
        )

        self.assertTrue(parsed["clarifications"])
        preview = generate_preview(parsed)
        self.assertFalse(preview["ready_for_scope_query"])
        self.assertFalse(preview["execution_allowed"])

    def test_rejects_unknown_action(self):
        with self.assertRaisesRegex(AIValidationError, "不支持的 action"):
            validate_command(
                {
                    "action": "delete_all_products",
                    "target": {"sku": "A"},
                    "scope": {},
                    "operation": {"mode": "none", "value": None, "unit": "none"},
                }
            )

    def test_api_key_is_read_only_from_environment(self):
        with patch.dict(os.environ, {}, clear=True):
            service = DeepSeekAIService()
            with self.assertRaisesRegex(
                AIConfigurationError,
                "DEEPSEEK_API_KEY",
            ):
                service.parse_command("SKU A价格上涨10%")

    def test_listing_material_is_normalized_and_cannot_publish(self):
        material = validate_listing_material(
            {
                "title": "65W GaN Charger",
                "brand": "No Brand",
                "category_name": "Wall Chargers",
                "description": "Three-port fast charger.",
                "attributes": {"Ports": "3"},
                "images": ["https://img.example.test/main.jpg", "not-a-url"],
                "variants": [
                    {
                        "sku": "GAN65-BK",
                        "specification_name": "Color",
                        "specification_value": "Black",
                        "price": 99.9,
                        "stock": 20,
                    }
                ],
                "warnings": [],
                "publishing_allowed": True,
            }
        )

        self.assertEqual(material["images"], ["https://img.example.test/main.jpg"])
        self.assertEqual(material["variants"][0]["stock"], 20)
        self.assertFalse(material["publishing_allowed"])

    def test_deepseek_generates_editable_listing_material(self):
        session = FakeSession(
            [
                FakeResponse(
                    200,
                    completion(
                        {
                            "title": "USB-C Cable",
                            "brand": "No Brand",
                            "category_name": "Cables",
                            "description": "One metre charging cable.",
                            "attributes": {},
                            "images": [],
                            "variants": [
                                {
                                    "sku": "",
                                    "specification_name": "Length",
                                    "specification_value": "1m",
                                    "price": None,
                                    "stock": None,
                                }
                            ],
                            "warnings": [],
                        }
                    ),
                )
            ]
        )
        service = DeepSeekAIService(
            api_key="test-key",
            session=session,
            sleep=lambda _: None,
        )

        material = service.generate_listing_material("生成一条1米USB-C线资料")

        self.assertEqual(material["title"], "USB-C Cable")
        self.assertFalse(material["publishing_allowed"])
        self.assertTrue(material["warnings"])


if __name__ == "__main__":
    unittest.main()
