# 跨境电商运营系统

这是公司内部使用的跨境电商运营工作台，当前包含商品、订单、马帮数据采集、定时任务和 Shopee 印尼店铺自动发货等功能。

## 当前重点

马帮自动发货服务目前覆盖同一马帮账号下的 5 个 Shopee 印尼店铺：

- Arca Woods
- CONOCO.ID
- JOJO Mall
- Table Trove Mall.ID
- Toko Penguin

其中 Arca Woods、JOJO Mall、Table Trove Mall.ID、Toko Penguin 已配置为可自动发货店铺；CONOCO.ID 目前没有可用于真实验证的订单，暂时只扫描、不自动提交。

自动发货每批最多处理 10 单，只接受“待处理”、信息完整、库存充足、尚无运单号且物流渠道匹配的订单。提交前会进行二次检查，提交后逐单回查运单号、物流渠道和订单状态，并将成功订单转入“配货中”。

Shopee 运单号长时间处于审批中时，系统会持久化回查；默认超过 30 分钟后严格复检并清空物流渠道，仅重新交运一次，最长观察 24 小时。写操作结果不确定时停止自动处理并转人工，避免重复发货。

主系统“发货任务”页已提供只读运单恢复队列，可直接查看订单当前恢复阶段、下次回查时间、渠道清空次数和最后异常。该页面不提供清空渠道或重新交运按钮，真实恢复动作仍受履约服务的精确订单确认与安全开关保护。

主系统“发货总览”已升级为运营看板：按北京时间从完整履约数据库统计今日订单、成功率、执行中、预检异常、店铺表现、平均耗时和近 7 日趋势。同一订单的重复尝试只采用最新结果，避免把接口重试误算成多笔订单；运单审批中的订单归入执行中，不计为人工异常。

发货页顶部提供异常雷达和异常中心，统一展示库存不足、多仓、发货时效、运单号延迟和马帮登录异常。严重异常优先显示，并带店铺、订单号、发现时间和建议动作；库存、多仓及运单延迟可直接进入只读重新核对。Windows 通知采用持久化冷却，同一问题不会因服务重启而频繁弹出。

待处理订单会读取马帮订单列表“剩余发货”所使用的原始字段，并按 UTC+8 换算为绝对截止时间；自动扫描和预览优先选择最早到期订单，期限缺失时回退到原付款时间顺序。看板按剩余 24 小时、6 小时、2 小时和已超时分级预警，但任何时效优先都不会绕过库存、多仓、状态、运单号或物流渠道检查。

自动发货的国家、店铺、平台、物流渠道、仓库范围和店铺级开关已迁移到 [fulfillment-shops.json](config/fulfillment-shops.json)。新增国家或店铺时先配置为只扫描，完成深度预检和单笔真实验证后再加入双重自动发货开关。维护说明见 [FULFILLMENT_SHOP_CONFIG.md](docs/FULFILLMENT_SHOP_CONFIG.md)。

更详细的发货规则见 [fulfillment-service/README.md](fulfillment-service/README.md)，每日工作记录见 [docs/DAILY_PROGRESS.md](docs/DAILY_PROGRESS.md)。

## 本机入口

| 功能 | 地址 |
| --- | --- |
| 运营系统前端 | http://127.0.0.1:3101/ |
| 自动发货控制台 | http://127.0.0.1:3101/ （进入“自动发货”页面） |
| 发货接口测试文档 | http://127.0.0.1:3112/docs |
| OpenAPI 接口定义 | http://127.0.0.1:3112/openapi.json |

## 环境要求

- Windows 10/11
- Node.js 22 或更高版本
- npm
- Python 3.10 或更高版本（马帮采集和广告分析功能需要）
- Chrome、Edge 或 Chromium

