# 运营系统后台运行

## 第一次安装或从旧任务升级

1. 确认当前没有正在执行的真实发货批次。
2. 双击项目目录下的 `scripts\install-fulfillment-startup.cmd`。
3. 看到 `Installation complete` 后关闭窗口。
4. 等待约 10 秒，分别打开 `http://127.0.0.1:3101/` 和 `http://127.0.0.1:3112/docs`。

安装器优先使用 Windows 计划任务；如果本机计划任务不可用，会自动改用当前用户的“启动”文件夹。新的 `ZNWX Commerce Ops` 任务会同时托管主系统、主系统调度器和自动发货服务。安装成功后才会移除旧的 `ZNWX Mabang Fulfillment` 任务。

## 查看状态和日志

双击项目目录下的 `scripts\status-fulfillment-startup.cmd`。

状态窗口会同时检查主系统 `3101` 和发货服务 `3112`。统一日志为 `storage\logs\commerce-ops-system.log`，发货详细日志为 `storage\logs\fulfillment-service.log`。单个日志超过 5 MB 时自动归档。

## 开发模式

先双击 `scripts\stop-system.cmd` 停止后台任务，再在 PowerShell 运行：

```powershell
npm.cmd run dev
```

该命令同时启动 3101、3112 和主系统调度器，主系统与发货后端代码保存后会自动重载。按一次 `Ctrl+C` 会停止本次开发模式启动的所有进程。

完成开发后，双击 `scripts\restart-system.cmd` 恢复后台守护。如果尚未安装新任务，则重新双击安装器。

## 重启或停止

- `scripts\restart-system.cmd`：重启整套系统并等待 3101、3112 恢复。
- `scripts\stop-system.cmd`：停止后台任务，通常用于切换到开发模式。
- `scripts\uninstall-fulfillment-startup.cmd`：删除新旧自动启动入口，不删除数据库、订单或日志。

## 运行条件

- 电脑保持开机且不进入睡眠。
- Windows 用户已经登录。
- 网络连接正常。
- 自动发货名单内的店铺会在安全检查通过后真实发货；名单外店铺只生成预览。
- 批次内最多同时处理 2 单，并按双单波次推进；任一波失败后不再启动下一波。
- 自动发货依赖 `.env` 中的真实提交、定时任务和自动发货三个开关，修改后必须重启服务。
