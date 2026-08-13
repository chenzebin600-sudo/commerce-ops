function epochSeconds(value) {
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) && millis % 1000 === 0 ? String(millis / 1000) : null;
}

export function exactRenewalProof(intent, activity, proof, { requireIntentBinding = true } = {}) {
  const metadata = activity?.metadata || {};
  return Boolean(proof
    && String(proof.shopId || "") === String(activity?.shopId || "")
    && proof.discountName === metadata.discountName
    && proof.marker === metadata.marker
    && proof.fingerprint === metadata.fingerprint
    && proof.startTime === epochSeconds(activity?.startsAt)
    && proof.endTime === epochSeconds(activity?.endsAt)
    && (!requireIntentBinding || (proof.operationUuid === intent?.operationUuid && proof.payloadHash === intent?.payloadHash)));
}
