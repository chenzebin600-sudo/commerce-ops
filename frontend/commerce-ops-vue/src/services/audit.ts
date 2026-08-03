import { apiJson } from "@/services/api";

export interface AuditEvent {
  id: string;
  occurredAt: string;
  module: string;
  action: string;
  actionLabel?: string;
  status: "success" | "failed";
  durationMs?: number;
  source?: string;
  taskId?: string;
  runId?: string;
  fileId?: string;
  errorSummary?: string;
  errorCode?: string;
  requestId?: string;
  httpMethod?: string;
  requestPath?: string;
  actorIdentifier?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditSummary {
  total: number;
  byStatus: { success?: number; failed?: number };
  byModule: Array<{ module: string; count: number }>;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  start?: string;
  end?: string;
  module?: string;
  status?: string;
  action?: string;
}

export function loadAuditEvents(query: AuditQuery) {
  const params = new URLSearchParams({ page: String(query.page), pageSize: String(query.pageSize) });
  for (const [key, value] of Object.entries(query)) {
    if (!new Set(["page", "pageSize"]).has(key) && value) params.set(key, String(value));
  }
  return apiJson<{ events: AuditEvent[]; total: number; page: number; pageSize: number; totalPages: number }>(`/api/audit/events?${params}`);
}

export async function loadAuditSummary() {
  const response = await apiJson<{ summary: AuditSummary }>("/api/audit/summary");
  return response.summary;
}

export async function loadAuditDetail(id: string) {
  const response = await apiJson<{ event: AuditEvent }>(`/api/audit/events/${encodeURIComponent(id)}`);
  return response.event;
}
