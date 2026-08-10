import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const FILE_DEFINITIONS = Object.freeze([
  ["product-masterdata-candidates.jsonl", "masterdata", "PRODUCT_CORE"],
  ["product-knowledge-claim-candidates.jsonl", "claims", "PRODUCT_KNOWLEDGE"],
  ["product-accessory-relation-candidates.jsonl", "accessories", "PRODUCT_KNOWLEDGE"],
  ["support-policy-candidates.jsonl", "policies", "CUSTOMER_SERVICE_POLICY"],
  ["support-playbook-candidates.jsonl", "playbooks", "CUSTOMER_SERVICE_PLAYBOOK"],
  ["product-media-candidates.jsonl", "media", "PRODUCT_MEDIA"],
  ["external-source-references.jsonl", "external", "CUSTOMER_SERVICE_OPERATIONS"],
  ["product-fact-conflict-candidates.jsonl", "conflicts", "GOVERNANCE"],
  ["country-difference-candidates.jsonl", "differences", "GOVERNANCE"],
]);

const ALLOWED_TARGETS = new Set([
  "PRODUCT_CORE", "PRODUCT_KNOWLEDGE", "PRODUCT_MEDIA", "CUSTOMER_SERVICE_POLICY",
  "CUSTOMER_SERVICE_PLAYBOOK", "CUSTOMER_SERVICE_OPERATIONS", "GOVERNANCE",
]);
const ALLOWED_STATUSES = new Set([
  "DRAFT", "REVIEW_REQUIRED", "MAPPING_REQUIRED", "SOURCE_READ_REQUIRED", "CONFLICT", "REJECTED",
]);
const ALLOWED_RISK_LEVELS = new Set(["NORMAL", "SENSITIVE", "HIGH"]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function stableKnowledgeJson(value) {
  return JSON.stringify(stableValue(value));
}

function digestText(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

async function digestFile(filePath) {
  const hash = createHash("sha256");
  let lineCount = 0;
  const input = fs.createReadStream(filePath);
  input.on("data", (chunk) => hash.update(chunk));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) lineCount += 1;
  return { sha256: hash.digest("hex"), lineCount };
}

function packageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function planSharedKnowledgePackage(packageDir) {
  const root = path.resolve(String(packageDir || ""));
  const manifestPath = path.join(root, "manifest.json");
  const qualityPath = path.join(root, "quality-summary.json");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(qualityPath)) {
    throw packageError("PK_PACKAGE_INVALID", "Shared-knowledge package requires manifest.json and quality-summary.json");
  }
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  const quality = JSON.parse(await fs.promises.readFile(qualityPath, "utf8"));
  if (String(manifest.schema_version || "") !== "1.0.0" || String(quality.schema_version || "") !== "1.0.0") {
    throw packageError("PK_CONTRACT_VERSION_UNSUPPORTED", "Only shared-knowledge package contract 1.0.0 is supported");
  }
  const files = [];
  for (const [name, countKey, defaultTarget] of FILE_DEFINITIONS) {
    const filePath = path.join(root, "data", name);
    if (!fs.existsSync(filePath)) throw packageError("PK_PACKAGE_FILE_MISSING", `Package file is missing: ${name}`);
    const measured = await digestFile(filePath);
    const declared = Number(quality.counts?.[countKey] || 0);
    if (measured.lineCount !== declared) {
      throw packageError(
        "PK_PACKAGE_COUNT_MISMATCH",
        `${name} declares ${declared} records but contains ${measured.lineCount}`,
      );
    }
    files.push({ name, countKey, defaultTarget, path: filePath, ...measured });
  }
  const digestInput = {
    schemaVersion: manifest.schema_version,
    sources: manifest.sources,
    files: files.map(({ name, sha256, lineCount }) => ({ name, sha256, lineCount })),
  };
  return Object.freeze({
    root,
    packageName: path.basename(root),
    contractVersion: "1.0.0",
    packageDigest: digestText(stableKnowledgeJson(digestInput)),
    manifest,
    quality,
    files,
    totalCandidates: files.reduce((sum, item) => sum + item.lineCount, 0),
  });
}

function targetFor(raw, fallback) {
  const requested = String(raw?.content?.target_domain || fallback || "GOVERNANCE").trim().toUpperCase();
  return ALLOWED_TARGETS.has(requested) ? requested : fallback;
}

function importedStatus(raw) {
  if (String(raw?.asset_type || "").includes("CONFLICT")) return "CONFLICT";
  const status = String(raw?.governance?.status || "REVIEW_REQUIRED").trim().toUpperCase();
  // An offline package is never trusted to self-approve runtime knowledge.
  if (status === "APPROVED") return "REVIEW_REQUIRED";
  return ALLOWED_STATUSES.has(status) ? status : "REVIEW_REQUIRED";
}

