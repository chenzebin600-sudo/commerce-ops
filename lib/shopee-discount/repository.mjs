import { randomUUID } from "node:crypto";
import { resolveSqliteProvider } from "../data/sqlite/sqlite-provider.mjs";

const PLAN_STATES = new Set([
  "PREVIEWING", "PREVIEWED", "APPROVED", "EXECUTING", "PARTIAL_SUCCESS",
  "SUCCEEDED", "FAILED", "BLOCKED", "EXPIRED", "CANCELLED",
]);
const ACTIVE_PLAN_STATES = ["PREVIEWING", "PREVIEWED", "APPROVED", "EXECUTING", "BLOCKED"];
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
const SENSITIVE_METADATA_KEYS = new Set([
  "password", "passwd", "secret", "token", "accesstoken", "refreshtoken", "cookie", "authorization",
  "apikey", "warehousekey", "warehouseapikey", "warehousetoken", "warehousesecret",
]);

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
function isSensitiveMetadataKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_METADATA_KEYS.has(normalized)
    || normalized.endsWith("password") || normalized.endsWith("secret")
    || normalized.endsWith("token") || normalized.endsWith("apikey");
}
function assertNoSensitiveMetadata(value, path = "metadata") {
  if (value == null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveMetadata(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveMetadataKey(key)) {
      throw error("SHOPEE_DISCOUNT_PLAINTEXT_SECRET_REJECTED", `Plaintext credential metadata is forbidden: ${path}.${key}`);
    }
    assertNoSensitiveMetadata(nested, `${path}.${key}`);
  }
}
function sanitizedMetadata(value) {
  if (Array.isArray(value)) return value.map(sanitizedMetadata);
  if (value == null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isSensitiveMetadataKey(key))
    .map(([key, nested]) => [key, sanitizedMetadata(nested)]));
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
    metadata: sanitizedMetadata(json(row.metadata_json)),
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
    operationUuid: row.operation_uuid, targetType: row.target_type, targetKey: row.target_key,
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
    if (Object.hasOwn(input, "metadata")) assertNoSensitiveMetadata(input.metadata);
    const current = this.db.prepare("SELECT * FROM shopee_discount_settings WHERE id='default'").get();
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
      JSON.stringify(pick("metadata", "metadata_json") === current.metadata_json ? json(current.metadata_json) : input.metadata || {}),
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
      this.db.prepare(`INSERT INTO shopee_discount_dispatch_intents (
        id,job_id,plan_id,plan_item_id,operation_uuid,target_type,target_key,payload_hash,epoch,owner_id,status,dispatched_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,'DISPATCHED',?,?)`).run(
        id, input.jobId, input.planId, input.planItemId || null, uuid,
        text(input.targetType, "targetType"), text(input.targetKey, "targetKey"), text(input.payloadHash, "payloadHash"),
        input.epoch, input.ownerId, dispatchedAt, now,
      );
      return intentRow(this.db.prepare("SELECT * FROM shopee_discount_dispatch_intents WHERE id=?").get(id));
    });
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

  async reconcileIntent({ intentId, resolution, evidence, actor = {} }) {
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
      this.db.prepare(`UPDATE shopee_discount_dispatch_intents SET status=?,evidence_json=?,reconciled_by=?,
        reconciled_at=?,completed_at=?,updated_at=? WHERE id=? AND status IN ('UNKNOWN','DISPATCHED')`).run(
        resolution, JSON.stringify(evidence), actor.id || actor.actorId || String(actor || "system"),
        timestamp, timestamp, timestamp, intentId,
      );
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
