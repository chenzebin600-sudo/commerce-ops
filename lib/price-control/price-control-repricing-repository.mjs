import { assertDatabaseProvider } from "../data/database-provider.mjs";
import { createPortableRepositoryExecutor } from "../data/portable-repository-executor.mjs";
import { createRepositorySql } from "../data/repository-sql.mjs";

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || "")); } catch { return fallback; }
}

function planRow(row, { includeCapability = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    sourceRoundId: row.source_round_id,
    accountId: row.account_id,
    executionProvider: row.execution_provider,
    status: row.status,
    instructionText: row.instruction_text,
    sourceAssignments: parseJson(row.source_assignments_json, []),
    aiProvider: parseJson(row.ai_provider_json, {}),
    parsedCommands: parseJson(row.parsed_commands_json, []),
    ...(includeCapability ? { previewToken: row.preview_token } : {}),
    previewFingerprint: row.preview_fingerprint,
    previewCreatedAt: row.preview_created_at,
    previewExpiresAt: row.preview_expires_at,
    targetShopCount: Number(row.target_shop_count || 0),
    listingChangeCount: Number(row.listing_change_count || 0),
    warnings: parseJson(row.warnings_json, []),
    selectedItemIds: parseJson(row.selected_item_ids_json, []),
    confirmedBy: row.confirmed_by || null,
    confirmedAt: row.confirmed_at || null,
    confirmationFingerprint: row.confirmation_fingerprint || null,
    executionJobId: row.execution_job_id || null,
    executionState: row.execution_state || null,
    result: parseJson(row.result_json, {}),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemRow(row) {
  if (!row) return null;
  const rawPreview = parseJson(row.raw_preview_json, {});
  return {
    id: row.id,
    planId: row.plan_id,
    sourceChangeId: row.source_change_id,
    sourceCommandIndex: Number(row.source_command_index),
    registryShopId: row.registry_shop_id,
    providerChangeId: row.provider_change_id,
    platform: row.platform,
    countryCode: row.country_code,
    sku: row.sku,
    matchedSku: String(rawPreview?.matched_sku || row.sku || ""),
    skuMatchType: String(rawPreview?.sku_match_type || "unknown"),
    controlShopType: row.control_shop_type,
    priceType: row.price_type,
    targetField: row.target_field,
    providerShopId: row.provider_shop_id,
    shopName: row.shop_name,
    internalListingId: row.internal_listing_id,
    variationKey: row.variation_key,
    oldValue: parseJson(row.old_value_json, null),
    newValue: parseJson(row.new_value_json, null),
    selected: Boolean(Number(row.selected)),
    status: row.status,
    result: parseJson(row.result_json, {}),
    rawPreview,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PriceControlRepricingRepository {
  constructor({ provider }) {
    const resolved = assertDatabaseProvider(provider);
    this.provider = createPortableRepositoryExecutor(resolved);
    this.sql = createRepositorySql(resolved);
  }

  isReady() {
    return this.sql.relationExists("price_control_repricing_plans");
  }

  async createPreviewPlan({ plan, items }) {
    return this.provider.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO price_control_repricing_plans (
          id,source_round_id,account_id,execution_provider,status,instruction_text,
          source_assignments_json,ai_provider_json,parsed_commands_json,preview_token,
          preview_fingerprint,preview_created_at,preview_expires_at,target_shop_count,
          listing_change_count,warnings_json,created_by,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [plan.id, plan.sourceRoundId, plan.accountId, plan.executionProvider,
          "PREVIEW_READY", plan.instructionText, JSON.stringify(plan.sourceAssignments),
          JSON.stringify(plan.aiProvider || {}), JSON.stringify(plan.parsedCommands || []),
          plan.previewToken, plan.previewFingerprint, plan.previewCreatedAt,
          plan.previewExpiresAt, plan.targetShopCount, items.length,
          JSON.stringify(plan.warnings || []), plan.createdBy, plan.createdAt, plan.createdAt],
      );
      for (const item of items) {
        await tx.execute(
          `INSERT INTO price_control_repricing_items (
            id,plan_id,source_change_id,source_command_index,registry_shop_id,
            provider_change_id,platform,country_code,sku,control_shop_type,price_type,
            target_field,provider_shop_id,shop_name,internal_listing_id,variation_key,
            old_value_json,new_value_json,selected,status,result_json,raw_preview_json,
            created_at,updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [item.id, plan.id, item.sourceChangeId, item.sourceCommandIndex,
            item.registryShopId, item.providerChangeId, item.platform, item.countryCode,
            item.sku, item.controlShopType, item.priceType, item.targetField,
            item.providerShopId, item.shopName, item.internalListingId,
            item.variationKey, JSON.stringify(item.oldValue), JSON.stringify(item.newValue),
            0, "PREVIEWED", "{}", JSON.stringify(item.rawPreview || {}),
            plan.createdAt, plan.createdAt],
        );
      }
      return this.getPlan(plan.id, { executor: tx });
    });
  }

  async getPlan(id, { includeCapability = false, executor = this.provider } = {}) {
    const plan = planRow((await executor.query(
      "SELECT * FROM price_control_repricing_plans WHERE id=?",
      [id],
    )).rows[0], { includeCapability });
    if (!plan) return null;
    const items = (await executor.query(
      `SELECT * FROM price_control_repricing_items WHERE plan_id=?
       ORDER BY source_command_index,shop_name,id`,
      [id],
    )).rows.map(itemRow);
    return { ...plan, items };
  }

  async listPlans({ sourceRoundId = null, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 20, 100));
    const result = sourceRoundId
      ? await this.provider.query(
        `SELECT * FROM price_control_repricing_plans WHERE source_round_id=?
         ORDER BY created_at DESC,id DESC LIMIT ?`,
        [sourceRoundId, safeLimit],
      )
      : await this.provider.query(
        "SELECT * FROM price_control_repricing_plans ORDER BY created_at DESC,id DESC LIMIT ?",
        [safeLimit],
      );
    return result.rows.map((row) => planRow(row));
  }

  async markExpired(id, now) {
    await this.provider.execute(
      `UPDATE price_control_repricing_plans SET status='EXPIRED',updated_at=?
       WHERE id=? AND status='PREVIEW_READY'`,
      [now.toISOString(), id],
    );
    return this.getPlan(id);
  }

  async claimConfirmation({ id, previewFingerprint, selectedItemIds, confirmedBy, now }) {
    const timestamp = now.toISOString();
    const selectedPlaceholders = selectedItemIds.map(() => "?").join(",");
    return this.provider.transaction(async (tx) => {
      const result = await tx.execute(
        `UPDATE price_control_repricing_plans SET
          status='CONFIRMING',selected_item_ids_json=?,confirmed_by=?,confirmed_at=?,
          confirmation_fingerprint=?,error_code=NULL,error_message=NULL,updated_at=?
         WHERE id=? AND status='PREVIEW_READY' AND preview_fingerprint=? AND preview_expires_at>?
           AND source_round_id=(
             SELECT event.sync_run_id FROM product_price_change_events AS event
             WHERE event.validity_status='VALID'
             ORDER BY event.detected_at DESC,event.sync_run_id DESC LIMIT 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM price_control_repricing_items AS item
             JOIN product_price_change_events AS change ON change.id=item.source_change_id
             WHERE item.plan_id=price_control_repricing_plans.id
               AND item.id IN (${selectedPlaceholders})
               AND (change.validity_status<>'VALID' OR change.adjustment_status='ADJUSTED')
           )`,
        [JSON.stringify(selectedItemIds), confirmedBy, timestamp, previewFingerprint,
          timestamp, id, previewFingerprint, timestamp, ...selectedItemIds],
      );
      if (Number(result.rowCount || 0) !== 1) return null;
      await tx.execute(
        "UPDATE price_control_repricing_items SET selected=0,status='SKIPPED',updated_at=? WHERE plan_id=?",
        [timestamp, id],
      );
      for (const itemId of selectedItemIds) {
        await tx.execute(
          `UPDATE price_control_repricing_items SET selected=1,status='PREVIEWED',updated_at=?
           WHERE plan_id=? AND id=?`,
          [timestamp, id, itemId],
        );
      }
      return this.getPlan(id, { includeCapability: true, executor: tx });
    });
  }

  async markExecutionStarted(id, job, now) {
    const timestamp = now.toISOString();
    await this.provider.transaction(async (tx) => {
      const transitioned = await tx.execute(
        `UPDATE price_control_repricing_plans SET
          status='EXECUTING',execution_job_id=?,execution_state=?,result_json=?,updated_at=?
         WHERE id=? AND status='CONFIRMING'`,
        [job.job_id, job.state || "queued", JSON.stringify(job), timestamp, id],
      );
      if (Number(transitioned.rowCount || 0) !== 1) {
        throw Object.assign(new Error("Accepted repricing job could not be persisted from the confirming state."), {
          code: "PRICE_CONTROL_REPRICING_STATE_TRANSITION_FAILED",
        });
      }
      await tx.execute(
        `UPDATE price_control_repricing_items SET status='SUBMITTED',updated_at=?
         WHERE plan_id=? AND selected=1`,
        [timestamp, id],
      );
    });
    return this.getPlan(id);
  }

  async markExecutionUnknown(id, error, now, job = null) {
    const timestamp = now.toISOString();
    await this.provider.transaction(async (tx) => {
      await tx.execute(
        `UPDATE price_control_repricing_plans SET
          status='EXECUTION_UNKNOWN',execution_job_id=COALESCE(?,execution_job_id),
          execution_state=?,result_json=CASE WHEN ? IS NULL THEN result_json ELSE ? END,
          error_code=?,error_message=?,updated_at=?
         WHERE id=? AND status='CONFIRMING'`,
        [job?.job_id || null, job?.state || "unknown", job ? 1 : null,
          job ? JSON.stringify(job) : null,
          String(error?.code || "REPRICING_EXECUTION_OUTCOME_UNKNOWN").slice(0, 80),
          String(error?.message || error || "Execution outcome is unknown").slice(0, 500),
          timestamp, id],
      );
      await tx.execute(
        `UPDATE price_control_repricing_items SET status='EXECUTION_UNKNOWN',updated_at=?
         WHERE plan_id=? AND selected=1`,
        [timestamp, id],
      );
    });
    return this.getPlan(id);
  }

  async markExecutionFailed(id, error, now) {
    const timestamp = now.toISOString();
    await this.provider.transaction(async (tx) => {
      await tx.execute(
        `UPDATE price_control_repricing_plans SET
          status='FAILED',execution_state='rejected',error_code=?,error_message=?,updated_at=?
         WHERE id=? AND status='CONFIRMING'`,
        [String(error?.code || "MABANG_REPRICING_EXECUTION_REJECTED").slice(0, 80),
          String(error?.message || error || "Execution request failed").slice(0, 500), timestamp, id],
      );
      await tx.execute(
        `UPDATE price_control_repricing_items SET status='FAILED',result_json=?,updated_at=?
         WHERE plan_id=? AND selected=1`,
        [JSON.stringify({ errorCode: error?.code || null, error: String(error?.message || error || "") }),
          timestamp, id],
      );
    });
    return this.getPlan(id);
  }

  async updateJob(id, job, now) {
    const timestamp = now.toISOString();
    const providerState = String(job?.state || "").toLowerCase();
    const terminal = ["completed", "partial", "failed"].includes(providerState);
    await this.provider.transaction(async (tx) => {
      const results = Array.isArray(job?.results) ? job.results : [];
      const rows = (await tx.query(
        "SELECT id,platform,internal_listing_id FROM price_control_repricing_items WHERE plan_id=? AND selected=1",
        [id],
      )).rows;
      const itemOutcomes = terminal ? rows.map((row) => {
        const matched = results.find((result) =>
          String(result?.platform || "").toUpperCase() === String(row.platform).toUpperCase()
          && String(result?.internal_id || result?.internalId || "") === String(row.internal_listing_id));
        const matchedStatus = String(matched?.status || "").toLowerCase();
        const status = matchedStatus === "success" ? "SUCCEEDED"
          : matchedStatus === "failed" || providerState === "failed" ? "FAILED"
            : "EXECUTION_UNKNOWN";
        return {
          row,
          matched,
          status,
          result: matched || {
            status: status === "FAILED" ? "failed" : "unknown",
            message: String(job?.message || "Provider result is incomplete"),
            jobState: providerState || null,
          },
        };
      }) : [];
      const unknownCount = itemOutcomes.filter((item) => item.status === "EXECUTION_UNKNOWN").length;
      const successCount = itemOutcomes.filter((item) => item.status === "SUCCEEDED").length;
      const failedCount = itemOutcomes.filter((item) => item.status === "FAILED").length;
      const planStatus = !terminal ? "EXECUTING"
        : !rows.length || unknownCount ? "EXECUTION_UNKNOWN"
          : successCount === rows.length ? "SUCCEEDED"
            : failedCount === rows.length ? "FAILED" : "PARTIAL";
      const errorCode = planStatus === "EXECUTION_UNKNOWN" ? "MABANG_REPRICING_RESULT_INCOMPLETE"
        : planStatus === "FAILED" ? "MABANG_REPRICING_JOB_FAILED"
          : planStatus === "PARTIAL" ? "MABANG_REPRICING_JOB_PARTIAL" : null;
      const errorMessage = planStatus === "EXECUTION_UNKNOWN"
        ? "马帮任务已结束或返回终态，但缺少完整的商品级执行结果；禁止推断成功，请继续回查或人工核对。"
        : planStatus === "FAILED" ? String(job?.message || "Mabang repricing job failed").slice(0, 500)
          : planStatus === "PARTIAL" ? String(job?.message || "Mabang repricing job partially succeeded").slice(0, 500)
            : null;
      await tx.execute(
        `UPDATE price_control_repricing_plans SET
          status=?,execution_state=?,result_json=?,error_code=?,error_message=?,updated_at=?
         WHERE id=? AND status IN ('EXECUTING','EXECUTION_UNKNOWN')`,
        [planStatus, job?.state || null, JSON.stringify(job || {}), errorCode, errorMessage, timestamp, id],
      );
      if (terminal) {
        for (const outcome of itemOutcomes) {
          await tx.execute(
            `UPDATE price_control_repricing_items SET status=?,result_json=?,updated_at=?
             WHERE id=?`,
            [outcome.status, JSON.stringify(outcome.result), timestamp, outcome.row.id],
          );
        }
      }
    });
    return this.getPlan(id);
  }
}
