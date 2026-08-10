import { apiJson } from "./api";

export interface WarehouseTransferPlanItem {
  itemId: string;
  stockSku: string;
  title: string;
  quantity: number;
  currentWarehouse: string;
}

export interface WarehouseTransferPlan {
  planHash: string;
  approvalText: string;
  createdAt: string;
  expiresAt: string;
  order: {
    internalOrderId: string;
    platformOrderId: string;
    shopId: string;
    platformId: string;
    orderStatus: string;
    anomalyReasons: string[];
  };
  targetWarehouse: string;
  items: WarehouseTransferPlanItem[];
  stock: Array<{ sku: string; quantity: number; available: number }>;
  alternatives: Array<{ warehouse: string; remaining: number }>;
}

export interface WarehouseTransferBatchPlan {
  batchHash: string;
  approvalText: string;
  createdAt: string;
  expiresAt: string;
  items: Array<{ orderReference: string; plan: WarehouseTransferPlan }>;
  failures: Array<{ orderReference: string; code: string; message: string }>;
  summary: { requested: number; executable: number; failed: number };
}

export type WarehouseTransferTaskItemStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW" | "NOT_EXECUTED";

export interface WarehouseTransferBatchTask {
  taskId: string;
  batchHash: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_FAILURES";
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  currentItem: number | null;
  items: Array<{
    orderReference: string;
    targetWarehouse: string;
    status: WarehouseTransferTaskItemStatus;
    code: string | null;
    message: string | null;
  }>;
  prevalidationFailures: WarehouseTransferBatchPlan["failures"];
  summary: { total: number; processed: number; completed: number; failed: number; manualReview: number; notExecuted: number; prevalidationFailed: number };
}

export function createWarehouseTransferBatchPlan(orderReferences: string[]) {
  return apiJson<WarehouseTransferBatchPlan>("/api/fulfillment-dashboard/warehouse-transfers/batch-plan", {
    method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ orderReferences }),
  });
}

export function executeWarehouseTransferBatch(batchHash: string,approvalText: string) {
  return apiJson<WarehouseTransferBatchTask>("/api/fulfillment-dashboard/warehouse-transfers/batch-execute", {
    method:"POST",headers:{ "content-type":"application/json" },body:JSON.stringify({ batchHash,approvalText }),
  });
}

export function getWarehouseTransferBatchTask(taskId: string) {
  return apiJson<WarehouseTransferBatchTask>(`/api/fulfillment-dashboard/warehouse-transfers/batch-executions/${encodeURIComponent(taskId)}`);
}