首次使用时，在项目目录执行：

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd run doctor
```

如果 `.env` 已经存在，不要覆盖。账号、密码、访问令牌等敏感配置只保存在 `.env`，不得写入 README 或提交到代码仓库。

## 常用启动方式

### 统一开发模式（推荐）

```powershell
npm.cmd run dev
```

一条命令同时启动主系统 `3101`、主系统调度器和自动发货服务 `3112`。主系统及发货服务代码保存后会自动重载，修改前端静态文件后刷新浏览器即可看到变化。按一次 `Ctrl+C` 会停止本次开发模式启动的全部进程。

Windows 也可以双击 `scripts\start-development-mode.cmd`。该入口会等待扫描或真实发货批次安全结束，自动请求管理员权限停止后台正式服务，然后在当前窗口启动主系统和发货服务的代码自动重载。

如果 Windows 后台任务已经占用 3101 或 3112，统一开发模式会拒绝启动重复的发货进程；使用上述一键入口即可先安全停止后台服务。

### 只调整前端或主系统代码

```powershell
npm.cmd run dev:main
```

主服务运行在 `3101` 端口。保存后端代码后会自动重启；修改前端静态文件后刷新浏览器即可看到变化。

### 调试自动发货服务

```powershell
npm.cmd run dev:fulfillment
```

发货服务运行在 `3112` 端口。修改 `.env` 后需要手动重启一次。

### 只启动主系统

```powershell
npm.cmd run start:main
```

### 正常启动整套系统

```powershell
npm.cmd start
```

该命令由统一守护程序管理主系统、主系统调度器和自动发货服务。单个服务异常时独立重启；已经存在健康服务时不会再启动重复进程。

### 查看项目状态

```powershell
npm.cmd run doctor
npm.cmd run build
npm.cmd test
```

Windows PowerShell 如果提示 `npm.ps1` 被禁止执行，直接使用本文中的 `npm.cmd`，不需要修改系统执行策略。

## 整套系统后台运行

主系统和自动发货服务可通过一个 Windows 计划任务在登录后自动启动：

1. 双击 `scripts\install-fulfillment-startup.cmd` 完成安装。
2. 双击 `scripts\status-fulfillment-startup.cmd` 查看状态。
3. 双击 `scripts\restart-system.cmd` 重启整套系统。
4. 双击 `scripts\stop-system.cmd` 停止后台服务，以便运行统一开发模式。
5. 统一日志位于 `storage\logs\commerce-ops-system.log`，发货详细日志仍位于 `storage\logs\fulfillment-service.log`。
6. 如需取消登录自启，双击 `scripts\uninstall-fulfillment-startup.cmd`。

安装器会先创建新的 `ZNWX Commerce Ops` 任务，成功后再移除旧的 `ZNWX Mabang Fulfillment` 任务，避免升级时先失去自动发货守护。

电脑必须保持开机、Windows 用户保持登录且网络正常。关闭浏览器或关闭显示器不会影响服务；电脑睡眠、关机或退出 Windows 登录会停止运行。

## 安全规则

- 真实提交总开关默认关闭。
- 缺货、库存未知、订单状态变化、已有运单号或物流渠道不匹配时不提交。
- 人工操作先生成预览，再使用一次性确认令牌确认。
- 自动模式只处理配置白名单中的店铺。
- 同一时间只允许一个真实发货批次运行。
- 单批任一订单失败后，后续未提交订单停止处理，避免扩大异常。
- 登录失效时只读操作可重新登录；真实提交不会盲目重试，避免重复发货。

## 局域网部署

系统可以部署到公司有线局域网。部署时将 `APP_HOST` 设置为 `0.0.0.0`，配置强访问令牌，并只在防火墙开放主系统端口。不要直接对局域网或公网暴露数据库、Chrome 调试端口和发货服务端口。详细说明见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 主要目录

```text
public/                 前端页面与样式
fulfillment-service/   马帮自动发货服务
lib/                    主系统业务模块
scripts/                启动、检查和维护脚本
storage/                本地数据库、日志和运行数据
docs/                   设计、技术与每日进度文档
tests/                  自动化测试
```
