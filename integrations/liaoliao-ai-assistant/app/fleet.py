from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import dotenv_values


ACCOUNT_KEY = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
ALLOWED_ACCOUNT_FIELDS = {
    "key",
    "displayName",
    "centralAccountId",
    "workerId",
    "enabled",
    "envFile",
}


def _iso_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _required_text(value: Any, label: str, maximum: int = 120) -> str:
    normalized = str(value or "").strip()
    if not normalized or len(normalized) > maximum:
        raise ValueError(f"{label} is required and must be at most {maximum} characters")
    return normalized


def _integer(value: Any, label: str, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    parsed = int(value)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"{label} must be between {minimum} and {maximum}")
    return parsed


@dataclass(frozen=True, slots=True)
class FleetAccount:
    key: str
    display_name: str
    central_account_id: str
    worker_id: str
    enabled: bool
    env_file: Path | None
    runtime_dir: Path


@dataclass(frozen=True, slots=True)
class FleetManifest:
    path: Path
    digest: str
    shard_id: str
    max_processes: int
    restart_limit: int
    runtime_root: Path
    accounts: tuple[FleetAccount, ...]

    @property
    def enabled_accounts(self) -> tuple[FleetAccount, ...]:
        return tuple(account for account in self.accounts if account.enabled)

    @property
    def status_path(self) -> Path:
        return self.runtime_root / "fleet-status.json"


