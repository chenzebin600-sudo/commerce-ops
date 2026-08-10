from __future__ import annotations

from pathlib import Path

import pytest

import app.browser as browser_module
from app.browser import BrowserCollector


class AtomicStorageContext:
    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.paths: list[Path] = []
        self.indexed_db_values: list[bool] = []

    async def storage_state(self, *, path: str, indexed_db: bool = False):
        target = Path(path)
        self.paths.append(target)
        self.indexed_db_values.append(indexed_db)
        target.write_text('{"cookies":[{"name":"new"}]}', encoding="utf-8")
        if self.fail:
            raise RuntimeError("storage state failed")


async def test_session_save_replaces_from_a_temporary_file_in_the_same_directory(
    settings_factory,
):
    settings = settings_factory()
    settings.session_path.parent.mkdir(parents=True, exist_ok=True)
    settings.session_path.write_text('{"cookies":[{"name":"old"}]}', encoding="utf-8")
    context = AtomicStorageContext()
    collector = BrowserCollector(settings)
    collector._context = context

    await collector._save_session()

    assert settings.session_path.read_text(encoding="utf-8") == '{"cookies":[{"name":"new"}]}'
    assert len(context.paths) == 1
    assert context.paths[0] != settings.session_path
    assert context.paths[0].parent == settings.session_path.parent
    assert context.indexed_db_values == [True]
    assert not context.paths[0].exists()


async def test_failed_session_save_preserves_the_previous_session_and_cleans_temporary_file(
    settings_factory,
):
    settings = settings_factory()
    settings.session_path.parent.mkdir(parents=True, exist_ok=True)
    previous = '{"cookies":[{"name":"old"}]}'
    settings.session_path.write_text(previous, encoding="utf-8")
    context = AtomicStorageContext(fail=True)
    collector = BrowserCollector(settings)
    collector._context = context

    with pytest.raises(RuntimeError, match="storage state failed"):
        await collector._save_session()

    assert settings.session_path.read_text(encoding="utf-8") == previous
    assert len(context.paths) == 1
    assert not context.paths[0].exists()


class LaunchContext:
    def __init__(self):
        self.default_timeout = None
        self.default_navigation_timeout = None
        self.closed = False

    def set_default_timeout(self, value: int):
        self.default_timeout = value

    def set_default_navigation_timeout(self, value: int):
        self.default_navigation_timeout = value

    async def close(self):
        self.closed = True


class LaunchBrowser:
    def __init__(self, context: LaunchContext):
        self.context = context
        self.context_options = None
        self.closed = False

    async def new_context(self, **options):
        self.context_options = options
        return self.context

    async def close(self):
        self.closed = True


class LaunchChromium:
    def __init__(self, browser: LaunchBrowser):
        self.browser = browser
        self.launch_options = None

    async def launch(self, **options):
        self.launch_options = options
        return self.browser


class LaunchPlaywright:
    def __init__(self, chromium: LaunchChromium):
        self.chromium = chromium
        self.stopped = False

    async def stop(self):
        self.stopped = True


class LaunchManager:
    def __init__(self, playwright: LaunchPlaywright):
        self.playwright = playwright

    async def start(self):
        return self.playwright


async def test_start_uses_installed_chrome_with_only_the_isolated_session_path(
    monkeypatch,
    settings_factory,
):
    settings = settings_factory(browser_channel="chrome", headless=False)
    settings.session_path.parent.mkdir(parents=True, exist_ok=True)
    settings.session_path.write_text('{"cookies":[]}', encoding="utf-8")
    context = LaunchContext()
    browser = LaunchBrowser(context)
    chromium = LaunchChromium(browser)
    playwright = LaunchPlaywright(chromium)
    monkeypatch.setattr(
        browser_module,
        "async_playwright",
        lambda: LaunchManager(playwright),
    )
    collector = BrowserCollector(settings)

    await collector._start()

    assert chromium.launch_options == {"headless": False, "channel": "chrome"}
    assert browser.context_options == {
        "locale": "zh-CN",
        "viewport": {"width": 1440, "height": 960},
        "storage_state": str(settings.session_path),
    }
    assert "args" not in chromium.launch_options
    assert "user_data_dir" not in chromium.launch_options
    assert context.default_timeout == 20_000
    assert context.default_navigation_timeout == 60_000

    await collector.close()
    assert context.closed is True
    assert browser.closed is True
    assert playwright.stopped is True


class LoginField:
    def __init__(self):
        self.fills: list[str] = []
        self.clicks = 0

    async def fill(self, value: str):
        self.fills.append(value)

    async def is_enabled(self):
        return True

    async def click(self):
        self.clicks += 1


class LoginPage:
    async def wait_for_timeout(self, _milliseconds: int):
        return None


class LoginContext:
    def __init__(self, page: LoginPage):
        self.page = page

    async def new_page(self):
        return self.page


@pytest.mark.parametrize(
    ("configured_account", "configured_password", "expected_account", "expected_password", "expected_clicks"),
    (
        (None, None, [], [], 0),
        ("local-account", None, [], [], 0),
        (None, "local-password", [], [], 0),
        ("local-account", "local-password", ["local-account"], ["local-password"], 1),
    ),
)
async def test_interactive_login_only_fills_and_submits_with_both_credentials(
    monkeypatch,
    settings_factory,
    configured_account,
    configured_password,
    expected_account,
    expected_password,
    expected_clicks,
):
    settings = settings_factory(
        account=configured_account,
        password=configured_password,
    )
    collector = BrowserCollector(settings)
    collector.selectors.update(
        {
            "login_account": ["account"],
            "login_password": ["password"],
            "login_submit": ["submit"],
        }
    )
    page = LoginPage()
    account = LoginField()
    password = LoginField()
    submit = LoginField()
    fields = {"account": account, "password": password, "submit": submit}
    saved = False

    async def start(*, headless=None):
        collector._context = LoginContext(page)

    async def close():
        collector._context = None

    async def first_visible(_page, candidates):
        return fields[candidates[0]] if candidates else None

    async def save_session():
        nonlocal saved
        saved = True

    monkeypatch.setattr(collector, "_start", start)
    monkeypatch.setattr(collector, "close", close)
    monkeypatch.setattr(collector, "_goto_app", lambda *_args, **_kwargs: _async_none())
    monkeypatch.setattr(collector, "_wait_for_login_form", lambda *_args: _async_none())
    monkeypatch.setattr(collector, "_first_visible", first_visible)
    monkeypatch.setattr(collector, "_is_authenticated", lambda *_args: _async_true())
    monkeypatch.setattr(collector, "_save_session", save_session)

    result = await collector.interactive_login()

    assert result == settings.session_path
    assert saved is True
    assert account.fills == expected_account
    assert password.fills == expected_password
    assert submit.clicks == expected_clicks


async def _async_none():
    return None


async def _async_true():
    return True
