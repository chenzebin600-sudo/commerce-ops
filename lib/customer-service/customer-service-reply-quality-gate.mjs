const RISK_RANK = Object.freeze({ LOW: 0, MEDIUM: 1, HIGH: 2 });

const FINANCIAL_SENSITIVE = /\b(?:refund|compensat(?:e|ion)|reimburse(?:ment)?|money\s*back)\b|退款|赔偿|补偿|退钱|คืนเงิน|ชดเชย|hoàn\s*tiền|bồi\s*thường|pengembalian\s*dana|kompensasi|ganti\s*rugi/i;
const DELIVERY_COMMITMENT = /\b(?:will|guarantee(?:d)?|definitely|surely|estimated|expect(?:ed)?)\b[^.!?\n]{0,80}\b(?:arrive|deliver(?:ed|y)?|reach)\b|\b(?:arrive|deliver(?:ed|y)?|reach)\b[^.!?\n]{0,80}\b(?:today|tomorrow|within|by\s+[a-z]|\d+\s*(?:hours?|days?|weeks?))\b|(?:保证|一定|预计|会在|将在).{0,30}(?:到货|送达|收到)|(?:今天|明天|\d+\s*(?:天|小时)).{0,24}(?:到货|送达|收到)/i;
const LOGISTICS_STATUS_ASSERTION = /\b(?:has\s+shipped|already\s+shipped|is\s+in\s+transit|was\s+delivered|out\s+for\s+delivery)\b|已发货|已经发货|运输中|派送中|已签收|กำลังจัดส่ง|จัดส่งแล้ว|đang\s*giao|đã\s*gửi|sedang\s*dikirim|sudah\s*dikirim/i;
const ORDER_STATUS_ASSERTION = /\b(?:order\s+is|payment\s+is)\s+(?:paid|cancelled|canceled|confirmed|completed)\b|订单(?:已经|已)?(?:取消|确认|完成)|付款(?:已经|已)?(?:成功|完成)/i;
const STOCK_ASSERTION = /\b(?:in\s+stock|available\s+now|ready\s+stock|we\s+have\s+stock)\b|有货|库存充足|现货|พร้อมส่ง|มีสินค้า|còn\s+hàng|có\s+sẵn|tersedia|stok\s+ada/i;
const TRACKING_REFERENCE = /(?:tracking\s+(?:number|no\.?|code)|waybill\s+(?:number|no\.?|code)|运单号|物流单号|快递单号|nomor\s+resi|mã\s+vận\s+đơn|เลขพัสดุ)\s*(?:is\s*)?[:#：-]?\s*([A-Z0-9][A-Z0-9-]{5,39})/gi;

function normalizedRisk(value) {
  const risk = String(value || "MEDIUM").trim().toUpperCase();
  return Object.hasOwn(RISK_RANK, risk) ? risk : "MEDIUM";
}

function maxRisk(...values) {
  return values.map(normalizedRisk).sort((left, right) => RISK_RANK[right] - RISK_RANK[left])[0] || "MEDIUM";
}

function addText(set, value) {
  const text = String(value ?? "").trim();
  if (text) set.add(text);
}

function allowedEvidenceIds(context, evidence) {
  const ids = new Set();
  for (const item of evidence || []) {
    addText(ids, item.sourceId);
    addText(ids, item.claimId);
  }
  addText(ids, context?.trigger?.messageId);
  addText(ids, context?.product?.productModelId);
  addText(ids, context?.product?.productSkuId);
  addText(ids, context?.product?.categoryId);
  addText(ids, context?.productPackage?.id);
  addText(ids, context?.productPackage?.version);
  addText(ids, context?.order?.data?.id);
  addText(ids, context?.order?.data?.orderRef);
  addText(ids, context?.logistics?.orderRef);
  addText(ids, context?.logistics?.providerRequestId);
  addText(ids, context?.inventory?.sourceSnapshot?.batchId);
  addText(ids, context?.inventory?.sourceSnapshot?.sourceSha256);
  for (const bucket of ["claims", "accessories", "policies", "playbooks"]) {
    for (const item of context?.knowledge?.[bucket] || []) addText(ids, item.id);
  }
  return ids;
}

function trackingCodes(context) {
  return new Set((context?.logistics?.records || [])
    .map((item) => String(item?.trackingCode || "").trim().toUpperCase())
    .filter(Boolean));
}

function referencedTrackingCodes(draft) {
  const codes = [];
  for (const match of String(draft || "").matchAll(TRACKING_REFERENCE)) {
    codes.push(String(match[1] || "").trim().toUpperCase());
  }
  return [...new Set(codes.filter(Boolean))];
}

export function evaluateCustomerServiceReply({
  output,
  context,
  evidence = [],
  minimumAutoFillConfidence = 0.72,
  enforceMinimumConfidence = true,
} = {}) {
  const draft = String(output?.draftReply || "").trim();
  const confidence = Number(output?.confidence);
  const parsedThreshold = Number(minimumAutoFillConfidence);
  const threshold = Math.max(0, Math.min(1, Number.isFinite(parsedThreshold) ? parsedThreshold : 0.72));
  const allowedIds = allowedEvidenceIds(context, evidence);
  const usedEvidenceIds = [...new Set((output?.usedEvidenceIds || []).map((item) => String(item || "").trim()).filter(Boolean))];
  const invalidEvidenceIds = usedEvidenceIds.filter((item) => !allowedIds.has(item));
  const blockers = [];
  const flags = [];
  let deterministicRisk = "LOW";

  const block = (code, risk = "MEDIUM") => {
    if (!blockers.includes(code)) blockers.push(code);
    if (!flags.includes(code)) flags.push(code);
    deterministicRisk = maxRisk(deterministicRisk, risk);
  };

  if (enforceMinimumConfidence && (!Number.isFinite(confidence) || confidence < threshold)) {
    block("LOW_CONFIDENCE_AUTO_FILL_BLOCKED", "MEDIUM");
  }
  if (invalidEvidenceIds.length) block("UNRECOGNIZED_EVIDENCE_REFERENCE", "MEDIUM");
  if (FINANCIAL_SENSITIVE.test(draft)) block("HIGH_RISK_FINANCIAL_OR_COMPENSATION", "HIGH");
  if (DELIVERY_COMMITMENT.test(draft)) block("HIGH_RISK_UNSUPPORTED_DELIVERY_COMMITMENT", "HIGH");

  const knownTracking = trackingCodes(context);
  const draftTracking = referencedTrackingCodes(draft);
  if (draftTracking.some((code) => !knownTracking.has(code))) {
    block("HIGH_RISK_UNKNOWN_TRACKING_IDENTIFIER", "HIGH");
  }
  if (LOGISTICS_STATUS_ASSERTION.test(draft)
    && !(context?.logistics?.authoritative === true && context?.logistics?.resolutionStatus === "RESOLVED")) {
    block("HIGH_RISK_UNSUPPORTED_LOGISTICS_STATUS", "HIGH");
  }
  if (ORDER_STATUS_ASSERTION.test(draft) && context?.order?.resolutionStatus !== "RESOLVED") {
    block("UNSUPPORTED_ORDER_STATUS", "MEDIUM");
  }
  if (STOCK_ASSERTION.test(draft) && context?.inventory?.resolutionStatus !== "RESOLVED") {
    block("UNSUPPORTED_STOCK_STATUS", "MEDIUM");
  }

  const modelRisk = normalizedRisk(output?.riskLevel);
  const effectiveRiskLevel = maxRisk(modelRisk, deterministicRisk);
  if (modelRisk === "HIGH" && !blockers.includes("MODEL_HIGH_RISK")) blockers.push("MODEL_HIGH_RISK");
  if (effectiveRiskLevel === "HIGH" && !flags.includes("HIGH_RISK_NOT_AUTO_FILLED")) {
    flags.push("HIGH_RISK_NOT_AUTO_FILLED");
  }
  const safeToAutoFill = blockers.length === 0 && effectiveRiskLevel !== "HIGH";
  const qualityScore = Math.max(0, Math.round(
    (Number.isFinite(confidence) ? confidence * 100 : 0) - blockers.length * 15,
  ));
  return {
    safeToAutoFill,
    effectiveRiskLevel,
    deterministicRiskLevel: deterministicRisk,
    minimumAutoFillConfidence: threshold,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    qualityScore,
    qualityFlags: flags,
    autoFillBlockers: blockers,
    invalidEvidenceIds,
  };
}
