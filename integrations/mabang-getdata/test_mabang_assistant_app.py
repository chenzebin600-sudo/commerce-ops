# -*- coding: utf-8 -*-

import unittest

import mabang_assistant_app as app


class AssistantCodeGenerationTests(unittest.TestCase):
    def test_generated_code_contains_only_runtime_connection_values(self):
        code = app.generate_wps_code(
            "https://example.trycloudflare.com",
            "token-12345678901234567890",
        )

        self.assertIn("https://example.trycloudflare.com", code)
        self.assertIn("token-12345678901234567890", code)
        self.assertIn("TARGET_TABLE_NAME = '请填写WPS表名'", code)
        self.assertIn("DATE_MODE = 'month_to_yesterday'", code)
        self.assertIn("DELETE_BEFORE_IMPORT = True", code)
        self.assertNotIn("MABANG_PASSWORD", code)
        compile(code, "generated_wps_script.py", "exec")

    def test_yesterday_code_keeps_existing_wps_rows(self):
        code = app.generate_wps_code(
            "https://example.trycloudflare.com",
            "token-12345678901234567890",
            date_mode=app.DATE_MODE_YESTERDAY,
        )

        self.assertIn("DATE_MODE = 'yesterday'", code)
        self.assertIn("DELETE_BEFORE_IMPORT = False", code)
        compile(code, "generated_yesterday_wps_script.py", "exec")

    def test_free_port_is_valid(self):
        port = app.find_free_port()
        self.assertGreater(port, 0)
        self.assertLess(port, 65536)


if __name__ == "__main__":
    unittest.main()
