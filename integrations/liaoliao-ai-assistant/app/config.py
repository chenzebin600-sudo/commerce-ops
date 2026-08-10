from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


PROJECT_DIR = Path(__file__).resolve().parent.parent

SUPPORTED_BROWSER_CHANNELS = frozenset(
    {"chrome", "chrome-beta", "chrome-dev", "chrome-canary"}
)


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, minimum: int = 0) -> int:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return max(minimum, int(raw))


def _path(name: str, default: str) -> Path:
    value = Path(os.getenv(name, default))
    if not value.is_absolute():
        value = PROJECT_DIR / value
    return value.resolve()


def _browser_channel(name: str = "LIAOLIAO_BROWSER_CHANNEL") -> str | None:
    value = (os.getenv(name) or "").strip().lower()
    if not value or value == "chromium":
        return None
    if value not in SUPPORTED_BROWSER_CHANNELS:
        supported = ", ".join(sorted(SUPPORTED_BROWSER_CHANNELS))
        raise ValueError(f"{name} must be Chromium or one of: {supported}")
    return value


@dataclass(frozen=True, slots=True)
class Settings:
    project_dir: Path
    login_url: str
    workbench_url: str
    account: str | None
    password: str | None
    headless: bool
    login_timeout_seconds: int
    collection_limit: int
    max_scroll_pages: int
    settle_milliseconds: int
    database_path: Path
    session_path: Path
    selectors_path: Path
    knowledge_dir: Path
    log_dir: Path
    llm_base_url: str
    llm_api_key: str | None
    llm_model: str | None
    llm_review_model: str | None
    llm_timeout_seconds: int
    quality_review_enabled: bool
    max_history_messages: int
    human_send_enabled: bool
    web_host: str
    web_port: int
    auto_collect_seconds: int
    central_api_url: str | None = None
    central_account_id: str | None = None
    central_worker_id: str | None = None
    central_worker_token: str | None = None
    central_timeout_seconds: int = 10
    browser_channel: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv(PROJECT_DIR / ".env", override=False)
        # Fleet/manager processes provide an intentionally bounded environment.
        # Do not let the repository-root .env silently supply another account's
        # login credentials when that isolation is requested.
        if not _bool("LIAOLIAO_SKIP_ROOT_ENV", False):
            load_dotenv(PROJECT_DIR.parent.parent / ".env", override=False)
        deepseek_key = os.getenv("DEEPSEEK_API_KEY") or None
        return cls(
            project_dir=PROJECT_DIR,
            login_url=os.getenv("LIAOLIAO_LOGIN_URL", "https://mai.zhisuitech.com/#/login"),
            workbench_url=os.getenv(
                "LIAOLIAO_WORKBENCH_URL",
                "https://mai.zhisuitech.com/#/workbench/conversation",
            ),
            account=os.getenv("LIAOLIAO_ACCOUNT") or None,
            password=os.getenv("LIAOLIAO_PASSWORD") or None,
            headless=_bool("LIAOLIAO_HEADLESS", True),
            login_timeout_seconds=_int("LIAOLIAO_LOGIN_TIMEOUT_SECONDS", 300, 30),
            collection_limit=_int("LIAOLIAO_COLLECTION_LIMIT", 100, 1),
            max_scroll_pages=_int("LIAOLIAO_MAX_SCROLL_PAGES", 20, 0),
            settle_milliseconds=_int("LIAOLIAO_SETTLE_MILLISECONDS", 2500, 250),
            database_path=_path("LIAOLIAO_DATABASE_PATH", "data/liaoliao.db"),
            session_path=_path(
                "LIAOLIAO_SESSION_PATH", "runtime/browser/storage-state.json"
            ),
            selectors_path=_path("LIAOLIAO_SELECTORS_PATH", "selectors.json"),
            knowledge_dir=_path("LIAOLIAO_KNOWLEDGE_DIR", "knowledge"),
            log_dir=_path("LIAOLIAO_LOG_DIR", "logs"),
            llm_base_url=(
                os.getenv("LIAOLIAO_LLM_BASE_URL")
                or os.getenv("DEEPSEEK_BASE_URL")
                or "https://api.deepseek.com"
            ).rstrip("/"),
            llm_api_key=os.getenv("LIAOLIAO_LLM_API_KEY") or deepseek_key,
            llm_model=(
                os.getenv("LIAOLIAO_LLM_MODEL")
                or os.getenv("DEEPSEEK_MODEL")
                or ("deepseek-v4-flash" if deepseek_key else None)
            ),
            llm_review_model=(
                os.getenv("LIAOLIAO_LLM_REVIEW_MODEL")
                or os.getenv("LIAOLIAO_LLM_MODEL")
                or os.getenv("DEEPSEEK_MODEL")
                or ("deepseek-v4-flash" if deepseek_key else None)
            ),
            llm_timeout_seconds=_int("LIAOLIAO_LLM_TIMEOUT_SECONDS", 60, 5),
            quality_review_enabled=_bool("LIAOLIAO_QUALITY_REVIEW_ENABLED", True),
            max_history_messages=_int("LIAOLIAO_MAX_HISTORY_MESSAGES", 12, 4),
            human_send_enabled=_bool("LIAOLIAO_HUMAN_SEND_ENABLED", False),
            web_host=os.getenv("LIAOLIAO_WEB_HOST", "127.0.0.1"),
            web_port=_int("LIAOLIAO_WEB_PORT", 8876, 1),
            auto_collect_seconds=_int("LIAOLIAO_AUTO_COLLECT_SECONDS", 0, 0),
            central_api_url=(os.getenv("COMMERCE_OPS_API_URL") or "").rstrip("/") or None,
            central_account_id=os.getenv("LIAOLIAO_CENTRAL_ACCOUNT_ID") or None,
            central_worker_id=os.getenv("LIAOLIAO_WORKER_ID") or None,
            central_worker_token=os.getenv("CUSTOMER_SERVICE_WORKER_TOKEN") or None,
            central_timeout_seconds=_int("LIAOLIAO_CENTRAL_TIMEOUT_SECONDS", 10, 2),
            browser_channel=_browser_channel(),
        )

    @property
    def llm_enabled(self) -> bool:
        return bool(self.llm_model and self.llm_base_url)

    @property
    def central_enabled(self) -> bool:
        return bool(
            self.central_api_url
            and self.central_account_id
            and self.central_worker_id
            and self.central_worker_token
        )

    def ensure_directories(self) -> None:
        for path in (
            self.database_path.parent,
            self.session_path.parent,
            self.knowledge_dir,
            self.log_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)

    def load_selectors(self) -> dict[str, list[str]]:
        with self.selectors_path.open("r", encoding="utf-8") as handle:
            payload: dict[str, Any] = json.load(handle)
        result: dict[str, list[str]] = {}
        for key, value in payload.items():
            if isinstance(value, list):
                result[key] = [str(item) for item in value if str(item).strip()]
        return result
