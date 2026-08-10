from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.fleet import account_environment, fleet_summary, load_fleet_manifest


def write_manifest(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "fleet.local.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def test_fleet_assigns_each_account_an_isolated_session_database_and_worker(tmp_path: Path):
    account_env = tmp_path / "th-home.env"
    account_env.write_text(
        "LIAOLIAO_ACCOUNT=local-login\n"
        "LIAOLIAO_SESSION_PATH=C:/unsafe/shared-session.json\n"
        "LIAOLIAO_HUMAN_SEND_ENABLED=true\n",
        encoding="utf-8",
    )
    path = write_manifest(
        tmp_path,
        {
            "version": 1,
            "shardId": "pc-01",
            "maxProcesses": 2,
            "runtimeRoot": "runtime/fleet",
            "accounts": [
                {
                    "key": "th-home-01",
                    "displayName": "Thailand Home 01",
                    "centralAccountId": "central-th-01",
                    "workerId": "worker-pc-01-th-01",
                    "enabled": True,
                    "envFile": "th-home.env",
                },
                {
                    "key": "ph-home-01",
                    "displayName": "Philippines Home 01",
                    "centralAccountId": "central-ph-01",
                    "workerId": "worker-pc-01-ph-01",
                    "enabled": True,
                },
            ],
        },
    )

    manifest = load_fleet_manifest(path, project_dir=tmp_path)
    first, second = manifest.accounts
    first_env = account_environment(first)
    second_env = account_environment(second)

    assert first.runtime_dir != second.runtime_dir
    assert first_env["LIAOLIAO_SESSION_PATH"] != second_env["LIAOLIAO_SESSION_PATH"]
    assert first_env["LIAOLIAO_DATABASE_PATH"] != second_env["LIAOLIAO_DATABASE_PATH"]
    assert first_env["LIAOLIAO_WORKER_ID"] == "worker-pc-01-th-01"
    assert first_env["LIAOLIAO_ACCOUNT"] == "local-login"
    assert first_env["LIAOLIAO_HUMAN_SEND_ENABLED"] == "false"
    assert "unsafe/shared-session" not in first_env["LIAOLIAO_SESSION_PATH"].replace("\\", "/")
    assert fleet_summary(manifest)["enabledAccounts"] == 2


def test_fleet_rejects_more_enabled_browsers_than_the_machine_shard_limit(tmp_path: Path):
    path = write_manifest(
        tmp_path,
        {
            "version": 1,
            "shardId": "pc-01",
            "maxProcesses": 1,
            "accounts": [
                {
                    "key": "account-1",
                    "centralAccountId": "central-1",
                    "workerId": "worker-1",
                    "enabled": True,
                },
                {
                    "key": "account-2",
                    "centralAccountId": "central-2",
                    "workerId": "worker-2",
                    "enabled": True,
                },
            ],
        },
    )

    with pytest.raises(ValueError, match="split the fleet across edge machines"):
        load_fleet_manifest(path, project_dir=tmp_path)
