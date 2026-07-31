import { apiJson } from "@/services/api";

export interface CompetitorProduct {
  role?: string;
  rank?: number;
  platform?: string;
  title?: string;
  shopName?: string;
  rating?: number | string;
  reviewCount?: number | string;
  soldCount?: number | string;
  discoverySoldText?: string;
  finalUrl?: string;
  inputUrl?: string;
  mainImage?: string;
  needsVerification?: boolean;
}

export interface CompetitorReport {
  products?: CompetitorProduct[];
  skuComparison?: Array<Record<string, unknown>>;
  productDetailsComparison?: Array<Record<string, unknown>>;
  needsVerification?: boolean;
  blockedProducts?: Array<Record<string, unknown>>;
  discovery?: Record<string, unknown>;
  analysis?: { raw?: string; modules?: Record<string, unknown> };
  mainImageAnalysis?: Record<string, unknown>;
}

export function analyzeLinks(input: { myUrl: string; competitorUrls: string[]; model: string; analyze?: boolean }) {
  return apiJson<CompetitorReport>(input.analyze === false ? "/api/extract" : "/api/extract-and-analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ myUrl: input.myUrl, competitorUrls: input.competitorUrls, model: input.model }),
  });
}

export function analyzeKeyword(input: { keyword: string; productDescription: string; country: string; site: string; model: string }) {
  return apiJson<CompetitorReport>("/api/discover-top5-and-analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, productImage: null }),
  });
}
