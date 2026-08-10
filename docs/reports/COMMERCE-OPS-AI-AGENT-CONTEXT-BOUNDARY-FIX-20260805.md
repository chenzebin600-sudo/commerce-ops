# Commerce Ops AI Agent Context Boundary Fix

Date: 2026-08-05
Status: PASS

## Incident

The first controlled production run of `sales.daily-report@2.1.0` failed before
Context resolution because the complete Sales and Assortment dashboard was sent
through Tool Runtime as Context input.

- Scheduler run: `47788a53-7362-4f3b-bf47-49fa5f669943`
- Agent run: `3d0f6d99-9c50-498c-a7de-1a5a9bf38222`
- Context input: 4,379,806 bytes
- Tool Runtime limit: 4,194,304 bytes
- Error: `AGENT_TOOL_INVOCATION_INVALID`

The deterministic report fallback and DingTalk delivery remained successful,
but the AI Context, Foundation task, Gateway, and token chain did not run.

## Root Cause

The Context Tool boundary accepted an unbounded business dashboard. Runtime
correctly rejected that payload, but the evidence reduction happened too late,
inside the Context resolver. The global Runtime limit was not the problem and
was not increased.

## Architecture Fix

The scheduler now creates a signed, bounded Daily Report Evidence Pack before
entering Agent Runtime.

1. Raw dashboard data remains inside the deterministic business service.
2. `DailyReportContextService.prepareInput()` creates and validates the
   Evidence Pack before the Tool invocation.
3. The Context Registry accepts only `evidence_pack` and `generated_at`.
4. `DailyReportAgent` accepts only prepared Context input and rejects a missing
   boundary object.
5. Tool Runtime keeps its existing 4 MiB global input limit.

Additional local limits are fail-closed:

- Evidence Pack: 240 KiB maximum.
- Complete Daily Report Context input: 256 KiB maximum.
- Evidence Pack contract and digest are validated before Runtime entry.

## Modified Files

- `lib/sales-assortment/daily-report-evidence-pack.mjs`
- `lib/ai/context/daily-report-context-service.mjs`
- `lib/ai/context/daily-report-context-registration.mjs`
- `lib/sales-assortment/daily-report-agent.mjs`
- `scheduler.mjs`
- `tests/daily-report-agent-v2.test.mjs`
- `tests/agent-runtime-architecture.test.mjs`

## Regression Coverage

The regression suite creates a synthetic raw dashboard larger than 6 MiB and
proves that:

- the Evidence Pack is at most 240 KiB;
- the Context input is at most 256 KiB;
- Context resolution succeeds through Tool Runtime;
- the Foundation task and Gateway chain complete;
- raw dashboard input is not accepted by the Agent or Context Registry.

## Production Validation

The combined main service and scheduler were restarted under the normal
`scripts/start-all.mjs` path. A second controlled report completed successfully.

- Scheduler run: `b8bb123f-2362-4f7c-8def-90630c2db319`
- Agent run: `9aadc66c-d959-4091-b4b4-8e966e900e68`
- Foundation task: `f0da211e-81d5-4f2a-b84d-41280f02d38f`
- Agent: `sales.daily-report@2.1.0`
- Context: `daily_report@2.1.0`, resolved as `AI-CONTEXT-1.0.0`
- Context Tool input: 24,204 bytes
- Tool calls: 7 succeeded, 0 failed
- Gateway model: `deepseek-v4-flash`
- Tokens: 8,218 input, 3,246 output, 11,464 total
- Foundation task state: `SUCCEEDED`
- Report version: `SALES-ASSORTMENT-DAILY-1.4.0`
- AI included: yes
- DingTalk delivery: success

The Agent Monitoring Center at `/#/agent-monitoring` displayed both the original
failed run and the corrected successful run. The success drawer showed the
Context version, all seven Tool calls, Gateway token usage, and no error code.
The browser console reported no warnings or errors.

## Verification

| Check | Result |
| --- | --- |
| Focused Agent/Runtime/Observability tests | 18/18 passed |
| Full repository test suite | 889/889 passed |
| Production build | Passed |
| Doctor | Passed |
| SQLite integrity | `ok` |
| Runtime stderr after restart | Empty |
| Agent summary fallback after restart | Not triggered |

## Data And Migration Boundary

- No migration was created or applied for this fix.
- No schema change was required.
- The controlled report created only the expected runtime task, audit, report,
  and notification records.
- The global Tool Runtime payload limit remains unchanged.

