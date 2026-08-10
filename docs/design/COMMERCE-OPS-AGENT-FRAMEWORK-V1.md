# Commerce Ops Agent Framework V1

Status: shared framework baseline
Scope: Agent contracts, registration, and task integration only. No production
business Agent is registered or executed in this phase.

Successor implementation: `COMMERCE-OPS-DAILY-REPORT-AGENT-V2.md` introduces
the first approved production runtime while preserving this V1 contract.
`COMMERCE-OPS-AI-AGENT-FOUNDATION-1.1.md` adds source-Agent Gateway tracing
and the standard Agent-produced operational recommendation envelope.
`COMMERCE-OPS-AI-AGENT-FOUNDATION-1.3.md` supersedes direct production
Framework construction with the mandatory `AgentRuntime` boundary.

## 1. Agent Definition

Every Agent definition is immutable, versioned, and contains these required
fields:

- `name`: stable machine identifier.
- `description`: bounded human-readable purpose.
- `input_context`: allowed `shop`, `product`, and `sku` context references,
  including required and cardinality rules.
- `tools`: declarative tool names, read/write access, and required permission
  scopes.
- `output_schema`: a versioned JSON object schema reference and schema body.
- `permission`: authority mode, existing Foundation task domain, scopes, and
  human-approval requirement.

Definitions with write tools are rejected unless they use `execute` authority
and require human approval. The registry rejects conflicting definitions under
the same `name@version` key.

## 2. Task Integration Standard

Agent requests reuse Foundation V1. They do not create an Agent-specific queue,
event table, lease table, or retry lifecycle.

| Foundation field | Agent mapping |
| --- | --- |
| `domain` | Existing domain declared by `permission.task_domain` |
| `task_kind` | `agent_run` |
| `domain_ref_type` | `agent_request` |
| `domain_ref_id` | `<agent-name>:<version>:<request-id>` |
| `execution_mode` | `human` when approval is required; otherwise `system` |
| `state` | `PENDING` |
| `idempotency_key` | Namespaced Agent definition and caller key |

The task input stores only the Agent identity and structured context subject
references. Evidence stores a context-reference digest, tool names, output
schema reference, permission mode, and correlation ID. Raw context payloads,
prompts, model responses, customer PII, and credentials are prohibited from
the task envelope.

The existing Foundation service remains authoritative for transitions, retry,
events, leases, optimistic concurrency, and idempotency.

## 3. Runtime Boundary

This phase deliberately provides no Agent execution worker and no public Agent
API. Created requests remain pending with
`evidence.execution_runtime=not_implemented`. A later approved runtime must:

1. resolve structured contexts through the AI Context Layer;
2. invoke models only through the unified AI Gateway;
3. validate responses against the registered output schema;
4. enforce tool permissions and human approval;
5. transition the existing Foundation task and append its audit evidence.

Daily Report Agent V2 is that first approved runtime. It uses
`execution_runtime=daily_report_agent_v2`, stays read/recommend-only, and does
not create a second queue or lifecycle.

## 4. Database and API Impact

- Database migrations: none.
- New tables: none.
- Existing tables reused: `foundation_tasks`, `foundation_task_events`, and
  `foundation_task_leases`.
- Public endpoints: none.
- Production Agent registrations: none.

## 5. Implementation Files

- `lib/ai/agent/agent-contracts.mjs`
- `lib/ai/agent/agent-registry.mjs`
- `lib/ai/agent/agent-task-bridge.mjs`
- `lib/ai/agent/agent-framework.mjs`
- `tests/agent-framework.test.mjs`
