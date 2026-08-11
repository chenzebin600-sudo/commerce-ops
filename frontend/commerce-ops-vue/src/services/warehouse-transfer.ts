import { apiJson } from "./api";

export interface WarehouseTransferItem {
  itemId: string; stockSku: string; title: string; quantity: number; currentWarehouse: string;
}
export interface WarehouseTransferPlan {
  planHash: string; approvalText: string; createdAt: string; expiresAt: string;
  order: { internalOrderId: string; platformOrderId: string; shopId: string; platformId: string; orderStatus: string };
  targetWarehouse: string; items: WarehouseTransferItem[];
  itemBindings: Array<{ itemId: string; optionValue: string; optionText: string; optionWarehouseKey: string }>;
  stock: Array<{ sku: string; quantity: number; available: number }>;
  alternatives: Array<{ warehouse: string; remaining: number }>;
  executedAt?: string; status?: string;
}
export interface WarehouseTransferBatch {
  batchHash: string; approvalText: string; createdAt: string; expiresAt: string; requestedCount: number;
  plans: WarehouseTransferPlan[]; failures: Array<{ orderReference: string; code: string; message: string }>;
  selectedCount?: number; executedAt?: string;
  results?: Array<{ planHash: string; orderReference: string; status: "COMPLETED" | "FAILED"; code?: string; message?: string; result?: WarehouseTransferPlan }>;
  summary?: { completed: number; failed: number };
}

export type SkuReplacementKind = "SAME" | "COLOR" | "SMALLER" | "SMALLER_COLOR";
export type SkuReplacementWarehouseMode = "KEEP_CURRENT" | "MOVE_WHOLE_ORDER";
export interface SkuReplacementWarehouseAlternative {
  warehouse: string; mode: SkuReplacementWarehouseMode; remaining: number;
}
export interface SkuReplacementCandidate {
  sku: string; chineseName: string; warehouse: string; available: number; productStatus: string;
  category1: string; category2: string; kind: SkuReplacementKind; label: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH"; colorChanged: boolean; specRelation: string;
  originalColors: string[]; candidateColors: string[];
  nameSource?: string; nameConfidence?: "VERIFIED" | "MISSING" | "AMBIGUOUS";
  warehouseMode: SkuReplacementWarehouseMode; targetWarehouse: string;
  warehouseAlternatives: SkuReplacementWarehouseAlternative[];
}
export interface SkuReplacementItem {
  itemId: string; originalSku: string; chineseName: string; quantity: number; currentWarehouse: string;
  available: number; shortage: number; candidates: SkuReplacementCandidate[]; requiresBundleReview: boolean;
}
export interface SkuReplacementPlan {
  order: { internalOrderId: string; platformOrderId: string; shopId: string; platformId: string; orderStatus: string };
  items: SkuReplacementItem[]; candidateCount: number; replaceableItemCount: number; unresolvedItemCount: number;
}
export interface SkuReplacementBatch {
  version: number; generatedAt: string; requestedCount: number; plans: SkuReplacementPlan[];
  batchHash?: string; orderReferences?: string[]; recoveredAt?: string;
  failures: Array<{ orderReference: string; code: string; message: string }>;
  executionAvailable: boolean; executionBlockReason: string;
  summary: { inspected: number; failed: number; ordersWithCandidates: number; replaceableItems: number; candidateCount: number };
}
export interface SkuReplacementExecutionPlan {
  planHash: string; approvalText: string; createdAt: string; expiresAt: string; status?: string; executedAt?: string;
  order: SkuReplacementPlan["order"];
  item: Omit<SkuReplacementItem, "shortage" | "candidates" | "requiresBundleReview">;
  replacement: SkuReplacementCandidate; replacementStockId: string;
  result?: { changed: boolean; stockId: string };
}
export interface SkuReplacementBatchPlan {
  batchHash: string; approvalText: string; createdAt: string; expiresAt: string;
  items: Array<{ selection: SkuReplacementSelection; plan: SkuReplacementExecutionPlan }>;
  failures: Array<SkuReplacementSelection & { code: string; message: string }>;
  summary: { requested: number; executable: number; failed: number };
}
export interface SkuReplacementSelection { orderReference: string; itemId: string; replacementSku: string; targetWarehouse: string }
export interface SkuReplacementLegacyDiagnostic {
  version: 1; capturedAt: string;
  stage: "mabang_response" | "mabang_request_uncertain" | "readback" | "service_precheck";
  endpoint: "order.doChanegOrderItem";
  request: { fieldNames: string[]; orderItemId: string; stockId: string;
    IsChangeWarehouse: string; isChangeOrderItemPrice: string };
  response: { httpStatus: number | null; contentType: string; success: string | number | boolean | null;
    code: string; message: string; fieldNames: string[]; bodyKind: string; bodyLength: number; textPreview?: string };
  verification: { beforeSku: string; targetSku: string; afterSku: string; result: string };
}
export interface SkuReplacementWarehouseDiagnostic {
  version: 1;
  phase: "POST_SKU_INSPECT" | "WAREHOUSE_PREVIEW" | "WAREHOUSE_EXECUTE" | "FINAL_VERIFY";
  skuWriteConfirmed: boolean; warehousePreviewAttempted: boolean; warehouseWriteAttempted: boolean;
  warehouseWriteConfirmed: boolean; targetSku: string; observedSku: string; targetWarehouse: string;
  finalWarehouses: string[]; message?: string; cause?: { code: string };
}
export type SkuReplacementDiagnostic = SkuReplacementLegacyDiagnostic | SkuReplacementWarehouseDiagnostic;
export type SkuReplacementTaskItemStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW" | "NOT_EXECUTED";
export interface SkuReplacementBatchTaskItem {
  orderReference: string; itemId: string; originalSku: string; replacementSku: string; planHash: string;
  status: SkuReplacementTaskItemStatus; startedAt: string | null; finishedAt: string | null;
  code: string | null; message: string | null; diagnostic: SkuReplacementDiagnostic | null;
  result: SkuReplacementExecutionPlan | null;
}
export interface SkuReplacementBatchTask {
  taskId: string; batchHash: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_FAILURES";
  createdAt: string; startedAt: string | null; finishedAt: string | null; currentItem: number | null;
  items: SkuReplacementBatchTaskItem[];
  prevalidationFailures: Array<SkuReplacementSelection & { code: string; message: string }>;
  summary: { total: number; processed: number; completed: number; failed: number; manualReview: number; notExecuted: number; prevalidationFailed: number };
}

