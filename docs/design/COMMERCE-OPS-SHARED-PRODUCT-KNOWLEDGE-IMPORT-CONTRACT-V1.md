# Commerce Ops 共享产品知识标准化导入契约 V1

更新时间：2026-08-08  
状态：已实现首批离线标准化和审核/发布控制面，生产导入与首批发布仍需业务审批

## 1. 目的

本契约定义 Excel、在线表格和后续上传文档如何进入 Commerce Ops 的共享产品资料体系。目标不是把所有文件内容塞入一张“知识库表”，而是把内容路由到正确的业务真源，同时保留可追溯证据，供客服、上架和未来 Agent 使用。

首批导入遵循以下约束：

- 不按平台复制产品资料；
- 相同产品事实只保留一份公共候选，只有存在证据的差异才建立国家覆盖；
- 原文件目录名只能作为来源线索，不能自动证明内容适用于该国家；
- 所有抽取内容先进入候选状态，不直接成为 AI 可执行规则；
- 每条候选必须保留源文件哈希、工作表、行号或单元格范围；
- 产品身份和一级类目由 Product Core 只读解析，不能由文件名或模型常识直接决定。

## 2. 资产路由

| 内容 | 归属域 | 标准资产类型 | 可供客服 | 可供上架 |
| --- | --- | --- | --- | --- |
| SKU、名称、款式、颜色、尺寸、重量、材质 | Product Core | `PRODUCT_MASTERDATA_CANDIDATE` | 通过 Product Core Snapshot | 通过 Product Core Snapshot |
| 安装、使用、保养、兼容、FAQ、安全、排障、包装内容 | Product Knowledge | `PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE` | 审批后的 SUPPORT View | 审批后的 LISTING View |
| 类目售后条件、赔偿方案、退款边界 | Customer Service Policy | `SUPPORT_POLICY_CANDIDATE` | 审批后可用 | 禁止 |
| 回复示例、沟通范式、语气要求 | Customer Service Playbook | `SUPPORT_PLAYBOOK_CANDIDATE` | 审批后只辅助表达 | 禁止 |
| 店铺营业时间、权限、额度、店铺特例 | Shop Configuration | `SHOP_CONFIGURATION_REFERENCE` | 通过店铺配置快照 | 按需读取 |
| 质检标准、绩效指标 | Customer Service Operations | `SUPPORT_OPERATIONS_REFERENCE` | 内部使用 | 禁止 |
| 平台红线、禁语、诱导好评限制 | Compliance Policy | `COMPLIANCE_POLICY_CANDIDATE` | 强制约束 | 按消费者视图约束 |
| 钉钉快捷方式但正文尚未读取 | Source Registry | `EXTERNAL_KNOWLEDGE_REFERENCE` | 不可用于生成 | 不可用于生成 |

## 3. 产品身份与类目解析

解析顺序固定如下：

1. `country + stock_sku` 精确匹配 Product Core 的正式 country SKU；
2. `main_sku` 精确匹配产品型号；
3. 无国家的 `stock_sku` 只能在所有匹配行映射到同一 `main_sku` 时解析到型号，不能据此创建 country SKU 绑定；
4. `style_code`、产品名和模糊文本只能生成待审候选；
5. 未匹配或多义结果进入 `MAPPING_REQUIRED`，不得发布。

标准类目取 Product Core 当前一级类目。文件夹中的“厨卫晾、大家具、大件实木、家纺、竹制品”等名称保留为 `source_category`，用于审计与人工核对，不覆盖 Product Core 类目。

## 4. 公共层与国家覆盖层

正式发布后的知识作用域只有两层；导入候选另允许使用 `UNVERIFIED` 暂存无法证明范围的内容：

- `COMMON`：产品本身不随国家变化的知识；
- `COUNTRY_OVERRIDE`：有明确国家证据的差异，例如电压、插头、语言附件、当地保修政策或法规限制。

目录位于某个国家文件夹但正文无国家字段时，标准化结果为：

```json
{
  "scope_type": "UNVERIFIED",
  "country_codes": [],
  "scope_evidence": "DIRECTORY_ONLY"
}
```

同一文件逐字节复制到多个国家目录时，只抽取一次公共候选，不生成多个国家副本。若内容中出现币种、国家名、当地法规或语言限定，则建立冲突或待审国家覆盖，不能自动继承目录范围。

## 5. 候选记录最小契约

```json
{
  "asset_id": "稳定内容哈希",
  "asset_type": "PRODUCT_KNOWLEDGE_CLAIM_CANDIDATE",
  "subject": {
    "source_sku": "...",
    "main_sku": "...",
    "product_sku_ids": [],
    "model_ids": [],
    "canonical_category": "...",
    "source_category": "...",
    "mapping_status": "EXACT_STOCK_SKU_TO_MODEL"
  },
  "content": {
    "claim_type": "INSTALLATION",
    "title": "...",
    "text": "...",
    "structured": {}
  },
  "scope": {
    "scope_type": "COMMON",
    "country_codes": [],
    "language": "zh-CN",
    "consumer_scopes": ["CUSTOMER_SERVICE", "LISTING"],
    "visibility": "CUSTOMER_VISIBLE"
  },
  "governance": {
    "status": "REVIEW_REQUIRED",
    "risk_level": "NORMAL",
    "risk_flags": [],
    "required_behavior": "OPTIONAL",
    "conflict_status": "UNCHECKED"
  },
  "evidence": {
    "source_id": "...",
    "source_sha256": "...",
    "sheet": "...",
    "cell_range": "...",
    "source_text": "..."
  }
}
```

## 6. 风险与发布门槛

满足任一条件时必须进入人工审核，且默认不能供模型生成：

- 金额、币种、赔偿比例、退款或补发承诺；
- “好评、五星、不要差评、撤销投诉”等评价诱导；
- 店长、仓库、外部链接或人工权限依赖；
- 同一内容出现在多个国家目录但包含单一国家币种；
- 与 Product Core 当前规格冲突；
- 没有产品身份、类目或国家范围证据；
- 安全、健康、承重、电气或儿童使用相关陈述；
- 平台禁止表达或可能对客户披露内部信息的内容。

只有 `APPROVED` 且进入不可变 Knowledge Release 的记录，才能进入 Product Knowledge Resolver。首批离线产物全部保持 `DRAFT`、`MAPPING_REQUIRED` 或 `REVIEW_REQUIRED`，不会写入生产库。

当前控制面按记录审核产品事实、配件关系、客服政策和客服话术，并使用四类 Release 成员表固定发布范围。审核人和发布人必须分离；金额、赔偿、评价诱导、安全等高风险内容还需要合规角色和显式风险确认。治理开关、审核人白名单、发布人白名单默认均为空或关闭，所以仅部署代码不会让候选自动进入模型证据。

## 7. 首批交付格式

首批标准化包同时提供：

- 结构化 JSONL：用于后续导入与逐条审批；
- 分类目 Markdown：用于业务阅读，先展示公共层，再展示有证据的国家差异；
- 汇总 Excel：用于筛选、校对、分派负责人和标记审批状态；
- 来源清单与待读取外部引用：用于后续增量接入钉钉正文；
- 质量报告：列出重复、未匹配、冲突、空字段和高风险政策。

所有生成物都由同一批标准化记录生成，不能分别人工维护，避免文档、Excel 和系统数据漂移。
