# Growth Radar G1B 开发环境 Fail-Closed 隔离

## 风险背景

Commerce Ops 通用运行配置原本允许在没有显式路径时回退到项目内的 `storage/commerce-ops.sqlite`，主端口也会回退到 3101。该行为适合普通单实例运行，但不适合 Growth Radar A2 永久工作树：漏配环境变量可能创建第二个同名数据库、连接错误的 storage，或占用正式端口。

本门禁只在 `COMMERCE_OPS_RUNTIME_PROFILE=growth-radar-g1b` 或显式 `test` profile 下生效。普通主线 profile 保持原有兼容行为。

## 推荐启动命令

```powershell
npm run dev:growth-radar:g1b
```

该命令只加载被 Git 忽略的 `.env.growth-radar-g1b.local`，在打开 SQLite 或执行迁移前运行隔离校验，并且只启动主 HTTP 服务。它不会启动 scheduler，也要求广告服务为 `external`，因此不会自动占用广告端口。

运行时只输出：

- 当前 runtime profile
- 相对于工作树的 SQLite 路径
- 相对于工作树的 storage 路径
- HTTP 端口

不会输出 token、Cookie、密码或环境变量全集。

## 本地配置

复制示例文件：

```powershell
Copy-Item .env.growth-radar-g1b.example .env.growth-radar-g1b.local
```

创建隔离目录（首次使用时）：

```powershell
New-Item -ItemType Directory -Force storage/development
```

必需配置：

```dotenv
COMMERCE_OPS_RUNTIME_PROFILE=growth-radar-g1b
DATA_ROOT=storage/development
STORAGE_ROOT=storage/development
UPLOAD_ROOT=storage/development/uploads
EXPORT_ROOT=storage/development/exports/mabang
TEMP_ROOT=storage/development/temp
DATABASE_PATH=storage/development/growth-radar-g1b.sqlite
APP_HOST=127.0.0.1
APP_PORT=3193
AD_SERVICE_MODE=external
```

`.env.growth-radar-g1b.local` 和 `.env.local` 均被 Git 忽略。A2 工作树的 `.env.local` 只保存 profile 标记，不保存路径或秘密；其作用是让误执行通用 `npm start`、`npm run migrate` 或 `npm run doctor` 时进入 A2 门禁并因缺少完整专用配置而拒绝继续。专用命令会加载完整 profile 文件。

不得把访问 token、广告内部 token、Cookie、API key、密码或本机绝对路径写入示例文件。

## Fail-Closed 规则

`growth-radar-g1b` profile 在数据库打开和迁移前执行全部检查。任一检查失败都会抛出 `RUNTIME_ISOLATION_REJECTED` 并终止：

1. `DATABASE_PATH` 必须显式且非空。
2. `STORAGE_ROOT` 必须显式且非空。
3. `APP_PORT` 必须显式且非空。
4. 数据库不能是默认 `storage/commerce-ops.sqlite`。
5. 数据库文件名必须为 `growth-radar-g1b.sqlite`。
6. `APP_ROOT` 必须真实解析为启动脚本所在的当前工作树；继承的外部 `APP_ROOT` 不能重定义隔离边界。
7. storage 必须真实解析为当前工作树内的 `storage/development`。
8. 数据库必须真实位于当前工作树内，并位于该 storage 根下。
9. 数据库父目录和 storage 必须已存在且可以真实解析。
10. `APP_PORT` 必须为 3193；3101 明确禁止。
11. `AD_SERVICE_MODE` 必须为 `external`。
12. 相对路径会先转绝对路径；Windows 比较不区分大小写。
13. 已存在文件和目录使用真实路径检查，符号链接或 junction 不能把目标带到工作树外。

路径边界通过 `path.relative`、规范化路径和 `realpath` 判断，不使用完整路径字符串包含关系作为安全边界。

## 拒绝启动场景

以下配置必须在 SQLite 打开前失败：

- 删除或留空 `DATABASE_PATH`。
- 使用 `storage/commerce-ops.sqlite`。
- 指向主线正式 SQLite。
- 指向其他工作树、支线目录或任意工作树外路径。
- 删除或留空 `STORAGE_ROOT`。
- 把 storage 设到工作树外。
- 使用 `APP_PORT=3101` 或除 3193 外的端口。
- 使用错误数据库文件名。
- 数据库父目录不存在。
- 通过 `..`、路径大小写、符号链接或 junction 逃逸。
- 将广告模式设为 `managed`。

失败校验不创建数据库、不创建迁移、不清理 WAL/SHM，也不尝试连接正式库。

## 测试数据库规则

需要启动完整服务的测试必须设置：

```dotenv
COMMERCE_OPS_RUNTIME_PROFILE=test
```

`test` profile 仍执行隔离检查：

- `DATABASE_PATH`、`STORAGE_ROOT`、`APP_PORT` 必须显式。
- 数据库和 storage 必须位于系统临时目录。
- 数据库必须位于测试自己的 storage 根下。
- 测试端口不能为 3101。
- 每个并行测试使用不同的临时根和数据库。
- 测试完成后删除自己的临时目录。

直接测试 repository/service 的单元测试继续显式传入内存库或 `mkdtemp` 数据库，不读取正式环境配置。不得通过禁用门禁让测试通过。

## Doctor

推荐检查命令：

```powershell
npm run doctor:growth-radar:g1b
```

Doctor 使用同一份专用本地配置和同一套 `inspectRuntimeIsolation` 检查，输出：

- runtime profile
- 数据库路径是否显式
- storage 是否显式和可真实解析
- 数据库父目录是否可确认
- 是否命中默认数据库风险
- 数据库和 storage 是否位于当前工作树
- 数据库是否位于隔离 storage
- 端口是否为 3193、是否避开 3101
- 广告模式是否为 external
- SQLite 是否存在及只读完整性检查
- 主端口与广告端口是否已占用

对 G1B profile，隔离检查失败是 `ERROR`，Doctor 返回非零；不会只给 WARNING 后继续启动。普通主线 profile 显示门禁未激活，不会误判为 A2 错误。

## 正式数据库保护验证

E0 验证必须在正式服务、scheduler 和自动任务停止后进行：

1. 记录正式 SQLite 主文件和 WAL 的大小、修改时间及 SHA-256。
2. 记录最高迁移、全部 Growth Radar 表计数和产品关键计数。
3. 运行缺失配置、默认路径、正式路径、工作树外路径和 3101 端口的拒绝测试。
4. 使用推荐命令启动合法 A2 配置，检查 `/api/health`。
5. 确认只监听 3193，不启动 3101 或广告服务。
6. 停止 A2 服务。
7. 再次比较正式主文件、WAL、迁移和业务计数。

不得删除或 checkpoint 正式 WAL/SHM，不得对正式 SQLite 进行测试写入。

## 开发人员注意事项

- 只使用 `npm run dev:growth-radar:g1b` 启动 A2。
- 修改本地配置后先运行 `npm run doctor:growth-radar:g1b`。
- 不要把 `.env.growth-radar-g1b.local`、`.env.local`、SQLite、WAL/SHM、日志或 token 加入 Git。
- 不要在 A2 profile 下使用 3101。
- 不要把隔离数据库复制到主线 storage。
- 不要用测试 profile 指向 A2 开发数据库或正式数据库。
- E0 只建立运行隔离；不恢复 stash、不实现 G1B 功能、不创建 015/016 迁移。
