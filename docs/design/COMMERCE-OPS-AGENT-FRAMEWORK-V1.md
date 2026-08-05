# Commerce Ops Agent Framework V1

Status: shared framework baseline
Scope: Agent contracts, registration, and task integration only. No production
business Agent is registered or executed in this phase.

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
