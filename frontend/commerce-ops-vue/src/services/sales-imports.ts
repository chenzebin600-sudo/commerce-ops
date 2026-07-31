import { apiJson, authorizedFetch } from "@/services/api";

export type SalesImportKind = "orders" | "inventory" | "product-package";

export interface SalesImportPreview {
  kind: SalesImportKind;
  previewId?: string;
  batchId?: string;
  rowCount: number;
  blockers: number;
  warnings: number;
  filename: string;
  summary?: Record<string, unknown>;
}

export interface SalesSourceDataPage {
  source: SalesImportKind;
  page: number;
  pageSize: number;
  total: number;
  rows: Array<Record<string, string | number | null>>;
}

async function rawJson(path: string, init: RequestInit) {
  const response = await authorizedFetch(path, init);
  const payload = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok || payload.ok === false) {
    throw new Error(String(payload.error || payload.message || `请求失败 (${response.status})`));
  }
  return payload;
}

export async function previewSalesImport(kind: SalesImportKind, file: File): Promise<SalesImportPreview> {
  const headers = {
    "content-type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "x-file-name": encodeURIComponent(file.name),
  };
  if (kind === "product-package") {
    const payload = await rawJson("/api/product-center/imports", { method: "POST", headers, body: file });
    const batch = payload.detail?.batch || {};
    return {
      kind,
      batchId: batch.id,
      rowCount: Number(batch.rowCount || 0),
      blockers: Number(batch.blockerCount || 0),
      warnings: Number(batch.reminderCount || 0) + Number(batch.exceptionCount || 0),
      filename: file.name,
      summary: batch,
    };
  }

  const payload = await rawJson(`/api/growth-radar/import/${kind}/preview`, {
    method: "POST",
    headers,
    body: file,
  });
  const preview = payload.preview || {};
  const issues = Array.isArray(preview.issues) ? preview.issues : [];
  return {
    kind,
    previewId: preview.previewId,
    rowCount: Number(preview.rowCount || 0),
    blockers: issues.filter((item: { blocking?: boolean }) => item.blocking).length,
    warnings: issues.filter((item: { blocking?: boolean }) => !item.blocking).length,
    filename: file.name,
    summary: preview.summary || {},
  };
}

export function applySalesImport(preview: SalesImportPreview) {
  if (preview.kind === "product-package") {
    return apiJson(`/api/product-center/imports/${encodeURIComponent(String(preview.batchId || ""))}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acknowledgeWarnings: true, acknowledgeUnknownFields: true }),
    });
  }
  return apiJson(`/api/growth-radar/import/${preview.kind}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId: preview.previewId }),
  });
}

export async function loadSalesSourceRows(kind: SalesImportKind, page = 1): Promise<SalesSourceDataPage> {
  const payload = await apiJson<{ result: SalesSourceDataPage }>(
    `/api/sales-assortment/source-rows?source=${encodeURIComponent(kind)}&page=${page}&page_size=50`,
  );
  return payload.result;
}
