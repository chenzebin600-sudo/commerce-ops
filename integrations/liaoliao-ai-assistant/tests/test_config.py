from __future__ import annotations

import os
from pathlib import Path

import pytest

import app.config as config_module
from app.config import Settings


def _project_dir(tmp_path: Path) -> Path:
    project_dir = tmp_path / "repo" / "integrations" / "liaoliao-ai-assistant"
    project_dir.mkdir(parents=True)
    return project_dir


def test_manager_can_skip_repository_root_dotenv(monkeypatch, tmp_path: Path):
    project_dir = _project_dir(tmp_path)
    calls: list[Path] = []

    monkeypatch.setattr(config_module, "PROJECT_DIR", project_dir)
    monkeypatch.setenv("LIAOLIAO_SKIP_ROOT_ENV", "true")
    monkeypatch.setattr(
        config_module,
        "load_dotenv",
        lambda path, override=False: calls.append(Path(path)),
    )

    Settings.from_env()

    assert calls == [project_dir / ".env"]


def test_explicit_empty_login_credentials_are_not_rehydrated_from_root_dotenv(
    monkeypatch, tmp_path: Path
):
    project_dir = _project_dir(tmp_path)
    root_dotenv = project_dir.parent.parent / ".env"
    calls: list[Path] = []

    monkeypatch.setattr(config_module, "PROJECT_DIR", project_dir)
    monkeypatch.setenv("LIAOLIAO_SKIP_ROOT_ENV", "false")
    monkeypatch.setenv("LIAOLIAO_ACCOUNT", "")
    monkeypatch.setenv("LIAOLIAO_PASSWORD", "")

    def fake_load_dotenv(path: Path, *, override: bool = False):
        calls.append(Path(path))
        if Path(path) == root_dotenv:
            os.environ.setdefault("LIAOLIAO_ACCOUNT", "root-account")
            os.environ.setdefault("LIAOLIAO_PASSWORD", "root-password")

    monkeypatch.setattr(config_module, "load_dotenv", fake_load_dotenv)

    settings = Settings.from_env()

    assert calls == [project_dir / ".env", root_dotenv]
    assert settings.account is None
    assert settings.password is None


def test_installed_google_chrome_channel_is_explicitly_configurable(
    monkeypatch, tmp_path: Path
):
    project_dir = _project_dir(tmp_path)
    monkeypatch.setattr(config_module, "PROJECT_DIR", project_dir)
    monkeypatch.setenv("LIAOLIAO_SKIP_ROOT_ENV", "true")
    monkeypatch.setenv("LIAOLIAO_BROWSER_CHANNEL", "chrome")
    monkeypatch.setattr(config_module, "load_dotenv", lambda *_args, **_kwargs: None)

    settings = Settings.from_env()

    assert settings.browser_channel == "chrome"


def test_unknown_browser_channel_fails_closed(monkeypatch, tmp_path: Path):
    project_dir = _project_dir(tmp_path)
    monkeypatch.setattr(config_module, "PROJECT_DIR", project_dir)
    monkeypatch.setenv("LIAOLIAO_SKIP_ROOT_ENV", "true")
    monkeypatch.setenv("LIAOLIAO_BROWSER_CHANNEL", "default-profile")
    monkeypatch.setattr(config_module, "load_dotenv", lambda *_args, **_kwargs: None)

    with pytest.raises(ValueError, match="LIAOLIAO_BROWSER_CHANNEL"):
        Settings.from_env()
