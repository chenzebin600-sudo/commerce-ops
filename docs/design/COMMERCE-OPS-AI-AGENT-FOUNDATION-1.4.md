# Commerce Ops AI Agent Foundation 1.4

## Status

- Version: `AI-AGENT-FOUNDATION-1.4.0`
- Scope: Agent Observability only
- Business Agents added: none
- Daily Report business behavior changed: no
- Database migration required: no

## Architecture

Foundation 1.4 adds an observability plane around the mandatory Foundation 1.3
Runtime. Business Agents remain unaware of storage, auditing, and monitoring.

```text
Business Agent
    |
    v
AgentRuntime run wrapper
    |-- agent.run.started
    |-- Agent Tool Runtime
    |      |-- agent.tool.invoke
    |      `-- safe Context/token/result summaries
    `-- agent.run.completed | agent.run.failed
             |
             v
       operation_audit_events
             |
             v
  AgentObservabilityRepository/Service
             |
             v
      read-only monitoring API
```

The Runtime creates a unique `run_id` for every invocation and keeps the caller's
`request_id` as its correlation key. Tool invocations inherit the active Run ID.
This happens outside the Agent implementation, so the Daily Report Prompt,
output, schedule, and delivery path do not change.

## Storage Model

Foundation 1.4 reuses migration 002 `operation_audit_events` as the canonical
append-only telemetry store. A second Agent telemetry database is deliberately
not introduced.

### Agent Run lifecycle

| Action | Meaning | Status |
| --- | --- | --- |
| `agent.run.started` | Runtime accepted the invocation | running projection |
| `agent.run.completed` | Agent returned normally | succeeded |
| `agent.run.failed` | Agent threw an error | failed |

The read repository projects these lifecycle events into one Run record:

- Agent name and version
- Run ID and request ID
- Declared and resolved Context versions
- Start, finish, and duration
- Tool call count, failed count, and per-Tool counts
- Input, output, total, cache-hit, and cache-miss token counts
- Result status, SHA-256 digest, byte count, and top-level keys
- Sanitized error code

No Prompt, Context payload, Tool input/output, AI response, customer data, or
Daily Report body is persisted by observability.

### Tool Invocation

`agent.tool.invoke` remains the canonical Tool event and now includes:

- Parent Run ID
- Agent and Tool exact versions
- Access and permission contract
- Input/output digest, byte count, and top-level keys
- Duration and success/failure
- Resolved Context version where relevant
- Normalized AI Gateway token usage where relevant

### Agent Evaluation

Contract: `COMMERCE-OPS-AGENT-EVALUATION-1.0.0`.

An evaluation is append-only and references one Run. It contains:

- Metric identifier
- Evaluator type: deterministic, human, or model
- Evaluator name and version
- Score from 0 to 100, or `not_evaluated`
- Verdict: pass, warning, fail, or not evaluated
- Evidence digest and reason code
- Evaluation time

Evaluation records use `agent.evaluation.recorded`. The current release defines
and tests the model and service boundary; it does not add an automatic evaluator
or a new business Agent.

## API

All endpoints are authenticated by the existing main API policy and are
read-only.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/ai/observability/status` | Storage readiness and Evaluation contract |
| `GET` | `/api/ai/observability/summary` | Run count, success rate, duration, Tools, tokens |
| `GET` | `/api/ai/observability/runs` | Paginated Run query |
| `GET` | `/api/ai/observability/runs/:runId` | Run, Tool invocations, and evaluations |

Run-list filters:

- `agent`
- `version`
- `requestId`
- `status=running|succeeded|failed`
- `start`, `end`
- `page`, `pageSize`

There is no public write endpoint for evaluations in Foundation 1.4.

## Operational Rules

1. Observability recording is fail-open and cannot interrupt Agent execution.
2. Agent construction remains impossible outside `AgentRuntime`.
3. Tool payloads and business results are represented only by safe summaries.
4. Operation Audit retention remains the single retention policy.
5. A dedicated observability table may be considered only after measured query
   volume proves the shared event store insufficient.

## File Ownership

- Runtime integration: `lib/ai/agent/agent-runtime.mjs`
- Tool telemetry: `lib/ai/tools/agent-tool-runtime.mjs`
- Audit projection: `lib/ai/tools/agent-tool-audit-tracer.mjs`
- Evaluation contract: `lib/ai/observability/agent-evaluation-contracts.mjs`
- Query repository: `lib/ai/observability/agent-observability-repository.mjs`
- Service: `lib/ai/observability/agent-observability-service.mjs`
- API: `lib/ai/observability/agent-observability-api.mjs`
- Tests: `tests/agent-observability.test.mjs`
