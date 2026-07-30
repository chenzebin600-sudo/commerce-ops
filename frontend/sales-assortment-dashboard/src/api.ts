import type { AuthorizedFetch, DashboardData } from "./types";

let fetchImpl: AuthorizedFetch = fetch;

export function configureApi(authorizedFetch: AuthorizedFetch) {
  fetchImpl = authorizedFetch;
}

async function responseJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `请求失败 (${response.status})`);
  }
  return payload;
}

export async function loadDashboard(filters: {
  periodDays: number;
  country?: string;
  categoryL1?: string;
  categoryL2?: string;
  style?: string;
}) {
  const query = new URLSearchParams({ period_days: String(filters.periodDays) });
  if (filters.country) query.set("country", filters.country);
  if (filters.categoryL1) query.set("category_l1", filters.categoryL1);
  if (filters.categoryL2) query.set("category_l2", filters.categoryL2);
  if (filters.style) query.set("style", filters.style);
  const payload = await responseJson(await fetchImpl(`/api/sales-assortment/dashboard?${query}`));
  return payload.dashboard as DashboardData;
}

export interface ImportPreview {
  kind: "orders" | "inventory" | "product-package";
  previewId?: string;
  batchId?: string;
  rowCount: number;
  blockers: number;
  warnings: number;
  filename: string;
  summary?: Record<string, unknown>;
}

export async function previewImport(kind: ImportPreview["kind"], file: File): Promise<ImportPreview> {
  const headers = {
    "content-type": file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "x-file-name": encodeURIComponent(file.name)
  };
  if (kind === "product-package") {
    const payload = await responseJson(await fetchImpl("/api/product-center/imports", {
      method: "POST",
      headers,
      body: file
    }));
    const batch = payload.detail?.batch || {};
    return {
      kind,
      batchId: batch.id,
      rowCount: Number(batch.rowCount || 0),
      blockers: Number(batch.blockerCount || 0),
      warnings: Number(batch.reminderCount || 0) + Number(batch.exceptionCount || 0),
      filename: file.name,
      summary: batch
    };
  }
  const payload = await responseJson(await fetchImpl(`/api/growth-radar/import/${kind}/preview`, {
    method: "POST",
    headers,
    body: file
  }));
  const preview = payload.preview;
  return {
    kind,
    previewId: preview.previewId,
    rowCount: Number(preview.rowCount || 0),
    blockers: (preview.issues || []).filter((item: { blocking?: boolean }) => item.blocking).length,
    warnings: (preview.issues || []).filter((item: { blocking?: boolean }) => !item.blocking).length,
    filename: file.name,
    summary: preview.summary
  };
}

export async function applyImport(preview: ImportPreview) {
  if (preview.kind === "product-package") {
    return responseJson(await fetchImpl(`/api/product-center/imports/${preview.batchId}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        acknowledgeWarnings: true,
        acknowledgeUnknownFields: true
      })
    }));
  }
  return responseJson(await fetchImpl(`/api/growth-radar/import/${preview.kind}/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ previewId: preview.previewId })
  }));
}
