# Growth Radar G1B2 前端闭环与隔离验收

## 1. 结论

G1B2 前端代码闭环与真实运行态视觉验收已经完成。页面通过 A2 隔离环境中的合成脱敏 fixture 验证，桌面端和 430px 移动端共生成 20 张真实运行态截图；没有执行真实马帮订单或库存样本，也没有把 fixture 统计解释为生产结果。

代码质量门和视觉验收门均通过。正式数据库的业务计数、完整性和最高迁移符合保护目标，但正式主文件与 WAL 相对本节点恢复基线发生了外部漂移；A2 服务始终使用隔离数据库，本节点对正式库只执行了只读查询。因此在主线侧独立解释并确认该文件漂移前，本报告不判定满足合并主线条件。

## 2. 页面信息架构

Growth Radar 使用一个主入口和八个按需加载的工作区：

| 工作区 | 主要职责 |
|---|---|
| 数据概览 | 批次、待确认店铺、预览、质量问题、新鲜度和能力边界 |
| 店铺与范围 | pending/confirmed 筛选、店铺详情、编辑、确认与撤销 |
| 来源批次 | 来源系统、窗口、快照、范围、状态、确认与结果入口 |
| 订单预览 | Excel 只读预览、PII/公式安全摘要、范围确认和二次应用确认 |
| 库存预览 | `source_sku + source_warehouse` 粒度预览、范围确认和应用 |
| 数据质量 | 稳定 issue code、严重程度、阻断状态、推荐动作和脱敏行号 |
| 数据语义 | 六类指标的值、来源、时间、确认状态与可用状态 |
| 应用记录 | 已应用批次、审计入口和幂等复用结果 |

页面没有加入 G2 机会评分、推荐榜单、店铺缺口推荐或 AI 推荐。

## 3. 接入 API

前端实际接入以下 Growth Radar API：

- 能力与概览：`GET /api/growth-radar/capabilities`、`GET /api/growth-radar/summary`、`GET /api/growth-radar/freshness`。
- 来源与结果：`GET /api/growth-radar/source-batches`、批次详情与批次结果接口。
- 店铺范围：店铺列表、店铺详情、编辑、确认、撤销和确认历史接口。
- 订单与库存：`POST /api/growth-radar/import/orders/preview`、`POST /api/growth-radar/import/orders/apply`、对应 inventory 预览与应用接口。
- 质量与语义：`GET /api/growth-radar/data-quality/issues`、`GET /api/growth-radar/semantics/status`。

截图自动化直接观察到 23 个来自 `http://127.0.0.1:3193` 的成功 Growth Radar API 响应，并额外在页面上下文中验证 summary API 返回 200。没有使用静态 HTML 或离线伪数据页面。

## 4. 关键交互

### 4.1 店铺确认

- 新发现的 16 个样本店铺默认保持 `pending`，不会被批量自动确认，也不会进入正式机会范围。
- 详情弹窗分别展示历史观察、当前在线可用性、范围状态、最近批次和确认历史。
- 确认人由服务器身份产生，客户端不能提交或伪造 `confirmedBy`。
- 取消确认必须填写原因；确认与取消均由后端权限和审计约束。

### 4.2 订单预览

- 选择文件后先生成只读预览；预览不创建批次、不写原始行、不生成标准事实。
- 页面只显示 PII 类别、影响字段数和脱敏行号，不回显客户原值。
- 公式风险只显示安全分类，不回显可执行公式。
- 用户核对数据窗口、店铺/国家/仓库范围和语义边界后，仍需在第二个确认弹窗中明确应用。

### 4.3 库存预览

- 匹配键固定为 `source_sku + source_warehouse`，同一 SKU 的多个仓库不会合并。
- 来源预测明确标注为预测而非实际销量；来源页面可见销量不等于公司总销量。
- 预览、范围确认、二次确认和幂等应用与订单流程保持一致。

### 4.4 数据质量与语义

- 数据质量页支持 issue code、批次、店铺/SKU、安全严重程度和阻断状态筛选。
- 质量样本仅展示来源行号和安全上下文；不展示客户原始信息。
- 数据语义页展示 `historical_observed`、`current_online`、`own_sales`、`company_sales`、`source_visible_sales` 和 `source_predicted_daily_sales`。
- `current_online` 当前仍为不可用，因为没有权威当前在线来源。
- `company_sales` 当前仍为不可用，因为没有经过确认的公司销量权威来源。