def load_fleet_manifest(path: Path, *, project_dir: Path) -> FleetManifest:
    manifest_path = path.expanduser().resolve()
    raw_bytes = manifest_path.read_bytes()
    payload = json.loads(raw_bytes.decode("utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise ValueError("Fleet manifest version must be 1")
    shard_id = _required_text(payload.get("shardId"), "shardId", 64)
    if not ACCOUNT_KEY.fullmatch(shard_id):
        raise ValueError("shardId must use lowercase letters, numbers, '-' or '_'")
    max_processes = _integer(payload.get("maxProcesses"), "maxProcesses", 6, 1, 12)
    restart_limit = _integer(payload.get("restartLimit"), "restartLimit", 5, 0, 20)
    runtime_value = Path(str(payload.get("runtimeRoot") or "runtime/fleet"))
    runtime_root = (
        runtime_value if runtime_value.is_absolute() else project_dir / runtime_value
    ).resolve()
    raw_accounts = payload.get("accounts")
    if not isinstance(raw_accounts, list) or len(raw_accounts) > 100:
        raise ValueError("accounts must be an array with at most 100 entries")

    accounts: list[FleetAccount] = []
    keys: set[str] = set()
    central_ids: set[str] = set()
    worker_ids: set[str] = set()
    for index, raw in enumerate(raw_accounts):
        if not isinstance(raw, dict):
            raise ValueError(f"accounts[{index}] must be an object")
        unknown = set(raw) - ALLOWED_ACCOUNT_FIELDS
        if unknown:
            raise ValueError(f"accounts[{index}] has unsupported fields: {', '.join(sorted(unknown))}")
        key = _required_text(raw.get("key"), f"accounts[{index}].key", 64).lower()
        if not ACCOUNT_KEY.fullmatch(key):
            raise ValueError(f"accounts[{index}].key has an invalid format")
        central_id = _required_text(
            raw.get("centralAccountId"), f"accounts[{index}].centralAccountId"
        )
        worker_id = _required_text(raw.get("workerId"), f"accounts[{index}].workerId")
        if key in keys or central_id in central_ids or worker_id in worker_ids:
            raise ValueError("Fleet account keys, centralAccountId values and workerId values must be unique")
        keys.add(key)
        central_ids.add(central_id)
        worker_ids.add(worker_id)
        env_file = None
        if raw.get("envFile"):
            env_value = Path(str(raw["envFile"]))
            env_file = (
                env_value if env_value.is_absolute() else manifest_path.parent / env_value
            ).resolve()
            if not env_file.is_file():
                raise ValueError(f"accounts[{index}].envFile does not exist: {env_file}")
        accounts.append(
            FleetAccount(
                key=key,
                display_name=_required_text(
                    raw.get("displayName") or key, f"accounts[{index}].displayName"
                ),
                central_account_id=central_id,
                worker_id=worker_id,
                enabled=raw.get("enabled") is True,
                env_file=env_file,
                runtime_dir=(runtime_root / key).resolve(),
            )
        )
    enabled_count = sum(account.enabled for account in accounts)
    if enabled_count > max_processes:
        raise ValueError(
            f"This shard enables {enabled_count} accounts but maxProcesses is {max_processes}; split the fleet across edge machines"
        )
    return FleetManifest(
        path=manifest_path,
        digest=hashlib.sha256(raw_bytes).hexdigest(),
        shard_id=shard_id,
        max_processes=max_processes,
        restart_limit=restart_limit,
        runtime_root=runtime_root,
        accounts=tuple(accounts),
    )


def account_environment(account: FleetAccount) -> dict[str, str]:
    environment = os.environ.copy()
    if account.env_file:
        for key, value in dotenv_values(account.env_file).items():
            if value is not None:
                environment[str(key)] = str(value)
    environment.update(
        {
            "PYTHONUNBUFFERED": "1",
            "LIAOLIAO_CENTRAL_ACCOUNT_ID": account.central_account_id,
            "LIAOLIAO_WORKER_ID": account.worker_id,
            "LIAOLIAO_DATABASE_PATH": str(account.runtime_dir / "data" / "liaoliao.db"),
            "LIAOLIAO_SESSION_PATH": str(account.runtime_dir / "browser" / "storage-state.json"),
            "LIAOLIAO_LOG_DIR": str(account.runtime_dir / "logs"),
            # Fleet mode belongs to the central fill-only path. It never enables the
            # legacy local review action that can click a send button.
            "LIAOLIAO_HUMAN_SEND_ENABLED": "false",
        }
    )
    return environment


def fleet_summary(manifest: FleetManifest) -> dict[str, Any]:
    return {
        "version": 1,
        "shardId": manifest.shard_id,
        "manifestDigest": manifest.digest,
        "runtimeRoot": str(manifest.runtime_root),
        "maxProcesses": manifest.max_processes,
        "enabledAccounts": len(manifest.enabled_accounts),
        "accounts": [
            {
                "key": account.key,
                "displayName": account.display_name,
                "centralAccountId": account.central_account_id,
                "workerId": account.worker_id,
                "enabled": account.enabled,
                "runtimeDir": str(account.runtime_dir),
                "sessionPath": str(account.runtime_dir / "browser" / "storage-state.json"),
            }
            for account in manifest.accounts
        ],
    }


class FleetSupervisor:
    def __init__(self, manifest: FleetManifest, *, project_dir: Path):
        self.manifest = manifest
        self.project_dir = project_dir
        self.processes: dict[str, asyncio.subprocess.Process] = {}
        self.states: dict[str, dict[str, Any]] = {}
        self._status_lock = asyncio.Lock()

    async def _write_status(self) -> None:
        async with self._status_lock:
            self.manifest.runtime_root.mkdir(parents=True, exist_ok=True)
            payload = {
                **fleet_summary(self.manifest),
                "observedAt": _iso_now(),
                "processes": self.states,
            }
            temporary = self.manifest.status_path.with_suffix(".json.tmp")
            temporary.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            temporary.replace(self.manifest.status_path)

    async def _run_account(self, account: FleetAccount) -> None:
        attempts = 0
        while attempts <= self.manifest.restart_limit:
            attempts += 1
            account.runtime_dir.mkdir(parents=True, exist_ok=True)
            supervisor_logs = account.runtime_dir / "supervisor"
            supervisor_logs.mkdir(parents=True, exist_ok=True)
            stdout_path = supervisor_logs / "assist.stdout.log"
            stderr_path = supervisor_logs / "assist.stderr.log"
            with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "app.cli",
                    "assist",
                    cwd=str(self.project_dir),
                    env=account_environment(account),
                    stdout=stdout,
                    stderr=stderr,
                )
                self.processes[account.key] = process
                self.states[account.key] = {
                    "state": "RUNNING",
                    "pid": process.pid,
                    "attempt": attempts,
                    "startedAt": _iso_now(),
                    "stdout": str(stdout_path),
                    "stderr": str(stderr_path),
                }
                await self._write_status()
                return_code = await process.wait()
            self.processes.pop(account.key, None)
            self.states[account.key] = {
                **self.states[account.key],
                "state": "STOPPED" if return_code == 0 else "RESTARTING",
                "returnCode": return_code,
                "stoppedAt": _iso_now(),
            }
            await self._write_status()
            if return_code == 0 or attempts > self.manifest.restart_limit:
                break
            await asyncio.sleep(min(60, 2 ** min(attempts, 6)))
        if self.states.get(account.key, {}).get("returnCode") not in (None, 0):
            self.states[account.key]["state"] = "FAILED"
            await self._write_status()

    async def stop(self) -> None:
        for process in list(self.processes.values()):
            if process.returncode is None:
                process.terminate()
        if self.processes:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*(process.wait() for process in self.processes.values())),
                    timeout=10,
                )
            except asyncio.TimeoutError:
                for process in list(self.processes.values()):
                    if process.returncode is None:
                        process.kill()
        for key, state in self.states.items():
            if state.get("state") in {"RUNNING", "RESTARTING"}:
                self.states[key] = {**state, "state": "STOPPED", "stoppedAt": _iso_now()}
        self.processes.clear()
        await self._write_status()

    async def run(self) -> None:
        if not self.manifest.enabled_accounts:
            raise ValueError("Fleet manifest has no enabled accounts")
        tasks = [
            asyncio.create_task(self._run_account(account), name=f"liaoliao:{account.key}")
            for account in self.manifest.enabled_accounts
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await self.stop()


async def run_account_login(account: FleetAccount, *, project_dir: Path) -> int:
    account.runtime_dir.mkdir(parents=True, exist_ok=True)
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "app.cli",
        "login",
        cwd=str(project_dir),
        env=account_environment(account),
    )
    return await process.wait()


def read_fleet_status(manifest: FleetManifest) -> dict[str, Any]:
    if not manifest.status_path.is_file():
        return {**fleet_summary(manifest), "status": "NOT_STARTED", "processes": {}}
    payload = json.loads(manifest.status_path.read_text(encoding="utf-8"))
    payload["status"] = "RECORDED"
    return payload
