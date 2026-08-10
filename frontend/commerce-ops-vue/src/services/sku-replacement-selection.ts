import type { SkuReplacementKind, SkuReplacementPlan } from "./warehouse-transfer";

export type ReplacementKindFilter = "ALL" | SkuReplacementKind;
export type ReplacementRiskFilter = "ALL" | "LOW" | "MEDIUM" | "HIGH";
export type ReplacementItemStatus = "UNSELECTED" | "SELECTED" | "NO_CANDIDATE" | "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW";
export type ReplacementStatusFilter = "ALL" | ReplacementItemStatus;
export type SkuSelections = Record<string, string>;
export type ReplacementExecutionStatuses = Record<string, Exclude<ReplacementItemStatus, "UNSELECTED" | "SELECTED" | "NO_CANDIDATE">>;

export interface ReplacementFilters {
  kind: ReplacementKindFilter;
  risk: ReplacementRiskFilter;
  status: ReplacementStatusFilter;
}

export function replacementItemKey(orderReference: string, itemId: string) {
  return `${orderReference}\u0000${itemId}`;
}

export function toggleSkuSelection(current: SkuSelections, key: string, sku: string): SkuSelections {
  const next = { ...current };
  if (next[key] === sku) delete next[key];
  else next[key] = sku;
  return next;
}

export function replacementItemStatus(orderReference: string, item: SkuReplacementPlan["items"][number], selections: SkuSelections,
  executionStatuses: ReplacementExecutionStatuses): ReplacementItemStatus {
  const key = replacementItemKey(orderReference, item.itemId);
  if (executionStatuses[key]) return executionStatuses[key];
  if (!item.candidates.length) return "NO_CANDIDATE";
  return selections[key] ? "SELECTED" : "UNSELECTED";
}

export function filterSkuReplacementPlans(plans: SkuReplacementPlan[], filters: ReplacementFilters, selections: SkuSelections,
  executionStatuses: ReplacementExecutionStatuses): SkuReplacementPlan[] {
  return plans.map((plan) => {
    const orderReference = plan.order.platformOrderId;
    const items = plan.items.filter((item) => item.shortage > 0).map((item) => {
      const status = replacementItemStatus(orderReference, item, selections, executionStatuses);
      if (filters.status !== "ALL" && filters.status !== status) return null;
      if (!item.candidates.length) return filters.kind === "ALL" && filters.risk === "ALL" ? { ...item, candidates: [] } : null;
      const candidates = item.candidates.filter((candidate) => (filters.kind === "ALL" || candidate.kind === filters.kind)
        && (filters.risk === "ALL" || candidate.riskLevel === filters.risk));
      if (!candidates.length) return null;
      if (filters.status === "SELECTED") {
        const selectedSku = selections[replacementItemKey(orderReference, item.itemId)];
        if (!candidates.some((candidate) => candidate.sku === selectedSku)) return null;
      }
      return { ...item, candidates };
    }).filter((item): item is SkuReplacementPlan["items"][number] => Boolean(item));
    return items.length ? { ...plan, items } : null;
  }).filter((plan): plan is SkuReplacementPlan => Boolean(plan));
}

export function summarizeSkuSelections(plans: SkuReplacementPlan[], selections: SkuSelections) {
  const selectedOrders = new Set<string>();
  let selectedItems = 0;
  for (const plan of plans) {
    for (const item of plan.items) {
      const selectedSku = selections[replacementItemKey(plan.order.platformOrderId, item.itemId)];
      if (!selectedSku || !item.candidates.some((candidate) => candidate.sku === selectedSku)) continue;
      selectedItems += 1;
      selectedOrders.add(plan.order.platformOrderId);
    }
  }
  return { selectedItems, selectedOrders: selectedOrders.size };
}