## 5. 权限与审计

页面明确显示查看、预览、应用、店铺管理和范围确认五类当前权限；按钮禁用理由可读。服务器仍是权限最终裁决方，不能通过隐藏按钮或构造请求绕过。

应用记录和详情显示服务端记录的操作用户、时间、批次、来源文件基础名称和实际结果；不显示 Token、Cookie、完整本机路径或客户 PII。重复应用相同来源哈希时复用既有批次，不重复写入事实。

## 6. 合成脱敏 fixture 验收

本次仅使用位于 A2 隔离开发存储、且被 Git 忽略的合成脱敏订单与库存 fixture。页面在 3193 环境明确显示“测试/验收数据”和“真实马帮订单/库存样本尚未执行”，不得将下列数字作为生产结果。

| 指标 | 隔离验收结果 |
|---|---:|
| 来源批次 | 2 |
| 订单原始行 | 19 |
| 标准订单头 | 17 |
| 标准订单行 | 17 |
| 店铺 / 店铺来源映射 | 16 / 16，全部 pending |
| 库存原始行 | 6 |
| 库存快照 | 3 |
| SKU + 仓库销售指标 | 3 |
| 订单库存链接 | 17 |
| 数据质量问题 | 20 |
| 映射问题 | 18 |
| 产品身份映射 | 0 |

多次自动验收重复使用相同来源哈希，数据库始终只有 2 个来源批次，证明幂等复用生效。A2 数据库 `integrity_check=ok`，`foreign_key_check` 违规数为 0。

真实马帮订单/库存样本尚未执行。这不阻塞 G1B2 代码质量验收，但必须作为正式数据启用前的后续验收项；本次没有从正式数据库复制任何业务数据到 A2。

## 7. 运行态浏览器验收

最终采用系统 Chrome 无头模式和原生 Chrome DevTools Protocol。验收脚本为 `scripts/capture-growth-radar-g1b.mjs`，不依赖新安装的第三方包。

每次截图前均验证：

- 页面 origin 为 `http://127.0.0.1:3193`，URL 为 `http://127.0.0.1:3193/#growth-radar`。
- 页面存在 Growth Radar 专属根节点、真实工作区标题和 A2 fixture 警示。
- 页面不是 `about:blank`、登录页、错误页、404 页或静态测试 HTML。
- Growth Radar API 响应来自同一个 3193 origin。
- 页面级无横向溢出；宽表只在 `.gr-table-wrap` 内滚动。
- 弹窗完整落在当前视口中，状态标签可读。

自动化首先检测到移动端单列 grid 子项保留 840px 最小内容宽度，导致表格容器越界。通过为 `.gr-split > section` 增加 `min-width: 0` 修复，并将约束加入现有 430px 测试。修复后 20 张截图全部通过运行时边界检查。

### 7.1 桌面端与移动端结果

| 项目 | 结果 |
|---|---|
| 桌面端 | 10/10，均为 1440×900 PNG |
| 430px 移动端 | 10/10，均为 430×932 PNG |
| 真实运行态 | 是，来自运行中的 3193 页面 |
| 数据 | 合成脱敏 fixture，页面有明确验收标识 |
| PII / Token / Cookie / 本机路径 | 截图中未发现 |
| 整页横向溢出 | 未发现 |
| 表格横向滚动 | 仅位于表格自身容器 |
| 弹窗 | 桌面和移动视口内完整显示 |

截图目录：`docs/screenshots/growth-radar-g1b/`

| 编号 | 桌面端 | 移动端 |
|---:|---|---|
| 01 | `desktop-01-overview.png` | `mobile-01-overview.png` |
| 02 | `desktop-02-shops-list.png` | `mobile-02-shops-list.png` |
| 03 | `desktop-03-shop-detail.png` | `mobile-03-shop-detail.png` |
| 04 | `desktop-04-source-batches.png` | `mobile-04-source-batches.png` |
| 05 | `desktop-05-order-preview.png` | `mobile-05-order-preview.png` |
| 06 | `desktop-06-inventory-preview.png` | `mobile-06-inventory-preview.png` |
| 07 | `desktop-07-data-quality.png` | `mobile-07-data-quality.png` |
| 08 | `desktop-08-data-semantics.png` | `mobile-08-data-semantics.png` |
| 09 | `desktop-09-apply-confirmation.png` | `mobile-09-apply-confirmation.png` |
| 10 | `desktop-10-application-result.png` | `mobile-10-application-result.png` |

