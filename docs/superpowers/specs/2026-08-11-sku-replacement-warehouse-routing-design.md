# SKU Replacement Warehouse Routing Design

## Goal

Make SKU replacement deterministic across both SKU and warehouse state. The final order must either keep its original single warehouse or move the whole order to an eligible warehouse from that shop's fulfillment allowlist. Mabang's automatically selected warehouse is never accepted as the source of truth.

## Definitions

- **Active item:** An order item for which the current fulfillment `ignored(item)` rule returns false.
- **Original warehouse:** The normalized warehouse shared by every active item before execution.
- **Allowed warehouse:** A warehouse listed in the order shop's fulfillment policy `allowedWarehouses`.
- **KEEP_CURRENT:** Replace the SKU and finish with every active item in the original warehouse.
- **MOVE_WHOLE_ORDER:** Replace the SKU and finish with every active item in one selected allowed warehouse.
- **Eligible warehouse:** A warehouse supported by every active item and holding enough inventory for the prospective final SKU set.

If the order initially spans multiple active warehouses, it has no single original warehouse and cannot use `KEEP_CURRENT`; it must use `MOVE_WHOLE_ORDER` or remain unresolved.

## Candidate and Warehouse Selection

The preview reads the current order once and builds the prospective final item set by replacing only the selected item SKU. Inventory is loaded for the original warehouse and the shop's configured allowed warehouses.

Selection follows this order:

1. If the order has one original warehouse and the prospective final item set is fully supported and sufficiently stocked there, select `KEEP_CURRENT` and that warehouse.
2. Otherwise, evaluate only the shop's configured `allowedWarehouses` for `MOVE_WHOLE_ORDER`.
3. A move candidate is eligible only when every active item supports it and every prospective final SKU has sufficient stock for the full order quantity.
4. Auto-selection uses the existing whole-order warehouse rule: eligible first, then greatest total remaining stock after reservation, then Chinese warehouse-name order for a deterministic tie-break.
5. The preview exposes every eligible alternative. An operator may manually select one of them; arbitrary warehouse text is rejected.

An empty allowlist disables `MOVE_WHOLE_ORDER`. It does not block `KEEP_CURRENT` when the original warehouse remains feasible.

## Plan Contract

Each replacement plan stores and hashes:

- order and item identity;
- original SKU and replacement SKU;
- original warehouse state for all active items;
- prospective final item set;
- `warehouseMode`;
- selected `targetWarehouse`;
- eligible warehouse alternatives and inventory evidence;
- resolved Mabang replacement stock ID;
- expiry time.

The confirmation text includes both the SKU transition and target warehouse:

```text
确认更换SKU并整单定仓 <订单号> <原SKU> -> <目标SKU> -> <目标仓库>
```

Changing the SKU, target warehouse, item quantities, policy allowlist, or inventory evidence requires a new preview and plan.

## Execution Flow

Execution is coordinated by the SKU replacement service behind one outer plan and one user confirmation:

1. Re-read the order, policy, item identities, quantities, current SKU, shipment state, and fresh inventory.
2. Recompute eligibility for the exact planned target warehouse. Stop before writing if any precondition changed.
3. Submit the single SKU replacement request.
4. Read the order back immediately.
5. If the replacement SKU is not confirmed, use the existing failure/manual-review rules and do not submit a warehouse change.
6. If every active item is already in the planned target warehouse, skip the warehouse write.
7. Otherwise, invoke the existing verified whole-order warehouse-transfer flow for the exact planned warehouse and prospective final item set.
8. Perform a final independent readback. Success requires the selected item to have the replacement SKU and every active item to be in the target warehouse.

The warehouse-transfer step is deterministic reconciliation. It is required even for `KEEP_CURRENT` when Mabang automatically moves the replaced item elsewhere.

## Failure Safety

- No automatic retry of either Mabang write endpoint.
- A failure before confirmed SKU change is `FAILED` and leaves the plan consumed.
- A confirmed SKU change followed by warehouse failure or uncertain warehouse readback is `MANUAL_REVIEW`.
- No automatic SKU rollback: rollback would add another irreversible write and could compound an uncertain state.
- Persist diagnostics for both phases, including intended mode/warehouse, safe request fields, and final SKU/warehouse readback.
- Batch processing continues with later orders after recording an isolated item failure, matching the current batch behavior.

## UI Behavior

Each selected replacement shows:

- replacement SKU and replacement type;
- `保持原仓` or `整单换仓`;
- selected target warehouse;
- inventory remaining after the order quantity;
- alternative eligible warehouses in a manual selector;
- a warning that SKU replacement plus whole-order movement performs two verified Mabang operations.

Changing the warehouse selection invalidates any existing execution plan and generates a new one. Filters and batch selection behavior remain unchanged.

## API Changes

- Preview candidates add `warehouseMode`, `targetWarehouse`, and `warehouseAlternatives`.
- Plan creation accepts an optional `targetWarehouse`; blank means deterministic auto-selection.
- Batch selections carry the optional selected warehouse.
- Execution continues to accept only `planHash` and the exact confirmation text; the target warehouse cannot be changed during execution.

The main dashboard proxy keeps its existing fixed-route and bounded-input protections, adding only the allowlisted warehouse field.

## Test Coverage

Tests must prove:

- same-warehouse inventory selects `KEEP_CURRENT`;
- a Mabang auto-hop is reconciled back to the original warehouse;
- original-warehouse shortage selects only a configured allowed warehouse;
- the highest remaining-stock eligible warehouse is auto-selected deterministically;
- manual selection accepts an eligible alternative and rejects arbitrary or stale warehouses;
- all active order SKUs, including the replacement SKU, must fit the target warehouse;
- empty allowlist permits feasible keep-current plans but blocks whole-order moves;
- multi-warehouse source orders cannot use keep-current;
- an already-correct post-SKU warehouse state skips the second write;
- warehouse failure after confirmed SKU change becomes `MANUAL_REVIEW` without retry or rollback;
- final success requires independent verification of both replacement SKU and every active item's warehouse;
- diagnostic UI displays both operation phases without exposing credentials, cookies, or authorization headers.

## Out of Scope

- Changing the buyer-facing Shopee order item.
- Automatically editing the shop's fulfillment allowlist.
- Using an undocumented Mabang warehouse flag as the correctness mechanism.
- Automatically rolling back a confirmed SKU replacement.
