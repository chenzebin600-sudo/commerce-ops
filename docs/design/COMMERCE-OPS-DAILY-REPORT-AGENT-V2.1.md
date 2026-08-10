# Commerce Ops Daily Report Agent V2.1

Status: implemented
Date: 2026-08-05

## Objective

Daily Report Agent V2.1 upgrades the scheduled report from a generic model
summary to an operations decision brief. AI Foundation V1 remains unchanged:
the Agent continues to use AI Gateway, Agent Registry, Prompt Registry, Context
Layer, the shared permission contract, and Foundation task lifecycle.

## Evidence Pack

The LLM does not receive raw orders, inventory rows, product rows, or full chart
series. `SALES-ASSORTMENT-EVIDENCE-PACK-2.1.0` is built by deterministic code
before the Gateway call and contains only ranked evidence:

- operating KPIs and the highest-priority alerts;
- store declines and growth ranked by priority and absolute GMV impact;
- product and style changes ranked by deterministic impact;
- inventory risks ranked by priority and exposed business value;
- business opportunities ranked by opportunity amount;
- the latest seven complete days versus the immediately preceding seven days;
- source freshness, quality limitations, rule contract, and selection limits.

The pack has bounded Top N limits. All amounts, deltas, rates, ranks, inventory
values, and opportunity amounts are calculated before the LLM call.

## Output Contract

Agent `sales.daily-report@2.1.0` uses prompt
`SALES-ASSORTMENT-DAILY-AGENT-2.1.0` and output schema
`sales.daily-report-operations-decision@2.1.0`.

The output always contains these modules:

1. `operatingOverview`
2. `storeAnomalies`
3. `productAnomalies`
4. `inventoryRisks`
5. `businessOpportunities`
6. `sevenDayTrends`

Every finding is normalized to:

- priority;
- object type and object name;
- data change;
- impact scale;
- reason, separating proven facts from hypotheses;
- a human-reviewed recommended action;
- evidence references.

Each module is limited to three findings. Missing optional model fields are
filled by the normalization layer, while the six-module envelope remains a hard
validation gate.

## Persistence

No migration is required. Existing SQLite migration 022 already provides
`foundation_tasks.result_json`, which can retain the complete normalized AI
analysis together with the Agent version, prompt version, output schema,
Evidence Pack version and digest, model, provider, and token usage.

This provides the durable material required for later A/B comparison, quality
scoring, and prompt optimization without changing AI Foundation V1.

## Delivery

The DingTalk markdown renderer is versioned as
`SALES-ASSORTMENT-DAILY-1.4.0`. It renders all six AI modules and shows, for each
selected finding, the object, data change, impact scale, reason, and action.
The complete model output remains in the Foundation task even though DingTalk
shows at most two findings per module to keep the message readable.

If Gateway execution or output validation fails, the existing deterministic
daily report remains the delivery fallback.

## Safety Boundary

- The LLM does not calculate business numbers.
- The Agent cannot change deterministic ranks or priorities.
- The Agent is read/recommend only.
- Recommendations require human review.
- No pricing, replenishment, listing, inventory-sync, or personal-notification
  action is executed by this Agent.
- No Foundation code or database migration is changed by V2.1.
