import { apiJson } from "./api";

export interface WarehouseTransferItem {
  itemId: string; stockSku: string; title: string; quantity: number; currentWarehouse: string;
}
export interface WarehouseTransferPlan {
  planHash: string; approvalText: string; createdAt: string; expiresAt: string;
  order: { internalOrderId: string; platformOrderId: string; shopId: string; platformId: string; orderStatus: string };
  targetWarehouse: string; items: WarehouseTransferItem[];
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

export function previewWarehouseTransfer(orderReference: string, targetWarehouse = "") {
  return apiJson<WarehouseTransferPlan>("/api/fulfillment-dashboard/warehouse-transfers/preview", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderReference, targetWarehouse }),
  });
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

export function executeWarehouseTransferBatch(batchHash: string, planHashes: string[], approvalText: string) {
  return apiJson<WarehouseTransferBatch>("/api/fulfillment-dashboard/warehouse-transfers/batch-execute", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ batchHash, planHashes, approvalText }),
  });
}
