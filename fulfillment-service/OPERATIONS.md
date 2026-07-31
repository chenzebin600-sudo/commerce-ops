# 马帮自动发货后台运行

## 第一次安装

1. 在 VS Code 的发货服务终端按 `Ctrl+C`，停止 `dev:fulfillment`。
2. 双击项目目录下的 `scripts\install-fulfillment-startup.cmd`。
3. 看到 `Installation complete` 后关闭窗口。
4. 等待约 10 秒，打开 `http://127.0.0.1:3112/docs`。

安装器优先使用 Windows 计划任务；如果本机计划任务不可用，会自动改用当前用户的“启动”文件夹。两种方式都不需要管理员权限，登录 Windows 后自动运行；服务异常退出时，守护程序会延迟后重新启动。

## 查看状态和日志

双击项目目录下的 `scripts\status-fulfillment-startup.cmd`。

日志文件：`storage\logs\fulfillment-service.log`。单个日志超过 5 MB 时自动归档，历史日志不会被自动删除。

只读发货 Agent 状态可通过 `http://127.0.0.1:3112/api/fulfillment/agent/status` 查看；交互测试入口位于 `http://127.0.0.1:3112/docs`。Agent 未配置 DeepSeek 时不会影响扫描和自动发货服务。

## 停止开机自启

双击项目目录下的 `scripts\uninstall-fulfillment-startup.cmd`。卸载会删除计划任务或“启动”文件夹入口，不删除订单数据库和日志。

## 运行条件

- 电脑保持开机且不进入睡眠。
- Windows 用户已经登录。
- 网络连接正常。
- 自动发货名单内的店铺会在安全检查通过后真实发货；名单外店铺只生成预览。
- 批次内最多同时处理 2 单，并按双单波次推进；任一波失败后不再启动下一波。
- 自动发货依赖 `.env` 中的真实提交、定时任务和自动发货三个开关，修改后必须重启服务。
