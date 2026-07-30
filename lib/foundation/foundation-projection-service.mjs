import {
  foundationAccountId,
  normalizeDomainTaskState,
} from "./foundation-contracts.mjs";

function taskPriority(value, fallback = "P2") {
  const priority = String(value || "").toUpperCase();
  return ["P0", "P1", "P2", "P3"].includes(priority) ? priority : fallback;
}

function sourceRunStatus(value) {
  const state = normalizeDomainTaskState(value, "FAILED");
  if (["PENDING", "READY"].includes(state)) return "PENDING";
  if (["RUNNING", "PAUSE_REQUESTED", "PAUSED", "RETRY_WAIT"].includes(state)) return "RUNNING";
  if (state === "SUCCEEDED") return "SUCCEEDED";
  if (state === "PARTIAL_SUCCESS") return "PARTIAL_SUCCESS";
  if (state === "CANCELLED") return "CANCELLED";
  return "FAILED";
}

export class FoundationProjectionService {
  constructor({ repository, taskService, now = () => new Date() }) {
    this.repository = repository;
    this.taskService = taskService;
    this.now = now;
  }

  async projectScheduledRuns() {
    if (!await this.repository.tableExists("scheduled_export_runs")) return 0;
    const result = await this.repository.provider.query(
      `SELECT
        run.*,
        task.task_type,
        task.account_profile_id
       FROM scheduled_export_runs run
       JOIN scheduled_export_tasks task ON task.id=run.task_id
       ORDER BY run.created_at,run.id`,
    );
    for (const row of result.rows) {
      const accountId = foundationAccountId("mabang", row.account_profile_id);
      const sourceRun = await this.repository.upsertSourceRun({
        sourceSystem: "mabang",
        accountId,
        domain: "mabang_data",
        sourceRefType: "scheduled_export_run",
        sourceRefId: row.id,
        status: sourceRunStatus(row.status),
        watermarkAt: row.finished_at || row.started_at || row.scheduled_run_at,
        evidence: {
          taskId: row.task_id,
          taskType: row.task_type,
          triggerType: row.trigger_type,
          rawOrderCount: Number(row.raw_order_count || 0),
          detailRowCount: Number(row.detail_row_count || 0),
        },
        startedAt: row.started_at || null,
        finishedAt: row.finished_at || null,
        createdAt: row.created_at,
      }, this.now());
      await this.taskService.project({
        domain: "mabang_data",
        taskKind: row.task_type || "scheduled_export",
        executionMode: "system",
        domainRefType: "scheduled_export_run",
        domainRefId: row.id,
        sourceState: row.status,
        priority: "P2",
        accountId,
        sourceRunId: sourceRun.id,
        attemptCount: Number(row.retry_count || 0),
        maxAttempts: Math.max(3, Number(row.retry_count || 0) + 1),
        startedAt: row.started_at || null,
        finishedAt: row.finished_at || null,
        evidence: {
          taskId: row.task_id,
          errorStage: row.error_stage || null,
          notificationStatus: row.notification_status || null,
        },
        result: {
          rawOrderCount: Number(row.raw_order_count || 0),
          filteredOrderCount: Number(row.filtered_order_count || 0),
          detailRowCount: Number(row.detail_row_count || 0),
          exportFileId: row.export_file_id || null,
        },
        lastErrorCode: row.error_code || null,
        lastErrorMessage: row.error_message || null,
        createdAt: row.created_at,
      });
    }
    return result.rows.length;
  }

