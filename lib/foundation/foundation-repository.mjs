import { randomUUID } from "node:crypto";
import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";
import {
  assertFoundationPriority,
  assertFoundationState,
  foundationStableId,
  parseFoundationJson,
  toJson,
} from "./foundation-contracts.mjs";

function iso(value = new Date()) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sameJson(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

function accountRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceSystem: row.source_system_code,
    displayName: row.display_name,
    credentialRefType: row.credential_ref_type,
    credentialRefId: row.credential_ref_id || null,
    status: row.status,
    metadata: parseFoundationJson(row.metadata_json, {}),
    lastVerifiedAt: row.last_verified_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain: row.domain,
    taskKind: row.task_kind,
    executionMode: row.execution_mode,
    authorityMode: row.authority_mode,
    domainRefType: row.domain_ref_type,
    domainRefId: row.domain_ref_id,
    sourceState: row.source_state || null,
    state: row.state,
    priority: row.priority,
    accountId: row.account_id || null,
    sourceRunId: row.source_run_id || null,
    ownerId: row.owner_id || null,
    storeId: row.store_id || null,
    warehouseId: row.warehouse_id || null,
    skuId: row.sku_id || null,
    idempotencyKey: row.idempotency_key,
    attemptCount: number(row.attempt_count),
    maxAttempts: number(row.max_attempts, 3),
    availableAt: row.available_at || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    input: parseFoundationJson(row.input_json, {}),
    evidence: parseFoundationJson(row.evidence_json, {}),
    result: parseFoundationJson(row.result_json, {}),
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    stateVersion: number(row.state_version, 1),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class FoundationRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }

  async isReady() {
    return this.sql.relationExists("foundation_tasks");
  }

  async tableExists(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ""))) {
      throw new TypeError("Table name is invalid");
    }
    return this.sql.relationExists(name);
  }

  async listAccounts({ sourceSystem = null, capability = null, status = null } = {}) {
    const filters = [];
    const parameters = [];
    let join = "";
    if (capability) {
      join = ` JOIN foundation_account_capabilities capability
        ON capability.account_id=account.id
       AND capability.capability_code=?
       AND capability.status='active'`;
      parameters.push(capability);
    }
    if (sourceSystem) {
      filters.push("account.source_system_code=?");
      parameters.push(sourceSystem);
    }
    if (status) {
      filters.push("account.status=?");
      parameters.push(status);
    }
    const result = await this.provider.query(
      `SELECT DISTINCT account.*
       FROM foundation_integration_accounts account
       ${join}
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY account.source_system_code,account.display_name,account.id`,
      parameters,
    );
    return result.rows.map(accountRow);
  }

  async getAccount(id) {
    const result = await this.provider.query(
      "SELECT * FROM foundation_integration_accounts WHERE id=?",
      [id],
    );
    return accountRow(result.rows[0]);
  }

  async upsertAccount(input, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(
      `INSERT INTO foundation_integration_accounts (
        id,source_system_code,display_name,credential_ref_type,credential_ref_id,
        status,metadata_json,last_verified_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        source_system_code=excluded.source_system_code,
        display_name=excluded.display_name,
        credential_ref_type=excluded.credential_ref_type,
        credential_ref_id=excluded.credential_ref_id,
        status=excluded.status,
        metadata_json=excluded.metadata_json,
        last_verified_at=excluded.last_verified_at,
        updated_at=excluded.updated_at`,
      [
        input.id,
        input.sourceSystem,
        input.displayName,
        input.credentialRefType,
        input.credentialRefId || null,
        input.status || "active",
        toJson(input.metadata),
        input.lastVerifiedAt || null,
        input.createdAt || timestamp,
        timestamp,
      ],
    );
    return this.getAccount(input.id);
  }

  async upsertCapability(accountId, capability, {
    status = "active",
    config = {},
  } = {}, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(
      `INSERT INTO foundation_account_capabilities (
        account_id,capability_code,status,config_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id,capability_code) DO UPDATE SET
        status=CASE
          WHEN foundation_account_capabilities.status='active'
            AND excluded.status='requires_binding'
            THEN foundation_account_capabilities.status
          ELSE excluded.status
        END,
        config_json=CASE
          WHEN foundation_account_capabilities.status='active'
            AND excluded.status='requires_binding'
            THEN foundation_account_capabilities.config_json
          ELSE excluded.config_json
        END,
        updated_at=excluded.updated_at`,
      [accountId, capability, status, toJson(config), timestamp, timestamp],
    );
  }

  async listMabangProfiles() {
    const result = await this.provider.query(
      `SELECT id,name,username,enabled,last_verified_at,last_verify_status,created_at,updated_at
       FROM mabang_account_profiles
       ORDER BY name,id`,
    );
    return result.rows;
  }

  async listGrowthShopOwners() {
    const result = await this.provider.query(
      `SELECT owner_user_id,MIN(created_at) AS created_at,MAX(updated_at) AS updated_at
       FROM growth_shops
       WHERE owner_user_id IS NOT NULL AND TRIM(owner_user_id)<>''
       GROUP BY owner_user_id
       ORDER BY owner_user_id`,
    );
    return result.rows;
  }

  async listCanonicalProducts() {
    const result = await this.provider.query(
      `SELECT
        id,source_system,source_main_sku,created_at,updated_at,identity_status
       FROM product_models
       ORDER BY source_system,source_main_sku,id`,
    );
    return result.rows;
  }

  async listCanonicalSkus() {
    const result = await this.provider.query(
      `SELECT
        id,source_system,source_sku,normalized_sku,created_at,updated_at,archived_at
       FROM product_skus
       ORDER BY source_system,normalized_sku,id`,
    );
    return result.rows;
  }

  async listCanonicalStores() {
    const result = await this.provider.query(
      `SELECT
        id,internal_shop_code,display_name,platform,identity_status,created_at,updated_at
       FROM growth_shops
       ORDER BY platform,internal_shop_code,id`,
    );
    return result.rows;
  }

  async upsertOwner(input, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(
      `INSERT INTO foundation_owners (
        id,display_name,source_system_code,external_key,status,metadata_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        display_name=excluded.display_name,
        source_system_code=excluded.source_system_code,
        external_key=excluded.external_key,
        status=excluded.status,
        metadata_json=excluded.metadata_json,
        updated_at=excluded.updated_at`,
      [
        input.id,
        input.displayName,
        input.sourceSystem || null,
        input.externalKey || null,
        input.status || "active",
        toJson(input.metadata),
        input.createdAt || timestamp,
        timestamp,
      ],
    );
  }

  async listWarehouseFacts() {
    const result = await this.provider.query(
      `SELECT
        LOWER(TRIM(warehouse_name)) AS normalized_name,
        MIN(TRIM(warehouse_name)) AS display_name,
        MIN(created_at) AS created_at,
        MAX(created_at) AS updated_at,
        COUNT(*) AS observation_count
      FROM growth_inventory_snapshots
      WHERE warehouse_name IS NOT NULL AND TRIM(warehouse_name)<>''
      GROUP BY LOWER(TRIM(warehouse_name))
      ORDER BY normalized_name`,
    );
    return result.rows;
  }

  async upsertWarehouse(input, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(
      `INSERT INTO foundation_warehouses (
        id,canonical_key,display_name,normalized_name,country_code,country_name,
        identity_status,metadata_json,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(canonical_key) DO UPDATE SET
        display_name=excluded.display_name,
        normalized_name=excluded.normalized_name,
        country_code=COALESCE(
          foundation_warehouses.country_code,
          excluded.country_code
        ),
        country_name=COALESCE(
          foundation_warehouses.country_name,
          excluded.country_name
        ),
        identity_status=CASE
          WHEN foundation_warehouses.identity_status IN ('confirmed','excluded')
            THEN foundation_warehouses.identity_status
          ELSE excluded.identity_status
        END,
        metadata_json=CASE
          WHEN foundation_warehouses.identity_status IN ('confirmed','excluded')
            THEN foundation_warehouses.metadata_json
          ELSE excluded.metadata_json
        END,
        updated_at=excluded.updated_at`,
      [
        input.id,
        input.canonicalKey,
        input.displayName,
        input.normalizedName,
        input.countryCode || null,
        input.countryName || null,
        input.identityStatus || "review_required",
        toJson(input.metadata),
        input.createdAt || timestamp,
        timestamp,
      ],
    );
  }

  async upsertIdentityLink(input, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(
      `INSERT INTO foundation_identity_links (
        id,entity_type,entity_id,source_system_code,source_entity_type,
        external_key,normalized_external_key,match_status,evidence_json,
        first_seen_at,last_seen_at,confirmed_by,confirmed_at,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_system_code,source_entity_type,normalized_external_key)
      DO UPDATE SET
        entity_type=excluded.entity_type,
        entity_id=excluded.entity_id,
        external_key=excluded.external_key,
        match_status=CASE
          WHEN foundation_identity_links.match_status IN ('confirmed','rejected')
            THEN foundation_identity_links.match_status
          ELSE excluded.match_status
        END,
        evidence_json=CASE
          WHEN foundation_identity_links.match_status IN ('confirmed','rejected')
            THEN foundation_identity_links.evidence_json
          ELSE excluded.evidence_json
        END,
        last_seen_at=excluded.last_seen_at,
        updated_at=excluded.updated_at`,
      [
        input.id || foundationStableId(
          "identity",
          input.sourceSystem,
          input.sourceEntityType,
          input.normalizedExternalKey,
        ),
        input.entityType,
        input.entityId,
        input.sourceSystem,
        input.sourceEntityType,
        input.externalKey,
        input.normalizedExternalKey,
        input.matchStatus || "confirmed",
        toJson(input.evidence),
        input.firstSeenAt || timestamp,
        input.lastSeenAt || timestamp,
        input.confirmedBy || null,
        input.confirmedAt || null,
        input.createdAt || timestamp,
        timestamp,
      ],
    );
  }

  async upsertSourceRun(input, now = new Date()) {
    const timestamp = iso(now);
    const id = input.id || foundationStableId(
      "source-run",
      input.domain,
      input.sourceRefType,
      input.sourceRefId,
    );
    await this.provider.execute(
      `INSERT INTO foundation_source_runs (
        id,source_system_code,account_id,domain,source_ref_type,source_ref_id,
        status,watermark_at,input_fingerprint,evidence_json,started_at,finished_at,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(domain,source_ref_type,source_ref_id) DO UPDATE SET
        source_system_code=excluded.source_system_code,
        account_id=excluded.account_id,
        status=excluded.status,
        watermark_at=excluded.watermark_at,
        input_fingerprint=excluded.input_fingerprint,
        evidence_json=excluded.evidence_json,
        started_at=COALESCE(
          foundation_source_runs.started_at,
          excluded.started_at
        ),
        finished_at=excluded.finished_at,
        updated_at=excluded.updated_at`,
      [
        id,
        input.sourceSystem,
        input.accountId || null,
        input.domain,
        input.sourceRefType,
        input.sourceRefId,
        assertFoundationState(input.status),
        input.watermarkAt || null,
        input.inputFingerprint || null,
        toJson(input.evidence),
        input.startedAt || null,
        input.finishedAt || null,
        input.createdAt || timestamp,
        timestamp,
      ],
    );
    const result = await this.provider.query(
      "SELECT * FROM foundation_source_runs WHERE domain=? AND source_ref_type=? AND source_ref_id=?",
      [input.domain, input.sourceRefType, input.sourceRefId],
    );
    return result.rows[0] || null;
  }

  async getTask(id) {
    const result = await this.provider.query(
      "SELECT * FROM foundation_tasks WHERE id=?",
      [id],
    );
    return taskRow(result.rows[0]);
  }

  async findTaskByDomainRef(domain, domainRefType, domainRefId) {
    const result = await this.provider.query(
      `SELECT * FROM foundation_tasks
       WHERE domain=? AND domain_ref_type=? AND domain_ref_id=?`,
      [domain, domainRefType, domainRefId],
    );
    return taskRow(result.rows[0]);
  }

  async listTasks({
    domain = null,
    state = null,
    ownerId = null,
    limit = 100,
  } = {}) {
    const filters = [];
    const parameters = [];
    if (domain) {
      filters.push("domain=?");
      parameters.push(domain);
    }
    if (state) {
      filters.push("state=?");
      parameters.push(assertFoundationState(state));
    }
    if (ownerId) {
      filters.push("owner_id=?");
      parameters.push(ownerId);
    }
    parameters.push(Math.max(1, Math.min(500, number(limit, 100))));
    const result = await this.provider.query(
      `SELECT * FROM foundation_tasks
       ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
       ORDER BY priority,state,(updated_at IS NULL),updated_at DESC,id DESC
       LIMIT ?`,
      parameters,
    );
    return result.rows.map(taskRow);
  }

  async insertTask(input, now = new Date()) {
    const timestamp = iso(now);
    const id = input.id || randomUUID();
    await this.provider.execute(
      `INSERT INTO foundation_tasks (
        id,domain,task_kind,execution_mode,authority_mode,domain_ref_type,
        domain_ref_id,source_state,state,priority,account_id,source_run_id,
        owner_id,store_id,warehouse_id,sku_id,idempotency_key,attempt_count,
        max_attempts,available_at,started_at,finished_at,input_json,evidence_json,
        result_json,last_error_code,last_error_message,state_version,created_by,
        created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.domain,
        input.taskKind,
        input.executionMode,
        input.authorityMode || "foundation",
        input.domainRefType,
        input.domainRefId,
        input.sourceState || null,
        assertFoundationState(input.state || "PENDING"),
        assertFoundationPriority(input.priority),
        input.accountId || null,
        input.sourceRunId || null,
        input.ownerId || null,
        input.storeId || null,
        input.warehouseId || null,
        input.skuId || null,
        input.idempotencyKey,
        number(input.attemptCount),
        Math.max(1, number(input.maxAttempts, 3)),
        input.availableAt || null,
        input.startedAt || null,
        input.finishedAt || null,
        toJson(input.input),
        toJson(input.evidence),
        toJson(input.result),
        input.lastErrorCode || null,
        input.lastErrorMessage || null,
        number(input.stateVersion, 1),
        input.createdBy,
        input.createdAt || timestamp,
        timestamp,
      ],
    );
    return this.getTask(id);
  }

  async updateTask(id, changes, {
    expectedVersion = null,
    now = new Date(),
  } = {}) {
    const current = await this.getTask(id);
    if (!current) return null;
    if (expectedVersion !== null && current.stateVersion !== expectedVersion) {
      throw Object.assign(new Error("Foundation task version conflict."), {
        code: "FOUNDATION_TASK_VERSION_CONFLICT",
        expectedVersion,
        actualVersion: current.stateVersion,
      });
    }
    const next = {
      ...current,
      ...changes,
      input: changes.input ?? current.input,
      evidence: changes.evidence ?? current.evidence,
      result: changes.result ?? current.result,
      stateVersion: changes.stateVersion ?? current.stateVersion + 1,
      updatedAt: iso(now),
    };
    const result = await this.provider.execute(
      `UPDATE foundation_tasks SET
        source_state=?,state=?,priority=?,account_id=?,source_run_id=?,owner_id=?,
        store_id=?,warehouse_id=?,sku_id=?,attempt_count=?,max_attempts=?,
        available_at=?,started_at=?,finished_at=?,input_json=?,evidence_json=?,
        result_json=?,last_error_code=?,last_error_message=?,state_version=?,
        updated_at=?
       WHERE id=? AND state_version=?`,
      [
        next.sourceState || null,
        assertFoundationState(next.state),
        assertFoundationPriority(next.priority),
        next.accountId || null,
        next.sourceRunId || null,
        next.ownerId || null,
        next.storeId || null,
        next.warehouseId || null,
        next.skuId || null,
        number(next.attemptCount),
        Math.max(1, number(next.maxAttempts, 3)),
        next.availableAt || null,
        next.startedAt || null,
        next.finishedAt || null,
        toJson(next.input),
        toJson(next.evidence),
        toJson(next.result),
        next.lastErrorCode || null,
        next.lastErrorMessage || null,
        next.stateVersion,
        next.updatedAt,
        id,
        current.stateVersion,
      ],
    );
    if (result.rowCount !== 1) {
      throw Object.assign(new Error("Foundation task was changed concurrently."), {
        code: "FOUNDATION_TASK_VERSION_CONFLICT",
      });
    }
    return this.getTask(id);
  }

  async upsertTaskProjection(input, now = new Date()) {
    const existing = await this.findTaskByDomainRef(
      input.domain,
      input.domainRefType,
      input.domainRefId,
    );
    if (!existing) {
      return this.insertTask({
        ...input,
        id: input.id || foundationStableId(
          "task",
          input.domain,
          input.domainRefType,
          input.domainRefId,
        ),
        authorityMode: "projection",
        idempotencyKey: input.idempotencyKey
          || `${input.domain}:${input.domainRefType}:${input.domainRefId}`,
      }, now);
    }
    const changes = {
      sourceState: input.sourceState || null,
      state: input.state,
      priority: input.priority || existing.priority,
      accountId: input.accountId ?? existing.accountId,
      sourceRunId: input.sourceRunId ?? existing.sourceRunId,
      ownerId: input.ownerId ?? existing.ownerId,
      storeId: input.storeId ?? existing.storeId,
      warehouseId: input.warehouseId ?? existing.warehouseId,
      skuId: input.skuId ?? existing.skuId,
      attemptCount: input.attemptCount ?? existing.attemptCount,
      maxAttempts: input.maxAttempts ?? existing.maxAttempts,
      availableAt: input.availableAt ?? existing.availableAt,
      startedAt: input.startedAt ?? existing.startedAt,
      finishedAt: input.finishedAt ?? existing.finishedAt,
      input: input.input ?? existing.input,
      evidence: input.evidence ?? existing.evidence,
      result: input.result ?? existing.result,
      lastErrorCode: input.lastErrorCode ?? existing.lastErrorCode,
      lastErrorMessage: input.lastErrorMessage ?? existing.lastErrorMessage,
    };
    const unchanged = [
      "sourceState",
      "state",
      "priority",
      "accountId",
      "sourceRunId",
      "ownerId",
      "storeId",
      "warehouseId",
      "skuId",
      "attemptCount",
      "maxAttempts",
      "availableAt",
      "startedAt",
      "finishedAt",
      "lastErrorCode",
      "lastErrorMessage",
    ].every((key) => changes[key] === existing[key])
      && sameJson(changes.input, existing.input)
      && sameJson(changes.evidence, existing.evidence)
      && sameJson(changes.result, existing.result);
    if (unchanged) return existing;
    return this.updateTask(existing.id, changes, {
      expectedVersion: existing.stateVersion,
      now,
    });
  }

  async addTaskEvent(input, now = new Date()) {
    const timestamp = iso(now);
    await this.provider.execute(
      `INSERT INTO foundation_task_events (
        id,task_id,event_type,from_state,to_state,source_state,actor_type,
        actor_id,reason_code,message,evidence_json,idempotency_key,task_version,
        occurred_at,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id,idempotency_key) DO NOTHING`,
      [
        input.id || randomUUID(),
        input.taskId,
        input.eventType,
        input.fromState || null,
        assertFoundationState(input.toState),
        input.sourceState || null,
        input.actorType || "system",
        input.actorId || "foundation",
        input.reasonCode || null,
        input.message || null,
        toJson(input.evidence),
        input.idempotencyKey,
        input.taskVersion,
        input.occurredAt || timestamp,
        timestamp,
      ],
    );
  }

  async listTaskEvents(taskId) {
    const result = await this.provider.query(
      `SELECT * FROM foundation_task_events
       WHERE task_id=?
       ORDER BY task_version,id`,
      [taskId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      eventType: row.event_type,
      fromState: row.from_state || null,
      toState: row.to_state,
      sourceState: row.source_state || null,
      actorType: row.actor_type,
      actorId: row.actor_id,
      reasonCode: row.reason_code || null,
      message: row.message || null,
      evidence: parseFoundationJson(row.evidence_json, {}),
      idempotencyKey: row.idempotency_key,
      taskVersion: number(row.task_version),
      occurredAt: row.occurred_at,
    }));
  }

  async acquireTaskLease(taskId, {
    leaseOwner,
    leaseToken,
    ttlMs,
  }, now = new Date()) {
    const acquiredAt = iso(now);
    const expiresAt = iso(new Date(new Date(now).getTime() + ttlMs));
    return this.provider.transaction(async (transaction) => {
      const current = await transaction.query(
        "SELECT * FROM foundation_task_leases WHERE task_id=?",
        [taskId],
      );
      const row = current.rows[0];
      if (row && row.expires_at > acquiredAt && row.lease_owner !== leaseOwner) {
        return null;
      }
      await transaction.execute(
        `INSERT INTO foundation_task_leases (
          task_id,lease_owner,lease_token,acquired_at,renewed_at,expires_at
        ) VALUES (?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET
          lease_owner=excluded.lease_owner,
          lease_token=excluded.lease_token,
          acquired_at=excluded.acquired_at,
          renewed_at=excluded.renewed_at,
          expires_at=excluded.expires_at`,
        [taskId, leaseOwner, leaseToken, acquiredAt, acquiredAt, expiresAt],
      );
      return {
        taskId,
        leaseOwner,
        leaseToken,
        acquiredAt,
        renewedAt: acquiredAt,
        expiresAt,
      };
    });
  }

  async renewTaskLease(taskId, {
    leaseToken,
    ttlMs,
  }, now = new Date()) {
    const renewedAt = iso(now);
    const expiresAt = iso(new Date(new Date(now).getTime() + ttlMs));
    const result = await this.provider.execute(
      `UPDATE foundation_task_leases
       SET renewed_at=?,expires_at=?
       WHERE task_id=? AND lease_token=? AND expires_at>?`,
      [renewedAt, expiresAt, taskId, leaseToken, renewedAt],
    );
    return result.rowCount === 1
      ? { taskId, leaseToken, renewedAt, expiresAt }
      : null;
  }

  async releaseTaskLease(taskId, leaseToken) {
    const result = await this.provider.execute(
      "DELETE FROM foundation_task_leases WHERE task_id=? AND lease_token=?",
      [taskId, leaseToken],
    );
    return result.rowCount === 1;
  }

  async domainSummary() {
    const result = await this.provider.query(
      "SELECT * FROM foundation_task_domain_summary_v ORDER BY domain,state",
    );
    return result.rows.map((row) => ({
      domain: row.domain,
      state: row.state,
      taskCount: number(row.task_count),
      oldestCreatedAt: row.oldest_created_at || null,
      latestUpdatedAt: row.latest_updated_at || null,
    }));
  }
}
