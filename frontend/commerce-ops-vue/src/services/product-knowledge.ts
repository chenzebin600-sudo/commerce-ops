import { apiJson } from "@/services/api";

export type KnowledgeCandidateStatus =
  | "DRAFT" | "REVIEW_REQUIRED" | "MAPPING_REQUIRED" | "SOURCE_READ_REQUIRED"
  | "CONFLICT" | "APPROVED" | "REJECTED";

export interface ProductKnowledgeStatus {
  ready: boolean;
  phase: string;
  runtimeReadsPublishedOnly: boolean;
  offlineCandidatesTrustedForGeneration: boolean;
  governance: {
    enabled: boolean;
    reviewerAllowlistConfigured: boolean;
    publisherAllowlistConfigured: boolean;
  };
  batches: Array<{ status: string; total: number }>;
  candidates: Array<{ status: string; targetDomain: string; total: number }>;
  releases: Array<{ status: string; consumerScope: string; total: number }>;
}

export interface ProductKnowledgeCandidate {
  id: string;
  importBatchId: string;
  assetId: string;
  assetType: string;
  targetDomain: string;
  status: KnowledgeCandidateStatus;
  mappingStatus: string | null;
  riskLevel: "NORMAL" | "SENSITIVE" | "HIGH";
  conflictStatus: string;
  canonicalCategoryName: string | null;
  productModelId: string | null;
  productSkuId: string | null;
  sourceSku: string | null;
  languageCode: string | null;
  scopeType: string;
  countries: string[];
  consumerScopes: string[];
  subject: Record<string, unknown>;
  content: Record<string, unknown>;
  scope: Record<string, unknown>;
  governance: Record<string, unknown>;
  evidence: Record<string, unknown>;
  sourceId: string | null;
  sourceSha256: string | null;
  sourceSheet: string | null;
  sourceLocation: string | null;
  contentDigest: string;
  createdAt: string;
}

export interface ProductKnowledgeRelease {
  id: string;
  key: string;
  version: number;
  consumerScope: string;
  status: "DRAFT" | "PUBLISHED" | "RETIRED";
  contentDigest: string;
  notes: string | null;
  createdBy: string;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  retiredAt: string | null;
  counts: { claims: number; accessories: number; policies: number; playbooks: number };
}

function actorHeaders(actorId: string) {
  return { "content-type": "application/json", "x-user-id": actorId.trim() };
}

export async function loadKnowledgeStatus() {
  const response = await apiJson<{ status: ProductKnowledgeStatus }>("/api/product-knowledge/status");
  return response.status;
}

export async function loadKnowledgeCandidates(filters: {
  status?: string;
  targetDomain?: string;
  riskLevel?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const query = new URLSearchParams();
  if (filters.status) query.set("status", filters.status);
  if (filters.targetDomain) query.set("target_domain", filters.targetDomain);
  if (filters.riskLevel) query.set("risk_level", filters.riskLevel);
  query.set("limit", String(filters.limit || 100));
  query.set("offset", String(filters.offset || 0));
  const response = await apiJson<{ candidates: ProductKnowledgeCandidate[] }>(`/api/product-knowledge/candidates?${query}`);
  return response.candidates;
}

export async function reviewKnowledgeCandidate(
  candidateId: string,
  input: Record<string, unknown>,
  actorId: string,
) {
  return apiJson<{ candidate: ProductKnowledgeCandidate; reviewId: string }>(
    `/api/product-knowledge/candidates/${encodeURIComponent(candidateId)}/reviews`,
    { method: "POST", headers: actorHeaders(actorId), body: JSON.stringify(input) },
  );
}

export async function loadKnowledgeReleases(filters: { consumerScope?: string; status?: string } = {}) {
  const query = new URLSearchParams();
  if (filters.consumerScope) query.set("consumer_scope", filters.consumerScope);
  if (filters.status) query.set("status", filters.status);
  const response = await apiJson<{ releases: ProductKnowledgeRelease[] }>(`/api/product-knowledge/releases?${query}`);
  return response.releases;
}

export async function createKnowledgeRelease(input: Record<string, unknown>, actorId: string) {
  return apiJson<{ duplicate: boolean; release: ProductKnowledgeRelease }>("/api/product-knowledge/releases", {
    method: "POST",
    headers: actorHeaders(actorId),
    body: JSON.stringify(input),
  });
}

export async function publishKnowledgeRelease(
  releaseId: string,
  input: { expectedContentDigest: string; acknowledgeHumanReview: true },
  actorId: string,
) {
  const response = await apiJson<{ release: ProductKnowledgeRelease }>(
    `/api/product-knowledge/releases/${encodeURIComponent(releaseId)}/publish`,
    { method: "POST", headers: actorHeaders(actorId), body: JSON.stringify(input) },
  );
  return response.release;
}
