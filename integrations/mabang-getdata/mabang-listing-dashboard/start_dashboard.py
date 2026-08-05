# -*- coding: utf-8 -*-
"""Build and start the local Mabang listing dashboard and its API bridge."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path


PROJECT_DIR = Path(__file__).resolve().parent
ROOT_DIR = PROJECT_DIR.parent
BRIDGE_SCRIPT = ROOT_DIR / "mabang_listing_service.py"
BRIDGE_HEALTH = "http://127.0.0.1:8877/api/health"
DASHBOARD_URL = "http://127.0.0.1:3000"
BUILD_INFO_URL = DASHBOARD_URL + "/build-version.json"
BUILD_INFO_PATH = PROJECT_DIR / "public" / "build-version.json"


def wait_for_url(url: str, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as response:
                if response.status < 500:
                    return True
        except (OSError, urllib.error.URLError):
            time.sleep(0.35)
    return False


def fetch_text(url: str, timeout: float = 2.0) -> str:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.read().decode("utf-8", errors="replace")
    except (OSError, urllib.error.URLError):
        return ""


def source_fingerprint() -> str:
    digest = hashlib.sha256()
    paths = [
        PROJECT_DIR / "package.json",
        PROJECT_DIR / "package-lock.json",
        PROJECT_DIR / "vite.config.ts",
        *sorted((PROJECT_DIR / "app").rglob("*.tsx")),
        *sorted((PROJECT_DIR / "app").rglob("*.css")),
    ]
    for path in paths:
        if not path.is_file():
            continue
        digest.update(path.relative_to(PROJECT_DIR).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:20]


def write_build_info(fingerprint: str) -> None:
    BUILD_INFO_PATH.write_text(
        json.dumps(
            {
                "app": "mabang-listing-dashboard",
                "fingerprint": fingerprint,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )


def remove_stale_runtime_state() -> None:
    server_dir = (PROJECT_DIR / "dist" / "server").resolve()
    target = server_dir / ".wrangler"
    if not target.exists():
        return
    resolved = target.resolve()
    if resolved.parent != server_dir or resolved.name != ".wrangler":
        raise RuntimeError("拒绝清理非预期的运行状态目录。")
    shutil.rmtree(resolved)


def remote_fingerprint() -> str:
    payload = fetch_text(BUILD_INFO_URL)
    if not payload:
        return ""
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return ""
    if not isinstance(parsed, dict) or parsed.get("app") != "mabang-listing-dashboard":
        return ""
    return str(parsed.get("fingerprint") or "")


def listener_pids(port: int) -> list[int]:
    if os.name != "nt":
        return []
    try:
        output = subprocess.check_output(
            ["netstat", "-ano"],
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return []
    pattern = re.compile(
        rf"^\s*TCP\s+127\.0\.0\.1:{port}\s+\S+\s+LISTENING\s+(\d+)\s*$",
        re.IGNORECASE,
    )
    return sorted(
        {
            int(match.group(1))
            for line in output.splitlines()
            if (match := pattern.match(line))
        }
    )


def load_windows_user_secret(name: str) -> None:
    """Refresh a user-scoped secret when the launcher inherited a stale environment."""

    if os.name != "nt" or os.getenv(name, "").strip():
        return
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            value, _value_type = winreg.QueryValueEx(key, name)
    except (OSError, ImportError):
        return
    if str(value).strip():
        os.environ[name] = str(value).strip()


def stop_stale_dashboard() -> bool:
    page = fetch_text(DASHBOARD_URL)
    if "马帮刊登工作台" not in page:
        print("端口 3000 已被其它程序占用，请先关闭该程序。")
        return False
    pids = listener_pids(3000)
    if not pids:
        print("检测到旧版页面，但无法定位其本地进程。")
        return False
    for pid in pids:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    deadline = time.time() + 8
    while time.time() < deadline:
        if not wait_for_url(DASHBOARD_URL, 0.3):
            return True
        time.sleep(0.2)
    return False


def terminate(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()


def main() -> int:
    if not BRIDGE_SCRIPT.exists():
        print("缺少本地桥接服务文件，请保留完整的 Mabang-getdata 目录。")
        return 1
    npm = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm:
        print("未找到 Node.js/npm，请先安装 Node.js 22 或更高版本。")
        return 1

    load_windows_user_secret("COMMERCE_OPS_AI_GATEWAY_URL")
    load_windows_user_secret("COMMERCE_OPS_AI_GATEWAY_TOKEN")
    load_windows_user_secret("DEEPSEEK_MODEL")
    fingerprint = source_fingerprint()
    write_build_info(fingerprint)

    if not (PROJECT_DIR / "node_modules").exists():
        print("首次运行：正在安装本地网页依赖…", flush=True)
        result = subprocess.run(
            [npm, "install", "--no-audit", "--no-fund"],
            cwd=PROJECT_DIR,
            check=False,
        )
        if result.returncode:
            return result.returncode

    try:
        remove_stale_runtime_state()
    except OSError:
        print("旧版本地服务仍占用构建文件，请关闭旧窗口后重试。")
        return 1

    print("正在构建马帮刊登工作台…", flush=True)
    result = subprocess.run([npm, "run", "build"], cwd=PROJECT_DIR, check=False)
    if result.returncode:
        return result.returncode

    bridge: subprocess.Popen | None = None
    dashboard: subprocess.Popen | None = None
    try:
        bridge_running = wait_for_url(BRIDGE_HEALTH, 0.6)
        if not bridge_running:
            bridge = subprocess.Popen(
                [sys.executable, str(BRIDGE_SCRIPT)],
                cwd=ROOT_DIR,
            )
            if not wait_for_url(BRIDGE_HEALTH, 15):
                print("本地马帮桥接服务未能启动，请查看上方提示。")
                return 1

        dashboard_running = wait_for_url(DASHBOARD_URL, 0.6)
        if dashboard_running and remote_fingerprint() != fingerprint:
            print("检测到旧版页面，正在关闭并切换到最新版本…", flush=True)
            if not stop_stale_dashboard():
                return 1
            dashboard_running = False
        if not dashboard_running:
            dashboard = subprocess.Popen([npm, "run", "start"], cwd=PROJECT_DIR)
            if not wait_for_url(DASHBOARD_URL, 20):
                print("本地网页未能启动，请查看上方提示。")
                return 1

        print()
        print(f"本地网页已启动：{DASHBOARD_URL}")
        print("账号默认显示“陈泽彬”，密码仅保存在当前运行内存。")
        print("请保持此窗口开启；按 Ctrl+C 可安全停止。")
        print()
        if os.getenv("MABANG_DASHBOARD_NO_BROWSER", "") != "1":
            webbrowser.open(DASHBOARD_URL)
        if dashboard is not None:
            return dashboard.wait()
        if bridge is not None:
            return bridge.wait()
        return 0
    except KeyboardInterrupt:
        print("\n正在停止本地网页…")
        return 0
    finally:
        terminate(dashboard)
        terminate(bridge)


if __name__ == "__main__":
    raise SystemExit(main())
