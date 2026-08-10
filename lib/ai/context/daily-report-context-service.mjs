import { createHash } from "node:crypto";
import { buildAiContextEnvelope } from "./ai-context-contracts.mjs";
import {
  assertDailyReportEvidencePack,
  buildDailyReportEvidencePack,
  DAILY_REPORT_EVIDENCE_PACK_VERSION,
  dailyReportEvidencePackBytes,
} from "../../sales-assortment/daily-report-evidence-pack.mjs";

export const DAILY_REPORT_CONTEXT_VERSION = "SALES-ASSORTMENT-DAILY-CONTEXT-2.1.0";
export const DAILY_REPORT_CONTEXT_INPUT_MAX_BYTES = 256 * 1024;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function qualityLimitations(facts) {
  const limitations = [];
  if (Array.isArray(facts?.quality?.limitations)) {
    limitations.push(...facts.quality.limitations.map(String));
  }
  if (!facts?.sources?.order) limitations.push("ORDER_SOURCE_UNAVAILABLE");
  if (!facts?.sources?.inventory) limitations.push("INVENTORY_SOURCE_UNAVAILABLE");
  if (!facts?.sources?.productPackage) limitations.push("PRODUCT_PACKAGE_SOURCE_UNAVAILABLE");
  return [...new Set(limitations)];
}

function normalizedGeneratedAt(value) {
  const result = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw Object.assign(new TypeError("Daily report generated time is invalid"), {
      code: "DAILY_REPORT_CONTEXT_TIME_INVALID",
    });
  }
  return result;
}

function contextInputBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class DailyReportContextService {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
  }

  prepareInput({ dashboard, generatedAt = this.now() } = {}) {
    if (!dashboard || typeof dashboard !== "object") {
      throw new TypeError("Daily report dashboard facts are required");
    }
    const timestamp = normalizedGeneratedAt(generatedAt);
    const evidencePack = buildDailyReportEvidencePack(dashboard);
    const input = Object.freeze({
      evidence_pack: evidencePack,
      generated_at: timestamp.toISOString(),
    });
    if (contextInputBytes(input) > DAILY_REPORT_CONTEXT_INPUT_MAX_BYTES) {
      throw Object.assign(new Error(
        `Daily report Context input exceeds ${DAILY_REPORT_CONTEXT_INPUT_MAX_BYTES} bytes`,
      ), { code: "DAILY_REPORT_CONTEXT_INPUT_TOO_LARGE" });
    }
    return input;
  }

  create({ evidencePack, generatedAt = this.now() } = {}) {
    const facts = assertDailyReportEvidencePack(evidencePack);
    if (!facts.reportDate) {
      throw Object.assign(new Error("Daily report date is unavailable"), {
        code: "DAILY_REPORT_CONTEXT_DATE_MISSING",
      });
    }
    const factsDigest = digest(facts);
    const timestamp = normalizedGeneratedAt(generatedAt);
    return buildAiContextEnvelope({
      type: "daily_report",
      id: `daily-report:${facts.reportDate}:${factsDigest.slice(0, 16)}`,
      generatedAt: timestamp,
      freshness: facts.sources,
      quality: {
        status: facts?.quality?.status || "available",
        evidenceSource: "structured_facts",
        limitations: qualityLimitations(facts),
      },
      data: {
        contract: DAILY_REPORT_CONTEXT_VERSION,
        evidencePackContract: DAILY_REPORT_EVIDENCE_PACK_VERSION,
        evidencePackBytes: dailyReportEvidencePackBytes(facts),
        factsDigest,
        deterministicMetricsOnly: true,
        facts,
      },
    });
  }
}
