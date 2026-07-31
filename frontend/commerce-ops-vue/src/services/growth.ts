import { apiJson } from "@/services/api";

export interface GrowthWorkspace {
  mode: "published" | "readiness";
  publishable: boolean;
  generatedFromPublishedRun: boolean;
  taskPersistenceReady: boolean;
  readiness: {
    inventoryRowCount: number;
    inventorySkuCount: number;
    warehouseCount: number;
    mappedWarehouseCount: number;
    unmappedWarehouseCount: number;
    sourceShopCount: number;
    mappedShopCount: number;
    unmappedShopCount: number;
    historyDays: number;
    requiredHistoryDays: number;
    operationTasksPublishable: boolean;
    blockers: string[];
  };
  summary: Record<string, number>;
  run?: Record<string, unknown> | null;
  operationTasks?: Array<Record<string, unknown>>;
  stores?: Array<Record<string, unknown>>;
  products?: Array<Record<string, unknown>>;
  opportunityMap?: Array<Record<string, unknown>>;
}

export interface GrowthTaskList {
  items: Array<Record<string, unknown>>;
  total: number;
  page: number;
  pageSize: number;
  totalPages?: number;
}

export function loadGrowthWorkspace() {
  return apiJson<GrowthWorkspace>("/api/growth-radar/v2/assistant/workspace?max_tasks=50");
}

export function loadGrowthTasks() {
  return apiJson<GrowthTaskList>("/api/growth-radar/v2/tasks?page_size=200&active_only=true");
}

export function runGrowthAnalysis() {
  return apiJson<Record<string, unknown>>("/api/growth-radar/v2/analysis-runs", { method: "POST" });
}
