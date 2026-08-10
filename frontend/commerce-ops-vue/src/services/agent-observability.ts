import { apiJson } from "./api";

export type AgentRunStatus = "running" | "succeeded" | "failed";

export interface AgentRun {
  runId: string;
  requestId: string;
  agent: { name: string | null; version: string | null };
  contextVersions: string[];
  resolvedContextVersions: string[];
  status: AgentRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  toolCalls: { total: number; failed: number; byTool: string[] };
  tokens: {
    input: number | null;
    output: number | null;
    total: number | null;
    cacheHit: number | null;
    cacheMiss: number | null;
  };
  result: { status: string | null; digest: string | null; bytes: number | null; keys: string[] };
  errorCode: string | null;
}

export interface AgentToolInvocation {
  id: string;
  runId: string | null;
  requestId: string;
  occurredAt: string;
  agent: { name: string | null; version: string | null };
  tool: { name: string | null; version: string | null };
  access: string | null;
  permission: string | null;
  status: "succeeded" | "failed";
  durationMs: number | null;
  input: { digest: string | null; bytes: number | null; keys: string[] };
  output: { digest: string | null; bytes: number | null; keys: string[] };
  tokens: AgentRun["tokens"];
  resultStatus: string | null;
  errorCode: string | null;
}

export interface AgentEvaluation {
  id: string;
  runId: string;
  occurredAt: string;
  metric: string | null;
  evaluator: { type: string | null; name: string | null; version: string | null };
  score: number | null;
  verdict: string | null;
  evidenceDigest: string | null;
  reasonCode: string | null;
}

export interface AgentRunDetail extends AgentRun {
  toolInvocations: AgentToolInvocation[];
  evaluations: AgentEvaluation[];
}

export interface AgentObservabilitySummary {
  totalRuns: number;
  runningRuns: number;
  succeededRuns: number;
  failedRuns: number;
  successRate: number | null;
  averageDurationMs: number | null;
  toolCalls: number;
  totalTokens: number;
}

export interface AgentObservabilityStatus {
  ready: boolean;
  storage: string;
  schemaMigrationRequired: boolean;
  activeRuns: number;
  evaluationModel?: { id?: string; version?: string; contractVersion?: string; [key: string]: unknown };
}

export interface AgentRunFilters {
  agent?: string;
  version?: string;
  requestId?: string;
  status?: AgentRunStatus | "";
  start?: string;
  end?: string;
  page?: number;
  pageSize?: number;
}

export interface AgentRunPage {
  items: AgentRun[];
  total: number;
  page: number;
  pageSize: number;
}

function queryString(filters: AgentRunFilters = {}) {
  const query = new URLSearchParams();
  if (filters.agent) query.set("agent", filters.agent);
  if (filters.version) query.set("version", filters.version);
  if (filters.requestId) query.set("requestId", filters.requestId);
  if (filters.status) query.set("status", filters.status);
  if (filters.start) query.set("start", filters.start);
  if (filters.end) query.set("end", filters.end);
  if (filters.page) query.set("page", String(filters.page));
  if (filters.pageSize) query.set("pageSize", String(filters.pageSize));
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}

export function loadAgentObservabilityStatus(signal?: AbortSignal) {
  return apiJson<AgentObservabilityStatus>("/api/ai/observability/status", { signal });
}

export async function loadAgentObservabilitySummary(filters: AgentRunFilters = {}, signal?: AbortSignal) {
  const response = await apiJson<{ summary: AgentObservabilitySummary }>(
    `/api/ai/observability/summary${queryString(filters)}`,
    { signal },
  );
  return response.summary;
}

export function loadAgentRuns(filters: AgentRunFilters = {}, signal?: AbortSignal) {
  return apiJson<AgentRunPage>(`/api/ai/observability/runs${queryString(filters)}`, { signal });
}

export async function loadAgentRunDetail(runId: string, signal?: AbortSignal) {
  const response = await apiJson<{ run: AgentRunDetail }>(
    `/api/ai/observability/runs/${encodeURIComponent(runId)}`,
    { signal },
  );
  return response.run;
}
