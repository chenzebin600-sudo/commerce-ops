from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import replace
from pathlib import Path

import uvicorn

from .config import Settings
from .factory import build_runtime
from .fleet import (
    FleetSupervisor,
    fleet_summary,
    load_fleet_manifest,
    read_fleet_status,
    run_account_login,
)
from .web import create_app


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description="乐聊 AI 辅助回复工具")
    root.add_argument("--verbose", action="store_true", help="输出调试日志")
    commands = root.add_subparsers(dest="command", required=True)
    commands.add_parser("init", help="初始化 SQLite 与运行目录")
    commands.add_parser("login", help="打开浏览器登录并保存 Session")
    commands.add_parser("collect", help="采集一次并生成待处理回复建议")
    commands.add_parser(
        "assist", help="在可见乐聊窗口抓取消息、生成 AI 建议并填入回复框（不发送）"
    )
    commands.add_parser("probe", help="探测当前登录后页面选择器和响应端点（不保存正文）")
    commands.add_parser("seed-demo", help="写入一条演示数据")

    fleet = commands.add_parser("fleet", help="管理本机多乐聊账号隔离运行分片")
    fleet_commands = fleet.add_subparsers(dest="fleet_command", required=True)
    for name, help_text in (
        ("validate", "校验账号清单与隔离路径，不启动浏览器"),
        ("status", "读取最近一次多账号运行状态"),
        ("assist", "为清单中启用的账号启动独立可见浏览器"),
    ):
        child = fleet_commands.add_parser(name, help=help_text)
        child.add_argument("--manifest", default="fleet.local.json")
    fleet_login = fleet_commands.add_parser("login", help="为一个账号交互登录并保存独立 Session")
    fleet_login.add_argument("--manifest", default="fleet.local.json")
    fleet_login.add_argument("--account", required=True, help="账号 key；一次只登录一个账号")

    serve = commands.add_parser("serve", help="启动本地 Web 页面")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.add_argument(
        "--auto-collect-seconds",
        type=int,
        default=None,
        help="大于0时按间隔自动采集",
    )
    return root


async def _login(verbose: bool) -> None:
    runtime = build_runtime(verbose=verbose)
    path = await runtime.collector.interactive_login()
    runtime.repository.audit(
        "session.saved", "browser_session", str(path), "cli", {}
    )
    print(f"Session 已保存：{path}")


async def _collect(verbose: bool) -> None:
    runtime = build_runtime(verbose=verbose)
    result = await runtime.service.collect_once()
    print(json.dumps(result, ensure_ascii=False, indent=2))


async def _assist(verbose: bool) -> None:
    runtime = build_runtime(verbose=verbose)
    await runtime.assistant.run()


async def _probe(verbose: bool) -> None:
    runtime = build_runtime(verbose=verbose)
    result = await runtime.collector.probe()
    output_path = runtime.settings.project_dir / "runtime" / "probe.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    runtime.repository.audit(
        "browser.probed",
        "browser_session",
        "current",
        "cli",
        {
            "selector_count": len(result["selector_counts"]),
            "endpoint_count": len(result["endpoint_hits"]),
        },
    )
    print(f"探测完成：{output_path}")


def main() -> None:
    args = parser().parse_args()
    settings = Settings.from_env()

    if args.command == "init":
        runtime = build_runtime(settings, verbose=args.verbose)
        runtime.repository.audit("application.initialized", None, None, "cli", {})
        print(f"数据库已初始化：{runtime.settings.database_path}")
    elif args.command == "login":
        asyncio.run(_login(args.verbose))
    elif args.command == "collect":
        asyncio.run(_collect(args.verbose))
    elif args.command == "assist":
        try:
            asyncio.run(_assist(args.verbose))
        except KeyboardInterrupt:
            print("乐聊 AI 辅助已由用户停止。")
    elif args.command == "probe":
        asyncio.run(_probe(args.verbose))
    elif args.command == "seed-demo":
        runtime = build_runtime(settings, verbose=args.verbose)
        runtime.repository.seed_demo()
        item = runtime.repository.list_work_items(limit=1)[0]
        runtime.repository.save_suggestion(
            int(item["message_id"]),
            status="ready",
            content=(
                "Hi! Thanks for checking. I need to confirm the destination and current "
                "delivery estimate before promising Friday. Could you share your city or postal code?"
            ),
            provider="demo",
            model="demo",
        )
        runtime.repository.audit("demo.seeded", None, None, "cli", {})
        print("演示数据已写入。")
    elif args.command == "serve":
        auto_collect = (
            settings.auto_collect_seconds
            if args.auto_collect_seconds is None
            else max(0, args.auto_collect_seconds)
        )
        settings = replace(settings, auto_collect_seconds=auto_collect)
        runtime = build_runtime(settings, verbose=args.verbose)
        app = create_app(runtime=runtime)
        uvicorn.run(
            app,
            host=args.host or settings.web_host,
            port=args.port or settings.web_port,
            log_level="debug" if args.verbose else "info",
        )
    elif args.command == "fleet":
        manifest_path = Path(args.manifest)
        if not manifest_path.is_absolute():
            manifest_path = settings.project_dir / manifest_path
        manifest = load_fleet_manifest(manifest_path, project_dir=settings.project_dir)
        if args.fleet_command == "validate":
            print(json.dumps(fleet_summary(manifest), ensure_ascii=False, indent=2))
        elif args.fleet_command == "status":
            print(json.dumps(read_fleet_status(manifest), ensure_ascii=False, indent=2))
        elif args.fleet_command == "login":
            account = next((item for item in manifest.accounts if item.key == args.account), None)
            if account is None:
                raise SystemExit(f"账号 key 不存在：{args.account}")
            code = asyncio.run(run_account_login(account, project_dir=settings.project_dir))
            if code:
                raise SystemExit(code)
        elif args.fleet_command == "assist":
            supervisor = FleetSupervisor(manifest, project_dir=settings.project_dir)
            try:
                asyncio.run(supervisor.run())
            except KeyboardInterrupt:
                print("多账号乐聊辅助已由用户停止。")


if __name__ == "__main__":
    main()
