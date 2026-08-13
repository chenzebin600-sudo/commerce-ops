import { randomUUID } from "node:crypto";
import { resolveSqliteProvider } from "../data/sqlite/sqlite-provider.mjs";
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

function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function bool(value) { return Boolean(Number(value)); }
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
function nonEmptyEvidence(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}

function settingsRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    encryptedWarehouseKeyCiphertext: row.encrypted_warehouse_key_ciphertext,
    warehouseKeyReference: row.warehouse_key_reference,
    warehouseKeyHint: row.warehouse_key_hint,
    warehouseKeyUpdatedAt: row.warehouse_key_updated_at,
    timezone: row.timezone,
    enabled: bool(row.enabled),
    metadata: sanitizeShopeeDiscountSettingsMetadata(json(row.metadata_json)),
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function planRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    foundationPlanId: row.foundation_plan_id,
    country: row.country,
    state: row.state,
    targetStartsAt: row.target_starts_at,
    targetEndsAt: row.target_ends_at,
    sourceSnapshotHash: row.source_snapshot_hash,
    policyHash: row.policy_hash,
    merkleRoot: row.merkle_root,
    itemCount: Number(row.item_count),
    shardCount: Number(row.shard_count),
    stateVersion: Number(row.state_version),
    reasonCode: row.reason_code,
    expiresAt: row.expires_at,
    sealedAt: row.sealed_at,
    approvedAt: row.approved_at,
    createdBy: row.created_by,
    retentionUntil: row.retention_until,
    summary: json(row.summary_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobRow(row) {
  if (!row) return null;
  return {
    id: row.id, planId: row.plan_id, foundationTaskId: row.foundation_task_id,
    jobType: row.job_type, status: row.status, ownerId: row.owner_id,
    epoch: Number(row.fencing_epoch), leaseUntil: row.lease_until,
    cursor: json(row.cursor_json), counters: json(row.counters_json), input: json(row.input_json),
    result: json(row.result_json), lastErrorCode: row.last_error_code, createdBy: row.created_by,
    startedAt: row.started_at, finishedAt: row.finished_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function intentRow(row) {
  if (!row) return null;
  return {
    id: row.id, jobId: row.job_id, planId: row.plan_id, planItemId: row.plan_item_id,
    operationUuid: row.operation_uuid, targetType: row.target_type, targetKey: row.target_key, attemptNo: Number(row.attempt_no || 1),
    payloadHash: row.payload_hash, epoch: Number(row.epoch), ownerId: row.owner_id, status: row.status,
    platformObjectId: row.platform_object_id, readback: json(row.readback_json, null),
    evidence: json(row.evidence_json, null), reconciledBy: row.reconciled_by,
    dispatchedAt: row.dispatched_at, completedAt: row.completed_at, reconciledAt: row.reconciled_at,
    updatedAt: row.updated_at,
  };
}

function dueJobRow(row) {
  if (!row) return null;
  return {
    id: row.id, jobType: row.job_type, dedupeKey: row.dedupe_key, dueAt: row.due_at,
    status: row.status, ownerId: row.owner_id, epoch: Number(row.fencing_epoch), leaseUntil: row.lease_until,
    payload: json(row.payload_json), result: json(row.result_json), lastErrorCode: row.last_error_code,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
  };
}

function planItemRow(row) {
  if (!row) return null;
  return {
    id: row.id, planId: row.plan_id, shardIndex: Number(row.shard_index), sequence: Number(row.sequence_no), shopId: row.shop_id,
    itemId: row.item_id, modelId: row.model_id, sku: row.sku, currency: row.currency, scale: Number(row.scale),
    currentPriceMinor: row.current_price_minor, controlPriceMinor: row.control_price_minor,
    targetPriceMinor: row.target_price_minor, payloadHash: row.payload_hash, payload: json(row.payload_json),
    executionStatus: row.execution_status, executionReasonCode: row.execution_reason_code,
  };
}

function executionItemRow(row) {
  if (!row) return null;
  return {
    ...planItemRow(row),
    jobId: row.execution_job_id,
    status: row.canonical_status,
    reasonCode: row.canonical_reason_code,
    intentId: row.execution_intent_id,
    platformObjectId: row.execution_platform_object_id,
    readback: json(row.execution_readback_json, null),
    evidence: json(row.execution_evidence_json),
    executionUpdatedAt: row.execution_updated_at,
  };
}

function activityRow(row) {
  if (!row) return null;
  return { id: row.id, planId: row.plan_id, shopId: row.shop_id, activityType: row.activity_type,
    platformActivityId: row.platform_activity_id, startsAt: row.target_starts_at, endsAt: row.target_ends_at,
    status: row.status, metadata: json(row.metadata_json) };
}

function eventRow(row) {
  if (!row) return null;
  return { id: row.id, planId: row.plan_id, jobId: row.job_id, eventType: row.event_type,
    code: row.reason_code, evidence: json(row.evidence_json), occurredAt: row.occurred_at };
}

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
      id: data.id || `${planId}:${shopId}`,
      shopId,
      activityType: data.activityType || "TARGET_PRICE",
      platformActivityId: data.platformActivityId || null,
      targetStartsAt: iso(data.targetStartsAt || data.startsAt || startsAt),
      targetEndsAt: iso(data.targetEndsAt || data.endsAt || endsAt),
      metadata: data.metadata || {},
    };
  });
}

export class ShopeeDiscountRepository {
  constructor({ provider, now = () => new Date() }) {
    this.provider = resolveSqliteProvider(provider);
    this.db = this.provider.connection;
    this.now = now;
  }

  async getStorageMode() {
    return { dialect: "sqlite", productionScale: false, pilotLimits: { shops: 1, variants: 10 } };
  }

  async getSettings() {
    return settingsRow(this.db.prepare("SELECT * FROM shopee_discount_settings WHERE id='default'").get());
  }

