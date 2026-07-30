# -*- coding: utf-8 -*-
"""Console entry point used by the installed desktop assistant."""

import ctypes
import os


def main():
    if os.name == "nt":
        ctypes.windll.kernel32.SetConsoleTitleW("马帮 WPS 本地同步服务 - 请勿关闭")
        os.system("chcp 65001 > nul")

    from mabang_local_service import main as run_service

    run_service()


if __name__ == "__main__":
    main()
