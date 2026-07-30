# -*- coding: utf-8 -*-
"""Windows desktop assistant for starting the local Mabang-to-WPS bridge."""

import json
import os
import queue
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import ctypes
from ctypes import wintypes
from pathlib import Path
import tkinter as tk
from tkinter import filedialog, messagebox, ttk


APP_NAME = "马帮 WPS 本地同步助手"
APP_VERSION = "1.1.0"
MABANG_SITE = "900445.private.mabangerp.com"
DATE_MODE_YESTERDAY = "yesterday"
DATE_MODE_MONTH = "month_to_yesterday"

BG = "#FFFFFF"
SURFACE = "#F5F6FA"
INK = "#171823"
MUTED = "#5D6172"
BORDER = "#D8DBE6"
PRIMARY = "#594AB5"
PRIMARY_HOVER = "#46399A"
SUCCESS = "#0F766E"
WARNING = "#9A5B00"
DANGER = "#B42318"

QUICK_URL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com", re.I)
DIRECT_HTTP_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
APP_MUTEX_NAME = "MabangWPSAssistant-8D0B0B77-EE86-4A68-8863-FD9C933FB19A"
_APP_MUTEX_HANDLE = None


def enable_dpi_awareness():
    if os.name != "nt":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


class JobObjectBasicLimitInformation(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class IoCounters(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JobObjectExtendedLimitInformation(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JobObjectBasicLimitInformation),
        ("IoInfo", IoCounters),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def acquire_single_instance():
    global _APP_MUTEX_HANDLE
    if os.name != "nt":
        return True
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    _APP_MUTEX_HANDLE = kernel32.CreateMutexW(None, False, APP_MUTEX_NAME)
    return bool(_APP_MUTEX_HANDLE) and kernel32.GetLastError() != 183


def create_kill_on_close_job():
    if os.name != "nt":
        return None
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    handle = kernel32.CreateJobObjectW(None, None)
    if not handle:
        return None

    information = JobObjectExtendedLimitInformation()
    information.BasicLimitInformation.LimitFlags = 0x00002000
    success = kernel32.SetInformationJobObject(
        handle,
        9,
        ctypes.byref(information),
        ctypes.sizeof(information),
    )
    if not success:
        kernel32.CloseHandle(handle)
        return None
    return handle


def assign_process_to_job(job_handle, process):
    if not job_handle or os.name != "nt":
        return
    try:
        ctypes.windll.kernel32.AssignProcessToJobObject(job_handle, wintypes.HANDLE(process._handle))
    except Exception:
        pass


def app_directory():
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def bundle_directory():
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)
    return Path(__file__).resolve().parent


def data_path(name):
    bundled = bundle_directory() / name
    if bundled.exists():
        return bundled
    return app_directory() / name


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http_json(url, timeout=5, method="GET", token="", payload=None):
    headers = {"User-Agent": "MabangWPSAssistant/1.0", "Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    body = None
    if method == "POST":
        body = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with DIRECT_HTTP_OPENER.open(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
            message = payload.get("message") or str(payload)
        except Exception:
            message = str(error)
        raise RuntimeError(message) from error


def replace_python_constant(source, name, value):
    replacement = f"{name} = {value!r}"
    pattern = re.compile(rf"^{re.escape(name)}\s*=.*$", re.M)
    updated, count = pattern.subn(replacement, source, count=1)
    if count != 1:
        raise RuntimeError(f"WPS 模板中缺少配置项：{name}")
    return updated


def generate_wps_code(
    service_url,
    token,
    table_name="请填写WPS表名",
    date_mode=DATE_MODE_MONTH,
):
    if date_mode not in (DATE_MODE_YESTERDAY, DATE_MODE_MONTH):
        raise ValueError(f"不支持的付款时间模式：{date_mode}")

    template = data_path("wps_call_local_mabang.py").read_text(encoding="utf-8")
    template = replace_python_constant(template, "LOCAL_SERVICE_URL", service_url)
    template = replace_python_constant(template, "SERVICE_TOKEN", token)
    template = replace_python_constant(template, "TARGET_TABLE_NAME", table_name)
    template = replace_python_constant(template, "DATE_MODE", date_mode)
    template = replace_python_constant(
        template,
        "DELETE_BEFORE_IMPORT",
        date_mode == DATE_MODE_MONTH,
    )
    compile(template, "generated_wps_script.py", "exec")
    return template


def process_command(name, source_script):
    if getattr(sys, "frozen", False):
        executable = app_directory() / name
        if not executable.exists():
            raise FileNotFoundError(f"安装目录缺少 {name}")
        return [str(executable)]
    return [sys.executable, str(app_directory() / source_script)]


def cloudflared_path():
    installed = app_directory() / "cloudflared.exe"
    if installed.exists():
        return installed

    program_files_roots = [
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("ProgramFiles"),
    ]
    for root in filter(None, program_files_roots):
        fallback = Path(root) / "cloudflared" / "cloudflared.exe"
        if fallback.exists():
            return fallback
    raise FileNotFoundError("未找到 cloudflared.exe，请重新安装本应用。")


def terminate_process_tree(process):
    if not process or process.poll() is not None:
        return
    try:
        process.terminate()
        process.wait(timeout=3)
        return
    except Exception:
        pass
    try:
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            timeout=10,
            check=False,
        )
    except Exception:
        try:
            process.terminate()
        except Exception:
            pass


class AssistantApp:
    def __init__(self, root, smoke_mode=False):
        self.root = root
        self.smoke_mode = smoke_mode
        self.smoke_error = ""
        self.events = queue.Queue()
        self.service_process = None
        self.tunnel_process = None
        self.generated_code = ""
        self.service_token = ""
        self.service_url = ""
        self.port = None
        self.running = False
        self.stopping = False
        self.run_generation = 0
        self.job_handle = create_kill_on_close_job()

        self.username_var = tk.StringVar()
        self.password_var = tk.StringVar()
        self.show_password_var = tk.BooleanVar(value=False)
        self.date_mode_var = tk.StringVar(value=DATE_MODE_MONTH)
        self.url_var = tk.StringVar(value="尚未生成")
        self.summary_var = tk.StringVar(value="选择付款时间并填写账号密码，然后开始准备数据。")
        self.service_status_var = tk.StringVar(value="待启动")
        self.data_status_var = tk.StringVar(value="待准备")
        self.tunnel_status_var = tk.StringVar(value="待启动")
        self.code_status_var = tk.StringVar(value="待生成")
        self.date_mode_buttons = []

        self._configure_window()
        self._configure_styles()
        self._build_ui()
        self.root.after(100, self._process_events)
        self.root.after(1500, self._monitor_processes)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

    def _configure_window(self):
        self.root.title(f"{APP_NAME}  {APP_VERSION}")
        self.root.geometry("940x820")
        self.root.minsize(820, 700)
        self.root.configure(bg=BG)

    def _configure_styles(self):
        style = ttk.Style(self.root)
        style.theme_use("clam")

        style.configure("App.TFrame", background=BG)
        style.configure("Surface.TFrame", background=SURFACE)
        style.configure("Title.TLabel", background=BG, foreground=INK, font=("Microsoft YaHei UI", 20, "bold"))
        style.configure("Subtitle.TLabel", background=BG, foreground=MUTED, font=("Microsoft YaHei UI", 10))
        style.configure("Section.TLabel", background=BG, foreground=INK, font=("Microsoft YaHei UI", 11, "bold"))
        style.configure("Field.TLabel", background=BG, foreground=INK, font=("Microsoft YaHei UI", 9, "bold"))
        style.configure("Hint.TLabel", background=BG, foreground=MUTED, font=("Microsoft YaHei UI", 9))
        style.configure("SurfaceHint.TLabel", background=SURFACE, foreground=MUTED, font=("Microsoft YaHei UI", 9))
        style.configure("StageName.TLabel", background=SURFACE, foreground=MUTED, font=("Microsoft YaHei UI", 9))
        style.configure("StageValue.TLabel", background=SURFACE, foreground=INK, font=("Microsoft YaHei UI", 10, "bold"))

        style.configure(
            "Primary.TButton",
            background=PRIMARY,
            foreground=BG,
            borderwidth=0,
            focusthickness=2,
            focuscolor=PRIMARY_HOVER,
            padding=(18, 11),
            font=("Microsoft YaHei UI", 10, "bold"),
        )
        style.map(
            "Primary.TButton",
            background=[("active", PRIMARY_HOVER), ("pressed", PRIMARY_HOVER), ("disabled", "#AAA5CA")],
            foreground=[("disabled", "#F5F4FA")],
        )
        style.configure(
            "Secondary.TButton",
            background=SURFACE,
            foreground=INK,
            bordercolor=BORDER,
            borderwidth=1,
            padding=(14, 9),
            font=("Microsoft YaHei UI", 9),
        )
        style.map("Secondary.TButton", background=[("active", "#EAECF3"), ("pressed", "#E2E4EE")])
        style.configure(
            "Mode.TRadiobutton",
            background=SURFACE,
            foreground=INK,
            padding=(12, 10),
            font=("Microsoft YaHei UI", 9),
        )
        style.map(
            "Mode.TRadiobutton",
            background=[("active", "#EAECF3"), ("selected", "#ECEAF8")],
            foreground=[("disabled", "#8B8E9C")],
        )
        style.configure("App.TEntry", fieldbackground=BG, foreground=INK, bordercolor=BORDER, padding=(10, 9))
        style.map("App.TEntry", bordercolor=[("focus", PRIMARY)])
        style.configure(
            "App.Horizontal.TProgressbar",
            troughcolor="#E8E9F0",
            background=PRIMARY,
            borderwidth=0,
            thickness=5,
        )

    def _build_ui(self):
        shell = ttk.Frame(self.root, style="App.TFrame", padding=(30, 24, 30, 24))
        shell.grid(row=0, column=0, sticky="nsew")
        self.root.grid_rowconfigure(0, weight=1)
        self.root.grid_columnconfigure(0, weight=1)
        shell.grid_columnconfigure(0, weight=1)
        shell.grid_rowconfigure(8, weight=1)

        header = ttk.Frame(shell, style="App.TFrame")
        header.grid(row=0, column=0, sticky="ew")
        header.grid_columnconfigure(0, weight=1)
        ttk.Label(header, text=APP_NAME, style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(
            header,
            text="选择付款时间后，本机提前导出数据并生成可复制的 WPS 脚本。",
            style="Subtitle.TLabel",
        ).grid(row=1, column=0, sticky="w", pady=(5, 0))
        ttk.Label(header, text=f"固定站点  {MABANG_SITE}", style="Subtitle.TLabel").grid(
            row=0, column=1, rowspan=2, sticky="e"
        )

        ttk.Separator(shell).grid(row=1, column=0, sticky="ew", pady=(20, 18))

        form = ttk.Frame(shell, style="App.TFrame")
        form.grid(row=2, column=0, sticky="ew")
        form.grid_columnconfigure(0, weight=1)
        form.grid_columnconfigure(1, weight=1)

        ttk.Label(form, text="马帮账号", style="Field.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(form, text="马帮密码", style="Field.TLabel").grid(row=0, column=1, sticky="w", padx=(18, 0))

        self.username_entry = ttk.Entry(form, textvariable=self.username_var, style="App.TEntry")
        self.username_entry.grid(row=1, column=0, sticky="ew", pady=(7, 0))

        password_row = ttk.Frame(form, style="App.TFrame")
        password_row.grid(row=1, column=1, sticky="ew", padx=(18, 0), pady=(7, 0))
        password_row.grid_columnconfigure(0, weight=1)
        self.password_entry = ttk.Entry(password_row, textvariable=self.password_var, show="●", style="App.TEntry")
        self.password_entry.grid(row=0, column=0, sticky="ew")
        ttk.Checkbutton(
            password_row,
            text="显示",
            variable=self.show_password_var,
            command=self._toggle_password,
        ).grid(row=0, column=1, padx=(10, 0))

        ttk.Label(
            form,
            text="账号和密码仅传给本机服务，不会写入 WPS 脚本或保存到磁盘。",
            style="Hint.TLabel",
        ).grid(row=2, column=0, columnspan=2, sticky="w", pady=(8, 0))

        ttk.Label(form, text="付款时间与写表方式", style="Field.TLabel").grid(
            row=3, column=0, columnspan=2, sticky="w", pady=(16, 0)
        )
        mode_row = ttk.Frame(form, style="Surface.TFrame", padding=(8, 4))
        mode_row.grid(row=4, column=0, columnspan=2, sticky="ew", pady=(7, 0))
        mode_row.grid_columnconfigure(0, weight=1)
        mode_row.grid_columnconfigure(1, weight=1)

        yesterday_button = ttk.Radiobutton(
            mode_row,
            text="昨天（保留原表并追加）",
            value=DATE_MODE_YESTERDAY,
            variable=self.date_mode_var,
            command=self._date_mode_changed,
            style="Mode.TRadiobutton",
        )
        yesterday_button.grid(row=0, column=0, sticky="ew")
        month_button = ttk.Radiobutton(
            mode_row,
            text="本月1日至昨天（清空后导入）",
            value=DATE_MODE_MONTH,
            variable=self.date_mode_var,
            command=self._date_mode_changed,
            style="Mode.TRadiobutton",
        )
        month_button.grid(row=0, column=1, sticky="ew", padx=(8, 0))
        self.date_mode_buttons = [yesterday_button, month_button]

        actions = ttk.Frame(shell, style="App.TFrame")
        actions.grid(row=3, column=0, sticky="ew", pady=(18, 16))
        actions.grid_columnconfigure(2, weight=1)
        self.start_button = ttk.Button(
            actions,
            text="准备数据并生成 WPS 代码",
            style="Primary.TButton",
            command=self.start_flow,
        )
        self.start_button.grid(row=0, column=0, sticky="w")
        self.stop_button = ttk.Button(
            actions,
            text="停止服务",
            style="Secondary.TButton",
            command=self.stop_services,
            state="disabled",
        )
        self.stop_button.grid(row=0, column=1, sticky="w", padx=(10, 0))
        ttk.Label(
            actions,
            textvariable=self.summary_var,
            style="Hint.TLabel",
            wraplength=340,
            justify="right",
        ).grid(row=0, column=2, sticky="e")

        self.progress = ttk.Progressbar(shell, mode="indeterminate", style="App.Horizontal.TProgressbar")
        self.progress.grid(row=4, column=0, sticky="ew", pady=(0, 14))
        self.progress.grid_remove()

        status = ttk.Frame(shell, style="Surface.TFrame", padding=(18, 14))
        status.grid(row=5, column=0, sticky="ew")
        for column in range(4):
            status.grid_columnconfigure(column, weight=1)

        self._stage(status, 0, "本地服务", self.service_status_var)
        self._stage(status, 1, "数据准备", self.data_status_var)
        self._stage(status, 2, "HTTPS 隧道", self.tunnel_status_var)
        self._stage(status, 3, "WPS 代码", self.code_status_var)

        url_row = ttk.Frame(shell, style="App.TFrame")
        url_row.grid(row=6, column=0, sticky="ew", pady=(16, 12))
        url_row.grid_columnconfigure(0, weight=1)
        ttk.Label(url_row, text="LOCAL_SERVICE_URL", style="Field.TLabel").grid(row=0, column=0, sticky="w")
        self.url_entry = ttk.Entry(url_row, textvariable=self.url_var, state="readonly", style="App.TEntry")
        self.url_entry.grid(row=1, column=0, sticky="ew", pady=(7, 0))
        self.copy_url_button = ttk.Button(
            url_row,
            text="复制地址",
            style="Secondary.TButton",
            command=self.copy_url,
            state="disabled",
        )
        self.copy_url_button.grid(row=1, column=1, padx=(10, 0), pady=(7, 0))

        tabs = ttk.Notebook(shell)
        tabs.grid(row=8, column=0, sticky="nsew")

        code_tab = ttk.Frame(tabs, style="App.TFrame", padding=(12, 12))
        log_tab = ttk.Frame(tabs, style="App.TFrame", padding=(12, 12))
        tabs.add(code_tab, text="WPS 完整代码")
        tabs.add(log_tab, text="运行日志")

        code_tab.grid_rowconfigure(1, weight=1)
        code_tab.grid_columnconfigure(0, weight=1)
        code_toolbar = ttk.Frame(code_tab, style="App.TFrame")
        code_toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        code_toolbar.grid_columnconfigure(0, weight=1)
        ttk.Label(
            code_toolbar,
            text="生成后完整复制到 WPS；代码中只需修改 TARGET_TABLE_NAME。",
            style="Hint.TLabel",
        ).grid(row=0, column=0, sticky="w")
        self.copy_code_button = ttk.Button(
            code_toolbar,
            text="复制全部代码",
            style="Secondary.TButton",
            command=self.copy_code,
            state="disabled",
        )
        self.copy_code_button.grid(row=0, column=1, padx=(8, 0))
        self.save_code_button = ttk.Button(
            code_toolbar,
            text="保存脚本",
            style="Secondary.TButton",
            command=self.save_code,
            state="disabled",
        )
        self.save_code_button.grid(row=0, column=2, padx=(8, 0))

        self.code_text = tk.Text(
            code_tab,
            wrap="none",
            font=("Consolas", 9),
            bg="#F8F9FC",
            fg=INK,
            insertbackground=INK,
            relief="solid",
            borderwidth=1,
            highlightthickness=0,
            padx=12,
            pady=10,
        )
        code_scroll_y = ttk.Scrollbar(code_tab, orient="vertical", command=self.code_text.yview)
        code_scroll_x = ttk.Scrollbar(code_tab, orient="horizontal", command=self.code_text.xview)
        self.code_text.configure(yscrollcommand=code_scroll_y.set, xscrollcommand=code_scroll_x.set)
        self.code_text.grid(row=1, column=0, sticky="nsew")
        code_scroll_y.grid(row=1, column=1, sticky="ns")
        code_scroll_x.grid(row=2, column=0, sticky="ew")

        log_tab.grid_rowconfigure(0, weight=1)
        log_tab.grid_columnconfigure(0, weight=1)
        self.log_text = tk.Text(
            log_tab,
            wrap="word",
            font=("Microsoft YaHei UI", 9),
            bg="#F8F9FC",
            fg=INK,
            relief="solid",
            borderwidth=1,
            highlightthickness=0,
            padx=12,
            pady=10,
            state="disabled",
        )
        log_scroll = ttk.Scrollbar(log_tab, orient="vertical", command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        log_scroll.grid(row=0, column=1, sticky="ns")

        ttk.Label(
            shell,
            text="运行期间请保持本应用和自动打开的终端窗口开启。临时 HTTPS 地址在重启后会变化。",
            style="Hint.TLabel",
        ).grid(row=9, column=0, sticky="w", pady=(12, 0))

        self.username_entry.focus_set()

    def _stage(self, parent, column, title, variable):
        frame = ttk.Frame(parent, style="Surface.TFrame")
        frame.grid(row=0, column=column, sticky="ew", padx=(0 if column == 0 else 18, 0))
        ttk.Label(frame, text=title, style="StageName.TLabel").grid(row=0, column=0, sticky="w")
        label = ttk.Label(frame, textvariable=variable, style="StageValue.TLabel")
        label.grid(row=1, column=0, sticky="w", pady=(3, 0))

    def _toggle_password(self):
        self.password_entry.configure(show="" if self.show_password_var.get() else "●")

    def _date_mode_changed(self):
        if self.date_mode_var.get() == DATE_MODE_YESTERDAY:
            self.summary_var.set("昨天模式：保留原表数据，并把昨天明细追加到表尾。")
        else:
            self.summary_var.set("本月模式：导入本月1日至昨天，并在写入前清空原表。")

    def _emit(self, kind, payload=None):
        self.events.put((kind, payload))

    def _log(self, message):
        self._emit("log", message)

    def start_flow(self):
        username = self.username_var.get().strip()
        password = self.password_var.get()
        date_mode = self.date_mode_var.get()

        if not username:
            self.summary_var.set("请输入马帮账号。")
            self.username_entry.focus_set()
            return
        if not password:
            self.summary_var.set("请输入马帮密码。")
            self.password_entry.focus_set()
            return

        if self.running:
            self.stop_services(silent=True)

        self.run_generation += 1
        generation = self.run_generation
        self.running = True
        self.stopping = False
        self.generated_code = ""
        self.service_url = ""
        self.service_token = secrets.token_urlsafe(32)
        self.port = find_free_port()

        self.code_text.delete("1.0", "end")
        self.url_var.set("正在生成...")
        self.summary_var.set("正在启动本地服务...")
        self.service_status_var.set("启动中")
        self.data_status_var.set("等待服务")
        self.tunnel_status_var.set("等待服务")
        self.code_status_var.set("待生成")
        self.start_button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.copy_url_button.configure(state="disabled")
        self.copy_code_button.configure(state="disabled")
        self.save_code_button.configure(state="disabled")
        self.username_entry.configure(state="disabled")
        self.password_entry.configure(state="disabled")
        for button in self.date_mode_buttons:
            button.configure(state="disabled")
        self.progress.grid()
        self.progress.start(12)

        self._append_log("开始启动本地同步环境。")
        threading.Thread(
            target=self._bootstrap,
            args=(username, password, self.service_token, self.port, date_mode, generation),
            daemon=True,
        ).start()

    def _is_current_run(self, generation):
        return self.running and not self.stopping and generation == self.run_generation

    def _bootstrap(self, username, password, token, port, date_mode, generation):
        try:
            service_cmd = process_command("MabangLocalService.exe", "mabang_service_worker.py")
            env = os.environ.copy()
            env.update(
                {
                    "MABANG_USERNAME": username,
                    "MABANG_PASSWORD": password,
                    "MABANG_LOCAL_TOKEN": token,
                    "MABANG_LOCAL_HOST": "127.0.0.1",
                    "MABANG_LOCAL_PORT": str(port),
                    "MABANG_DATE_MODE": date_mode,
                    "PYTHONUTF8": "1",
                }
            )

            self._log("正在打开本地服务终端...")
            self.service_process = subprocess.Popen(
                service_cmd,
                cwd=str(app_directory()),
                env=env,
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
            assign_process_to_job(self.job_handle, self.service_process)

            health_url = f"http://127.0.0.1:{port}/health"
            self._wait_local_health(health_url, 45, generation)
            if not self._is_current_run(generation):
                return
            self._emit("service_validating")

            if not self.smoke_mode:
                self._log("正在使用本机网络验证马帮账号...")
                validation = http_json(
                    f"http://127.0.0.1:{port}/validate",
                    timeout=60,
                    method="POST",
                    token=token,
                )
                if not validation.get("success"):
                    raise RuntimeError(validation.get("message") or "马帮账号验证失败。")

            if not self._is_current_run(generation):
                return
            self._emit("service_ready")

            prepared_job_id = ""
            if not self.smoke_mode:
                self._emit("data_preparing", "正在创建本地预导出任务")
                prepared = http_json(
                    f"http://127.0.0.1:{port}/jobs",
                    timeout=15,
                    method="POST",
                    token=token,
                    payload={"date_mode": date_mode},
                )
                prepared_job_id = prepared.get("job_id") or ""
                if not prepared_job_id:
                    raise RuntimeError("本地服务未返回预导出任务编号。")

            tunnel_exe = cloudflared_path()
            tunnel_cmd = [
                str(tunnel_exe),
                "tunnel",
                "--no-autoupdate",
                "--protocol",
                "http2",
                "--url",
                f"http://127.0.0.1:{port}",
            ]
            self._log("正在创建临时 HTTPS 地址...")
            self._emit("tunnel_starting")

            self.tunnel_process = subprocess.Popen(
                tunnel_cmd,
                cwd=str(app_directory()),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            assign_process_to_job(self.job_handle, self.tunnel_process)

            service_url = self._read_tunnel_url(90, generation)
            if not self._is_current_run(generation):
                return
            self._emit("url_found", service_url)
            public_ready = self._wait_public_health(service_url + "/health", 45, generation)
            if not self._is_current_run(generation):
                return
            if not public_ready:
                self._log("本机暂时无法验证公网地址；WPS 脚本会自动重试连接。")

            if prepared_job_id:
                prepared_status = self._wait_local_job(
                    port,
                    token,
                    prepared_job_id,
                    3600,
                    generation,
                )
                if not self._is_current_run(generation):
                    return
                self._emit("data_ready", prepared_status)
            else:
                self._emit("data_ready", {"rows": 0, "orders": 0})

            code = generate_wps_code(service_url, token, date_mode=date_mode)
            self._emit("ready", (service_url, code))
            threading.Thread(target=self._drain_tunnel_output, daemon=True).start()

        except Exception as error:
            if self._is_current_run(generation):
                self._emit("error", str(error))

    def _wait_local_health(self, url, timeout_seconds, generation):
        deadline = time.time() + timeout_seconds
        last_error = None
        while time.time() < deadline and self._is_current_run(generation):
            if self.service_process and self.service_process.poll() is not None:
                raise RuntimeError("本地服务终端已退出，请查看终端中的错误信息。")
            try:
                data = http_json(url, timeout=2)
                if data.get("success"):
                    return
            except Exception as error:
                last_error = error
            time.sleep(1)
        raise RuntimeError(f"本地服务启动超时：{last_error or '无法连接服务'}")

    def _wait_local_job(self, port, token, job_id, timeout_seconds, generation):
        url = f"http://127.0.0.1:{port}/jobs/{job_id}"
        deadline = time.time() + timeout_seconds
        last_message = ""

        while time.time() < deadline and self._is_current_run(generation):
            if self.service_process and self.service_process.poll() is not None:
                raise RuntimeError("数据准备期间本地服务已退出，请查看终端错误。")

            status = http_json(url, timeout=10, token=token)
            state = status.get("state")
            message = str(status.get("message") or "正在准备数据")

            if message != last_message:
                self._log(message)
                self._emit("data_preparing", message)
                last_message = message

            if state == "ready":
                return status
            if state == "failed":
                raise RuntimeError(message or "本地预导出失败。")

            time.sleep(2)

        raise RuntimeError("本地预导出等待超时，请查看终端中的导出进度。")

    def _read_tunnel_url(self, timeout_seconds, generation):
        deadline = time.time() + timeout_seconds
        while time.time() < deadline and self._is_current_run(generation):
            if not self.tunnel_process or not self.tunnel_process.stdout:
                raise RuntimeError("Cloudflare 隧道进程未启动。")
            if self.tunnel_process.poll() is not None:
                raise RuntimeError("Cloudflare 隧道已退出，请检查网络连接。")

            line = self.tunnel_process.stdout.readline()
            if not line:
                time.sleep(0.2)
                continue

            clean = line.strip()
            if clean:
                match = QUICK_URL_PATTERN.search(clean)
                if match:
                    self._log("临时 HTTPS 地址已生成，正在验证连通性。")
                    return match.group(0)
                if "ERR" in clean or "error" in clean.lower():
                    self._log("Cloudflare：" + clean[:260])

        raise RuntimeError("等待 Cloudflare HTTPS 地址超时，请检查当前网络是否允许访问 Cloudflare。")

    def _wait_public_health(self, url, timeout_seconds, generation):
        deadline = time.time() + timeout_seconds
        last_error = None
        while time.time() < deadline and self._is_current_run(generation):
            try:
                data = http_json(url, timeout=5)
                if data.get("success"):
                    self._log("公网 HTTPS 地址验证成功。")
                    return True
            except Exception as error:
                last_error = error
            time.sleep(2)
        if last_error:
            self._log("公网验证提醒：" + str(last_error))
        return False

    def _drain_tunnel_output(self):
        process = self.tunnel_process
        if not process or not process.stdout:
            return
        for line in process.stdout:
            if not self.running:
                break
            clean = line.strip()
            if clean and ("ERR" in clean or "error" in clean.lower()):
                self._log("Cloudflare：" + clean[:260])

    def _process_events(self):
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "log":
                    self._append_log(payload)
                elif kind == "service_validating":
                    self.service_status_var.set("验证账号")
                    self.summary_var.set("正在通过本机网络验证马帮账号...")
                elif kind == "service_ready":
                    self.service_status_var.set("已启动")
                    self.data_status_var.set("启动中")
                    self.tunnel_status_var.set("启动中")
                    self.summary_var.set("本地服务已启动，正在准备数据和 HTTPS 地址...")
                elif kind == "data_preparing":
                    self.data_status_var.set("准备中")
                    self.summary_var.set(str(payload or "正在准备马帮订单数据..."))
                elif kind == "data_ready":
                    rows = int((payload or {}).get("rows") or 0)
                    self.data_status_var.set(f"已准备 {rows} 行" if rows else "已就绪")
                    self.summary_var.set("数据已准备完成，正在生成 WPS 代码...")
                elif kind == "tunnel_starting":
                    self.tunnel_status_var.set("启动中")
                elif kind == "url_found":
                    self.url_var.set(payload)
                    self.tunnel_status_var.set("验证中")
                elif kind == "ready":
                    self._show_ready(*payload)
                elif kind == "error":
                    self._show_error(payload)
        except queue.Empty:
            pass
        self.root.after(100, self._process_events)

    def _append_log(self, message):
        stamp = time.strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"{stamp}  {message}\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _show_ready(self, service_url, code):
        self.service_url = service_url
        self.generated_code = code
        self.url_var.set(service_url)
        self.service_status_var.set("运行中")
        if self.data_status_var.get() in ("等待服务", "启动中", "准备中"):
            self.data_status_var.set("已准备")
        self.tunnel_status_var.set("已连接")
        self.code_status_var.set("已生成")
        self.summary_var.set("全部就绪，可以复制 WPS 代码。")
        self.progress.stop()
        self.progress.grid_remove()
        self.copy_url_button.configure(state="normal")
        self.copy_code_button.configure(state="normal")
        self.save_code_button.configure(state="normal")
        self.start_button.configure(text="重新启动", state="normal")
        self.code_text.delete("1.0", "end")
        self.code_text.insert("1.0", code)
        mode_text = "昨天追加" if self.date_mode_var.get() == DATE_MODE_YESTERDAY else "本月重建"
        self._append_log(f"WPS 完整代码已生成，模式：{mode_text}；只需修改 TARGET_TABLE_NAME。")

    def _show_error(self, message):
        if self.stopping:
            return
        terminate_process_tree(self.tunnel_process)
        terminate_process_tree(self.service_process)
        self.tunnel_process = None
        self.service_process = None
        self.running = False
        self.progress.stop()
        self.progress.grid_remove()
        self.summary_var.set("启动失败，请查看运行日志。")
        self._append_log("启动失败：" + message)
        if self.service_status_var.get() == "启动中":
            self.service_status_var.set("失败")
        if self.data_status_var.get() in ("等待服务", "启动中", "准备中"):
            self.data_status_var.set("失败")
        if self.tunnel_status_var.get() in ("等待服务", "启动中", "验证中"):
            self.tunnel_status_var.set("失败")
        self.start_button.configure(text="重新尝试", state="normal")
        self.stop_button.configure(state="disabled")
        self.username_entry.configure(state="normal")
        self.password_entry.configure(state="normal")
        for button in self.date_mode_buttons:
            button.configure(state="normal")
        self.smoke_error = message
        if not self.smoke_mode:
            messagebox.showerror("启动失败", message, parent=self.root)

    def _monitor_processes(self):
        if self.running and not self.stopping:
            if self.service_process and self.service_process.poll() is not None:
                self._show_error("本地服务终端已关闭。请点击“重新尝试”再次启动。")
                self.running = False
            elif self.tunnel_process and self.tunnel_process.poll() is not None and self.service_url:
                self._show_error("HTTPS 隧道已断开。请点击“重新尝试”生成新地址和代码。")
                self.running = False
        self.root.after(1500, self._monitor_processes)

    def copy_url(self):
        if not self.service_url:
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.service_url)
        self.summary_var.set("HTTPS 地址已复制。")

    def copy_code(self):
        if not self.generated_code:
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.generated_code)
        self.summary_var.set("WPS 完整代码已复制。")
        self._append_log("已复制 WPS 完整代码。")

    def save_code(self):
        if not self.generated_code:
            return
        path = filedialog.asksaveasfilename(
            parent=self.root,
            title="保存 WPS 脚本",
            defaultextension=".py",
            initialfile="马帮WPS同步脚本.py",
            filetypes=[("Python 脚本", "*.py"), ("所有文件", "*.*")],
        )
        if not path:
            return
        Path(path).write_text(self.generated_code, encoding="utf-8")
        self.summary_var.set("WPS 脚本已保存。")

    def stop_services(self, silent=False):
        self.stopping = True
        self.run_generation += 1
        terminate_process_tree(self.tunnel_process)
        terminate_process_tree(self.service_process)
        self.tunnel_process = None
        self.service_process = None
        self.running = False
        self.stopping = False
        self.progress.stop()
        self.progress.grid_remove()
        self.service_status_var.set("已停止")
        self.data_status_var.set("已停止")
        self.tunnel_status_var.set("已停止")
        if not self.generated_code:
            self.code_status_var.set("待生成")
        self.summary_var.set("服务已停止；原临时地址将不再可用。")
        self.start_button.configure(text="准备数据并生成 WPS 代码", state="normal")
        self.stop_button.configure(state="disabled")
        self.username_entry.configure(state="normal")
        self.password_entry.configure(state="normal")
        for button in self.date_mode_buttons:
            button.configure(state="normal")
        if not silent:
            self._append_log("本地服务和 HTTPS 隧道已停止。")

    def _on_close(self):
        if self.running:
            confirmed = messagebox.askyesno(
                "退出应用",
                "退出后本地服务和 HTTPS 地址会立即失效，WPS 将无法同步。确定退出吗？",
                parent=self.root,
            )
            if not confirmed:
                return
        self.stop_services(silent=True)
        self.root.destroy()


def cli_option_value(name):
    prefix = name + "="
    for index, argument in enumerate(sys.argv):
        if argument.startswith(prefix):
            return argument[len(prefix):]
        if argument == name and index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return ""


def emit_cli_result(payload):
    output = json.dumps(payload, ensure_ascii=False)
    print(output, flush=True)
    result_file = cli_option_value("--result-file")
    if result_file:
        Path(result_file).write_text(output, encoding="utf-8")


def self_test():
    token = secrets.token_urlsafe(32)
    code = generate_wps_code("https://example.trycloudflare.com", token)
    yesterday_code = generate_wps_code(
        "https://example.trycloudflare.com",
        token,
        date_mode=DATE_MODE_YESTERDAY,
    )
    checks = {
        "template": data_path("wps_call_local_mabang.py").exists(),
        "code_compiles": bool(code),
        "token_embedded": token in code,
        "url_embedded": "https://example.trycloudflare.com" in code,
        "table_placeholder": "TARGET_TABLE_NAME = '请填写WPS表名'" in code,
        "month_deletes_table": "DELETE_BEFORE_IMPORT = True" in code,
        "yesterday_keeps_table": "DELETE_BEFORE_IMPORT = False" in yesterday_code,
        "yesterday_mode": "DATE_MODE = 'yesterday'" in yesterday_code,
    }
    emit_cli_result(checks)
    return 0 if all(checks.values()) else 1


def main():
    enable_dpi_awareness()

    if "--self-test" in sys.argv:
        raise SystemExit(self_test())

    smoke_mode = "--smoke-test" in sys.argv
    if not smoke_mode and not acquire_single_instance():
        ctypes.windll.user32.MessageBoxW(
            None,
            "应用已经在运行，请切换到现有窗口。",
            APP_NAME,
            0x00000040,
        )
        return
    root = tk.Tk()
    app = AssistantApp(root, smoke_mode=smoke_mode)

    if smoke_mode:
        app.username_var.set("smoke-test")
        app.password_var.set("smoke-test")
        started_at = time.time()

        def check_smoke_result():
            if app.generated_code:
                result = {
                    "success": True,
                    "service_url": app.service_url,
                    "code_length": len(app.generated_code),
                }
                emit_cli_result(result)
                app.stop_services(silent=True)
                root.destroy()
                return
            if app.smoke_error or time.time() - started_at > 180:
                result = {
                    "success": False,
                    "message": app.smoke_error or "smoke test timeout",
                }
                emit_cli_result(result)
                app.stop_services(silent=True)
                root.destroy()
                return
            root.after(500, check_smoke_result)

        root.after(300, app.start_flow)
        root.after(800, check_smoke_result)

    root.mainloop()


if __name__ == "__main__":
    main()