  async saveSettings(input = {}, audit = {}) {
    for (const key of Object.keys(input)) {
      if (PLAINTEXT_SETTING_KEYS.has(key)) {
        throw error("SHOPEE_DISCOUNT_PLAINTEXT_SECRET_REJECTED", `Plaintext credential field is forbidden: ${key}`);
      }
    }
    const current = this.db.prepare("SELECT * FROM shopee_discount_settings WHERE id='default'").get();
    const metadata = Object.hasOwn(input, "metadata")
      ? normalizeShopeeDiscountSettingsMetadata(input.metadata)
      : sanitizeShopeeDiscountSettingsMetadata(json(current.metadata_json));
    const timestamp = iso(audit.occurredAt || this.now());
    const pick = (key, column) => Object.hasOwn(input, key) ? input[key] : current[column];
    const encrypted = pick("encryptedWarehouseKeyCiphertext", "encrypted_warehouse_key_ciphertext") || null;
    const reference = pick("warehouseKeyReference", "warehouse_key_reference") || null;
    const hint = pick("warehouseKeyHint", "warehouse_key_hint") || null;
    const keyChanged = Object.hasOwn(input, "encryptedWarehouseKeyCiphertext") || Object.hasOwn(input, "warehouseKeyReference");
    this.db.prepare(`UPDATE shopee_discount_settings SET
      encrypted_warehouse_key_ciphertext=?,warehouse_key_reference=?,warehouse_key_hint=?,warehouse_key_updated_at=?,
      timezone=?,enabled=?,metadata_json=?,updated_by=?,updated_at=? WHERE id='default'`).run(
      encrypted, reference, hint, keyChanged ? timestamp : current.warehouse_key_updated_at,
      pick("timezone", "timezone"), Object.hasOwn(input, "enabled") ? Number(Boolean(input.enabled)) : current.enabled,
      JSON.stringify(metadata),
      audit.actorId || audit.actorName || current.updated_by || null, timestamp,
    );
    return this.getSettings();
  }

  async createPlan(input) {
    const id = input.id || randomUUID();
    const timestamp = iso(input.createdAt || this.now());
    const startsAt = iso(input.targetStartsAt || input.startsAt || input.targetWindow?.startsAt);
    const endsAt = iso(input.targetEndsAt || input.endsAt || input.targetWindow?.endsAt);
    if (endsAt <= startsAt) throw new RangeError("targetEndsAt must be after targetStartsAt");
    const activities = planActivities(input, id, startsAt, endsAt);
    const retentionUntil = iso(input.retentionUntil || afterYears(timestamp, 10));
    return this.provider.transactionManager.run(() => {
      const conflict = this.db.prepare(`SELECT a.plan_id FROM shopee_discount_activities a
        JOIN shopee_discount_plans p ON p.id=a.plan_id
        WHERE a.shop_id=? AND a.target_starts_at<? AND a.target_ends_at>?
          AND p.state IN (${ACTIVE_PLAN_STATES.map(() => "?").join(",")}) LIMIT 1`);
      for (const activity of activities) {
        if (conflict.get(activity.shopId, activity.targetEndsAt, activity.targetStartsAt, ...ACTIVE_PLAN_STATES)) {
          throw error("SHOPEE_DISCOUNT_ACTIVE_WINDOW_CONFLICT", `An active target plan overlaps for shop ${activity.shopId}`);
        }
      }
      this.db.prepare(`INSERT INTO shopee_discount_plans (
        id,foundation_plan_id,country,state,target_starts_at,target_ends_at,source_snapshot_hash,policy_hash,
        expires_at,created_by,retention_until,summary_json,created_at,updated_at
      ) VALUES (?,?,?,'PREVIEWING',?,?,?,?,?,?,?,?,?,?)`).run(
        id, input.foundationPlanId || null, text(input.country, "country"), startsAt, endsAt,
        text(input.sourceSnapshotHash, "sourceSnapshotHash"), text(input.policyHash, "policyHash"),
        input.expiresAt ? iso(input.expiresAt) : null, text(input.createdBy, "createdBy"), retentionUntil,
        JSON.stringify(input.summary || {}), timestamp, timestamp,
      );
      const insertActivity = this.db.prepare(`INSERT INTO shopee_discount_activities (
        id,plan_id,shop_id,activity_type,platform_activity_id,target_starts_at,target_ends_at,status,metadata_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,'PLANNED',?,?,?)`);
      for (const activity of activities) insertActivity.run(
        activity.id, id, activity.shopId, activity.activityType, activity.platformActivityId,
        activity.targetStartsAt, activity.targetEndsAt, JSON.stringify(activity.metadata), timestamp, timestamp,
      );
      return planRow(this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(id));
    });
  }

  async getPlan(id) {
    return planRow(this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(id));
  }

  async getPlanShopIds(planId) {
    return this.db.prepare("SELECT shop_id FROM shopee_discount_activities WHERE plan_id=? ORDER BY shop_id").all(planId).map(({ shop_id }) => shop_id);
  }

  async bindFoundationPlan(planId, foundationPlanId) {
    const result = this.db.prepare("UPDATE shopee_discount_plans SET foundation_plan_id=?,updated_at=? WHERE id=? AND state='PREVIEWING' AND (foundation_plan_id IS NULL OR foundation_plan_id=?)")
      .run(foundationPlanId, iso(this.now()), planId, foundationPlanId);
    if (!result.changes) throw error("SHOPEE_DISCOUNT_FOUNDATION_BIND_FAILED", "Domain plan could not bind Foundation plan");
    return this.getPlan(planId);
  }

  async listPlanShards(planId) {
    return this.db.prepare("SELECT shard_index,shard_hash,item_count FROM shopee_discount_plan_shards WHERE plan_id=? ORDER BY shard_index").all(planId)
      .map((row) => ({ shardIndex: Number(row.shard_index), shardHash: row.shard_hash, itemCount: Number(row.item_count) }));
  }
  async listPlanShardsPage(planId, { cursor = -1, pageSize = 100 } = {}) {
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const rows = this.db.prepare("SELECT shard_index,shard_hash,item_count FROM shopee_discount_plan_shards WHERE plan_id=? AND shard_index>? ORDER BY shard_index LIMIT ?").all(planId, Number(cursor), limit + 1);
    const items = rows.slice(0, limit).map((row) => ({ shardIndex: Number(row.shard_index), shardHash: row.shard_hash, itemCount: Number(row.item_count) }));
    return { items, nextCursor: rows.length > limit ? items.at(-1).shardIndex : null };
  }

  async listPlanItems(planId, { cursor = -1, pageSize = 50, shopId = null, status = null, code = null } = {}) {
    const clauses = ["plan_id=?", "sequence_no>?"]; const values = [planId, cursor];
    if (shopId) { clauses.push("shop_id=?"); values.push(shopId); }
    if (status) { clauses.push("execution_status=?"); values.push(status); }
    if (code) { clauses.push("execution_reason_code=?"); values.push(code); }
    const bounded = Math.max(1, Math.min(100, Number(pageSize) || 50));
    const rows = this.db.prepare(`SELECT * FROM shopee_discount_plan_items WHERE ${clauses.join(" AND ")} ORDER BY sequence_no LIMIT ?`).all(...values, bounded + 1);
    const page = rows.slice(0, bounded);
    return { items: page.map(planItemRow), nextCursor: rows.length > bounded ? String(page.at(-1).sequence_no) : null, pageSize: bounded };
  }