function boundedText(value, max = 500) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
}

export function normalizeKnowledgeRiskLevel(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!normalized) return "NORMAL";
  if (ALLOWED_RISK_LEVELS.has(normalized)) return normalized;
  // Unknown or stronger source classifications must never become NORMAL.
  // The current package uses RESTRICTED for review-inducement policies; HIGH
  // keeps those records behind the compliance acknowledgement gate.
  return "HIGH";
}

export function normalizeKnowledgeCandidate(raw, { batchId, packageDigest, defaultTarget, now }) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw packageError("PK_CANDIDATE_INVALID", "Candidate must be a JSON object");
  }
  const assetId = boundedText(raw.asset_id, 300);
  const assetType = boundedText(raw.asset_type, 120);
  if (!assetId || !assetType) throw packageError("PK_CANDIDATE_IDENTITY_REQUIRED", "Candidate asset_id and asset_type are required");
  const subject = raw.subject && typeof raw.subject === "object" ? raw.subject : {};
  const content = raw.content && typeof raw.content === "object" ? raw.content : {};
  const scope = raw.scope && typeof raw.scope === "object" ? raw.scope : {};
  const governance = raw.governance && typeof raw.governance === "object" ? raw.governance : {};
  const evidence = raw.evidence && typeof raw.evidence === "object" ? raw.evidence : {};
  const modelIds = Array.isArray(subject.model_ids) ? [...new Set(subject.model_ids.map(String).filter(Boolean))] : [];
  const skuIds = Array.isArray(subject.product_sku_ids) ? [...new Set(subject.product_sku_ids.map(String).filter(Boolean))] : [];
  const countries = Array.isArray(scope.country_codes)
    ? [...new Set(scope.country_codes.map((item) => String(item).trim().toUpperCase()).filter(Boolean))]
    : [];
  const consumers = Array.isArray(scope.consumer_scopes)
    ? [...new Set(scope.consumer_scopes.map((item) => String(item).trim().toUpperCase()).filter(Boolean))]
    : [];
  const normalized = {
    id: `pkc_${digestText(`${packageDigest}\n${assetId}`).slice(0, 40)}`,
    importBatchId: batchId,
    assetId,
    assetType,
    targetDomain: targetFor(raw, defaultTarget),
    candidateStatus: importedStatus(raw),
    mappingStatus: boundedText(subject.mapping_status, 80),
    riskLevel: normalizeKnowledgeRiskLevel(governance.risk_level),
    conflictStatus: boundedText(governance.conflict_status || "UNCHECKED", 80),
    canonicalCategoryName: boundedText(subject.canonical_category, 300),
    productModelId: modelIds.length === 1 ? modelIds[0] : null,
    productSkuId: skuIds.length === 1 ? skuIds[0] : null,
    sourceSku: boundedText(subject.source_sku, 300),
    languageCode: boundedText(scope.language || "zh-CN", 30),
    scopeType: new Set(["COMMON", "COUNTRY_OVERRIDE", "UNVERIFIED"]).has(String(scope.scope_type || "").toUpperCase())
      ? String(scope.scope_type).toUpperCase() : "UNVERIFIED",
    countries,
    consumers,
    subject,
    content,
    scope,
    governance,
    evidence: { primary: evidence, occurrences: Array.isArray(raw.evidence_occurrences) ? raw.evidence_occurrences : [] },
    sourceId: boundedText(evidence.source_id, 300),
    sourceSha256: boundedText(evidence.source_sha256, 80),
    sourceSheet: boundedText(evidence.sheet, 500),
    sourceLocation: boundedText(evidence.cell_range, 500),
    createdAt: now,
  };
  normalized.contentDigest = digestText(stableKnowledgeJson({
    assetType: normalized.assetType,
    subject, content, scope, governance, evidence: normalized.evidence,
  }));
  return normalized;
}

export async function* readSharedKnowledgeCandidates(plan, { now = new Date().toISOString() } = {}) {
  const batchId = `pkib_${plan.packageDigest.slice(0, 40)}`;
  for (const file of plan.files) {
    const lines = readline.createInterface({ input: fs.createReadStream(file.path), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      let raw;
      try { raw = JSON.parse(line); } catch {
        throw packageError("PK_CANDIDATE_JSON_INVALID", `${file.name}:${lineNumber} is not valid JSON`);
      }
      yield normalizeKnowledgeCandidate(raw, {
        batchId,
        packageDigest: plan.packageDigest,
        defaultTarget: file.defaultTarget,
        now,
      });
    }
  }
}

export const SHARED_KNOWLEDGE_FILE_DEFINITIONS = FILE_DEFINITIONS;
