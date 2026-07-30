# COM-GROWTH-RADAR-V2.2-INT-1-C 报告

## 1. 节点结论

Growth Radar V2 运行时已从 `GRV2-METRICS-1.1.0` 全面对齐至正式合同
`GRV2-METRICS-1.2.0`。本节点未执行正式迁移、未修改正式数据库、未合并前端，
也未修改 A2 或 COM-015 业务逻辑。

运行时门禁已满足，可以进入下一项人工批准节点；本报告不代表已批准正式应用
019/020/021，也不代表已启动正式分析。

## 2. 修改文件

运行时：

- `lib/growth-radar/v2/growth-radar-v2-service.mjs`
- `lib/growth-radar/v2/growth-radar-v2-engine.mjs`
- `lib/growth-radar/v2/growth-radar-v2-repository.mjs`
- `lib/growth-radar/v2/growth-radar-v2-api.mjs`
- `lib/growth-radar/v2/growth-radar-v2-assistant.mjs`

测试与迁移就绪合同：

- `tests/growth-radar-v2.test.mjs`
- `tests/postgresql-readiness.test.mjs`
- `docs/postgresql-readiness.md`

为通过现有可移植路径门禁，仅移除以下 Growth Radar 文档中的本机绝对样例路径，
未改变设计结论：

- `docs/design/COM-GROWTH-RADAR-V2.2-MABANG-SOURCE-DATA-CONTRACT.md`
- `docs/reports/COM-GROWTH-RADAR-V2.2-INT-0-DATA-READINESS.md`
- `docs/reports/COM-GROWTH-RADAR-V2.2-INT-0.1-GATE-REPORT.md`

## 3. 规则变化

### 指标合同

- 运行时默认与校验版本统一为 `GRV2-METRICS-1.2.0`。
- 非 1.2.0 活跃规则集 fail-closed，不再隐式使用 1.1.0。
- 规则保存继承完整的 1.2.0 配置结构，不在运行时重新写死正式阈值。

### 有效订单

实际销量、历史准备度和分析水位统一使用以下四种有效状态：

- `已发货`
- `待处理`
- `配货中`
- `已完成`

测试已验证四种状态均进入销量计算，其他状态不进入。

### 货盘承接与类目排名

- 低承接阈值由正式配置读取，当前正式值为 `10%`。
- 货盘验证排名只在“国家 × 类目”范围计算。
- 二级类目样本不足时回退一级类目；一级类目仍不足最小样本时返回数据不足，
  不回退全国家 SKU，也不伪造排名。
- 规则名和证据语义使用 `ASSORTMENT_VERIFIED_*`，不再使用
  `MARKET_VERIFIED_*`。

### 库存风险

- 风险粒度固定为“国家 + 仓库 + SKU”。
- 直接使用马帮 `当前可售天数`，不在国家层重新计算可售天数。
- 国家 SKU 层仅汇总各仓风险数量与状态分布。
- 缺货、临界、预警、在途和滞销信号均保留来源仓库与标准化仓库。

### 信号和运营任务

- 仓库风险信号使用 `warehouse_sku` 主体。
- 信号、任务、证据和任务去重键均包含仓库维度。
- SKU 详情同时返回全局事实、国家指标、仓库指标、信号和店铺表现，避免把
  国家类目排名错误写回全局指标。

## 4. 测试结果

- Growth Radar V2 核心专项：`11/11` 通过。
- Growth Radar 全部相关测试：`194/194` 通过。
- PostgreSQL readiness 与合同复测：`8/8` 通过。
- 仓库全量测试：`710/710` 通过。
- Build：通过。
  - Portable path check：通过。
  - 前端静态检查：`466` 个唯一元素 ID、`217` 个静态绑定。
- Doctor：全部 OK。

## 5. 正式数据库保护

只读复核结果：

- 正式库最高迁移：`018_mabang_image_collection_performance.sql`
- `PRAGMA integrity_check`：`ok`
- `PRAGMA foreign_key_check`：`0`
- SQLite SHA-256：
  `5aa3ad56465f2602f899e3bb7c20e59dd327a3a13824811de48d464c47acec84`
- WAL SHA-256：
  `3c4cec0291896401e104a9026ea58d8b82844a3e15e4d7deddafe7e3cb0b694a`
- SHM SHA-256：
  `205f3438f59b36d21a18c58ecd4d16def4aa6c9e63d8831dd9af354455befea6`

三个哈希均与 INT-1-B 基线一致。未执行正式 migration，未写入正式分析结果或
运营任务。

验证结束后，`3101`、`3193`、`4173`、`9222` 均无监听。

## 6. 风险与边界

- 工作树仍包含多个并行节点的既有修改和未跟踪文件，本节点未暂存、提交、删除
  或回退这些内容。
- 019/020/021 仍是候选 migration；运行时已兼容，但正式数据库尚未应用。
- Growth Radar V2 前端仍未合并，本节点只完成运行时合同对齐。
- 正式启用前仍需单独批准 migration 应用、数据配置门禁和首次正式分析。

## 7. 门禁判断

INT-1-C 运行时合同门禁：**通过**。

可进入下一人工批准节点，但继续禁止自动执行正式 migration、修改正式数据库、
合并前端或启动正式分析。
