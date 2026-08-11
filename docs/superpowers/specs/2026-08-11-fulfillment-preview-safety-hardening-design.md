# Fulfillment Preview Safety Hardening Design

## Goal

Stop false SKU replacement candidates, make whole-order warehouse moves use the
correct Mabang option for every order line, and make long-running previews
recoverable after a browser refresh or transient service timeout. No irreversible
SKU or warehouse write may rely on stale, ambiguous, or parser-unverified data.

## Confirmed Failures

### False SKU candidates

The scoped inventory request returns JSON whose `message` field contains an HTML
table. The parser currently treats the second text token in the SKU column as the
Chinese product name. In the observed response that token was the sales-state text
`正常销售`, so unrelated SKUs received the same name. The replacement matcher then
accepted candidates without usable specification evidence and labeled them
`同款同规格`.

Consequences:

- `T3AA1353145` was shown with unrelated replacement SKUs;
- the candidate card displayed `正常销售` as though it were the product name;
- old batch previews now contain unsafe candidate evidence and must not execute.

### Whole-order warehouse option mismatch

Warehouse preview already checks all active SKUs and their aggregate quantities in
one canonical target warehouse. However, it collapses line-level warehouse options
to a normalized key and retains one raw option text. Execution then submits that
same raw text for every line. Mabang option text/value can differ by line even when
the normalized warehouse is the same, so a valid canonical target can fail with
`WAREHOUSE_TARGET_UNAVAILABLE` for another item.

### Lost long-running preview state

Warehouse preview is currently a synchronous request. If the browser request times
out, the service briefly stops answering health checks, or the page is refreshed,
the frontend loses its request state. The recovery action only searches completed
results, so an active task is incorrectly presented as “没有找到最近完成的预览结果，
请重新获取”. Starting again can duplicate expensive read work.

## Considered Approaches

### A. Fail-closed provenance, per-line bindings, and durable preview tasks

This is the selected approach. Every parsed inventory name carries source and
confidence; candidate matching requires positive product/specification evidence;
warehouse plans bind the canonical target to each line's exact option; previews run
as queryable background tasks. It is the largest change but fixes the causes and
creates enforceable safety boundaries.

### B. Patch the current HTML token position and raw warehouse text

This would be smaller, but both HTML column token order and line-level option text
are unstable. Another Mabang markup or option change would silently recreate the
same class of failure. Rejected.

### C. Return to full Excel inventory export

The page reported 50,770 inventory rows while the exported workbook contained only
16,085 rows. Relying on that export would knowingly operate on incomplete stock
data and was already designed to stop safely. Rejected.

## Inventory Record Contract

The scoped inventory parser must identify fields from HTML structure and labels,
not an unverified text-token position. Its output becomes:

```text
{
  sku,
  chineseName,
  nameSource,       // explicit field/cell/attribute identifier
  nameConfidence,   // VERIFIED | MISSING | AMBIGUOUS
  warehouse,
  available,
  stockId,
  salesState
}
```

`salesState` is a separate field and is never a name fallback. A record with a
missing or ambiguous Chinese name remains usable for exact inventory lookup but is
not usable for automatic substitute discovery.

Fixture tests must use a captured, sanitized shape of the actual Mabang inventory
HTML, including sales-state text adjacent to the SKU/name cells. Tests must prove
that `正常销售` cannot become `chineseName`.

## Replacement Candidate Contract

Automatic candidates require all of the following:

1. verified Chinese names for both original and candidate records;
2. positive same-product evidence after removing only recognized color/spec tokens;
3. either equal recognized specification, a strictly smaller recognized
   specification, or a recognized color-only difference;
4. sufficient stock in an eligible route for the prospective whole order;
5. no combination-SKU or other existing safety exclusion.

Missing specification evidence is no longer equivalent to `同款同规格`. It is
classified `UNKNOWN` and excluded from automatic candidates. The UI may show an
unknown item only under manual review, never as a selectable safe substitute.

Each selectable candidate stores and displays evidence:

```text
{
  originalChineseName,
  replacementChineseName,
  matchKind,
  matchedProductTokens,
  originalSpecification,
  replacementSpecification,
  colorDifference,
  nameSource,
  nameConfidence
}
```

## Preview and Plan Versioning

Introduce a new preview/plan schema version. All SKU replacement previews, batch
previews, selections, and execution plans created by the older parser or older
candidate rules are rejected with `PREVIEW_SCHEMA_OBSOLETE` and a message to
regenerate the preview. Existing files can remain for audit; they cannot be used to
write.

The plan hash covers schema version, parser provenance, candidate evidence,
prospective items, policy snapshot, inventory snapshot, warehouse route, and
expiry. Any changed input requires a new preview.

## Whole-order Warehouse Route Contract

Warehouse eligibility remains a whole-order decision. For each prospective active
item, the route evaluator must confirm:

- the same canonical warehouse key is offered by that item;
- that item's exact Mabang option `value` and `text` are captured;
- aggregate required quantity for every final SKU is covered by fresh inventory;
- a moved target is in the shop fulfillment configuration's allowed warehouses.

A route stores one canonical target plus line-level bindings:

```text
{
  targetWarehouse,
  targetWarehouseKey,
  itemBindings: [
    { itemId, sku, quantity, optionValue, optionText, optionWarehouseKey }
  ]
}
```

