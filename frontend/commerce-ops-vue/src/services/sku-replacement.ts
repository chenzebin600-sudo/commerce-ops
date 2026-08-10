import { apiJson } from "./api";

export type SkuReplacementKind = "SAME" | "COLOR" | "SMALLER" | "SMALLER_COLOR";

export interface SkuReplacementCandidate {
  sku: string;
  chineseName: string;
  warehouse: string;
  available: number;
  productStatus: string;
  category1: string;
  category2: string;
  kind: SkuReplacementKind;
  label: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  colorChanged: boolean;
  specRelation: string;
  originalColors: string[];
  candidateColors: string[];
}

export interface SkuReplacementItem {
  itemId: string;
  originalSku: string;
  chineseName: string;
  quantity: number;
  currentWarehouse: string;
  available: number;
  shortage: number;
  candidates: SkuReplacementCandidate[];
  requiresBundleReview: boolean;
}

export interface SkuReplacementPlan {
  order: { internalOrderId: string; platformOrderId: string; shopId: string; platformId: string; orderStatus: string };
  items: SkuReplacementItem[];
  candidateCount: number;
  replaceableItemCount: number;
  unresolvedItemCount: number;
}

export interface SkuReplacementBatch {
  version: number;
  generatedAt: string;
  requestedCount: number;
  plans: SkuReplacementPlan[];
  batchHash?: string;
  orderReferences?: string[];
  recoveredAt?: string;
  failures: Array<{ orderReference: string; code: string; message: string }>;
  executionAvailable: boolean;
  executionBlockReason: string;
  summary: { inspected: number; failed: number; ordersWithCandidates: number; replaceableItems: number; candidateCount: number };
}

export interface SkuReplacementExecutionPlan {
  planHash: string;
  approvalText: string;
  createdAt: string;
  expiresAt: string;
  status?: string;
  executedAt?: string;
  order: SkuReplacementPlan["order"];
  item: Omit<SkuReplacementItem,"shortage" | "candidates" | "requiresBundleReview">;
  replacement: SkuReplacementCandidate;
  replacementStockId: string;
  result?: { changed: boolean; stockId: string };
}

export interface SkuReplacementSelection { orderReference: string; itemId: string; replacementSku: string }

export interface SkuReplacementBatchPlan {
  batchHash: string;
  approvalText: string;
  createdAt: string;
  expiresAt: string;
  items: Array<{ selection: SkuReplacementSelection; plan: SkuReplacementExecutionPlan }>;
  failures: Array<SkuReplacementSelection & { code: string; message: string }>;
  summary: { requested: number; executable: number; failed: number };
}

export type SkuReplacementTaskItemStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW" | "NOT_EXECUTED";

export interface SkuReplacementBatchTaskItem {
  orderReference: string;
  itemId: string;
  originalSku: string;
  replacementSku: string;
  planHash: string;
  status: SkuReplacementTaskItemStatus;
  startedAt: string | null;
  finishedAt: string | null;
  code: string | null;
  message: string | null;
  result: SkuReplacementExecutionPlan | null;
}

export interface SkuReplacementBatchTask {
  taskId: string;
  batchHash: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_FAILURES";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentItem: number | null;
  items: SkuReplacementBatchTaskItem[];
  prevalidationFailures: Array<SkuReplacementSelection & { code: string; message: string }>;
  summary: { total: number; processed: number; completed: number; failed: number; manualReview: number; notExecuted: number; prevalidationFailed: number };
}

export function previewSkuReplacementBatch(orderReferences: string[]) {
  return apiJson<SkuReplacementBatch>("/api/fulfillment-dashboard/sku-replacements/batch-preview", {
    method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ orderReferences }),
  });
}

export function recoverSkuReplacementBatch(orderReferences: string[]) {
  return apiJson<SkuReplacementBatch>("/api/fulfillment-dashboard/sku-replacements/batch-recover", {
    method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ orderReferences }),
  });
}

export function createSkuReplacementBatchPlan(selections: SkuReplacementSelection[]) {
  return apiJson<SkuReplacementBatchPlan>("/api/fulfillment-dashboard/sku-replacements/batch-plan", {
    method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ selections }),
  });
}

export function executeSkuReplacementBatch(batchHash: string,approvalText: string) {
  return apiJson<SkuReplacementBatchTask>("/api/fulfillment-dashboard/sku-replacements/batch-execute", {
    method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ batchHash,approvalText }),
  });
}

export function getSkuReplacementBatchTask(taskId: string) {
  return apiJson<SkuReplacementBatchTask>(`/api/fulfillment-dashboard/sku-replacements/batch-executions/${encodeURIComponent(taskId)}`);
}