  async projectImageWork() {
    let projected = 0;
    if (await this.repository.tableExists("mabang_sku_image_sync_runs")) {
      const runs = await this.repository.provider.query(
        "SELECT * FROM mabang_sku_image_sync_runs ORDER BY created_at,id",
      );
      for (const row of runs.rows) {
        const accountId = foundationAccountId("mabang", row.account_id);
        const sourceRun = await this.repository.upsertSourceRun({
          sourceSystem: "mabang",
          accountId,
          domain: "images",
          sourceRefType: "mabang_image_sync_run",
          sourceRefId: row.id,
          status: sourceRunStatus(row.status),
          watermarkAt: row.completed_at || row.started_at || row.created_at,
          evidence: {
            segmentCount: Number(row.segment_count || 0),
            discoveredSkus: Number(row.discovered_skus || 0),
            downloadedImages: Number(row.downloaded_images || 0),
          },
          startedAt: row.started_at || null,
          finishedAt: row.completed_at || null,
          createdAt: row.created_at,
        }, this.now());
        await this.taskService.project({
          domain: "mabang_images",
          taskKind: "full_image_sync",
          executionMode: "system",
          domainRefType: "mabang_image_sync_run",
          domainRefId: row.id,
          sourceState: row.status,
          accountId,
          sourceRunId: sourceRun.id,
          evidence: {
            nextPage: Number(row.next_page || 1),
            segmentCount: Number(row.segment_count || 0),
          },
          result: {
            discoveredSkus: Number(row.discovered_skus || 0),
            downloadedImages: Number(row.downloaded_images || 0),
            duplicateImages: Number(row.duplicate_images || 0),
            failedImages: Number(row.failed_images || 0),
          },
          lastErrorCode: row.last_error_code || null,
          lastErrorMessage: row.last_error_message || null,
          startedAt: row.started_at || null,
          finishedAt: row.completed_at || null,
          createdAt: row.created_at,
        });
        projected += 1;
      }
    }
    if (await this.repository.tableExists("mabang_sku_image_batches")) {
      const batches = await this.repository.provider.query(
        "SELECT * FROM mabang_sku_image_batches ORDER BY created_at,id",
      );
      for (const row of batches.rows) {
        await this.taskService.project({
          domain: "mabang_images",
          taskKind: `image_batch:${row.mode}`,
          executionMode: "system",
          domainRefType: "mabang_image_batch",
          domainRefId: row.id,
          sourceState: row.status,
          accountId: foundationAccountId("mabang", row.account_id),
          evidence: {
            syncRunId: row.sync_run_id || null,
            segmentNo: row.segment_no === null ? null : Number(row.segment_no),
            currentPage: Number(row.current_page || 0),
          },
          result: {
            discoveredSkus: Number(row.discovered_skus || 0),
            downloadedImages: Number(row.downloaded_images || 0),
            duplicateImages: Number(row.duplicate_images || 0),
            failedImages: Number(row.failed_images || 0),
            linkedProducts: Number(row.linked_products || 0),
          },
          lastErrorCode: row.last_error_code || null,
          lastErrorMessage: row.last_error_message || null,
          startedAt: row.started_at || null,
          finishedAt: row.completed_at || null,
          createdAt: row.created_at,
        });
        projected += 1;
      }
    }
    return projected;
  }

  async projectGrowthFocusItems() {
    if (!await this.repository.tableExists("growth_focus_items")) return 0;
    const result = await this.repository.provider.query(
      "SELECT * FROM growth_focus_items ORDER BY created_at,id",
    );
    for (const row of result.rows) {
      await this.taskService.project({
        domain: "growth",
        taskKind: row.task_type,
        executionMode: "human",
        domainRefType: "growth_focus_item",
        domainRefId: row.id,
        sourceState: row.status,
        priority: taskPriority(row.priority),
        ownerId: row.owner_user_id
          ? `foundation:owner:growth:${row.owner_user_id}`
          : "foundation:owner:unassigned",
        storeId: row.internal_shop_id || null,
        skuId: null,
        evidence: {
          taskKey: row.task_key,
          subjectType: row.subject_type,
          countryCode: row.country_code || null,
          warehouseName: row.normalized_warehouse_name || null,
          normalizedSku: row.normalized_source_sku || null,
          reasonCode: row.reason_code,
          recommendedActionCode: row.recommended_action_code,
        },
        startedAt: row.started_at || null,
        finishedAt: row.resolved_at || null,
        createdAt: row.created_at,
      });
    }
    return result.rows.length;
  }

  async projectListingJobs(jobs = []) {
    let projected = 0;
    for (const job of jobs) {
      await this.taskService.project({
        domain: "listing",
        taskKind: "publish",
        executionMode: "system",
        domainRefType: "publisher_job",
        domainRefId: job.id,
        sourceState: job.status,
        priority: taskPriority(job.priority),
        accountId: job.foundationAccountId || null,
        storeId: job.storeId || null,
        skuId: job.skuId || null,
        attemptCount: Number(job.attempts || 0),
        evidence: {
          draftId: job.draftId || null,
          draftVersion: job.draftVersion ?? null,
          mabangBatchId: job.mabangBatchId || null,
          sourceDatabase: "listing_sidecar",
        },
        result: job.result || {},
        lastErrorMessage: job.error || null,
        startedAt: job.startedAt || null,
        finishedAt: job.finishedAt || null,
        createdAt: job.createdAt || this.now().toISOString(),
      });
      projected += 1;
    }
    return projected;
  }

  async projectAll({ listingJobs = [] } = {}) {
    const [scheduledRuns, imageWork, growthFocusItems, listing] = await Promise.all([
      this.projectScheduledRuns(),
      this.projectImageWork(),
      this.projectGrowthFocusItems(),
      this.projectListingJobs(listingJobs),
    ]);
    return {
      scheduledRuns,
      imageWork,
      growthFocusItems,
      listing,
      total: scheduledRuns + imageWork + growthFocusItems + listing,
    };
  }
}

