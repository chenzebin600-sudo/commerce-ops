import { randomUUID } from "node:crypto";
import {
  normalizeShopeeDiscountSettingsMetadata,
  sanitizeShopeeDiscountSettingsMetadata,
} from "./settings-metadata.mjs";

const PLAN_STATES = new Set([
  "PREVIEWING", "PREVIEWED", "APPROVED", "EXECUTING", "PARTIAL_SUCCESS",
  "SUCCEEDED", "FAILED", "BLOCKED", "EXPIRED", "CANCELLED",
]);
const ACTIVE_PLAN_STATES = ["PREVIEWING", "PREVIEWED", "APPROVED", "EXECUTING"];
const PLAN_TRANSITIONS = Object.freeze({
  PREVIEWING: new Set(["BLOCKED", "FAILED", "CANCELLED"]),
  PREVIEWED: new Set(["BLOCKED", "EXPIRED", "CANCELLED"]),
  APPROVED: new Set(["EXECUTING", "BLOCKED", "EXPIRED", "CANCELLED"]),
  EXECUTING: new Set(["PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"]),
  BLOCKED: new Set(["EXECUTING", "FAILED", "EXPIRED", "CANCELLED"]),
  PARTIAL_SUCCESS: new Set(), SUCCEEDED: new Set(), FAILED: new Set(), EXPIRED: new Set(), CANCELLED: new Set(),
});
const CLOSED_RECONCILIATIONS = new Set(["LINK_VERIFIED_OBJECT", "CONFIRMED_NOT_SENT", "ABANDONED"]);
const PLAINTEXT_SETTING_KEYS = new Set([
  "warehouseKey", "warehouseApiKey", "warehouseSecret", "warehouseToken", "password", "secret", "token", "apiKey",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function iso(value = new Date()) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("A valid date/time is required");
  return parsed.toISOString();
}

function afterYears(value, years) {
  const date = new Date(iso(value));
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString();
}

function isoNullable(value) { return value == null ? null : iso(value); }

function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function text(value, name) {
  const output = String(value ?? "").trim();
  if (!output) throw new TypeError(`${name} is required`);
  return output;
}

function error(code, message) { return Object.assign(new Error(message), { code }); }
function operationUuid(value) {
  const uuid = String(value || "").trim();
  if (!UUID_PATTERN.test(uuid)) throw error("SHOPEE_DISCOUNT_OPERATION_UUID_INVALID", "operationUuid must be a UUID");
  return uuid.toLowerCase();
}
function nonEmptyEvidence(value) { return Boolean(value && typeof value === "object" && Object.keys(value).length); }

function settingsRow(row) {
  if (!row) return null;
  return {
    id: row.id, encryptedWarehouseKeyCiphertext: row.encrypted_warehouse_key_ciphertext,
    warehouseKeyReference: row.warehouse_key_reference, warehouseKeyHint: row.warehouse_key_hint,
    warehouseKeyUpdatedAt: isoNullable(row.warehouse_key_updated_at), timezone: row.timezone, enabled: Boolean(row.enabled),
    metadata: sanitizeShopeeDiscountSettingsMetadata(json(row.metadata_json)), updatedBy: row.updated_by,
    createdAt: isoNullable(row.created_at), updatedAt: isoNullable(row.updated_at),
  };
}

function planRow(row) {
  if (!row) return null;
  return {
    id: row.id, foundationPlanId: row.foundation_plan_id, country: row.country, state: row.state,
    targetStartsAt: isoNullable(row.target_starts_at), targetEndsAt: isoNullable(row.target_ends_at),
    sourceSnapshotHash: row.source_snapshot_hash, policyHash: row.policy_hash, merkleRoot: row.merkle_root,
    itemCount: Number(row.item_count), shardCount: Number(row.shard_count), stateVersion: Number(row.state_version),
    reasonCode: row.reason_code, expiresAt: isoNullable(row.expires_at), sealedAt: isoNullable(row.sealed_at),
    approvedAt: isoNullable(row.approved_at), createdBy: row.created_by,
    retentionUntil: isoNullable(row.retention_until), summary: json(row.summary_json),
    createdAt: isoNullable(row.created_at), updatedAt: isoNullable(row.updated_at),
  };
}

function jobRow(row) {
  if (!row) return null;
  return {
    id: row.id, planId: row.plan_id, foundationTaskId: row.foundation_task_id, jobType: row.job_type,
    status: row.status, ownerId: row.owner_id, epoch: Number(row.fencing_epoch), leaseUntil: isoNullable(row.lease_until),
    cursor: json(row.cursor_json), counters: json(row.counters_json), input: json(row.input_json), result: json(row.result_json),
    lastErrorCode: row.last_error_code, createdBy: row.created_by, startedAt: isoNullable(row.started_at),
    finishedAt: isoNullable(row.finished_at), createdAt: isoNullable(row.created_at), updatedAt: isoNullable(row.updated_at),
  };
}

function intentRow(row) {
  if (!row) return null;
  return {
    id: row.id, jobId: row.job_id, planId: row.plan_id, planItemId: row.plan_item_id,
    operationUuid: row.operation_uuid, targetType: row.target_type, targetKey: row.target_key, attemptNo: Number(row.attempt_no || 1),
    payloadHash: row.payload_hash, epoch: Number(row.epoch), ownerId: row.owner_id, status: row.status,
    platformObjectId: row.platform_object_id, readback: json(row.readback_json, null), evidence: json(row.evidence_json, null),
    reconciledBy: row.reconciled_by, dispatchedAt: isoNullable(row.dispatched_at), completedAt: isoNullable(row.completed_at),
    reconciledAt: isoNullable(row.reconciled_at), updatedAt: isoNullable(row.updated_at),
  };
}

function dueJobRow(row) {
  if (!row) return null;
  return {
    id: row.id, jobType: row.job_type, dedupeKey: row.dedupe_key, dueAt: isoNullable(row.due_at),
    status: row.status, ownerId: row.owner_id, epoch: Number(row.fencing_epoch), leaseUntil: isoNullable(row.lease_until),
    payload: json(row.payload_json), result: json(row.result_json), lastErrorCode: row.last_error_code,
    createdAt: isoNullable(row.created_at), updatedAt: isoNullable(row.updated_at), completedAt: isoNullable(row.completed_at),
  };
}

function planItemRow(row) { return row ? { id: row.id, planId: row.plan_id, shardIndex: Number(row.shard_index), sequence: Number(row.sequence_no), shopId: row.shop_id,
  itemId: row.item_id, modelId: row.model_id, sku: row.sku, currency: row.currency, scale: Number(row.scale),
  currentPriceMinor: row.current_price_minor, controlPriceMinor: row.control_price_minor, targetPriceMinor: row.target_price_minor,
  payloadHash: row.payload_hash, payload: json(row.payload_json), executionStatus: row.execution_status,
  executionReasonCode: row.execution_reason_code } : null; }
function executionItemRow(row) { return row ? { ...planItemRow(row), jobId: row.execution_job_id,
  status: row.canonical_status, reasonCode: row.canonical_reason_code, intentId: row.execution_intent_id,
  platformObjectId: row.execution_platform_object_id, readback: json(row.execution_readback_json, null),
  evidence: json(row.execution_evidence_json), executionUpdatedAt: isoNullable(row.execution_updated_at) } : null; }
function activityRow(row) { return row ? { id: row.id, planId: row.plan_id, shopId: row.shop_id, activityType: row.activity_type,
  platformActivityId: row.platform_activity_id, startsAt: isoNullable(row.target_starts_at), endsAt: isoNullable(row.target_ends_at),
  status: row.status, metadata: json(row.metadata_json) } : null; }
function eventRow(row) { return row ? { id: row.id, planId: row.plan_id, jobId: row.job_id, eventType: row.event_type,
  code: row.reason_code, evidence: json(row.evidence_json), occurredAt: isoNullable(row.occurred_at) } : null; }

function planActivities(input, planId, startsAt, endsAt) {
  const source = Array.isArray(input.activities) ? input.activities
    : Array.isArray(input.shops) ? input.shops
      : Array.isArray(input.shopIds) ? input.shopIds
        : input.shopId ? [input.shopId] : [];
  if (!source.length) throw new TypeError("At least one shop is required");
  const seen = new Set();
  return source.map((entry) => {
    const data = typeof entry === "string" ? { shopId: entry } : entry;
    const shopId = text(data.shopId, "shopId");
    if (seen.has(shopId)) throw new TypeError(`Duplicate shop in plan: ${shopId}`);
    seen.add(shopId);
    return {
      id: data.id || `${planId}:${shopId}`, shopId, activityType: data.activityType || "TARGET_PRICE",
      platformActivityId: data.platformActivityId || null,
      targetStartsAt: iso(data.targetStartsAt || data.startsAt || startsAt),
      targetEndsAt: iso(data.targetEndsAt || data.endsAt || endsAt), metadata: data.metadata || {},
    };
  });
}

export class PostgresqlShopeeDiscountRepository {
  constructor({ provider, now = () => new Date() }) {
    if (!provider?.query || !provider?.transaction) throw new TypeError("PostgreSQL Shopee Discount provider is required");
    this.provider = provider;
    this.schema = provider.config?.schema || "app";
    this.now = now;
  }

  #table(name) { return `"${this.schema}"."${name}"`; }

  async getStorageMode() { return { dialect: "postgres", productionScale: true, pilotLimits: null }; }

  async getSettings() {
    return settingsRow((await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_settings")} WHERE id=$1`, ["default"])).rows[0]);
  }

  async saveSettings(input = {}, audit = {}) {
    for (const key of Object.keys(input)) {
      if (PLAINTEXT_SETTING_KEYS.has(key)) throw error("SHOPEE_DISCOUNT_PLAINTEXT_SECRET_REJECTED", `Plaintext credential field is forbidden: ${key}`);
    }
    const metadata = Object.hasOwn(input, "metadata") ? normalizeShopeeDiscountSettingsMetadata(input.metadata) : null;
    const timestamp = iso(audit.occurredAt || this.now());
    const result = await this.provider.query(`UPDATE ${this.#table("shopee_discount_settings")} SET
      encrypted_warehouse_key_ciphertext=COALESCE($1,encrypted_warehouse_key_ciphertext),
      warehouse_key_reference=COALESCE($2,warehouse_key_reference),warehouse_key_hint=COALESCE($3,warehouse_key_hint),
      warehouse_key_updated_at=CASE WHEN $1 IS NOT NULL OR $2 IS NOT NULL THEN $4 ELSE warehouse_key_updated_at END,
      timezone=COALESCE($5,timezone),enabled=COALESCE($6,enabled),metadata_json=COALESCE($7::jsonb,metadata_json),
      updated_by=COALESCE($8,updated_by),updated_at=$4 WHERE id='default' RETURNING *`, [
      input.encryptedWarehouseKeyCiphertext ?? null, input.warehouseKeyReference ?? null, input.warehouseKeyHint ?? null,
      timestamp, input.timezone ?? null, Object.hasOwn(input, "enabled") ? Boolean(input.enabled) : null,
      metadata === null ? null : JSON.stringify(metadata), audit.actorId || audit.actorName || null,
    ]);
    return settingsRow(result.rows[0]);
  }

  async createPlan(input) {
    const id = input.id || randomUUID();
    const timestamp = iso(input.createdAt || this.now());
    const startsAt = iso(input.targetStartsAt || input.startsAt || input.targetWindow?.startsAt);
    const endsAt = iso(input.targetEndsAt || input.endsAt || input.targetWindow?.endsAt);
    if (endsAt <= startsAt) throw new RangeError("targetEndsAt must be after targetStartsAt");
    const activities = planActivities(input, id, startsAt, endsAt);
    return this.provider.transaction(async (transaction) => {
      for (const activity of [...activities].sort((left, right) => left.shopId.localeCompare(right.shopId))) {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked", [activity.shopId]);
        const conflict = await transaction.query(`SELECT a.plan_id FROM ${this.#table("shopee_discount_activities")} a
          JOIN ${this.#table("shopee_discount_plans")} p ON p.id=a.plan_id
          WHERE a.shop_id=$1 AND a.target_starts_at < $2 AND a.target_ends_at > $3
            AND p.state=ANY($4::text[]) LIMIT 1 FOR UPDATE OF a`, [
          activity.shopId, activity.targetEndsAt, activity.targetStartsAt, ACTIVE_PLAN_STATES,
        ]);
        if (conflict.rows[0]) throw error("SHOPEE_DISCOUNT_ACTIVE_WINDOW_CONFLICT", `An active target plan overlaps for shop ${activity.shopId}`);
      }
      const created = await transaction.query(`INSERT INTO ${this.#table("shopee_discount_plans")} (
        id,foundation_plan_id,country,state,target_starts_at,target_ends_at,source_snapshot_hash,policy_hash,
        expires_at,created_by,retention_until,summary_json,created_at,updated_at
      ) VALUES ($1,$2,$3,'PREVIEWING',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$12) RETURNING *`, [
        id, input.foundationPlanId || null, text(input.country, "country"), startsAt, endsAt,
        text(input.sourceSnapshotHash, "sourceSnapshotHash"), text(input.policyHash, "policyHash"),
        input.expiresAt ? iso(input.expiresAt) : null, text(input.createdBy, "createdBy"),
        iso(input.retentionUntil || afterYears(timestamp, 10)), JSON.stringify(input.summary || {}), timestamp,
      ]);
      for (const activity of activities) await transaction.execute(`INSERT INTO ${this.#table("shopee_discount_activities")} (
        id,plan_id,shop_id,activity_type,platform_activity_id,target_starts_at,target_ends_at,status,metadata_json,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'PLANNED',$8::jsonb,$9,$9)`, [
        activity.id, id, activity.shopId, activity.activityType, activity.platformActivityId,
        activity.targetStartsAt, activity.targetEndsAt, JSON.stringify(activity.metadata), timestamp,
      ]);
      return planRow(created.rows[0]);
    });
  }

  async getPlan(id) {
    return planRow((await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_plans")} WHERE id=$1`, [id])).rows[0]);
  }

  async getPlanShopIds(planId) {
    return (await this.provider.query(`SELECT shop_id FROM ${this.#table("shopee_discount_activities")} WHERE plan_id=$1 ORDER BY shop_id`, [planId])).rows.map(({ shop_id }) => shop_id);
  }

  async bindFoundationPlan(planId, foundationPlanId) {
    const result = await this.provider.query(`UPDATE ${this.#table("shopee_discount_plans")} SET foundation_plan_id=$1,updated_at=$2
      WHERE id=$3 AND state='PREVIEWING' AND (foundation_plan_id IS NULL OR foundation_plan_id=$1) RETURNING *`, [foundationPlanId, iso(this.now()), planId]);
    if (!result.rows[0]) throw error("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Domain plan could not bind Foundation plan");
    return planRow(result.rows[0]);
  }

  async listPlanShards(planId) {
    return (await this.provider.query(`SELECT shard_index,shard_hash,item_count FROM ${this.#table("shopee_discount_plan_shards")} WHERE plan_id=$1 ORDER BY shard_index`, [planId])).rows
      .map((row) => ({ shardIndex: Number(row.shard_index), shardHash: row.shard_hash, itemCount: Number(row.item_count) }));
  }
  async listPlanShardsPage(planId, { cursor = -1, pageSize = 100 } = {}) {
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const rows = (await this.provider.query(`SELECT shard_index,shard_hash,item_count FROM ${this.#table("shopee_discount_plan_shards")}
      WHERE plan_id=$1 AND shard_index>$2 ORDER BY shard_index LIMIT $3`, [planId, Number(cursor), limit + 1])).rows;
    const items = rows.slice(0, limit).map((row) => ({ shardIndex: Number(row.shard_index), shardHash: row.shard_hash, itemCount: Number(row.item_count) }));
    return { items, nextCursor: rows.length > limit ? items.at(-1).shardIndex : null };
  }

  async listPlanItems(planId, { cursor = -1, pageSize = 50, shopId = null, status = null, code = null } = {}) {
    const values = [planId, cursor], clauses = ["plan_id=$1", "sequence_no>$2"];
    for (const [column, value] of [["shop_id", shopId], ["execution_status", status], ["execution_reason_code", code]]) if (value) { values.push(value); clauses.push(`${column}=$${values.length}`); }
    const bounded = Math.max(1, Math.min(100, Number(pageSize) || 50)); values.push(bounded + 1);
    const rows = (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_plan_items")} WHERE ${clauses.join(" AND ")} ORDER BY sequence_no LIMIT $${values.length}`, values)).rows;
    const page = rows.slice(0, bounded);
    return { items: page.map(planItemRow), nextCursor: rows.length > bounded ? String(page.at(-1).sequence_no) : null, pageSize: bounded };
  }

  async getPlanItem(planItemId) {
    return planItemRow((await this.provider.query(
      `SELECT * FROM ${this.#table("shopee_discount_plan_items")} WHERE id=$1`, [planItemId],
    )).rows[0]);
  }

  async getPlanApproval(planId) {
    const row = (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_approvals")} WHERE plan_id=$1`, [planId])).rows[0];
    return row ? { merkleRoot: row.merkle_root, policyHash: row.policy_hash, actorId: row.actor_id, actorName: row.actor_name,
      evidence: json(row.evidence_json), approvedAt: isoNullable(row.approved_at) } : null;
  }

  async getApprovalSagaPhase(planId) {
    const row = (await this.provider.query(`SELECT event_type,evidence_json,occurred_at FROM ${this.#table("shopee_discount_events")}
      WHERE plan_id=$1 AND event_type LIKE 'APPROVAL_SAGA_%' ORDER BY
      CASE event_type WHEN 'APPROVAL_SAGA_COMPENSATION_FAILED' THEN 3 WHEN 'APPROVAL_SAGA_BOTH_APPROVED' THEN 2 ELSE 1 END DESC,
      occurred_at DESC,id DESC LIMIT 1`, [planId])).rows[0];
    return row ? { phase: row.event_type.slice("APPROVAL_SAGA_".length), evidence: json(row.evidence_json), occurredAt: isoNullable(row.occurred_at) } : null;
  }

  async recordApprovalSagaPhase(planId, phase, evidence = {}) {
    const normalized = text(phase, "approval phase");
    if (!new Set(["DOMAIN_APPROVED", "BOTH_APPROVED", "COMPENSATION_FAILED"]).has(normalized)) throw new TypeError("Unsupported approval saga phase");
    const id = `${planId}:approval-saga:${normalized}`;
    const existing = (await this.provider.query(`SELECT id FROM ${this.#table("shopee_discount_events")} WHERE id=$1`, [id])).rows[0];
    if (existing) return existing;
    try { return await this.appendEvent({ id, planId, eventType: `APPROVAL_SAGA_${normalized}`,
      reasonCode: normalized === "COMPENSATION_FAILED" ? "SHOPEE_DISCOUNT_APPROVAL_COMPENSATION_FAILED" : null, evidence }); }
    catch (cause) {
      const concurrent = (await this.provider.query(`SELECT id FROM ${this.#table("shopee_discount_events")} WHERE id=$1`, [id])).rows[0];
      if (concurrent) return concurrent;
      throw cause;
    }
  }

  async countPlanItemsByShop(planId) {
    return (await this.provider.query(`SELECT shop_id,COUNT(*) item_count FROM ${this.#table("shopee_discount_plan_items")} WHERE plan_id=$1 GROUP BY shop_id ORDER BY shop_id`, [planId])).rows
      .map((row) => ({ shopId: row.shop_id, itemCount: Number(row.item_count) }));
  }

  async countPlanShops(planId) {
    return Number((await this.provider.query(`SELECT COUNT(DISTINCT shop_id) count FROM ${this.#table("shopee_discount_plan_items")} WHERE plan_id=$1`, [planId])).rows[0]?.count || 0);
  }

  async listExecutionJobs(planId) {
    return (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_jobs")} WHERE plan_id=$1 AND job_type='EXECUTE' ORDER BY created_at,id`, [planId])).rows.map(jobRow);
  }

  async getJob(jobId) {
    return jobRow((await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_jobs")} WHERE id=$1`, [jobId])).rows[0]);
  }

  async listPlanActivities(planId) {
    return (await this.provider.query(
      `SELECT * FROM ${this.#table("shopee_discount_activities")} WHERE plan_id=$1 ORDER BY shop_id,id`, [planId],
    )).rows.map(activityRow);
  }

  async getPlanActivity(planId, shopId) {
    return activityRow((await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_activities")} WHERE plan_id=$1 AND shop_id=$2 ORDER BY id LIMIT 1`, [planId, shopId])).rows[0]);
  }
  async listPlanActivitiesPage(planId, { cursor = "", pageSize = 100 } = {}) {
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const rows = (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_activities")} WHERE plan_id=$1 AND shop_id>$2 ORDER BY shop_id,id LIMIT $3`, [planId, cursor, limit + 1])).rows;
    const items = rows.slice(0, limit).map(activityRow);
    return { items, nextCursor: rows.length > limit ? items.at(-1).shopId : null };
  }

  async listRunsScoped(filters = {}, authorizedShopIds = null) {
    const values = [], clauses = [];
    if (filters.status) { values.push(filters.status); clauses.push(`j.status=$${values.length}`); }
    if (filters.planId) { values.push(filters.planId); clauses.push(`j.plan_id=$${values.length}`); }
    if (authorizedShopIds) { if (!authorizedShopIds.length) return []; values.push(authorizedShopIds); clauses.push(`NOT EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_activities")} a WHERE a.plan_id=j.plan_id AND NOT (a.shop_id=ANY($${values.length}::text[])))`); }
    values.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    return (await this.provider.query(`SELECT j.* FROM ${this.#table("shopee_discount_jobs")} j ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY j.created_at DESC,j.id LIMIT $${values.length}`, values)).rows.map(jobRow);
  }

  async listActivitiesScoped(filters = {}, authorizedShopIds = null) {
    const values = [], clauses = [];
    if (filters.shopId) { values.push(filters.shopId); clauses.push(`shop_id=$${values.length}`); }
    if (filters.status) { values.push(filters.status); clauses.push(`status=$${values.length}`); }
    if (authorizedShopIds) { if (!authorizedShopIds.length) return []; values.push(authorizedShopIds); clauses.push(`shop_id=ANY($${values.length}::text[])`); }
    values.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    return (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_activities")} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY target_starts_at DESC,id LIMIT $${values.length}`, values)).rows.map(activityRow);
  }

  async listIssuesScoped(filters = {}, authorizedShopIds = null) {
    const values = [], clauses = ["e.reason_code IS NOT NULL"];
    if (filters.planId) { values.push(filters.planId); clauses.push(`e.plan_id=$${values.length}`); }
    if (filters.code) { values.push(filters.code); clauses.push(`e.reason_code=$${values.length}`); }
    if (authorizedShopIds) { if (!authorizedShopIds.length) return []; values.push(authorizedShopIds); clauses.push(`NOT EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_activities")} a WHERE a.plan_id=e.plan_id AND NOT (a.shop_id=ANY($${values.length}::text[])))`); }
    values.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    return (await this.provider.query(`SELECT e.* FROM ${this.#table("shopee_discount_events")} e WHERE ${clauses.join(" AND ")} ORDER BY e.occurred_at DESC,e.id LIMIT $${values.length}`, values)).rows.map(eventRow);
  }

  async getStoredSystemActivity(shopId, platformActivityId) {
    const row = (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_activities")} WHERE shop_id=$1 AND platform_activity_id=$2 AND metadata_json->>'systemManaged'='true' ORDER BY updated_at DESC LIMIT 1`, [shopId, platformActivityId])).rows[0];
    return activityRow(row);
  }

  async getLatestWarehouseBaseline({ country, category, tier }) {
    const rows = (await this.provider.query(`SELECT evidence_json FROM ${this.#table("shopee_discount_events")} WHERE event_type='WAREHOUSE_BASELINE' ORDER BY occurred_at DESC,id DESC LIMIT 500`)).rows;
    for (const row of rows) { const value = json(row.evidence_json, null); if (value?.scope?.country === country && value.scope.category === category && value.scope.tier === tier) return value; }
    return null;
  }

  async saveWarehouseBaseline(input) {
    const existing = (await this.provider.query(`SELECT id FROM ${this.#table("shopee_discount_events")} WHERE id=$1`, [input.id])).rows[0];
    return existing || this.appendEvent({ id: input.id, eventType: "WAREHOUSE_BASELINE", evidence: input });
  }

  async listPlans(filters = {}) {
    const clauses = [], values = [];
    const add = (sql, value) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
    if (filters.country) add("country=?", filters.country);
    if (filters.state) add("state=?", filters.state);
    if (filters.createdBefore) add("created_at<?", iso(filters.createdBefore));
    if (filters.createdAfter) add("created_at>=?", iso(filters.createdAfter));
    if (filters.shopId) {
      values.push(filters.shopId);
      clauses.push(`EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_activities")} a WHERE a.plan_id=p.id AND a.shop_id=$${values.length})`);
    }
    values.push(Math.min(200, Math.max(1, Number(filters.limit) || 50)));
    const result = await this.provider.query(`SELECT p.* FROM ${this.#table("shopee_discount_plans")} p
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at DESC,id DESC LIMIT $${values.length}`, values);
    return result.rows.map(planRow);
  }

  async appendPlanShard({ planId, shardIndex, shardHash, items = [] }) {
    if (!Number.isInteger(shardIndex) || shardIndex < 0) throw new TypeError("shardIndex must be a non-negative integer");
    const timestamp = iso(this.now());
    return this.provider.transaction(async (transaction) => {
      const plan = (await transaction.query(`SELECT id,state FROM ${this.#table("shopee_discount_plans")} WHERE id=$1 FOR UPDATE`, [planId])).rows[0];
      if (!plan) throw error("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
      if (plan.state !== "PREVIEWING") throw error("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Plan shards can only be appended while PREVIEWING");
      const shardId = `${planId}:${shardIndex}`;
      await transaction.execute(`INSERT INTO ${this.#table("shopee_discount_plan_shards")}
        (id,plan_id,shard_index,shard_hash,item_count,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
        shardId, planId, shardIndex, text(shardHash, "shardHash"), items.length, timestamp,
      ]);
      if (items.length) {
        const values = [], groups = [];
        for (let index = 0; index < items.length; index += 1) {
          const value = items[index];
          const shopId = text(value.shopId, "item.shopId"), itemId = text(value.itemId, "item.itemId"), modelId = text(value.modelId, "item.modelId");
          const itemKey = `${shopId}\u001f${itemId}\u001f${modelId}`;
          if (value.itemKey != null && value.itemKey !== itemKey) throw new TypeError("itemKey must use canonical shop/item/model identity");
          const sequence = Number.isInteger(value.sequence) ? value.sequence : shardIndex * 10_000 + index;
          const start = values.length + 1;
          values.push(
            value.id || randomUUID(), planId, shardId, shardIndex, sequence, shopId, itemId, modelId, itemKey,
            text(value.sku, "item.sku"), text(value.currency, "item.currency"), value.scale,
            text(value.currentPriceMinor ?? value.sourcePriceMinor, "item.currentPriceMinor"),
            value.controlPriceMinor == null ? null : String(value.controlPriceMinor), text(value.targetPriceMinor, "item.targetPriceMinor"),
            text(value.payloadHash, "item.payloadHash"), JSON.stringify(value.payload || {}),
            iso(value.retentionUntil || afterYears(timestamp, 2)), timestamp,
          );
          const placeholders = Array.from({ length: 19 }, (_, offset) => `$${start + offset}`);
          placeholders[16] = `${placeholders[16]}::jsonb`;
          groups.push(`(${placeholders.join(",")})`);
        }
        await transaction.execute(`INSERT INTO ${this.#table("shopee_discount_plan_items")} (
          id,plan_id,shard_id,shard_index,sequence_no,shop_id,item_id,model_id,item_key,sku,currency,scale,
          current_price_minor,control_price_minor,target_price_minor,payload_hash,payload_json,retention_until,created_at
        ) VALUES ${groups.join(",")}`, values);
      }
      return { planId, shardIndex, shardHash, itemCount: items.length, createdAt: timestamp };
    });
  }

  async sealPlan({ planId, merkleRoot, itemCount, shardCount, expectedVersion }) {
    const root = text(merkleRoot, "merkleRoot");
    return this.provider.transaction(async (transaction) => {
      const plan = (await transaction.query(`SELECT * FROM ${this.#table("shopee_discount_plans")} WHERE id=$1 FOR UPDATE`, [planId])).rows[0];
      if (!plan) throw error("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
      if (Number(plan.state_version) !== Number(expectedVersion)) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      if (plan.state !== "PREVIEWING") throw error("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Only PREVIEWING plans may be sealed");
      const shards = (await transaction.query(`SELECT shard_index,item_count FROM ${this.#table("shopee_discount_plan_shards")}
        WHERE plan_id=$1 ORDER BY shard_index FOR UPDATE`, [planId])).rows;
      const contiguous = shards.length === Number(shardCount) && shards.every((row, index) => Number(row.shard_index) === index)
        && shards.reduce((sum, row) => sum + Number(row.item_count), 0) === Number(itemCount);
      if (!contiguous) throw error("SHOPEE_DISCOUNT_SHARDS_NOT_CONTIGUOUS", "Plan shards must be contiguous and counts must match");
      const timestamp = iso(this.now());
      const result = await transaction.query(`UPDATE ${this.#table("shopee_discount_plans")} SET state='PREVIEWED',merkle_root=$1,
        item_count=$2,shard_count=$3,state_version=state_version+1,sealed_at=$4,updated_at=$4
        WHERE id=$5 AND state='PREVIEWING' AND state_version=$6 RETURNING *`, [root, itemCount, shardCount, timestamp, planId, expectedVersion]);
      if (!result.rows[0]) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      return planRow(result.rows[0]);
    });
  }

  async approvePlan({ planId, merkleRoot, policyHash, approval = {}, expectedVersion }) {
    return this.provider.transaction(async (transaction) => {
      const plan = (await transaction.query(`SELECT * FROM ${this.#table("shopee_discount_plans")} WHERE id=$1 FOR UPDATE`, [planId])).rows[0];
      if (!plan) throw error("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
      if (Number(plan.state_version) !== Number(expectedVersion)) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      if (plan.state !== "PREVIEWED") throw error("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Only PREVIEWED plans may be approved");
      if (plan.merkle_root !== merkleRoot) throw error("SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH", "Approval Merkle root does not match the sealed plan");
      if (plan.policy_hash !== policyHash) throw error("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Approval policy hash does not match the plan");
      const timestamp = iso(approval.approvedAt || this.now());
      await transaction.execute(`INSERT INTO ${this.#table("shopee_discount_approvals")} (
        id,plan_id,merkle_root,policy_hash,approval_mode,actor_id,actor_name,evidence_json,approved_at,created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9)`, [
        approval.id || randomUUID(), planId, merkleRoot, policyHash, approval.mode || "human",
        text(approval.actorId, "approval.actorId"), approval.actorName || null, JSON.stringify(approval.evidence || {}), timestamp,
      ]);
      const result = await transaction.query(`UPDATE ${this.#table("shopee_discount_plans")} SET state='APPROVED',
        state_version=state_version+1,approved_at=$1,updated_at=$1 WHERE id=$2 AND state='PREVIEWED' AND state_version=$3 RETURNING *`,
      [timestamp, planId, expectedVersion]);
      if (!result.rows[0]) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      return planRow(result.rows[0]);
    });
  }

  async markPlanState({ planId, fromState, toState, expectedVersion, reasonCode = null }) {
    if (!PLAN_STATES.has(fromState) || !PLAN_STATES.has(toState)) throw new TypeError("Unsupported Shopee Discount plan state");
    if (fromState === toState || !PLAN_TRANSITIONS[fromState].has(toState)) {
      throw error("SHOPEE_DISCOUNT_PLAN_TRANSITION_INVALID", `Plan cannot transition from ${fromState} to ${toState}`);
    }
    return this.provider.transaction(async (transaction) => {
      const timestamp = iso(this.now());
      const result = await transaction.query(`UPDATE ${this.#table("shopee_discount_plans")} SET state=$1,reason_code=$2,
        state_version=state_version+1,updated_at=$3 WHERE id=$4 AND state=$5 AND state_version=$6 RETURNING *`,
      [toState, reasonCode, timestamp, planId, fromState, expectedVersion]);
      if (!result.rows[0]) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan state or version changed");
      if (["PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"].includes(toState)) {
        await transaction.execute(`UPDATE ${this.#table("shopee_discount_activities")} SET status=$1,updated_at=$2 WHERE plan_id=$3`,
          [toState === "CANCELLED" ? "CANCELLED" : "ENDED", timestamp, planId]);
      } else if (toState === "EXECUTING") {
        await transaction.execute(`UPDATE ${this.#table("shopee_discount_activities")} SET status='ACTIVE',updated_at=$1 WHERE plan_id=$2`, [timestamp, planId]);
      }
      return planRow(result.rows[0]);
    });
  }

  async createJob(input) {
    const id = input.id || randomUUID(), timestamp = iso(input.createdAt || this.now());
    const result = await this.provider.query(`INSERT INTO ${this.#table("shopee_discount_jobs")} (
      id,plan_id,foundation_task_id,job_type,status,input_json,created_by,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$8) RETURNING *`, [
      id, text(input.planId, "planId"), input.foundationTaskId || null, text(input.jobType, "jobType"), input.status || "PENDING",
      JSON.stringify(input.input || {}), text(input.createdBy, "createdBy"), timestamp,
    ]);
    return jobRow(result.rows[0]);
  }

  async prepareExecutionItems({ jobId, planId, ownerId, epoch }) {
    const timestamp = iso(this.now());
    return this.provider.transaction(async (transaction) => {
      const job = (await transaction.query(`SELECT id FROM ${this.#table("shopee_discount_jobs")} WHERE id=$1 AND plan_id=$2
        AND status='RUNNING' AND owner_id=$3 AND fencing_epoch=$4 AND lease_until>$5 FOR UPDATE`,
      [jobId, planId, ownerId, epoch, timestamp])).rows[0];
      if (!job) throw error("SHOPEE_DISCOUNT_STALE_EPOCH", "Execution checkpoint initialization rejected for stale ownership");
      await transaction.execute(`INSERT INTO ${this.#table("shopee_discount_execution_items")}
        (job_id,plan_item_id,status,evidence_json,created_at,updated_at)
        SELECT $1,id,'PENDING','{}'::jsonb,$2,$2 FROM ${this.#table("shopee_discount_plan_items")} WHERE plan_id=$3
        ON CONFLICT (job_id,plan_item_id) DO NOTHING`, [jobId, timestamp, planId]);
      const count = (await transaction.query(
        `SELECT COUNT(*) count FROM ${this.#table("shopee_discount_execution_items")} WHERE job_id=$1`, [jobId],
      )).rows[0]?.count;
      return Number(count || 0);
    });
  }

  async listExecutionItems(jobId, { shopId = null, statuses = null } = {}) {
    const values = [jobId], clauses = ["e.job_id=$1"];
    if (shopId) { values.push(shopId); clauses.push(`i.shop_id=$${values.length}`); }
    if (statuses) {
      if (!Array.isArray(statuses) || !statuses.length) return [];
      values.push(statuses); clauses.push(`e.status=ANY($${values.length}::text[])`);
    }
    const rows = (await this.provider.query(`SELECT i.*,e.job_id execution_job_id,e.status canonical_status,
      e.reason_code canonical_reason_code,e.intent_id execution_intent_id,
      e.platform_object_id execution_platform_object_id,e.readback_json execution_readback_json,
      e.evidence_json execution_evidence_json,e.updated_at execution_updated_at
      FROM ${this.#table("shopee_discount_execution_items")} e
      JOIN ${this.#table("shopee_discount_plan_items")} i ON i.id=e.plan_item_id
      WHERE ${clauses.join(" AND ")} ORDER BY i.shop_id,i.sequence_no`, values)).rows;
    return rows.map(executionItemRow);
  }

  async listExecutionItemsPage(jobId, { cursor = -1, pageSize = 100, shopId = null, statuses = null } = {}) {
    const values = [jobId, Number(cursor)], clauses = ["e.job_id=$1", "i.sequence_no>$2"];
    if (shopId) { values.push(shopId); clauses.push(`i.shop_id=$${values.length}`); }
    if (statuses) { if (!statuses.length) return { items: [], nextCursor: null }; values.push(statuses); clauses.push(`e.status=ANY($${values.length}::text[])`); }
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100)); values.push(limit + 1);
    const rows = (await this.provider.query(`SELECT i.*,e.job_id execution_job_id,e.status canonical_status,e.reason_code canonical_reason_code,
      e.intent_id execution_intent_id,e.platform_object_id execution_platform_object_id,e.readback_json execution_readback_json,
      e.evidence_json execution_evidence_json,e.updated_at execution_updated_at FROM ${this.#table("shopee_discount_execution_items")} e
      JOIN ${this.#table("shopee_discount_plan_items")} i ON i.id=e.plan_item_id WHERE ${clauses.join(" AND ")} ORDER BY i.sequence_no LIMIT $${values.length}`, values)).rows;
    const page = rows.slice(0, limit).map(executionItemRow);
    return { items: page, nextCursor: rows.length > limit ? page.at(-1).sequence : null };
  }

  async countExecutionItemsByStatus(jobId) {
    return Object.fromEntries((await this.provider.query(`SELECT status,COUNT(*) count FROM ${this.#table("shopee_discount_execution_items")} WHERE job_id=$1 GROUP BY status`, [jobId])).rows
      .map((row) => [row.status, Number(row.count)]));
  }

  async setExecutionItemStatus({ jobId, planItemId, ownerId, epoch, status, reasonCode = null, evidence = {} }) {
    if (!new Set(["PENDING", "SUCCEEDED", "REJECTED", "CONFLICT", "AUTH_BLOCKED", "UNKNOWN", "REQUIRES_REAPPROVAL", "SKIPPED"]).has(status)) {
      throw new TypeError("Unsupported execution item status");
    }
    const timestamp = iso(this.now());
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_execution_items")} e
      SET status=$1,reason_code=$2,evidence_json=$3::jsonb,updated_at=$4
      WHERE e.job_id=$5 AND e.plan_item_id=$6 AND e.status!='SUCCEEDED'
      AND EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_jobs")} j WHERE j.id=e.job_id AND j.status='RUNNING'
        AND j.owner_id=$7 AND j.fencing_epoch=$8 AND j.lease_until>$4)`,
    [status, reasonCode, JSON.stringify(evidence), timestamp, jobId, planItemId, ownerId, epoch]);
    return Number(result.rowCount || 0) > 0;
  }

  async claimJob({ jobId, ownerId, leaseMs }) {
    const owner = text(ownerId, "ownerId"), now = iso(this.now());
    const leaseUntil = new Date(new Date(now).getTime() + Math.max(1, Number(leaseMs) || 0)).toISOString();
    return this.provider.transaction(async (transaction) => {
      const row = (await transaction.query(`SELECT * FROM ${this.#table("shopee_discount_jobs")} WHERE id=$1 FOR UPDATE`, [jobId])).rows[0];
      if (!row || !["PENDING", "RUNNING"].includes(row.status)) {
        return { claimed: false, epoch: row ? Number(row.fencing_epoch) : null, leaseUntil: isoNullable(row?.lease_until) };
      }
      const live = row.lease_until && iso(row.lease_until) > now;
      if (live && row.owner_id !== owner) {
        return { claimed: false, epoch: Number(row.fencing_epoch), leaseUntil: isoNullable(row.lease_until) };
      }
      const epoch = live && row.owner_id === owner ? Number(row.fencing_epoch) : Number(row.fencing_epoch) + 1;
      const result = await transaction.query(`UPDATE ${this.#table("shopee_discount_jobs")} SET status='RUNNING',owner_id=$1,
        fencing_epoch=$2,lease_until=$3,started_at=COALESCE(started_at,$4),updated_at=$4
        WHERE id=$5 AND fencing_epoch=$6 RETURNING fencing_epoch,lease_until`, [owner, epoch, leaseUntil, now, jobId, row.fencing_epoch]);
      const claimed = result.rows[0];
      return {
        claimed: Boolean(claimed),
        epoch: Number(claimed?.fencing_epoch ?? epoch),
        leaseUntil: isoNullable(claimed?.lease_until) || leaseUntil,
      };
    });
  }

  async renewJobLease({ jobId, ownerId, epoch, leaseMs }) {
    const now = iso(this.now()), leaseUntil = new Date(new Date(now).getTime() + Math.max(1, Number(leaseMs) || 0)).toISOString();
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_jobs")} SET lease_until=$1,updated_at=$2
      WHERE id=$3 AND status='RUNNING' AND owner_id=$4 AND fencing_epoch=$5 AND lease_until>$2`, [leaseUntil, now, jobId, ownerId, epoch]);
    return Number(result.rowCount || 0) > 0;
  }

  async checkpointJob({ jobId, ownerId, epoch, cursor = {}, counters = {} }) {
    const now = iso(this.now());
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_jobs")} SET cursor_json=$1::jsonb,
      counters_json=$2::jsonb,updated_at=$3 WHERE id=$4 AND status='RUNNING' AND owner_id=$5 AND fencing_epoch=$6 AND lease_until>$3`,
    [JSON.stringify(cursor), JSON.stringify(counters), now, jobId, ownerId, epoch]);
    return Number(result.rowCount || 0) > 0;
  }

  async createDispatchIntent(input) {
    const id = input.id || randomUUID(), now = iso(this.now()), dispatchedAt = iso(input.dispatchedAt || now);
    const uuid = operationUuid(input.operationUuid);
    return this.provider.transaction(async (transaction) => {
      const job = (await transaction.query(`SELECT id FROM ${this.#table("shopee_discount_jobs")}
        WHERE id=$1 AND plan_id=$2 AND status='RUNNING' AND owner_id=$3 AND fencing_epoch=$4 AND lease_until>$5 FOR UPDATE`,
      [input.jobId, input.planId, input.ownerId, input.epoch, now])).rows[0];
      if (!job) throw error("SHOPEE_DISCOUNT_STALE_EPOCH", "Dispatch intent rejected for stale job ownership");
      const attemptNo = Number((await transaction.query(`SELECT COALESCE(MAX(attempt_no),0)+1 attempt_no FROM ${this.#table("shopee_discount_dispatch_intents")}
        WHERE job_id=$1 AND target_type=$2 AND target_key=$3`, [input.jobId, input.targetType, input.targetKey])).rows[0]?.attempt_no || 1);
      const result = await transaction.query(`INSERT INTO ${this.#table("shopee_discount_dispatch_intents")} (
        id,job_id,plan_id,plan_item_id,operation_uuid,target_type,target_key,attempt_no,payload_hash,epoch,owner_id,status,dispatched_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DISPATCHED',$12,$13) RETURNING *`, [
        id, input.jobId, input.planId, input.planItemId || null, uuid,
        text(input.targetType, "targetType"), text(input.targetKey, "targetKey"), attemptNo, text(input.payloadHash, "payloadHash"),
        input.epoch, input.ownerId, dispatchedAt, now,
      ]);
      if (input.planItemId) {
        const checkpoint = await transaction.execute(`UPDATE ${this.#table("shopee_discount_execution_items")}
          SET status='DISPATCHED',updated_at=$1,intent_id=$4
          WHERE job_id=$2 AND plan_item_id=$3 AND status='PENDING'`, [now, input.jobId, input.planItemId, id]);
        if (!Number(checkpoint.rowCount || 0)) {
          throw error("SHOPEE_DISCOUNT_ITEM_NOT_DISPATCHABLE", "Execution item is not pending dispatch");
        }
      }
      return intentRow(result.rows[0]);
    });
  }

  async getDispatchIntent(intentId) {
    return intentRow((await this.provider.query(
      `SELECT * FROM ${this.#table("shopee_discount_dispatch_intents")} WHERE id=$1`, [intentId],
    )).rows[0]);
  }

  async listDispatchIntents({ jobId, statuses = null } = {}) {
    const values = [jobId], clauses = ["job_id=$1"];
    if (statuses) {
      if (!Array.isArray(statuses) || !statuses.length) return [];
      values.push(statuses); clauses.push(`status=ANY($${values.length}::text[])`);
    }
    return (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_dispatch_intents")}
      WHERE ${clauses.join(" AND ")} ORDER BY dispatched_at,id`, values)).rows.map(intentRow);
  }

  async listDispatchIntentsPage({ jobId, statuses = null, cursor = null, pageSize = 100 } = {}) {
    const values = [jobId], clauses = ["job_id=$1"];
    if (statuses) { if (!statuses.length) return { items: [], nextCursor: null }; values.push(statuses); clauses.push(`status=ANY($${values.length}::text[])`); }
    if (cursor) { values.push(cursor.dispatchedAt, cursor.id); clauses.push(`(dispatched_at>$${values.length - 1} OR (dispatched_at=$${values.length - 1} AND id>$${values.length}))`); }
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100)); values.push(limit + 1);
    const rows = (await this.provider.query(`SELECT * FROM ${this.#table("shopee_discount_dispatch_intents")} WHERE ${clauses.join(" AND ")} ORDER BY dispatched_at,id LIMIT $${values.length}`, values)).rows;
    const page = rows.slice(0, limit).map(intentRow), last = page.at(-1);
    return { items: page, nextCursor: rows.length > limit ? { dispatchedAt: last.dispatchedAt, id: last.id } : null };
  }

  async recordIntentOutcome({ intentId, jobId, ownerId, epoch, intentStatus, itemStatus, reasonCode = null,
    platformObjectId = null, readback = null, evidence = {} }) {
    if (!new Set(["SUCCEEDED", "REJECTED", "CONFIRMED_NOT_SENT", "UNKNOWN"]).has(intentStatus)) throw new TypeError("Unsupported intent outcome");
    if (!new Set(["SUCCEEDED", "REJECTED", "CONFLICT", "AUTH_BLOCKED", "UNKNOWN", "REQUIRES_REAPPROVAL", "SKIPPED"]).has(itemStatus)) {
      throw new TypeError("Unsupported execution item outcome");
    }
    const timestamp = iso(this.now());
    return this.provider.transaction(async (transaction) => {
      const current = (await transaction.query(`SELECT i.* FROM ${this.#table("shopee_discount_dispatch_intents")} i
        JOIN ${this.#table("shopee_discount_jobs")} j ON j.id=i.job_id
        WHERE i.id=$1 AND i.job_id=$2 AND i.status=ANY($3::text[]) AND j.status='RUNNING'
          AND j.owner_id=$4 AND j.fencing_epoch=$5 AND j.lease_until>$6 FOR UPDATE OF i`,
      [intentId, jobId, ["DISPATCHED", "UNKNOWN"], ownerId, epoch, timestamp])).rows[0];
      if (!current) return false;
      await transaction.execute(`UPDATE ${this.#table("shopee_discount_dispatch_intents")}
        SET status=$1,platform_object_id=$2,readback_json=$3::jsonb,evidence_json=$4::jsonb,
          completed_at=CASE WHEN $1=ANY(ARRAY['SUCCEEDED','REJECTED']) THEN $5 ELSE completed_at END,updated_at=$5 WHERE id=$6`,
      [intentStatus, platformObjectId, readback ? JSON.stringify(readback) : null, JSON.stringify(evidence), timestamp, intentId]);
      if (current.plan_item_id) await transaction.execute(`UPDATE ${this.#table("shopee_discount_execution_items")}
        SET status=$1,reason_code=$2,platform_object_id=$3,readback_json=$4::jsonb,evidence_json=$5::jsonb,updated_at=$6
        WHERE job_id=$7 AND plan_item_id=$8 AND status!='SUCCEEDED'`, [
        itemStatus, reasonCode, platformObjectId, readback ? JSON.stringify(readback) : null,
        JSON.stringify(evidence), timestamp, jobId, current.plan_item_id,
      ]);
      return true;
    });
  }

  async bindActivityPlatformId({ jobId, planId, shopId, ownerId, epoch, platformActivityId, evidence = {} }) {
    const timestamp = iso(this.now());
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_activities")} a
      SET platform_activity_id=$1,metadata_json=jsonb_set(metadata_json,'{bindingEvidence}',$2::jsonb,true),updated_at=$3
      WHERE plan_id=$4 AND shop_id=$5 AND EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_jobs")} j
        WHERE j.id=$6 AND j.status='RUNNING' AND j.owner_id=$7 AND j.fencing_epoch=$8 AND j.lease_until>$3)`, [
      text(platformActivityId, "platformActivityId"), JSON.stringify(evidence), timestamp,
      planId, shopId, jobId, ownerId, epoch,
    ]);
    return Number(result.rowCount || 0) > 0;
  }

  async completeJob({ jobId, ownerId, epoch, status, result = {}, counters = {} }) {
    if (!new Set(["PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "BLOCKED"]).has(status)) throw new TypeError("Unsupported job outcome");
    const timestamp = iso(this.now());
    const updated = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_jobs")}
      SET status=$1,result_json=$2::jsonb,counters_json=$3::jsonb,finished_at=$4,updated_at=$4
      WHERE id=$5 AND status='RUNNING' AND owner_id=$6 AND fencing_epoch=$7 AND lease_until>$4`,
    [status, JSON.stringify(result), JSON.stringify(counters), timestamp, jobId, ownerId, epoch]);
    return Number(updated.rowCount || 0) > 0;
  }

  async completeDispatchIntent({ intentId, ownerId, epoch, platformObjectId, readback }) {
    if (!nonEmptyEvidence(readback)) throw new TypeError("Conclusive readback evidence is required");
    const timestamp = iso(this.now());
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_dispatch_intents")} i SET status='SUCCEEDED',
      platform_object_id=$1,readback_json=$2::jsonb,completed_at=$3,updated_at=$3
      WHERE i.id=$4 AND i.status='DISPATCHED' AND i.owner_id=$5 AND i.epoch=$6
        AND EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_jobs")} j WHERE j.id=i.job_id AND j.owner_id=$5 AND j.fencing_epoch=$6 AND j.lease_until>$3)`,
    [platformObjectId || null, JSON.stringify(readback), timestamp, intentId, ownerId, epoch]);
    return Number(result.rowCount || 0) > 0;
  }

  async markDispatchUnknown({ intentId, ownerId, epoch, evidence }) {
    if (!nonEmptyEvidence(evidence)) throw new TypeError("UNKNOWN evidence is required");
    const timestamp = iso(this.now());
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_dispatch_intents")} i SET status='UNKNOWN',
      evidence_json=$1::jsonb,updated_at=$2 WHERE i.id=$3 AND i.status='DISPATCHED' AND i.owner_id=$4 AND i.epoch=$5
        AND EXISTS (SELECT 1 FROM ${this.#table("shopee_discount_jobs")} j WHERE j.id=i.job_id AND j.owner_id=$4 AND j.fencing_epoch=$5 AND j.lease_until>$2)`,
    [JSON.stringify(evidence), timestamp, intentId, ownerId, epoch]);
    return Number(result.rowCount || 0) > 0;
  }

  async reconcileIntent({ intentId, resolution, evidence, actor = {}, platformObjectId = null, readback = null,
    executionStatus = null, reasonCode = null, activityShopId = null, resetActivityItems = false }) {
    if (!CLOSED_RECONCILIATIONS.has(resolution) || !nonEmptyEvidence(evidence)) {
      throw error("SHOPEE_DISCOUNT_RECONCILIATION_INVALID", "A closed reconciliation resolution and evidence are required");
    }
    return this.provider.transaction(async (transaction) => {
      const current = (await transaction.query(`SELECT * FROM ${this.#table("shopee_discount_dispatch_intents")} WHERE id=$1 FOR UPDATE`, [intentId])).rows[0];
      if (!current) throw error("SHOPEE_DISCOUNT_INTENT_NOT_FOUND", "Dispatch intent was not found");
      if (!["UNKNOWN", "DISPATCHED"].includes(current.status)) throw error("SHOPEE_DISCOUNT_RECONCILIATION_CLOSED", "Dispatch intent reconciliation is already closed");
      const timestamp = iso(this.now());
      const result = await transaction.query(`UPDATE ${this.#table("shopee_discount_dispatch_intents")}
        SET status=$1,platform_object_id=COALESCE($2,platform_object_id),readback_json=COALESCE($3::jsonb,readback_json),
          evidence_json=$4::jsonb,reconciled_by=$5,reconciled_at=$6,completed_at=$6,updated_at=$6
        WHERE id=$7 AND status=ANY($8::text[]) RETURNING *`, [
        resolution, platformObjectId, readback ? JSON.stringify(readback) : null, JSON.stringify(evidence),
        actor.id || actor.actorId || String(actor || "system"), timestamp, intentId, ["UNKNOWN", "DISPATCHED"],
      ]);
      if (current.plan_item_id && executionStatus) {
        if (!new Set(["SUCCEEDED", "SKIPPED", "UNKNOWN"]).has(executionStatus)) throw new TypeError("Unsupported reconciliation item status");
        await transaction.execute(`UPDATE ${this.#table("shopee_discount_execution_items")}
          SET status=$1,reason_code=$2,platform_object_id=COALESCE($3,platform_object_id),
            readback_json=COALESCE($4::jsonb,readback_json),evidence_json=$5::jsonb,updated_at=$6
          WHERE job_id=$7 AND plan_item_id=$8`, [
          executionStatus, reasonCode, platformObjectId, readback ? JSON.stringify(readback) : null,
          JSON.stringify(evidence), timestamp, current.job_id, current.plan_item_id,
        ]);
      }
      if (!current.plan_item_id && activityShopId && platformObjectId) {
        const bound = await transaction.execute(`UPDATE ${this.#table("shopee_discount_activities")}
          SET platform_activity_id=$1,updated_at=$2 WHERE plan_id=$3 AND shop_id=$4
          AND (platform_activity_id IS NULL OR platform_activity_id=$1)`, [
          platformObjectId, timestamp, current.plan_id, activityShopId,
        ]);
        if (!Number(bound.rowCount || 0)) throw error("SHOPEE_DISCOUNT_RECONCILIATION_ACTIVITY_BIND_FAILED", "Verified activity could not be bound");
      }
      if (!current.plan_item_id && activityShopId && resetActivityItems) {
        await transaction.execute(`UPDATE ${this.#table("shopee_discount_execution_items")} SET status='PENDING',reason_code=NULL,updated_at=$1
          WHERE job_id=$2 AND status='UNKNOWN' AND plan_item_id IN
          (SELECT id FROM ${this.#table("shopee_discount_plan_items")} WHERE plan_id=$3 AND shop_id=$4)`, [timestamp, current.job_id, current.plan_id, activityShopId]);
      } else if (!current.plan_item_id && activityShopId && resolution === "ABANDONED") {
        await transaction.execute(`UPDATE ${this.#table("shopee_discount_execution_items")} SET status='SKIPPED',reason_code=$1,updated_at=$2
          WHERE job_id=$3 AND status=ANY($4::text[]) AND plan_item_id IN
          (SELECT id FROM ${this.#table("shopee_discount_plan_items")} WHERE plan_id=$5 AND shop_id=$6)`,
        [reasonCode, timestamp, current.job_id, ["UNKNOWN", "PENDING"], current.plan_id, activityShopId]);
      }
      return intentRow(result.rows[0]);
    });
  }

  async appendEvent(input) {
    const id = input.id || randomUUID(), timestamp = iso(input.occurredAt || this.now());
    const result = await this.provider.query(`INSERT INTO ${this.#table("shopee_discount_events")} (
      id,plan_id,job_id,intent_id,event_type,actor_id,reason_code,evidence_json,occurred_at,retention_until,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$9) RETURNING *`, [
      id, input.planId || null, input.jobId || null, input.intentId || null, text(input.eventType, "eventType"),
      input.actorId || null, input.reasonCode || null, JSON.stringify(input.evidence || {}), timestamp,
      input.retentionUntil ? iso(input.retentionUntil) : null,
    ]);
    const row = result.rows[0] || {};
    return {
      id: row.id || id,
      ...input,
      occurredAt: isoNullable(row.occurred_at) || timestamp,
      createdAt: isoNullable(row.created_at) || timestamp,
    };
  }

  async createDueJob(input) {
    const id = input.id || randomUUID(), timestamp = iso(input.createdAt || this.now());
    const result = await this.provider.query(`INSERT INTO ${this.#table("shopee_discount_due_jobs")} (
      id,job_type,dedupe_key,due_at,status,payload_json,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,'PENDING',$5::jsonb,$6,$6) RETURNING *`, [
      id, text(input.jobType, "jobType"), text(input.dedupeKey, "dedupeKey"), iso(input.dueAt), JSON.stringify(input.payload || {}), timestamp,
    ]);
    return dueJobRow(result.rows[0]);
  }

  async claimDueJobs({ now = this.now(), limit = 20, ownerId }) {
    const timestamp = iso(now), bounded = Math.min(100, Math.max(1, Number(limit) || 20)), owner = text(ownerId, "ownerId");
    const leaseUntil = new Date(new Date(timestamp).getTime() + 60_000).toISOString();
    return this.provider.transaction(async (transaction) => {
      const rows = (await transaction.query(`SELECT id,fencing_epoch FROM ${this.#table("shopee_discount_due_jobs")}
        WHERE due_at<=$1 AND (status='PENDING' OR (status='CLAIMED' AND lease_until<=$1))
        ORDER BY due_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`, [timestamp, bounded])).rows;
      const claimed = [];
      for (const row of rows) {
        const result = await transaction.query(`UPDATE ${this.#table("shopee_discount_due_jobs")} SET status='CLAIMED',owner_id=$1,
          fencing_epoch=$2,lease_until=$3,updated_at=$4 WHERE id=$5 AND fencing_epoch=$6
          AND (status='PENDING' OR (status='CLAIMED' AND lease_until<=$4)) RETURNING *`, [
          owner, Number(row.fencing_epoch) + 1, leaseUntil, timestamp, row.id, row.fencing_epoch,
        ]);
        if (result.rows[0]) claimed.push(dueJobRow(result.rows[0]));
      }
      return claimed;
    });
  }

  async completeDueJob(input) {
    const timestamp = iso(input.completedAt || this.now()), status = input.status || "SUCCEEDED";
    if (!new Set(["SUCCEEDED", "FAILED", "CANCELLED"]).has(status)) throw new TypeError("Due-job completion status is invalid");
    const result = await this.provider.execute(`UPDATE ${this.#table("shopee_discount_due_jobs")} SET status=$1,result_json=$2::jsonb,
      last_error_code=$3,completed_at=$4,updated_at=$4 WHERE id=$5 AND status='CLAIMED' AND owner_id=$6 AND fencing_epoch=$7`, [
      status, JSON.stringify(input.result || {}), input.lastErrorCode || null, timestamp,
      input.dueJobId || input.id, input.ownerId, input.epoch,
    ]);
    return Number(result.rowCount || 0) > 0;
  }
}