The Python writer selects by the planned line's exact option value first and exact
text second. It must never reuse another line's option token. A missing or changed
binding stops before the warehouse write.

For an order containing one stocked SKU and one out-of-stock SKU, every mapped
warehouse is evaluated using both SKUs and their full quantities. The order is
eligible only if all lines fit together in that one warehouse.

## Execution Safety Boundary

Immediately before the first irreversible write, execution re-reads:

- the current active order and all item identities, SKUs, quantities, shipment
  state, and warehouse options;
- the current explicit shop warehouse allowlist;
- fresh inventory for every prospective SKU at the exact target;
- the selected replacement SKU record and its verified name/match provenance.

The service then recomputes the entire prospective route from that fresh snapshot
and compares it with the hashed plan. A mismatch returns a stale-plan error before
writing. Refreshing only the replacement SKU is insufficient.

Selections for multiple lines of the same order are not planned independently from
one original snapshot. They are grouped into one prospective-order plan, or each
later selection is re-previewed after the previous verified write. The initial
implementation will use grouped prospective planning so inventory and route
quantities are evaluated atomically.

After a confirmed SKU write, deterministic warehouse reconciliation and independent
readback remain required. Any uncertain post-write state is `MANUAL_REVIEW`; there
is no automatic retry or rollback.

## Background Preview Task Contract

Both warehouse and SKU batch previews use a background task resource:

```text
POST /preview-tasks  -> { taskId, state }
GET  /preview-tasks/:taskId -> { state, progress, result?, error? }
```

States are `QUEUED`, `RUNNING`, `SUCCEEDED`, and `FAILED`. The service persists task
metadata and the normalized request fingerprint. Starting the same active request
returns the existing task instead of duplicating it.

The frontend stores the task ID in session storage, polls with bounded backoff, and
restores the running view after refresh. A health timeout is displayed as
“服务繁忙/连接暂时超时，任务仍在后台核查” unless the listener is positively known
to be absent. Completed results remain recoverable. “重新获取” is only offered
after a terminal failure, obsolete result, or confirmed missing task.

## Diagnostics

Safe diagnostics expose:

- task ID, request fingerprint, stage, timestamps, and progress counts;
- parser source/confidence and rejected-candidate reason;
- canonical target and per-line warehouse binding outcome;
- HTTP status and sanitized Mabang response body;
- pre-write or post-write phase and final readback state.

Cookies, authorization headers, credentials, and full browser payloads are never
persisted or rendered. Frontend diagnostic types and renderer must support both SKU
replacement and warehouse-route diagnostics rather than hiding new fields behind
the legacy shape.

## Error Handling

- `INVENTORY_NAME_UNVERIFIED`: record cannot participate in auto-substitution.
- `SKU_MATCH_EVIDENCE_INSUFFICIENT`: product/spec match is not proven.
- `PREVIEW_SCHEMA_OBSOLETE`: old preview or plan must be regenerated.
- `PLAN_STALE`: fresh order, policy, option, or inventory snapshot changed.
- `WAREHOUSE_LINE_BINDING_CHANGED`: a line no longer exposes the planned option.
- `PREVIEW_TASK_NOT_FOUND`: recovery ID is genuinely absent.
- `PREVIEW_TASK_FAILED`: background task ended with its sanitized cause.

Pre-write errors are safe failures. Post-write verification uncertainty remains
`MANUAL_REVIEW` with the relevant phase attached.

## UI Behavior

Candidate cards show both real Chinese names, match category, parsed color/spec
evidence, target warehouse mode, and remaining inventory. Unknown matches are not
selectable. Warehouse choices show that the complete order has been checked and may
optionally expose a compact per-line stock summary.

During a long preview the page shows task progress and preserves input. Refreshing
the page resumes the same task. The recovery button label reflects the actual
state: resume running task, restore completed result, or retry failed task.

## Test Strategy

Tests are written before production changes and cover:

- captured HTML fixture parsing and separation of product name from sales state;
- exclusion of missing/ambiguous names and unspecified matches;
- invalidation of all older preview and plan schemas;
- whole-order aggregate inventory checks for mixed stocked/out-of-stock lines;
- two lines sharing a canonical warehouse but requiring different option values;
- full fresh revalidation before any SKU write;
- same-order multi-line replacement planning without stale intermediate snapshots;
- background task idempotency, persistence, polling, refresh recovery, and terminal
  retry behavior;
- frontend distinction between busy timeout and confirmed service absence;
- diagnostics for candidate and warehouse failures;
- existing no-retry, no-rollback, and final-readback guarantees.

No automated test performs a live Mabang write. After all suites pass, the service
is restarted and only read-only preview/health behavior is verified before the user
chooses to run a real operation.

## Rollout

1. Deploy the schema gate first so unsafe old candidates cannot execute.
2. Deploy verified inventory parsing and fail-closed candidate matching.
3. Deploy per-line warehouse bindings and full pre-write recomputation.
4. Deploy durable preview tasks and frontend recovery.
5. Rebuild the frontend, restart the 3112 service, and verify health/read-only
   previews. Do not automatically execute or retry any order write.

## Out of Scope

- inferring product equivalence from SKU prefixes alone;
- broadening a shop's configured allowed warehouses;
- changing buyer-facing marketplace items;
- automatic rollback after a confirmed Mabang write;
- treating incomplete Excel exports as complete inventory.
