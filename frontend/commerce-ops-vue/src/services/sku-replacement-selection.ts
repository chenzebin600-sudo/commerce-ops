import type { SkuReplacementBatchTask, SkuReplacementBatchTaskItem, SkuReplacementDiagnostic,
  SkuReplacementCandidate, SkuReplacementKind, SkuReplacementPlan, SkuReplacementSelection } from "./warehouse-transfer";

export type ReplacementKindFilter = "ALL" | SkuReplacementKind;
export type ReplacementRiskFilter = "ALL" | "LOW" | "MEDIUM" | "HIGH";
export type ReplacementItemStatus = "UNSELECTED" | "SELECTED" | "NO_CANDIDATE" | "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW";
export type ReplacementStatusFilter = "ALL" | ReplacementItemStatus;
export interface SkuSelectionState { sku: string; targetWarehouse: string }
export type SkuSelections = Record<string, SkuSelectionState>;
export type ReplacementExecutionStatuses = Record<string, Exclude<ReplacementItemStatus, "UNSELECTED" | "SELECTED" | "NO_CANDIDATE">>;

export interface ReplacementFilters {
  kind: ReplacementKindFilter;
  risk: ReplacementRiskFilter;
  status: ReplacementStatusFilter;
}

export function replacementItemKey(orderReference: string, itemId: string) {
  return `${orderReference}\u0000${itemId}`;
}

export function toggleSkuSelection(current: SkuSelections, key: string,
  candidate: Pick<SkuReplacementCandidate, "sku" | "targetWarehouse">): SkuSelections {
  const next = { ...current };
  if (next[key]?.sku === candidate.sku) delete next[key];
  else next[key] = { sku: candidate.sku, targetWarehouse: candidate.targetWarehouse };
  return next;
}

export function setSkuSelectionWarehouse(current: SkuSelections, key: string, targetWarehouse: string): SkuSelections {
  const selected = current[key];
  return selected ? { ...current, [key]: { ...selected, targetWarehouse } } : current;
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
        const selectedSku = selections[replacementItemKey(orderReference, item.itemId)]?.sku;
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
      const selectedSku = selections[replacementItemKey(plan.order.platformOrderId, item.itemId)]?.sku;
      if (!selectedSku || !item.candidates.some((candidate) => candidate.sku === selectedSku)) continue;
      selectedItems += 1;
      selectedOrders.add(plan.order.platformOrderId);
    }
  }
  return { selectedItems, selectedOrders: selectedOrders.size };
}

export function buildSkuReplacementSelections(plans: SkuReplacementPlan[], selections: SkuSelections) {
  const result: SkuReplacementSelection[] = [];
  for (const plan of plans) {
    for (const item of plan.items) {
      const selected = selections[replacementItemKey(plan.order.platformOrderId, item.itemId)];
      const candidate = selected && item.candidates.find((candidate) => candidate.sku === selected.sku);
      if (!candidate?.warehouseAlternatives.some((alternative) => alternative.warehouse === selected.targetWarehouse)) continue;
      result.push({ orderReference: plan.order.platformOrderId, itemId: item.itemId,
        replacementSku: selected.sku, targetWarehouse: selected.targetWarehouse });
    }
  }
  return result;
}

export function executionStatusesFromTask(task: { items?: Array<{ orderReference: string; itemId: string; status: string }> } | null) {
  const result: ReplacementExecutionStatuses = {};
  for (const item of task?.items || []) {
    const status = item.status === "NOT_EXECUTED" ? "FAILED" : item.status;
    if (["RUNNING", "COMPLETED", "FAILED", "MANUAL_REVIEW"].includes(status)) {
      result[replacementItemKey(item.orderReference, item.itemId)] = status as ReplacementExecutionStatuses[string];
    }
  }
  return result;
}

export function taskItemFor(orderReference: string, itemId: string,
  task: Pick<SkuReplacementBatchTask, "items"> | { items?: SkuReplacementBatchTaskItem[] } | null) {
  return task?.items?.find((item) => item.orderReference === orderReference && item.itemId === itemId) || null;
}

export function diagnosticRows(diagnostic: SkuReplacementDiagnostic | null | undefined) {
  if (!diagnostic || diagnostic.version !== 1) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: unknown) => {
    const text = String(value ?? "").trim();
    if (text) rows.push({ label, value: text });
  };
  add("阶段", diagnostic.stage);
  add("HTTP", diagnostic.response?.httpStatus);
  const requestFields = ["orderItemId", "stockId", "IsChangeWarehouse", "isChangeOrderItemPrice"]
    .map((key) => `${key}=${String(diagnostic.request?.[key as keyof typeof diagnostic.request] ?? "").trim()}`)
    .filter((value) => !value.endsWith("="));
  add("请求字段", requestFields.join(" · "));
  add("业务码", diagnostic.response?.code);
  add("马帮信息", diagnostic.response?.message);
  add("返回字段", diagnostic.response?.fieldNames?.join(" · "));
  const verification = diagnostic.verification;
  if (verification && (verification.beforeSku || verification.targetSku || verification.afterSku || verification.result)) {
    add("回读", `${verification.beforeSku || "?"} → ${verification.targetSku || "?"}，最终 ${verification.afterSku || "?"}${verification.result ? `（${verification.result}）` : ""}`);
  }
  return rows;
}