  async getPlanItem(planItemId) {
    return planItemRow(this.db.prepare("SELECT * FROM shopee_discount_plan_items WHERE id=?").get(planItemId));
  }

  async getPlanApproval(planId) {
    const row = this.db.prepare("SELECT * FROM shopee_discount_approvals WHERE plan_id=?").get(planId);
    return row ? { merkleRoot: row.merkle_root, policyHash: row.policy_hash, actorId: row.actor_id,
      actorName: row.actor_name, evidence: json(row.evidence_json), approvedAt: row.approved_at } : null;
  }

  async getApprovalSagaPhase(planId) {
    const row = this.db.prepare(`SELECT event_type,evidence_json,occurred_at FROM shopee_discount_events
      WHERE plan_id=? AND event_type LIKE 'APPROVAL_SAGA_%' ORDER BY
      CASE event_type WHEN 'APPROVAL_SAGA_COMPENSATION_FAILED' THEN 3 WHEN 'APPROVAL_SAGA_BOTH_APPROVED' THEN 2 ELSE 1 END DESC,
      occurred_at DESC,id DESC LIMIT 1`).get(planId);
    return row ? { phase: row.event_type.slice("APPROVAL_SAGA_".length), evidence: json(row.evidence_json), occurredAt: row.occurred_at } : null;
  }

  async recordApprovalSagaPhase(planId, phase, evidence = {}) {
    const normalized = text(phase, "approval phase");
    if (!new Set(["DOMAIN_APPROVED", "BOTH_APPROVED", "COMPENSATION_FAILED"]).has(normalized)) throw new TypeError("Unsupported approval saga phase");
    const id = `${planId}:approval-saga:${normalized}`;
    const existing = this.db.prepare("SELECT id FROM shopee_discount_events WHERE id=?").get(id);
    return existing || this.appendEvent({ id, planId, eventType: `APPROVAL_SAGA_${normalized}`,
      reasonCode: normalized === "COMPENSATION_FAILED" ? "SHOPEE_DISCOUNT_APPROVAL_COMPENSATION_FAILED" : null, evidence });
  }

  async countPlanItemsByShop(planId) {
    return this.db.prepare("SELECT shop_id,COUNT(*) item_count FROM shopee_discount_plan_items WHERE plan_id=? GROUP BY shop_id ORDER BY shop_id").all(planId)
      .map((row) => ({ shopId: row.shop_id, itemCount: Number(row.item_count) }));
  }

  async countPlanShops(planId) {
    return Number(this.db.prepare("SELECT COUNT(DISTINCT shop_id) count FROM shopee_discount_plan_items WHERE plan_id=?").get(planId).count);
  }

  async listExecutionJobs(planId) {
    return this.db.prepare("SELECT * FROM shopee_discount_jobs WHERE plan_id=? AND job_type='EXECUTE' ORDER BY created_at,id").all(planId).map(jobRow);
  }

  async getJob(jobId) {
    return jobRow(this.db.prepare("SELECT * FROM shopee_discount_jobs WHERE id=?").get(jobId));
  }

  async listPlanActivities(planId) {
    return this.db.prepare("SELECT * FROM shopee_discount_activities WHERE plan_id=? ORDER BY shop_id,id").all(planId).map(activityRow);
  }


  async getPlanActivity(planId, shopId) {
    return activityRow(this.db.prepare("SELECT * FROM shopee_discount_activities WHERE plan_id=? AND shop_id=? ORDER BY id LIMIT 1").get(planId, shopId));
  }
  async listPlanActivitiesPage(planId, { cursor = "", pageSize = 100 } = {}) {
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const rows = this.db.prepare("SELECT * FROM shopee_discount_activities WHERE plan_id=? AND shop_id>? ORDER BY shop_id,id LIMIT ?").all(planId, cursor, limit + 1);
    const items = rows.slice(0, limit).map(activityRow);
    return { items, nextCursor: rows.length > limit ? items.at(-1).shopId : null };
  }

  async listRunsScoped(filters = {}, authorizedShopIds = null) {
    const clauses = [], values = [];
    if (filters.status) { clauses.push("j.status=?"); values.push(filters.status); }
    if (filters.planId) { clauses.push("j.plan_id=?"); values.push(filters.planId); }
    if (authorizedShopIds) {
      if (!authorizedShopIds.length) return [];
      clauses.push(`NOT EXISTS (SELECT 1 FROM shopee_discount_activities a WHERE a.plan_id=j.plan_id AND a.shop_id NOT IN (${authorizedShopIds.map(() => "?").join(",")}))`);
      values.push(...authorizedShopIds);
    }
    values.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    return this.db.prepare(`SELECT j.* FROM shopee_discount_jobs j ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY j.created_at DESC,j.id LIMIT ?`).all(...values).map(jobRow);
  }

  async listActivitiesScoped(filters = {}, authorizedShopIds = null) {
    const clauses = [], values = [];
    if (filters.shopId) { clauses.push("shop_id=?"); values.push(filters.shopId); }
    if (filters.status) { clauses.push("status=?"); values.push(filters.status); }
    if (authorizedShopIds) {
      if (!authorizedShopIds.length) return [];
      clauses.push(`shop_id IN (${authorizedShopIds.map(() => "?").join(",")})`); values.push(...authorizedShopIds);
    }
    values.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    return this.db.prepare(`SELECT * FROM shopee_discount_activities ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY target_starts_at DESC,id LIMIT ?`).all(...values).map(activityRow);
  }

  async listIssuesScoped(filters = {}, authorizedShopIds = null) {
    const clauses = ["e.reason_code IS NOT NULL"], values = [];
    if (filters.planId) { clauses.push("e.plan_id=?"); values.push(filters.planId); }
    if (filters.code) { clauses.push("e.reason_code=?"); values.push(filters.code); }
    if (authorizedShopIds) {
      if (!authorizedShopIds.length) return [];
      clauses.push(`NOT EXISTS (SELECT 1 FROM shopee_discount_activities a WHERE a.plan_id=e.plan_id AND a.shop_id NOT IN (${authorizedShopIds.map(() => "?").join(",")}))`); values.push(...authorizedShopIds);
    }
    values.push(Math.max(1, Math.min(100, Number(filters.limit) || 50)));
    return this.db.prepare(`SELECT e.* FROM shopee_discount_events e WHERE ${clauses.join(" AND ")} ORDER BY e.occurred_at DESC,e.id LIMIT ?`).all(...values).map(eventRow);
  }

  async getStoredSystemActivity(shopId, platformActivityId) {
    const row = this.db.prepare(`SELECT * FROM shopee_discount_activities WHERE shop_id=? AND platform_activity_id=?
      AND json_extract(metadata_json,'$.systemManaged')=1 ORDER BY updated_at DESC LIMIT 1`).get(shopId, platformActivityId);
    return row ? activityRow(row) : null;
  }