export function previewWarehouseTransfer(orderReference: string, targetWarehouse = "") {
  return apiJson<WarehouseTransferPlan>("/api/fulfillment-dashboard/warehouse-transfers/preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReference, targetWarehouse }),
  });
}
export interface PreviewTask<T> {
  taskId: string; kind: string; fingerprint: string; state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  createdAt: string; startedAt: string | null; finishedAt: string | null; progress: Record<string, unknown> | null;
  result: T | null; error: { code: string; message: string } | null;
}

export function probeFulfillmentHealth() {
  return apiJson<{ success: boolean }>("/api/fulfillment-dashboard/health");
}

export function executeWarehouseTransfer(planHash: string, approvalText: string) {
  return apiJson<WarehouseTransferPlan>("/api/fulfillment-dashboard/warehouse-transfers/execute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planHash, approvalText }),
  });
}

export function previewWarehouseTransferBatch(orderReferences: string[]) {
  return apiJson<WarehouseTransferBatch>("/api/fulfillment-dashboard/warehouse-transfers/batch-preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReferences }),
  });
}

export function startWarehouseTransferBatchPreview(orderReferences: string[]) {
  return apiJson<PreviewTask<WarehouseTransferBatch>>("/api/fulfillment-dashboard/warehouse-transfers/batch-preview-tasks", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReferences }),
  });
}

export function getWarehouseTransferBatchPreviewTask(taskId: string) {
  return apiJson<PreviewTask<WarehouseTransferBatch>>(`/api/fulfillment-dashboard/warehouse-transfers/batch-preview-tasks/${encodeURIComponent(taskId)}`);
}

export function recoverWarehouseTransferBatch(orderReferences: string[]) {
  return apiJson<WarehouseTransferBatch>("/api/fulfillment-dashboard/warehouse-transfers/batch-recover", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReferences }),
  });
}

export function executeWarehouseTransferBatch(batchHash: string, planHashes: string[], approvalText: string) {
  return apiJson<WarehouseTransferBatch>("/api/fulfillment-dashboard/warehouse-transfers/batch-execute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchHash, planHashes, approvalText }),
  });
}

export function previewSkuReplacementBatch(orderReferences: string[]) {
  return apiJson<SkuReplacementBatch>("/api/fulfillment-dashboard/sku-replacements/batch-preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReferences }),
  });
}

export function startSkuReplacementBatchPreview(orderReferences: string[]) {
  return apiJson<PreviewTask<SkuReplacementBatch>>("/api/fulfillment-dashboard/sku-replacements/batch-preview-tasks", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReferences }),
  });
}

export function getSkuReplacementBatchPreviewTask(taskId: string) {
  return apiJson<PreviewTask<SkuReplacementBatch>>(`/api/fulfillment-dashboard/sku-replacements/batch-preview-tasks/${encodeURIComponent(taskId)}`);
}

export function recoverSkuReplacementBatch(orderReferences: string[]) {
  return apiJson<SkuReplacementBatch>("/api/fulfillment-dashboard/sku-replacements/batch-recover", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReferences }),
  });
}

export function createSkuReplacementPlan(orderReference: string, itemId: string, replacementSku: string) {
  return apiJson<SkuReplacementExecutionPlan>("/api/fulfillment-dashboard/sku-replacements/plan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReference, itemId, replacementSku }),
  });
}

export function executeSkuReplacement(planHash: string, approvalText: string) {
  return apiJson<SkuReplacementExecutionPlan>("/api/fulfillment-dashboard/sku-replacements/execute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planHash, approvalText }),
  });
}

export function createSkuReplacementBatchPlan(selections: SkuReplacementSelection[]) {
  return apiJson<SkuReplacementBatchPlan>("/api/fulfillment-dashboard/sku-replacements/batch-plan", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selections }),
  });
}

export function executeSkuReplacementBatch(batchHash: string, approvalText: string) {
  return apiJson<SkuReplacementBatchTask>("/api/fulfillment-dashboard/sku-replacements/batch-execute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchHash, approvalText }),
  });
}

export function getSkuReplacementBatchTask(taskId: string) {
  return apiJson<SkuReplacementBatchTask>(`/api/fulfillment-dashboard/sku-replacements/batch-executions/${encodeURIComponent(taskId)}`);
}
