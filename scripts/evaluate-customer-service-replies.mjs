import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCustomerServiceReply } from "../lib/customer-service/customer-service-reply-quality-gate.mjs";

const CONTRACT_VERSION = "CS_REPLY_EVALUATION_V1";
const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function textArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function parseJsonl(content) {
  return String(content || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch {
      throw new Error(`Invalid JSONL at line ${index + 1}`);
    }
  });
}

function assertion(name, passed, detail = null) {
  return { name, passed: Boolean(passed), detail };
}

export function evaluateCustomerServiceReplyDataset(cases, { minimumAutoFillConfidence = 0.72 } = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("Customer-service evaluation dataset is empty");
  const seenCaseIds = new Set();
  const results = cases.map((item, index) => {
    if (item?.contractVersion !== CONTRACT_VERSION) throw new Error(`Case ${index + 1} has an unsupported contractVersion`);
    const caseId = String(item.caseId || "").trim();
    if (!caseId) throw new Error(`Case ${index + 1} is missing caseId`);
    if (seenCaseIds.has(caseId)) throw new Error(`Duplicate caseId: ${caseId}`);
    seenCaseIds.add(caseId);
    if (!String(item.candidate?.draftReply || "").trim()) throw new Error(`Case ${caseId} is missing candidate.draftReply`);
    const gate = evaluateCustomerServiceReply({
      output: item.candidate,
      context: item.context || {},
      evidence: item.evidence || [],
      minimumAutoFillConfidence,
    });
    const expected = item.expected || {};
    const draft = String(item.candidate?.draftReply || "").toLocaleLowerCase();
    const requiredFlags = textArray(expected.requiredQualityFlags);
    const forbiddenFlags = textArray(expected.forbiddenQualityFlags);
    const mustIncludeAny = textArray(expected.mustIncludeAny).map((value) => value.toLocaleLowerCase());
    const mustNotInclude = textArray(expected.mustNotInclude).map((value) => value.toLocaleLowerCase());
    const assertions = [];
    if (typeof expected.safeToAutoFill === "boolean") {
      assertions.push(assertion("safeToAutoFill", gate.safeToAutoFill === expected.safeToAutoFill, {
        expected: expected.safeToAutoFill,
        actual: gate.safeToAutoFill,
      }));
    }
    if (expected.riskLevel) {
      assertions.push(assertion("riskLevel", gate.effectiveRiskLevel === expected.riskLevel, {
        expected: expected.riskLevel,
        actual: gate.effectiveRiskLevel,
      }));
    }
    for (const flag of requiredFlags) {
      assertions.push(assertion(`requiredFlag:${flag}`, gate.qualityFlags.includes(flag)));
    }
    for (const flag of forbiddenFlags) {
      assertions.push(assertion(`forbiddenFlag:${flag}`, !gate.qualityFlags.includes(flag)));
    }
    if (mustIncludeAny.length) {
      assertions.push(assertion("mustIncludeAny", mustIncludeAny.some((value) => draft.includes(value))));
    }
    for (const phrase of mustNotInclude) {
      assertions.push(assertion(`mustNotInclude:${phrase}`, !draft.includes(phrase)));
    }
    if (!assertions.length) throw new Error(`Case ${caseId} does not define any expected assertions`);
    const failures = assertions.filter((item) => !item.passed);
    return {
      caseId,
      passed: failures.length === 0,
      assertionTotal: assertions.length,
      failureTotal: failures.length,
      failures,
      observed: {
        safeToAutoFill: gate.safeToAutoFill,
        riskLevel: gate.effectiveRiskLevel,
        confidence: gate.confidence,
        qualityFlags: gate.qualityFlags,
      },
    };
  });
  const assertionTotal = results.reduce((total, item) => total + item.assertionTotal, 0);
  const failedAssertions = results.reduce((total, item) => total + item.failureTotal, 0);
  return {
    contractVersion: CONTRACT_VERSION,
    evaluator: "DETERMINISTIC_REPLAY_NO_MODEL_CALL",
    minimumAutoFillConfidence,
    caseTotal: results.length,
    passedCases: results.filter((item) => item.passed).length,
    failedCases: results.filter((item) => !item.passed).length,
    assertionTotal,
    failedAssertions,
    passed: failedAssertions === 0,
    results,
  };
}

function argumentValue(name, fallback = null) {
  const exact = process.argv.find((item) => item.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function main() {
  const datasetArg = argumentValue("--dataset", "contracts/customer-service/cs-reply-evaluation-v1.example.jsonl");
  const datasetPath = path.resolve(rootDir, datasetArg);
  const threshold = Number(argumentValue("--minimum-confidence", "0.72"));
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("--minimum-confidence must be between 0 and 1");
  }
  const cases = parseJsonl(fs.readFileSync(datasetPath, "utf8"));
  const report = evaluateCustomerServiceReplyDataset(cases, { minimumAutoFillConfidence: threshold });
  process.stdout.write(`${JSON.stringify({ dataset: path.relative(rootDir, datasetPath), ...report }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