  async getLatestWarehouseBaseline({ country, category, tier }) {
    const rows = this.db.prepare("SELECT evidence_json FROM shopee_discount_events WHERE event_type='WAREHOUSE_BASELINE' ORDER BY occurred_at DESC,id DESC LIMIT 500").all();
    for (const row of rows) {
      const value = json(row.evidence_json, null);
      if (value?.scope?.country === country && value.scope.category === category && value.scope.tier === tier) return value;
    }
    return null;
  }

  async saveWarehouseBaseline(input) {
    const existing = this.db.prepare("SELECT id FROM shopee_discount_events WHERE id=?").get(input.id);
    return existing || this.appendEvent({ id: input.id, eventType: "WAREHOUSE_BASELINE", evidence: input });
  }

  async listPlans(filters = {}) {
    const clauses = [], values = [];
    if (filters.country) { clauses.push("country=?"); values.push(filters.country); }
    if (filters.state) { clauses.push("state=?"); values.push(filters.state); }
    if (filters.createdBefore) { clauses.push("created_at<?"); values.push(iso(filters.createdBefore)); }
    if (filters.createdAfter) { clauses.push("created_at>=?"); values.push(iso(filters.createdAfter)); }
    if (filters.shopId) {
      clauses.push("EXISTS (SELECT 1 FROM shopee_discount_activities a WHERE a.plan_id=shopee_discount_plans.id AND a.shop_id=?)");
      values.push(filters.shopId);
    }
    const limit = Math.min(200, Math.max(1, Number(filters.limit) || 50));
    return this.db.prepare(`SELECT * FROM shopee_discount_plans ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC,id DESC LIMIT ?`).all(...values, limit).map(planRow);
  }