### 7.2 浏览器失败与恢复记录

- 先前内置浏览器插件初始化失败：`Cannot redefine property: process`。
- 先前 Computer Use 因不能可靠确认 URL 而停止；本节点没有再次使用这两种方式。
- 项目依赖中没有 Playwright、Puppeteer 或 CDP 客户端；本机捆绑 Playwright 清单缺少其运行所需的 `playwright-core`，没有联网补装。
- 最终改用系统 Chrome 原生 CDP 和 Node WebSocket，完成了 URL、DOM、API、布局和 20 张截图验收。因此不存在待人工补拍项。

## 8. 最终质量门

| 质量门 | 结果 |
|---|---|
| A2 隔离专项 | 17/17 |
| G1B1 后端专项 | 46/46 |
| G1B2 前端专项 | 36/36 |
| Growth Radar 全部专项 | 156/156 |
| 权限筛选专项 | 3/3 |
| 最终全量测试 | 605/605，高于此前 569 |
| Build | 通过 |
| 页面唯一 ID | 422 个，全部唯一 |
| 静态事件绑定 | 185 个，通过 |
| 430px 布局 | CSS 专项与真实 Chrome 运行态均通过 |
| A2 Doctor | 通过；广告服务、3101、4173 为既有外部端口警告 |
| 路径检查 | 通过 |
| 敏感信息扫描 | 0 命中 |
| Git 数据库文件扫描 | 跟踪 0、未忽略未跟踪 0 |
| HTTP 健康检查 | `/api/health` 与 Growth Radar summary 均为 200 |
| A2 SQLite | `integrity_check=ok`，外键违规 0 |

全量测试使用本机既有广告服务目录环境配置来满足无关的广告集成测试依赖，没有修改或弱化旧测试。

## 9. 正式数据库最终保护结果

本节点恢复时记录了正式文件基线；最终仅通过只读连接执行完整性、外键、迁移和计数查询。该只读查询自身前后没有改变主文件或 WAL 元数据，也没有执行 checkpoint、截断或 fixture 导入。

| 文件 | 恢复基线 | 最终稳定快照 | 一致 |
|---|---|---|---|
| 主文件 | 260,849,664 字节；SHA-256 `4DDDE54B38D6F9108E477EE0538A61FC27E44196E4D434D0303218A9DA989222` | 260,849,664 字节；SHA-256 `B606814FFF95362D8ACAACF7779B54048402B452FEFF54E066F3B960C693C09E` | 否 |
| WAL | 3,786,312 字节；SHA-256 `7A3FD7DB1E604224F5236F823B5D12FE8DAC179DE924EDA89941E4371963E1F0` | 4,120,032 字节；SHA-256 `50B9D28096D0E4053AE1CD4AE9AB56A2621EDEA88957DABFE63EEEFFFE927AAC` | 否 |

恢复前已存在的 3101 与 4173 进程在最终检查时仍为相同 PID 和启动时间；3193 为独立 A2 进程。正式文件漂移发生在这些既有正式服务持续运行期间，不能归因给本节点的只读检查；但由于严格的“正式文件前后一致”条件未满足，仍须由主线侧独立审计。

最终只读业务检查：

| 项目 | 结果 |
|---|---:|
| `integrity_check` | ok |
| 外键违规 | 0 |
| 最高迁移 | `014_deterministic_growth_radar_scope_and_linkage.sql` |
| 015 或 016 | 不存在 |
| 15 张 `growth_*` 表 | 全部 0 |
| `product_identity_mappings` | 0 |
| `product_package_rows` | 21,714 |
| 产品 `product_skus` | 18,347 |
| `product_images` | 1 |
| Listing 草稿 | 0 |
| Listing 发布记录 | 0 |

没有向正式库写入 fixture 或测试数据。

## 10. 完成条件

| 条件 | 判定 | 说明 |
|---|---|---|
| G1B 代码完成 | 是 | 前后端闭环、专项、全量、Build、Doctor 和隔离验收通过 |
| 视觉验收 | 是 | 20 张 3193 真实运行态截图完成，桌面与 430px 均通过 |
| 合并主线 | 否 | 正式主文件和 WAL 相对恢复基线不一致，需主线侧先完成外部漂移审计 |

真实样本未执行是正式数据启用前验收项，不作为本次代码质量失败；本节点没有开始 A3、没有创建迁移、没有应用 stash。
