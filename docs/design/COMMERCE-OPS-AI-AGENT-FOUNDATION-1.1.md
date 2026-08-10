# Commerce Ops AI Agent Foundation 1.1

Status: implemented additive foundation

Scope: shared Agent infrastructure only. This version does not introduce a new
business Agent and does not change the Daily Report Agent business behavior.

## 1. Foundation Boundary

The existing Foundation V1 remains authoritative for:

- immutable versioned Agent definitions;
- Shop, Product, and SKU contexts from structured database facts;
- the shared AI Gateway and Prompt Registry;
- Foundation task lifecycle, leases, idempotency, and audit events.

Foundation 1.1 adds only two missing cross-Agent capabilities:

1. source-Agent tracing on every AI Gateway call;
2. a standard envelope for operational recommendations produced by an Agent.

## 2. Agent Registry

Every registration remains an immutable contract containing:

- `name` and `version`;
- declared `input_context` references;
- allowed `tools` and per-tool permissions;
- `permission` mode, scopes, task domain, and approval requirement;
- a versioned `output_schema`.

Conflicting definitions for the same `name@version` are rejected. Write tools
require `execute` mode and human approval.

## 3. Context Layer

The first context types remain:

- `shop`;
- `product`;
- `sku`.

They are assembled by `AiContextService` from repository queries over current
structured data and published metrics. Production Context modules cannot read
Excel files or source export files.

Read-only HTTP APIs:

```text
GET /api/ai/context/shop/:id
GET /api/ai/context/product/:id
GET /api/ai/context/sku/:id
```

## 4. AI Gateway Trace

An Agent may pass this optional trace reference to `AiGateway.complete`:

```js
agent: {
  name: "sales.daily-report",
  version: "2.1.0",
  taskId: "foundation-task-id",
}
```

The normalized result and safe audit metadata include:

- Agent name, version, and Foundation task ID;
- provider and model;
- prompt ID and prompt version;
- input, output, total, and cache-hit token counts when provided;
- result status, output schema ID, validation state, and result SHA-256 digest;
- attempts, duration, request ID, and stable error code.

Prompts, business input, model output, and secrets are not copied into the AI
audit log. A business Agent stores its validated full result in its own
Foundation task `result_json`.

## 5. Agent-Produced Operation Task

Contract version:

```text
COMMERCE-OPS-AGENT-OPERATION-TASK-1.0.0
```

Required fields:

```js
{
  agent_name,
  agent_version,
  request_id,
  idempotency_key,
  requested_by,
  business_object: { type, id, name },
  reason: { code, summary },
  evidence: [{ type, label, value, source }],
  suggested_action: { code, summary, parameters },
  priority: "P0" | "P1" | "P2" | "P3",
  requires_approval,
}
```

The framework maps this contract to a `foundation_tasks` row with:

- `task_kind=agent_recommendation`;
- `domain_ref_type=agent_recommendation`;
- an Agent, request, and business-object based stable domain reference;
- `PENDING` initial state;
- a single attempt and no automatic executor;
- complete reason, evidence, suggested action, priority, and approval evidence.

Approval can only be escalated. A request cannot weaken the registered Agent
permission. All generated recommendations record
`automatic_execution=false`.

## 6. Code API

```js
framework.register(definition)
framework.get(name, version)
framework.list()
framework.createTask(agentRunRequest)
framework.createOperationTask(operationTaskRequest)
```

`createTask` keeps its original meaning: run a registered Agent. The additive
`createOperationTask` method creates an operational recommendation produced by
an Agent. No public write HTTP endpoint is exposed in this phase; server-side
services must preserve Agent permission and Foundation approval boundaries.

## 7. Database Impact

No migration is required. Migration 022 already provides bounded identity
columns and flexible `input_json`, `evidence_json`, and `result_json` fields in
`foundation_tasks`.

## 8. Agent Development Standard

1. Register an immutable versioned Agent definition before execution.
2. Declare every Context type, tool, permission scope, and output schema.
3. Build Context from repositories and structured facts, never directly from
   Excel or user export files.
4. Send every model call through `AiGateway` with an Agent trace and managed
   prompt version.
5. Let deterministic code calculate metrics; use the model only for bounded
   interpretation allowed by the Agent definition.
6. Validate model output before storing or presenting it.
7. Store the full validated result in the Agent's Foundation task result.
8. Use `createOperationTask` for operational recommendations and provide
   evidence for every task.
9. Never weaken registered approval requirements or execute a generated task
   automatically.
10. Test Registry, Context, Gateway trace, output validation, idempotency,
    approval escalation, and existing Agent compatibility.

## 9. Compatibility

The Daily Report Agent continues to use the original Agent run task lifecycle.
It now adds its registered identity and current Foundation task ID to its AI
Gateway call. Its prompts, Context, output schema, scheduling, and report
delivery behavior are unchanged.
