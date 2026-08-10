import { randomUUID } from "node:crypto";
import { normalizeFulfillmentActor } from "../../lib/security/fulfillment-actor-assertion.mjs";

function required(value, name, maxLength = 200) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maxLength) throw new TypeError(`${name} is invalid`);
  return normalized;
}

function optional(value, maxLength = 500) {
  const normalized = String(value || "").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function rows(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function rowCount(result) {
  return Number(result?.rowCount ?? rows(result).length);
}

export class FulfillmentV2Repository {
  constructor({ provider, now = () => new Date(), createId = randomUUID } = {}) {
    if (!provider || typeof provider.transaction !== "function") throw new TypeError("Fulfillment V2 database provider is required");
    if (typeof now !== "function" || typeof createId !== "function") throw new TypeError("Fulfillment V2 repository dependencies are invalid");
    this.provider = provider;
    this.now = now;
    this.createId = createId;
  }

  async registerActor(actorInput, transaction = this.provider) {
    const actor = normalizeFulfillmentActor(actorInput);
    const result = await transaction.query(`INSERT INTO fulfillment.actors
      (id,actor_type,auth_source,external_subject,display_name,status,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,'active',$6,$6)
      ON CONFLICT (auth_source,external_subject) DO UPDATE SET
        display_name=EXCLUDED.display_name,updated_at=EXCLUDED.updated_at
      WHERE fulfillment.actors.actor_type=EXCLUDED.actor_type
      RETURNING id,actor_type,auth_source,external_subject,display_name,status`, [
      this.createId(), actor.actorType, actor.authSource, actor.externalSubject, actor.displayName, this.now().toISOString(),
    ]);
    const registered = rows(result)[0];
    if (!registered || registered.status !== "active") throw Object.assign(new Error("Fulfillment actor is unavailable"), { code: "FULFILLMENT_ACTOR_UNAVAILABLE" });
    return registered;
  }

  async approvePreview({
    previewId,
    approvalMode = "manual",
    actor: actorInput,
    reasonCode,
    decisionNote = null,
    requestId,
    sourceIp = null,
    userAgent = null,
    decidedAt = this.now().toISOString(),
  } = {}) {
    const mode = required(approvalMode, "Fulfillment approval mode", 20);
    if (!new Set(["manual", "automatic"]).has(mode)) throw new TypeError("Fulfillment approval mode is invalid");
    const actor = normalizeFulfillmentActor(actorInput, { requireHuman: mode === "manual" });
    if (mode === "automatic" && !new Set(["service", "system"]).has(actor.actorType)) {
      throw new TypeError("Automatic fulfillment approval requires a service or system actor");
    }
    const normalizedPreviewId = required(previewId, "Fulfillment preview ID");
    const normalizedRequestId = required(requestId, "Fulfillment request ID", 160);
    const normalizedReason = required(reasonCode, "Fulfillment approval reason", 120);
    return this.provider.transaction(async (transaction) => {
      const registeredActor = await this.registerActor(actor, transaction);
      const previewResult = await transaction.query(`SELECT p.id,p.status,p.preview_hash,p.policy_hash,p.expires_at,
          policy.mode AS policy_mode
        FROM fulfillment.previews p
        JOIN fulfillment.shop_policy_versions policy ON policy.id=p.policy_version_id
        WHERE p.id=$1
        FOR UPDATE`, [normalizedPreviewId]);
      const preview = rows(previewResult)[0];
      if (!preview) throw Object.assign(new Error("Fulfillment preview does not exist"), { code: "PREVIEW_NOT_FOUND" });
      if (preview.status !== "pending") throw Object.assign(new Error("Fulfillment preview is not pending"), { code: "PREVIEW_NOT_PENDING" });
      if (new Date(preview.expires_at).getTime() <= this.now().getTime()) {
        throw Object.assign(new Error("Fulfillment preview has expired"), { code: "PREVIEW_EXPIRED" });
      }
      const expectedPolicyMode = mode === "manual" ? "manual" : "automatic";
      if (preview.policy_mode !== expectedPolicyMode) {
        throw Object.assign(new Error("Fulfillment approval mode does not match policy"), { code: "APPROVAL_POLICY_MISMATCH" });
      }
      const decisionId = this.createId();
      await transaction.query(`INSERT INTO fulfillment.approval_decisions
        (id,preview_id,decision,approval_mode,actor_id,actor_type_snapshot,actor_subject_snapshot,
         actor_display_name_snapshot,auth_source_snapshot,preview_hash,policy_hash,reason_code,
         decision_note,request_id,source_ip,user_agent,decided_at,created_at)
        VALUES ($1,$2,'approved',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`, [
        decisionId, preview.id, mode, registeredActor.id, actor.actorType, actor.externalSubject,
        actor.displayName, actor.authSource, preview.preview_hash, preview.policy_hash, normalizedReason,
        optional(decisionNote, 1000), normalizedRequestId, optional(sourceIp, 80), optional(userAgent, 500), decidedAt,
      ]);
      const stateResult = await transaction.query(`INSERT INTO fulfillment.preview_approval_state
          (preview_id,current_decision_id,status,state_version,updated_at)
        VALUES ($1,$2,'approved',1,$3)
        ON CONFLICT (preview_id) DO UPDATE SET
          current_decision_id=EXCLUDED.current_decision_id,status='approved',
          state_version=fulfillment.preview_approval_state.state_version+1,updated_at=EXCLUDED.updated_at
        WHERE fulfillment.preview_approval_state.status IN ('revoked','rejected')`, [preview.id, decisionId, decidedAt]);
      if (rowCount(stateResult) !== 1) {
        throw Object.assign(new Error("Fulfillment preview already has an active approval"), { code: "APPROVAL_STATE_CONFLICT" });
      }
      const previewUpdate = await transaction.query("UPDATE fulfillment.previews SET status='approved' WHERE id=$1 AND status='pending'", [preview.id]);
      if (rowCount(previewUpdate) !== 1) {
        throw Object.assign(new Error("Fulfillment preview state changed during approval"), { code: "PREVIEW_STATE_CONFLICT" });
      }
      return Object.freeze({
        id: decisionId,
        previewId: preview.id,
        decision: "approved",
        approvalMode: mode,
        actor: Object.freeze({ id: registeredActor.id, ...actor }),
        requestId: normalizedRequestId,
        decidedAt,
      });
    });
  }
}