  async appendPlanShard({ planId, shardIndex, shardHash, items = [] }) {
    const timestamp = iso(this.now());
    return this.provider.transactionManager.run(() => {
      const plan = this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(planId);
      if (!plan) throw error("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
      if (plan.state !== "PREVIEWING") throw error("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Plan shards can only be appended while PREVIEWING");
      if (!Number.isInteger(shardIndex) || shardIndex < 0) throw new TypeError("shardIndex must be a non-negative integer");
      const shardId = `${planId}:${shardIndex}`;
      this.db.prepare(`INSERT INTO shopee_discount_plan_shards
        (id,plan_id,shard_index,shard_hash,item_count,created_at) VALUES (?,?,?,?,?,?)`).run(
        shardId, planId, shardIndex, text(shardHash, "shardHash"), items.length, timestamp,
      );
      const insert = this.db.prepare(`INSERT INTO shopee_discount_plan_items (
        id,plan_id,shard_id,shard_index,sequence_no,shop_id,item_id,model_id,item_key,sku,currency,scale,
        current_price_minor,control_price_minor,target_price_minor,payload_hash,payload_json,retention_until,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (let index = 0; index < items.length; index += 1) {
        const value = items[index];
        const shopId = text(value.shopId, "item.shopId");
        const itemId = text(value.itemId, "item.itemId");
        const modelId = text(value.modelId, "item.modelId");
        const itemKey = `${shopId}\u001f${itemId}\u001f${modelId}`;
        if (value.itemKey != null && value.itemKey !== itemKey) throw new TypeError("itemKey must use canonical shop/item/model identity");
        const sequence = Number.isInteger(value.sequence) ? value.sequence : (shardIndex * 10_000 + index);
        insert.run(
          value.id || randomUUID(), planId, shardId, shardIndex, sequence, shopId, itemId, modelId, itemKey,
          text(value.sku, "item.sku"), text(value.currency, "item.currency"), value.scale,
          text(value.currentPriceMinor ?? value.sourcePriceMinor, "item.currentPriceMinor"),
          value.controlPriceMinor == null ? null : String(value.controlPriceMinor),
          text(value.targetPriceMinor, "item.targetPriceMinor"), text(value.payloadHash, "item.payloadHash"),
          JSON.stringify(value.payload || {}), iso(value.retentionUntil || afterYears(timestamp, 2)), timestamp,
        );
      }
      return { planId, shardIndex, shardHash, itemCount: items.length, createdAt: timestamp };
    });
  }

  async sealPlan({ planId, merkleRoot, itemCount, shardCount, expectedVersion }) {
    return this.provider.transactionManager.run(() => {
      const plan = this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(planId);
      if (!plan) throw error("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
      if (Number(plan.state_version) !== Number(expectedVersion)) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      if (plan.state !== "PREVIEWING") throw error("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Only PREVIEWING plans may be sealed");
      const shards = this.db.prepare(`SELECT shard_index,item_count FROM shopee_discount_plan_shards
        WHERE plan_id=? ORDER BY shard_index`).all(planId);
      const contiguous = shards.length === Number(shardCount)
        && shards.every((row, index) => Number(row.shard_index) === index)
        && shards.reduce((sum, row) => sum + Number(row.item_count), 0) === Number(itemCount);
      if (!contiguous) throw error("SHOPEE_DISCOUNT_SHARDS_NOT_CONTIGUOUS", "Plan shards must be contiguous and counts must match");
      const timestamp = iso(this.now());
      const result = this.db.prepare(`UPDATE shopee_discount_plans SET state='PREVIEWED',merkle_root=?,item_count=?,shard_count=?,
        state_version=state_version+1,sealed_at=?,updated_at=? WHERE id=? AND state='PREVIEWING' AND state_version=?`).run(
        text(merkleRoot, "merkleRoot"), itemCount, shardCount, timestamp, timestamp, planId, expectedVersion,
      );
      if (!result.changes) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      return planRow(this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(planId));
    });
  }

  async approvePlan({ planId, merkleRoot, policyHash, approval = {}, expectedVersion }) {
    return this.provider.transactionManager.run(() => {
      const plan = this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(planId);
      if (!plan) throw error("SHOPEE_DISCOUNT_PLAN_NOT_FOUND", "Shopee Discount plan was not found");
      if (Number(plan.state_version) !== Number(expectedVersion)) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      if (plan.state !== "PREVIEWED") throw error("SHOPEE_DISCOUNT_PLAN_IMMUTABLE", "Only PREVIEWED plans may be approved");
      if (plan.merkle_root !== merkleRoot) throw error("SHOPEE_DISCOUNT_APPROVAL_ROOT_MISMATCH", "Approval Merkle root does not match the sealed plan");
      if (plan.policy_hash !== policyHash) throw error("SHOPEE_DISCOUNT_APPROVAL_POLICY_MISMATCH", "Approval policy hash does not match the plan");
      const timestamp = iso(approval.approvedAt || this.now());
      this.db.prepare(`INSERT INTO shopee_discount_approvals (
        id,plan_id,merkle_root,policy_hash,approval_mode,actor_id,actor_name,evidence_json,approved_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        approval.id || randomUUID(), planId, merkleRoot, policyHash, approval.mode || "human",
        text(approval.actorId, "approval.actorId"), approval.actorName || null, JSON.stringify(approval.evidence || {}), timestamp, timestamp,
      );
      const result = this.db.prepare(`UPDATE shopee_discount_plans SET state='APPROVED',state_version=state_version+1,
        approved_at=?,updated_at=? WHERE id=? AND state='PREVIEWED' AND state_version=?`).run(timestamp, timestamp, planId, expectedVersion);
      if (!result.changes) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan version changed");
      return planRow(this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(planId));
    });
  }

  async markPlanState({ planId, fromState, toState, expectedVersion, reasonCode = null }) {
    if (!PLAN_STATES.has(fromState) || !PLAN_STATES.has(toState)) throw new TypeError("Unsupported Shopee Discount plan state");
    if (fromState === toState || !PLAN_TRANSITIONS[fromState].has(toState)) {
      throw error("SHOPEE_DISCOUNT_PLAN_TRANSITION_INVALID", `Plan cannot transition from ${fromState} to ${toState}`);
    }
    const timestamp = iso(this.now());
    return this.provider.transactionManager.run(() => {
      const result = this.db.prepare(`UPDATE shopee_discount_plans SET state=?,reason_code=?,state_version=state_version+1,updated_at=?
        WHERE id=? AND state=? AND state_version=?`).run(toState, reasonCode, timestamp, planId, fromState, expectedVersion);
      if (!result.changes) throw error("SHOPEE_DISCOUNT_PLAN_VERSION_CONFLICT", "Plan state or version changed");
      if (["PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"].includes(toState)) {
        this.db.prepare(`UPDATE shopee_discount_activities SET status=?,updated_at=? WHERE plan_id=?`).run(
          toState === "CANCELLED" ? "CANCELLED" : "ENDED", timestamp, planId,
        );
      } else if (toState === "EXECUTING") {
        this.db.prepare("UPDATE shopee_discount_activities SET status='ACTIVE',updated_at=? WHERE plan_id=?").run(timestamp, planId);
      }
      return planRow(this.db.prepare("SELECT * FROM shopee_discount_plans WHERE id=?").get(planId));
    });
  }

  async createJob(input) {
    const id = input.id || randomUUID();
    const timestamp = iso(input.createdAt || this.now());
    this.db.prepare(`INSERT INTO shopee_discount_jobs (
      id,plan_id,foundation_task_id,job_type,status,input_json,created_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)`).run(
      id, text(input.planId, "planId"), input.foundationTaskId || null, text(input.jobType, "jobType"),
      input.status || "PENDING", JSON.stringify(input.input || {}), text(input.createdBy, "createdBy"), timestamp, timestamp,
    );
    return jobRow(this.db.prepare("SELECT * FROM shopee_discount_jobs WHERE id=?").get(id));
  }

  async prepareExecutionItems({ jobId, planId, ownerId, epoch }) {
    const timestamp = iso(this.now());
    return this.provider.transactionManager.run(() => {
      const job = this.db.prepare(`SELECT id FROM shopee_discount_jobs WHERE id=? AND plan_id=? AND status='RUNNING'
        AND owner_id=? AND fencing_epoch=? AND lease_until>?`).get(jobId, planId, ownerId, epoch, timestamp);
      if (!job) throw error("SHOPEE_DISCOUNT_STALE_EPOCH", "Execution checkpoint initialization rejected for stale ownership");
      this.db.prepare(`INSERT OR IGNORE INTO shopee_discount_execution_items
        (job_id,plan_item_id,status,evidence_json,created_at,updated_at)
        SELECT ?,id,'PENDING','{}',?,? FROM shopee_discount_plan_items WHERE plan_id=?`).run(jobId, timestamp, timestamp, planId);
      return this.db.prepare("SELECT COUNT(*) count FROM shopee_discount_execution_items WHERE job_id=?").get(jobId).count;
    });
  }

  async listExecutionItems(jobId, { shopId = null, statuses = null } = {}) {
    const clauses = ["e.job_id=?"], values = [jobId];
    if (shopId) { clauses.push("i.shop_id=?"); values.push(shopId); }
    if (statuses) {
      if (!Array.isArray(statuses) || !statuses.length) return [];
      clauses.push(`e.status IN (${statuses.map(() => "?").join(",")})`); values.push(...statuses);
    }
    return this.db.prepare(`SELECT i.*,e.job_id execution_job_id,e.status canonical_status,
      e.reason_code canonical_reason_code,e.intent_id execution_intent_id,
      e.platform_object_id execution_platform_object_id,e.readback_json execution_readback_json,
      e.evidence_json execution_evidence_json,e.updated_at execution_updated_at
      FROM shopee_discount_execution_items e JOIN shopee_discount_plan_items i ON i.id=e.plan_item_id
      WHERE ${clauses.join(" AND ")} ORDER BY i.shop_id,i.sequence_no`).all(...values).map(executionItemRow);
  }

  async listExecutionItemsPage(jobId, { cursor = -1, pageSize = 100, shopId = null, statuses = null } = {}) {
    const clauses = ["e.job_id=?", "i.sequence_no>?"], values = [jobId, Number(cursor)];
    if (shopId) { clauses.push("i.shop_id=?"); values.push(shopId); }
    if (statuses) {
      if (!Array.isArray(statuses) || !statuses.length) return { items: [], nextCursor: null };
      clauses.push(`e.status IN (${statuses.map(() => "?").join(",")})`); values.push(...statuses);
    }
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const rows = this.db.prepare(`SELECT i.*,e.job_id execution_job_id,e.status canonical_status,
      e.reason_code canonical_reason_code,e.intent_id execution_intent_id,e.platform_object_id execution_platform_object_id,
      e.readback_json execution_readback_json,e.evidence_json execution_evidence_json,e.updated_at execution_updated_at
      FROM shopee_discount_execution_items e JOIN shopee_discount_plan_items i ON i.id=e.plan_item_id
      WHERE ${clauses.join(" AND ")} ORDER BY i.sequence_no LIMIT ?`).all(...values, limit + 1);
    const page = rows.slice(0, limit).map(executionItemRow);
    return { items: page, nextCursor: rows.length > limit ? page.at(-1).sequence : null };
  }

  async countExecutionItemsByStatus(jobId) {
    return Object.fromEntries(this.db.prepare("SELECT status,COUNT(*) count FROM shopee_discount_execution_items WHERE job_id=? GROUP BY status").all(jobId)
      .map((row) => [row.status, Number(row.count)]));
  }

  async setExecutionItemStatus({ jobId, planItemId, ownerId, epoch, status, reasonCode = null, evidence = {} }) {
    const allowed = new Set(["PENDING", "SUCCEEDED", "REJECTED", "CONFLICT", "AUTH_BLOCKED", "UNKNOWN", "REQUIRES_REAPPROVAL", "SKIPPED"]);
    if (!allowed.has(status)) throw new TypeError("Unsupported execution item status");
    const timestamp = iso(this.now());
    const result = this.db.prepare(`UPDATE shopee_discount_execution_items SET status=?,reason_code=?,evidence_json=?,updated_at=?
      WHERE job_id=? AND plan_item_id=? AND status!='SUCCEEDED'
      AND EXISTS (SELECT 1 FROM shopee_discount_jobs j WHERE j.id=job_id AND j.status='RUNNING'
        AND j.owner_id=? AND j.fencing_epoch=? AND j.lease_until>?)`).run(
      status, reasonCode, JSON.stringify(evidence), timestamp, jobId, planItemId, ownerId, epoch, timestamp,
    );
    return Boolean(result.changes);
  }

  async claimJob({ jobId, ownerId, leaseMs }) {
    const owner = text(ownerId, "ownerId");
    const duration = Math.max(1, Number(leaseMs) || 0);
    return this.provider.transactionManager.run(() => {
      const row = this.db.prepare("SELECT * FROM shopee_discount_jobs WHERE id=?").get(jobId);
      if (!row || !["PENDING", "RUNNING"].includes(row.status)) return { claimed: false, epoch: row ? Number(row.fencing_epoch) : null, leaseUntil: row?.lease_until || null };
      const now = iso(this.now());
      const leaseUntil = new Date(new Date(now).getTime() + duration).toISOString();
      const live = row.lease_until && row.lease_until > now;
      if (live && row.owner_id !== owner) return { claimed: false, epoch: Number(row.fencing_epoch), leaseUntil: row.lease_until };
      const sameLiveOwner = live && row.owner_id === owner;
      const epoch = sameLiveOwner ? Number(row.fencing_epoch) : Number(row.fencing_epoch) + 1;
      const result = this.db.prepare(`UPDATE shopee_discount_jobs SET status='RUNNING',owner_id=?,fencing_epoch=?,lease_until=?,
        started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND fencing_epoch=?`).run(
        owner, epoch, leaseUntil, now, now, jobId, row.fencing_epoch,
      );
      return { claimed: Boolean(result.changes), epoch, leaseUntil };
    });
  }

  async renewJobLease({ jobId, ownerId, epoch, leaseMs }) {
    const now = iso(this.now());
    const leaseUntil = new Date(new Date(now).getTime() + Math.max(1, Number(leaseMs) || 0)).toISOString();
    const result = this.db.prepare(`UPDATE shopee_discount_jobs SET lease_until=?,updated_at=?
      WHERE id=? AND status='RUNNING' AND owner_id=? AND fencing_epoch=? AND lease_until>?`).run(
      leaseUntil, now, jobId, ownerId, epoch, now,
    );
    return Boolean(result.changes);
  }

  async checkpointJob({ jobId, ownerId, epoch, cursor = {}, counters = {} }) {
    const now = iso(this.now());
    const result = this.db.prepare(`UPDATE shopee_discount_jobs SET cursor_json=?,counters_json=?,updated_at=?
      WHERE id=? AND status='RUNNING' AND owner_id=? AND fencing_epoch=? AND lease_until>?`).run(
      JSON.stringify(cursor), JSON.stringify(counters), now, jobId, ownerId, epoch, now,
    );
    return Boolean(result.changes);
  }

  async createDispatchIntent(input) {
    const id = input.id || randomUUID();
    const now = iso(this.now());
    const dispatchedAt = iso(input.dispatchedAt || now);
    const uuid = operationUuid(input.operationUuid);
    return this.provider.transactionManager.run(() => {
      const job = this.db.prepare(`SELECT id FROM shopee_discount_jobs
        WHERE id=? AND plan_id=? AND status='RUNNING' AND owner_id=? AND fencing_epoch=? AND lease_until>?`).get(
        input.jobId, input.planId, input.ownerId, input.epoch, now,
      );
      if (!job) throw error("SHOPEE_DISCOUNT_STALE_EPOCH", "Dispatch intent rejected for stale job ownership");
      const attemptNo = Number(this.db.prepare(`SELECT COALESCE(MAX(attempt_no),0)+1 attempt_no FROM shopee_discount_dispatch_intents
        WHERE job_id=? AND target_type=? AND target_key=?`).get(input.jobId, input.targetType, input.targetKey).attempt_no);
      this.db.prepare(`INSERT INTO shopee_discount_dispatch_intents (
        id,job_id,plan_id,plan_item_id,operation_uuid,target_type,target_key,attempt_no,payload_hash,epoch,owner_id,status,dispatched_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?)`).run(
        id, input.jobId, input.planId, input.planItemId || null, uuid,
        text(input.targetType, "targetType"), text(input.targetKey, "targetKey"), attemptNo, text(input.payloadHash, "payloadHash"),
        input.epoch, input.ownerId, dispatchedAt, now,
      );
      if (input.planItemId) {
        const checkpoint = this.db.prepare(`UPDATE shopee_discount_execution_items SET status='DISPATCHED',intent_id=?,updated_at=?
          WHERE job_id=? AND plan_item_id=? AND status='PENDING'`).run(id, now, input.jobId, input.planItemId);
        if (!checkpoint.changes) throw error("SHOPEE_DISCOUNT_ITEM_NOT_DISPATCHABLE", "Execution item is not pending dispatch");
      }
      return intentRow(this.db.prepare("SELECT * FROM shopee_discount_dispatch_intents WHERE id=?").get(id));
    });
  }

  async getDispatchIntent(intentId) {
    return intentRow(this.db.prepare("SELECT * FROM shopee_discount_dispatch_intents WHERE id=?").get(intentId));
  }

  async listDispatchIntents({ jobId, statuses = null } = {}) {
    const clauses = ["job_id=?"], values = [jobId];
    if (statuses) {
      if (!Array.isArray(statuses) || !statuses.length) return [];
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); values.push(...statuses);
    }
    return this.db.prepare(`SELECT * FROM shopee_discount_dispatch_intents WHERE ${clauses.join(" AND ")} ORDER BY dispatched_at,id`)
      .all(...values).map(intentRow);
  }

  async listDispatchIntentsPage({ jobId, statuses = null, cursor = null, pageSize = 100 } = {}) {
    const clauses = ["job_id=?"], values = [jobId];
    if (statuses) {
      if (!Array.isArray(statuses) || !statuses.length) return { items: [], nextCursor: null };
      clauses.push(`status IN (${statuses.map(() => "?").join(",")})`); values.push(...statuses);
    }
    if (cursor) { clauses.push("(dispatched_at>? OR (dispatched_at=? AND id>?))"); values.push(cursor.dispatchedAt, cursor.dispatchedAt, cursor.id); }
    const limit = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const rows = this.db.prepare(`SELECT * FROM shopee_discount_dispatch_intents WHERE ${clauses.join(" AND ")} ORDER BY dispatched_at,id LIMIT ?`).all(...values, limit + 1);
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
    return this.provider.transactionManager.run(() => {
      const current = this.db.prepare(`SELECT i.* FROM shopee_discount_dispatch_intents i
        JOIN shopee_discount_jobs j ON j.id=i.job_id WHERE i.id=? AND i.job_id=? AND i.status IN ('DISPATCHED','UNKNOWN')
        AND j.status='RUNNING' AND j.owner_id=? AND j.fencing_epoch=? AND j.lease_until>?`).get(
        intentId, jobId, ownerId, epoch, timestamp,
      );
      if (!current) return false;
      this.db.prepare(`UPDATE shopee_discount_dispatch_intents SET status=?,platform_object_id=?,readback_json=?,evidence_json=?,
        completed_at=CASE WHEN ?='SUCCEEDED' THEN ? ELSE completed_at END,updated_at=? WHERE id=?`).run(
        intentStatus, platformObjectId, readback ? JSON.stringify(readback) : null, JSON.stringify(evidence),
        intentStatus, timestamp, timestamp, intentId,
      );
      if (current.plan_item_id) this.db.prepare(`UPDATE shopee_discount_execution_items SET status=?,reason_code=?,
        platform_object_id=?,readback_json=?,evidence_json=?,updated_at=? WHERE job_id=? AND plan_item_id=? AND status!='SUCCEEDED'`).run(
        itemStatus, reasonCode, platformObjectId, readback ? JSON.stringify(readback) : null, JSON.stringify(evidence),
        timestamp, jobId, current.plan_item_id,
      );
      return true;
    });
  }

  async bindActivityPlatformId({ jobId, planId, shopId, ownerId, epoch, platformActivityId, evidence = {} }) {
    const timestamp = iso(this.now());
    const result = this.db.prepare(`UPDATE shopee_discount_activities SET platform_activity_id=?,metadata_json=json_set(metadata_json,'$.bindingEvidence',json(?)),updated_at=?
      WHERE plan_id=? AND shop_id=? AND EXISTS (SELECT 1 FROM shopee_discount_jobs j WHERE j.id=? AND j.status='RUNNING'
        AND j.owner_id=? AND j.fencing_epoch=? AND j.lease_until>?)`).run(
      text(platformActivityId, "platformActivityId"), JSON.stringify(evidence), timestamp, planId, shopId,
      jobId, ownerId, epoch, timestamp,
    );
    return Boolean(result.changes);
  }

  async completeJob({ jobId, ownerId, epoch, status, result = {}, counters = {} }) {
    if (!new Set(["PARTIAL_SUCCESS", "SUCCEEDED", "FAILED", "BLOCKED"]).has(status)) throw new TypeError("Unsupported job outcome");
    const timestamp = iso(this.now());
    const updated = this.db.prepare(`UPDATE shopee_discount_jobs SET status=?,result_json=?,counters_json=?,finished_at=?,updated_at=?
      WHERE id=? AND status='RUNNING' AND owner_id=? AND fencing_epoch=? AND lease_until>?`).run(
      status, JSON.stringify(result), JSON.stringify(counters), timestamp, timestamp, jobId, ownerId, epoch, timestamp,
    );
    return Boolean(updated.changes);
  }

  async completeDispatchIntent({ intentId, ownerId, epoch, platformObjectId, readback }) {
    if (!nonEmptyEvidence(readback)) throw new TypeError("Conclusive readback evidence is required");
    const timestamp = iso(this.now());
    const result = this.db.prepare(`UPDATE shopee_discount_dispatch_intents SET status='SUCCEEDED',platform_object_id=?,readback_json=?,
      completed_at=?,updated_at=? WHERE id=? AND status='DISPATCHED' AND owner_id=? AND epoch=?
      AND EXISTS (SELECT 1 FROM shopee_discount_jobs j WHERE j.id=job_id AND j.owner_id=? AND j.fencing_epoch=? AND j.lease_until>?)`).run(
      platformObjectId || null, JSON.stringify(readback), timestamp, timestamp, intentId, ownerId, epoch, ownerId, epoch, timestamp,
    );
    return Boolean(result.changes);
  }

  async markDispatchUnknown({ intentId, ownerId, epoch, evidence }) {
    if (!nonEmptyEvidence(evidence)) throw new TypeError("UNKNOWN evidence is required");
    const timestamp = iso(this.now());
    const result = this.db.prepare(`UPDATE shopee_discount_dispatch_intents SET status='UNKNOWN',evidence_json=?,updated_at=?
      WHERE id=? AND status='DISPATCHED' AND owner_id=? AND epoch=?
      AND EXISTS (SELECT 1 FROM shopee_discount_jobs j WHERE j.id=job_id AND j.owner_id=? AND j.fencing_epoch=? AND j.lease_until>?)`).run(
      JSON.stringify(evidence), timestamp, intentId, ownerId, epoch, ownerId, epoch, timestamp,
    );
    return Boolean(result.changes);
  }

  async reconcileIntent({ intentId, resolution, evidence, actor = {}, platformObjectId = null, readback = null,
    executionStatus = null, reasonCode = null, activityShopId = null, resetActivityItems = false }) {
    if (!CLOSED_RECONCILIATIONS.has(resolution) || !nonEmptyEvidence(evidence)) {
      throw error("SHOPEE_DISCOUNT_RECONCILIATION_INVALID", "A closed reconciliation resolution and evidence are required");
    }
    return this.provider.transactionManager.run(() => {
      const current = this.db.prepare("SELECT * FROM shopee_discount_dispatch_intents WHERE id=?").get(intentId);
      if (!current) throw error("SHOPEE_DISCOUNT_INTENT_NOT_FOUND", "Dispatch intent was not found");
      if (!["UNKNOWN", "DISPATCHED"].includes(current.status)) {
        throw error("SHOPEE_DISCOUNT_RECONCILIATION_CLOSED", "Dispatch intent reconciliation is already closed");
      }
      const timestamp = iso(this.now());
      this.db.prepare(`UPDATE shopee_discount_dispatch_intents SET status=?,platform_object_id=COALESCE(?,platform_object_id),
        readback_json=COALESCE(?,readback_json),evidence_json=?,reconciled_by=?,reconciled_at=?,completed_at=?,updated_at=?
        WHERE id=? AND status IN ('UNKNOWN','DISPATCHED')`).run(
        resolution, platformObjectId, readback ? JSON.stringify(readback) : null, JSON.stringify(evidence),
        actor.id || actor.actorId || String(actor || "system"), timestamp, timestamp, timestamp, intentId,
      );
      if (current.plan_item_id && executionStatus) {
        if (!new Set(["SUCCEEDED", "SKIPPED", "UNKNOWN"]).has(executionStatus)) throw new TypeError("Unsupported reconciliation item status");
        this.db.prepare(`UPDATE shopee_discount_execution_items SET status=?,reason_code=?,platform_object_id=COALESCE(?,platform_object_id),
          readback_json=COALESCE(?,readback_json),evidence_json=?,updated_at=? WHERE job_id=? AND plan_item_id=?`).run(
          executionStatus, reasonCode, platformObjectId, readback ? JSON.stringify(readback) : null,
          JSON.stringify(evidence), timestamp, current.job_id, current.plan_item_id,
        );
      }
      if (!current.plan_item_id && activityShopId && platformObjectId) {
        const bound = this.db.prepare(`UPDATE shopee_discount_activities SET platform_activity_id=?,updated_at=?
          WHERE plan_id=? AND shop_id=? AND (platform_activity_id IS NULL OR platform_activity_id=?)`).run(
          platformObjectId, timestamp, current.plan_id, activityShopId, platformObjectId,
        );
        if (!bound.changes) throw error("SHOPEE_DISCOUNT_RECONCILIATION_ACTIVITY_BIND_FAILED", "Verified activity could not be bound");
      }
      if (!current.plan_item_id && activityShopId && resetActivityItems) {
        this.db.prepare(`UPDATE shopee_discount_execution_items SET status='PENDING',reason_code=NULL,updated_at=?
          WHERE job_id=? AND status='UNKNOWN' AND plan_item_id IN
          (SELECT id FROM shopee_discount_plan_items WHERE plan_id=? AND shop_id=?)`).run(timestamp, current.job_id, current.plan_id, activityShopId);
      } else if (!current.plan_item_id && activityShopId && resolution === "ABANDONED") {
        this.db.prepare(`UPDATE shopee_discount_execution_items SET status='SKIPPED',reason_code=?,updated_at=?
          WHERE job_id=? AND status IN ('UNKNOWN','PENDING') AND plan_item_id IN
          (SELECT id FROM shopee_discount_plan_items WHERE plan_id=? AND shop_id=?)`).run(reasonCode, timestamp, current.job_id, current.plan_id, activityShopId);
      }
      return intentRow(this.db.prepare("SELECT * FROM shopee_discount_dispatch_intents WHERE id=?").get(intentId));
    });
  }

  async appendEvent(input) {
    const id = input.id || randomUUID();
    const timestamp = iso(input.occurredAt || this.now());
    this.db.prepare(`INSERT INTO shopee_discount_events (
      id,plan_id,job_id,intent_id,event_type,actor_id,reason_code,evidence_json,occurred_at,retention_until,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.planId || null, input.jobId || null, input.intentId || null, text(input.eventType, "eventType"),
      input.actorId || null, input.reasonCode || null, JSON.stringify(input.evidence || {}), timestamp,
      input.retentionUntil ? iso(input.retentionUntil) : null, timestamp,
    );
    return { id, ...input, occurredAt: timestamp, createdAt: timestamp };
  }

  async createDueJob(input) {
    const id = input.id || randomUUID();
    const timestamp = iso(input.createdAt || this.now());
    this.db.prepare(`INSERT INTO shopee_discount_due_jobs (
      id,job_type,dedupe_key,due_at,status,payload_json,created_at,updated_at
    ) VALUES (?,?,?,?,'PENDING',?,?,?)`).run(
      id, text(input.jobType, "jobType"), text(input.dedupeKey, "dedupeKey"), iso(input.dueAt),
      JSON.stringify(input.payload || {}), timestamp, timestamp,
    );
    return dueJobRow(this.db.prepare("SELECT * FROM shopee_discount_due_jobs WHERE id=?").get(id));
  }

  async claimDueJobs({ now = this.now(), limit = 20, ownerId }) {
    const timestamp = iso(now);
    const bounded = Math.min(100, Math.max(1, Number(limit) || 20));
    const owner = text(ownerId, "ownerId");
    const leaseUntil = new Date(new Date(timestamp).getTime() + 60_000).toISOString();
    return this.provider.transactionManager.run(() => {
      const rows = this.db.prepare(`SELECT * FROM shopee_discount_due_jobs
        WHERE due_at<=? AND (status='PENDING' OR (status='CLAIMED' AND lease_until<=?))
        ORDER BY due_at,id LIMIT ?`).all(timestamp, timestamp, bounded);
      const claimed = [];
      for (const row of rows) {
        const epoch = Number(row.fencing_epoch) + 1;
        const result = this.db.prepare(`UPDATE shopee_discount_due_jobs SET status='CLAIMED',owner_id=?,fencing_epoch=?,lease_until=?,updated_at=?
          WHERE id=? AND fencing_epoch=? AND (status='PENDING' OR (status='CLAIMED' AND lease_until<=?))`).run(
          owner, epoch, leaseUntil, timestamp, row.id, row.fencing_epoch, timestamp,
        );
        if (result.changes) claimed.push(dueJobRow(this.db.prepare("SELECT * FROM shopee_discount_due_jobs WHERE id=?").get(row.id)));
      }
      return claimed;
    });
  }

  async completeDueJob(input) {
    const timestamp = iso(input.completedAt || this.now());
    const status = input.status || "SUCCEEDED";
    if (!new Set(["SUCCEEDED", "FAILED", "CANCELLED"]).has(status)) throw new TypeError("Due-job completion status is invalid");
    const result = this.db.prepare(`UPDATE shopee_discount_due_jobs SET status=?,result_json=?,last_error_code=?,completed_at=?,updated_at=?
      WHERE id=? AND status='CLAIMED' AND owner_id=? AND fencing_epoch=?`).run(
      status, JSON.stringify(input.result || {}), input.lastErrorCode || null, timestamp, timestamp,
      input.dueJobId || input.id, input.ownerId, input.epoch,
    );
    return Boolean(result.changes);
  }
}
