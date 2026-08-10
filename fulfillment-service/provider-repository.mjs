import { createPortableRepositoryExecutor } from "../lib/data/portable-repository-executor.mjs";
import { createRepositorySql } from "../lib/data/repository-sql.mjs";

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  if (value && typeof value === "object") return value;
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};
const bool = (value) => value === true || Number(value) === 1;

export const FULFILLMENT_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS fulfillment_previews (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, shop_id TEXT NOT NULL, shop_name TEXT NOT NULL,
  channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, confirmation_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fulfillment_preview_orders (
  preview_id TEXT NOT NULL, order_key TEXT NOT NULL, display_order_id TEXT NOT NULL,
  trade_number TEXT, warehouse TEXT, sku_count INTEGER NOT NULL DEFAULT 0,
  eligible INTEGER NOT NULL, exclusion_json TEXT NOT NULL DEFAULT '[]', snapshot_json TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (preview_id, order_key), FOREIGN KEY (preview_id) REFERENCES fulfillment_previews(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS fulfillment_batches (
  id TEXT PRIMARY KEY, preview_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
  created_at TEXT NOT NULL, finished_at TEXT, timings_json TEXT,
  FOREIGN KEY (preview_id) REFERENCES fulfillment_previews(id)
);
CREATE TABLE IF NOT EXISTS fulfillment_batch_orders (
  batch_id TEXT NOT NULL, order_key TEXT NOT NULL, display_order_id TEXT NOT NULL,
  status TEXT NOT NULL, tracking_number_masked TEXT, error_code TEXT, error_message TEXT,
  before_status TEXT, after_status TEXT, timings_json TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, order_key), FOREIGN KEY (batch_id) REFERENCES fulfillment_batches(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS fulfillment_idempotency (
  order_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS fulfillment_scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
  outcome TEXT NOT NULL, message TEXT NOT NULL, eligible_count INTEGER NOT NULL DEFAULT 0,
  excluded_count INTEGER NOT NULL DEFAULT 0, preview_id TEXT
);
CREATE TABLE IF NOT EXISTS fulfillment_manual_recovery_checks (
  order_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL, pass_count INTEGER NOT NULL DEFAULT 0,
  first_passed_at TEXT NOT NULL, last_passed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fulfillment_tracking_recoveries (
  order_key TEXT PRIMARY KEY, batch_id TEXT NOT NULL, display_order_id TEXT NOT NULL,
  shop_id TEXT NOT NULL, status TEXT NOT NULL, submitted_at TEXT NOT NULL,
  next_check_at TEXT NOT NULL, deadline_at TEXT NOT NULL, last_checked_at TEXT,
  reset_count INTEGER NOT NULL DEFAULT 0, last_reset_at TEXT, last_error_code TEXT,
  last_error_message TEXT, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS fulfillment_agent_runs (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, status TEXT NOT NULL, model TEXT NOT NULL,
  step_count INTEGER NOT NULL DEFAULT 0, tool_trace_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT
);`;

function previewFrom(row, orders) {
  return row ? {
    id: row.id,
    status: row.status,
    shopId: row.shop_id,
    shopName: row.shop_name,
    channelId: row.channel_id,
    channelName: row.channel_name,
    confirmationHash: row.confirmation_hash,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    orders: orders.map((order) => ({
      orderKey: order.order_key,
      displayOrderId: order.display_order_id,
      tradeNumber: order.trade_number,
      warehouse: order.warehouse,
      skuCount: Number(order.sku_count || 0),
      eligible: bool(order.eligible),
      exclusions: parse(order.exclusion_json, []),
      snapshot: parse(order.snapshot_json, {}),
    })),
  } : null;
}

function recoveryFrom(row) {
  return {
    orderKey: row.order_key,
    batchId: row.batch_id,
    displayOrderId: row.display_order_id,
    shopId: row.shop_id,
    status: row.status,
    submittedAt: row.submitted_at,
    nextCheckAt: row.next_check_at,
    deadlineAt: row.deadline_at,
    lastCheckedAt: row.last_checked_at || null,
    resetCount: Number(row.reset_count || 0),
    lastResetAt: row.last_reset_at || null,
    lastErrorCode: row.last_error_code || null,
    lastErrorMessage: row.last_error_message || null,
    completedAt: row.completed_at || null,
  };
}

export class ProviderFulfillmentRepository {
  constructor({ provider, initializeSqliteSchema = true }) {
    this.db = createPortableRepositoryExecutor(provider);
    this.sql = createRepositorySql(this.db);
    this.initializeSqliteSchema = Boolean(initializeSqliteSchema);
  }

  static async open(options) {
    const repository = new ProviderFulfillmentRepository(options);
    await repository.initialize();
    return repository;
  }

  async initialize() {
    if (this.db.dialect === "sqlite" && this.initializeSqliteSchema) {
      await this.db.executeScript(FULFILLMENT_SQLITE_SCHEMA);
    }
    const required = [
      "fulfillment_previews",
      "fulfillment_preview_orders",
      "fulfillment_batches",
      "fulfillment_batch_orders",
      "fulfillment_idempotency",
      "fulfillment_scan_runs",
      "fulfillment_manual_recovery_checks",
      "fulfillment_tracking_recoveries",
      "fulfillment_agent_runs",
    ];
    for (const relation of required) {
      if (!await this.sql.relationExists(relation)) {
        throw Object.assign(new Error(`Fulfillment relation is missing: ${relation}`), { code: "FULFILLMENT_SCHEMA_MISSING" });
      }
    }
  }

  async rows(text, parameters = [], executor = this.db) {
    return (await executor.query(text, parameters)).rows;
  }

  async row(text, parameters = [], executor = this.db) {
    return (await this.rows(text, parameters, executor))[0] || null;
  }

  async run(text, parameters = [], executor = this.db) {
    return executor.execute(text, parameters);
  }

  async startAgentRun({ id, conversationId, model, startedAt }) {
    await this.run(`INSERT INTO fulfillment_agent_runs
      (id,conversation_id,status,model,started_at) VALUES (?,?,'running',?,?)`,
    [id, conversationId, model, startedAt]);
  }

  async finishAgentRun({ id, status, stepCount = 0, toolTrace = [], errorCode = null, finishedAt }) {
    await this.run(`UPDATE fulfillment_agent_runs SET status=?,step_count=?,tool_trace_json=?,error_code=?,finished_at=?
      WHERE id=?`, [status, stepCount, json(toolTrace), errorCode, finishedAt, id]);
  }

  async getAgentRun(id) {
    const row = await this.row("SELECT * FROM fulfillment_agent_runs WHERE id=?", [id]);
    return row ? {
      id: row.id,
      conversationId: row.conversation_id,
      status: row.status,
      model: row.model,
      stepCount: Number(row.step_count || 0),
      toolTrace: parse(row.tool_trace_json, []),
      errorCode: row.error_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    } : null;
  }

  async createPreview(preview, orders) {
    await this.db.transaction(async (tx) => {
      await this.run(`INSERT INTO fulfillment_previews
        (id,status,shop_id,shop_name,channel_id,channel_name,confirmation_hash,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [preview.id, preview.status, preview.shopId, preview.shopName,
        preview.channelId, preview.channelName, preview.confirmationHash, preview.expiresAt, preview.createdAt], tx);
      for (let priority = 0; priority < orders.length; priority += 1) {
        const order = orders[priority];
        await this.run(`INSERT INTO fulfillment_preview_orders
          (preview_id,order_key,display_order_id,trade_number,warehouse,sku_count,eligible,exclusion_json,snapshot_json,priority)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [preview.id, order.orderKey, order.displayOrderId, order.tradeNumber,
          order.warehouse, order.skuCount, order.eligible ? 1 : 0, json(order.exclusions), json(order.snapshot), priority], tx);
      }
    });
    return this.getPreview(preview.id);
  }

  async getPreview(id) {
    const row = await this.row("SELECT * FROM fulfillment_previews WHERE id=?", [id]);
    if (!row) return null;
    const orders = await this.rows(`SELECT * FROM fulfillment_preview_orders
      WHERE preview_id=? ORDER BY priority,display_order_id`, [id]);
    return previewFrom(row, orders);
  }

  async isCompleted(orderKey) {
    return Boolean(await this.row(`SELECT 1 FROM fulfillment_idempotency
      WHERE order_key=? AND status IN ('success','needs_attention')`, [orderKey]));
  }

  async quarantineFailedOrders(errorCode, updatedAt) {
    const candidates = await this.rows(`SELECT i.order_key,i.batch_id
      FROM fulfillment_idempotency i
      JOIN fulfillment_batch_orders o ON o.batch_id=i.batch_id AND o.order_key=i.order_key
      WHERE i.status='failed' AND o.status='failed' AND o.error_code=?`, [errorCode]);
    if (!candidates.length) return 0;
    return this.db.transaction(async (tx) => {
      let changed = 0;
      for (const candidate of candidates) {
        const order = await this.run(`UPDATE fulfillment_batch_orders SET status='needs_attention',updated_at=?
          WHERE batch_id=? AND order_key=? AND status='failed' AND error_code=?`,
        [updatedAt, candidate.batch_id, candidate.order_key, errorCode], tx);
        const reservation = await this.run(`UPDATE fulfillment_idempotency SET status='needs_attention',completed_at=?
          WHERE order_key=? AND batch_id=? AND status='failed'`,
        [updatedAt, candidate.order_key, candidate.batch_id], tx);
        if (order.rowCount === 1 && reservation.rowCount === 1) changed += 1;
      }
      return changed;
    });
  }

  async getManualReview(shopId, displayOrderId) {
    const row = await this.row(`SELECT o.batch_id,o.order_key,o.display_order_id,o.error_code,o.error_message,o.updated_at,
      p.shop_id,p.shop_name
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE p.shop_id=? AND o.display_order_id=? AND o.status='needs_attention' AND i.status='needs_attention'
      AND o.error_code IN ('INVENTORY_UNKNOWN_BEFORE_SUBMIT','MULTI_WAREHOUSE_REQUIRES_REVIEW')
      ORDER BY o.updated_at DESC LIMIT 1`, [shopId, displayOrderId]);
    return row ? {
      batchId: row.batch_id,
      orderKey: row.order_key,
      displayOrderId: row.display_order_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      updatedAt: row.updated_at,
      shop: { id: row.shop_id, name: row.shop_name },
    } : null;
  }

  async listRecoverableManualReviews(shopId, limit = 5) {
    const rows = await this.rows(`SELECT o.batch_id,o.order_key,o.display_order_id,o.error_code,o.error_message,o.updated_at,
      p.shop_id,p.shop_name,COALESCE(r.pass_count,0) AS recovery_pass_count,r.last_passed_at
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      LEFT JOIN fulfillment_manual_recovery_checks r ON r.order_key=o.order_key AND r.batch_id=o.batch_id
      WHERE p.shop_id=? AND o.status='needs_attention' AND i.status='needs_attention'
      AND o.error_code IN ('INVENTORY_UNKNOWN_BEFORE_SUBMIT','MULTI_WAREHOUSE_REQUIRES_REVIEW')
      ORDER BY o.updated_at ASC LIMIT ?`, [shopId, Math.max(1, Math.min(Number(limit) || 5, 10))]);
    return rows.map((row) => ({
      batchId: row.batch_id,
      orderKey: row.order_key,
      displayOrderId: row.display_order_id,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      updatedAt: row.updated_at,
      recoveryPassCount: Number(row.recovery_pass_count || 0),
      recoveryLastPassedAt: row.last_passed_at || null,
      shop: { id: row.shop_id, name: row.shop_name },
    }));
  }

  async recordManualRecoveryPass(review, checkedAt) {
    return this.db.transaction(async (tx) => {
      const locked = await this.row(`SELECT 1 FROM fulfillment_idempotency
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`, [review.orderKey, review.batchId], tx);
      if (!locked) return null;
      const current = await this.row(`SELECT pass_count,batch_id,first_passed_at
        FROM fulfillment_manual_recovery_checks WHERE order_key=?`, [review.orderKey], tx);
      const continuePrevious = current?.batch_id === review.batchId;
      const passCount = continuePrevious ? Math.min(2, Number(current.pass_count || 0) + 1) : 1;
      const firstPassedAt = continuePrevious ? current.first_passed_at : checkedAt;
      await this.run(`INSERT INTO fulfillment_manual_recovery_checks
        (order_key,batch_id,pass_count,first_passed_at,last_passed_at) VALUES (?,?,?,?,?)
        ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,pass_count=excluded.pass_count,
        first_passed_at=excluded.first_passed_at,last_passed_at=excluded.last_passed_at`,
      [review.orderKey, review.batchId, passCount, firstPassedAt, checkedAt], tx);
      return { passCount, firstPassedAt, lastPassedAt: checkedAt };
    });
  }

  async resetManualRecovery(review) {
    const result = await this.run(`DELETE FROM fulfillment_manual_recovery_checks
      WHERE order_key=? AND batch_id=?`, [review.orderKey, review.batchId]);
    return result.rowCount === 1;
  }

  async releaseManualReview(review, updatedAt) {
    return this.db.transaction(async (tx) => {
      const result = await this.run(`UPDATE fulfillment_idempotency SET status='failed',completed_at=NULL
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`, [review.orderKey, review.batchId], tx);
      if (result.rowCount !== 1) return false;
      await this.run(`UPDATE fulfillment_batch_orders SET status='released',updated_at=?
        WHERE batch_id=? AND order_key=? AND status='needs_attention'`, [updatedAt, review.batchId, review.orderKey], tx);
      await this.run("DELETE FROM fulfillment_manual_recovery_checks WHERE order_key=?", [review.orderKey], tx);
      return true;
    });
  }

  async migratePendingTrackingRecoveries({ nowIso, checkSeconds = 300, deadlineHours = 24 }) {
    const candidates = (await this.rows(`SELECT o.batch_id,o.order_key,o.display_order_id,o.tracking_number_masked,
      o.updated_at,o.timings_json,p.shop_id
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention' AND o.error_code='VERIFY_FAILED'
      AND COALESCE(o.after_status,'') LIKE '%待处理%'`)).filter((row) => {
      const timings = parse(row.timings_json, {});
      return Number(timings?.submitRequest || 0) > 0 && Number(timings?.distributionRequest || 0) === 0;
    });
    if (!candidates.length) return 0;
    return this.db.transaction(async (tx) => {
      let changed = 0;
      for (const row of candidates) {
        const submittedAt = row.updated_at || nowIso;
        const nextCheckAt = new Date(Math.max(Date.parse(nowIso), Date.parse(submittedAt) + checkSeconds * 1000)).toISOString();
        const deadlineAt = new Date(Date.parse(submittedAt) + deadlineHours * 3600000).toISOString();
        const hasTracking = Boolean(String(row.tracking_number_masked || "").trim());
        await this.run(`UPDATE fulfillment_batch_orders SET error_code=?,error_message=?
          WHERE batch_id=? AND order_key=? AND error_code='VERIFY_FAILED'`, [
          hasTracking ? "DISTRIBUTION_PENDING" : "TRACKING_NUMBER_PENDING",
          hasTracking ? "已取得运单号，等待按固定物流渠道转入配货中。" : "交运已提交，Shopee 运单号审批中；系统将持续回查，禁止重复交运。",
          row.batch_id,
          row.order_key,
        ], tx);
        const inserted = await this.run(`INSERT INTO fulfillment_tracking_recoveries
          (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at)
          VALUES (?,?,?,?,'waiting_tracking',?,?,?) ON CONFLICT(order_key) DO NOTHING`,
        [row.order_key, row.batch_id, row.display_order_id, row.shop_id, submittedAt, nextCheckAt, deadlineAt], tx);
        changed += inserted.rowCount;
      }
      return changed;
    });
  }

  async createBatch(batch, orders) {
    await this.db.transaction(async (tx) => {
      const activeBatch = await this.row(`SELECT id FROM fulfillment_batches
        WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1`, [], tx);
      if (activeBatch) {
        throw Object.assign(new Error(`已有发货批次正在运行：${activeBatch.id}`), { code: "BATCH_ALREADY_RUNNING" });
      }
      const confirmation = await this.run(`UPDATE fulfillment_previews SET status='confirmed'
        WHERE id=? AND status='pending'`, [batch.previewId], tx);
      if (confirmation.rowCount !== 1) {
        throw Object.assign(new Error("预览已经确认或失效"), { code: "PREVIEW_ALREADY_USED" });
      }
      await this.run(`INSERT INTO fulfillment_batches (id,preview_id,status,created_at)
        VALUES (?,?,?,?)`, [batch.id, batch.previewId, batch.status, batch.createdAt], tx);
      for (const order of orders) {
        await this.run(`INSERT INTO fulfillment_batch_orders
          (batch_id,order_key,display_order_id,status,before_status,updated_at) VALUES (?,?,?,?,?,?)`,
        [batch.id, order.orderKey, order.displayOrderId, "queued", order.snapshot.orderStatus, batch.createdAt], tx);
        const reservation = await this.run(`INSERT INTO fulfillment_idempotency (order_key,batch_id,status,completed_at)
          VALUES (?,?,?,NULL)
          ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,status='running',completed_at=NULL
          WHERE fulfillment_idempotency.status='failed'`, [order.orderKey, batch.id, "running"], tx);
        if (reservation.rowCount !== 1) {
          const existing = await this.row("SELECT status FROM fulfillment_idempotency WHERE order_key=?", [order.orderKey], tx);
          const message = existing?.status === "success"
            ? "订单已经成功发货，禁止重复提交"
            : "订单已有正在执行的发货批次";
          throw Object.assign(new Error(message), { code: "IDEMPOTENCY_CONFLICT" });
        }
      }
    });
    return this.getBatch(batch.id);
  }

  async startBatch(batchId) {
    await this.run("UPDATE fulfillment_batches SET status='running' WHERE id=? AND status='queued'", [batchId]);
    return this.getBatch(batchId);
  }

  async getActiveBatch() {
    const row = await this.row(`SELECT id FROM fulfillment_batches
      WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1`);
    return row ? this.getBatch(row.id) : null;
  }

  async getLatestPendingPreview(nowIso, shopId = null) {
    const parameters = [nowIso];
    let shopClause = "";
    if (shopId) {
      shopClause = " AND p.shop_id=?";
      parameters.push(shopId);
    }
    const row = await this.row(`SELECT p.id FROM fulfillment_previews p
      WHERE p.status='pending' AND p.expires_at>?${shopClause}
      AND EXISTS (SELECT 1 FROM fulfillment_preview_orders o WHERE o.preview_id=p.id AND o.eligible=1)
      ORDER BY p.created_at DESC LIMIT 1`, parameters);
    return row ? this.getPreview(row.id) : null;
  }

  async listPendingPreviewSummaries(nowIso, limit = 20) {
    const rows = await this.rows(`SELECT p.id AS preview_id,p.shop_id,p.shop_name,p.created_at,p.expires_at,
      SUM(CASE WHEN o.eligible=1 THEN 1 ELSE 0 END) AS eligible_count,
      SUM(CASE WHEN o.eligible=0 THEN 1 ELSE 0 END) AS excluded_count
      FROM fulfillment_previews p JOIN fulfillment_preview_orders o ON o.preview_id=p.id
      WHERE p.status='pending' AND p.expires_at>?
      GROUP BY p.id,p.shop_id,p.shop_name,p.created_at,p.expires_at
      ORDER BY p.created_at DESC LIMIT ?`, [nowIso, limit]);
    return rows.map((row) => ({
      previewId: row.preview_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      shop: { id: row.shop_id, name: row.shop_name },
      eligibleOrderCount: Number(row.eligible_count || 0),
      excludedOrderCount: Number(row.excluded_count || 0),
    }));
  }

  async recordScanRun(run) {
    await this.run(`INSERT INTO fulfillment_scan_runs
      (started_at,finished_at,outcome,message,eligible_count,excluded_count,preview_id)
      VALUES (?,?,?,?,?,?,?)`, [run.startedAt, run.finishedAt, run.outcome, run.message,
      run.eligibleCount || 0, run.excludedCount || 0, run.previewId || null]);
  }

  async listRecentScanRuns(limit = 10) {
    const rows = await this.rows("SELECT * FROM fulfillment_scan_runs ORDER BY id DESC LIMIT ?", [limit]);
    return rows.map((row) => ({
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      message: row.message,
      eligibleOrderCount: Number(row.eligible_count || 0),
      excludedOrderCount: Number(row.excluded_count || 0),
      previewId: row.preview_id,
    }));
  }

  async listRecentBatches(limit = 20) {
    const rows = await this.rows("SELECT id FROM fulfillment_batches ORDER BY created_at DESC LIMIT ?", [limit]);
    return Promise.all(rows.map(({ id }) => this.getBatch(id)));
  }

  async updatePreviewConfirmationHash(previewId, confirmationHash) {
    const result = await this.run(`UPDATE fulfillment_previews SET confirmation_hash=?
      WHERE id=? AND status='pending'`, [confirmationHash, previewId]);
    return result.rowCount === 1;
  }

  async recoverInterruptedBatches(nowIso) {
    const batchIds = await this.db.transaction(async (tx) => {
      const batches = await this.rows(`SELECT id FROM fulfillment_batches
        WHERE status IN ('queued','running') ORDER BY created_at`, [], tx);
      for (const { id } of batches) {
        const uncertain = await this.rows(`SELECT order_key FROM fulfillment_batch_orders
          WHERE batch_id=? AND status='queued'`, [id], tx);
        await this.run(`UPDATE fulfillment_batch_orders SET status='needs_attention',
          error_code='SERVICE_RESTARTED_DURING_BATCH',
          error_message='服务中断时订单是否已经提交无法确定，请在马帮核对后人工处理。',updated_at=?
          WHERE batch_id=? AND status='queued'`, [nowIso, id], tx);
        for (const order of uncertain) {
          await this.run(`UPDATE fulfillment_idempotency SET status='needs_attention',completed_at=?
            WHERE order_key=?`, [nowIso, order.order_key], tx);
        }
        const successful = await this.row(`SELECT 1 FROM fulfillment_batch_orders
          WHERE batch_id=? AND status='success' LIMIT 1`, [id], tx);
        await this.run("UPDATE fulfillment_batches SET status=?,finished_at=? WHERE id=?",
          [successful ? "partial_success" : "failed", nowIso, id], tx);
      }
      return batches.map(({ id }) => id);
    });
    return Promise.all(batchIds.map((id) => this.getBatch(id)));
  }

  async updateBatchOrder(batchId, orderKey, patch) {
    await this.db.transaction(async (tx) => {
      await this.run(`UPDATE fulfillment_batch_orders SET status=?,tracking_number_masked=?,error_code=?,error_message=?,
        after_status=?,timings_json=?,updated_at=? WHERE batch_id=? AND order_key=?`, [patch.status,
        patch.trackingNumberMasked || null, patch.errorCode || null, patch.errorMessage || null,
        patch.afterStatus || null, json(patch.timings), patch.updatedAt, batchId, orderKey], tx);
      await this.run("UPDATE fulfillment_idempotency SET status=?,completed_at=? WHERE order_key=?", [
        patch.status === "success" ? "success" : patch.status === "needs_attention" ? "needs_attention" : "failed",
        patch.updatedAt,
        orderKey,
      ], tx);
    });
  }

  async registerTrackingRecovery({ orderKey, batchId, displayOrderId, shopId, submittedAt, nextCheckAt, deadlineAt }) {
    await this.run(`INSERT INTO fulfillment_tracking_recoveries
      (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at)
      VALUES (?,?,?,?,'waiting_tracking',?,?,?)
      ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,display_order_id=excluded.display_order_id,
      shop_id=excluded.shop_id,status='waiting_tracking',submitted_at=excluded.submitted_at,
      next_check_at=excluded.next_check_at,deadline_at=excluded.deadline_at,last_checked_at=NULL,
      reset_count=0,last_reset_at=NULL,last_error_code=NULL,last_error_message=NULL,completed_at=NULL`,
    [orderKey, batchId, displayOrderId, shopId, submittedAt, nextCheckAt, deadlineAt]);
  }

  async listDueTrackingRecoveries(nowIso, limit = 10, shopId = null, displayOrderId = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 10));
    const orderId = String(displayOrderId || "").trim();
    const conditions = ["status IN ('waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset')"];
    const parameters = [];
    if (!orderId) {
      conditions.push("next_check_at<=?");
      parameters.push(nowIso);
    }
    if (shopId) {
      conditions.push("shop_id=?");
      parameters.push(shopId);
    }
    if (orderId) {
      conditions.push("display_order_id=?");
      parameters.push(orderId);
    }
    parameters.push(boundedLimit);
    const rows = await this.rows(`SELECT * FROM fulfillment_tracking_recoveries
      WHERE ${conditions.join(" AND ")} ORDER BY next_check_at ASC LIMIT ?`, parameters);
    return rows.map(recoveryFrom);
  }

  async listTrackingRecoveries(limit = 50, shopId = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const rows = shopId
      ? await this.rows(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE shop_id=? ORDER BY submitted_at DESC LIMIT ?`, [shopId, boundedLimit])
      : await this.rows(`SELECT * FROM fulfillment_tracking_recoveries
          ORDER BY submitted_at DESC LIMIT ?`, [boundedLimit]);
    return rows.map(recoveryFrom);
  }

  async deferTrackingRecovery(orderKey, { status, checkedAt, nextCheckAt, errorCode = null, errorMessage = null,
    resetCount = null, lastResetAt = null }) {
    const current = await this.row(`SELECT reset_count,last_reset_at
      FROM fulfillment_tracking_recoveries WHERE order_key=?`, [orderKey]);
    if (!current) return false;
    const result = await this.run(`UPDATE fulfillment_tracking_recoveries SET status=?,last_checked_at=?,next_check_at=?,
      reset_count=?,last_reset_at=?,last_error_code=?,last_error_message=? WHERE order_key=? AND completed_at IS NULL`, [
      status,
      checkedAt,
      nextCheckAt,
      resetCount == null ? current.reset_count : resetCount,
      lastResetAt == null ? current.last_reset_at : lastResetAt,
      errorCode,
      errorMessage,
      orderKey,
    ]);
    return result.rowCount === 1;
  }

  async completeTrackingRecovery(recovery, { completedAt, trackingNumberMasked, afterStatus }) {
    return this.db.transaction(async (tx) => {
      const updated = await this.run(`UPDATE fulfillment_tracking_recoveries SET status='completed',completed_at=?,
        last_checked_at=?,last_error_code=NULL,last_error_message=NULL WHERE order_key=? AND completed_at IS NULL`,
      [completedAt, completedAt, recovery.orderKey], tx);
      if (updated.rowCount !== 1) return false;
      await this.run(`UPDATE fulfillment_batch_orders SET status='success',tracking_number_masked=?,error_code=NULL,
        error_message=NULL,after_status=?,updated_at=? WHERE batch_id=? AND order_key=?`,
      [trackingNumberMasked || null, afterStatus || null, completedAt, recovery.batchId, recovery.orderKey], tx);
      await this.run(`UPDATE fulfillment_idempotency SET status='success',completed_at=?
        WHERE order_key=? AND batch_id=?`, [completedAt, recovery.orderKey, recovery.batchId], tx);
      return true;
    });
  }

  async expireTrackingRecovery(recovery, { completedAt, errorCode, errorMessage }) {
    return this.db.transaction(async (tx) => {
      const updated = await this.run(`UPDATE fulfillment_tracking_recoveries SET status='manual_attention',completed_at=?,
        last_checked_at=?,last_error_code=?,last_error_message=? WHERE order_key=? AND completed_at IS NULL`,
      [completedAt, completedAt, errorCode, errorMessage, recovery.orderKey], tx);
      if (updated.rowCount !== 1) return false;
      await this.run(`UPDATE fulfillment_batch_orders SET status='needs_attention',error_code=?,error_message=?,updated_at=?
        WHERE batch_id=? AND order_key=?`, [errorCode, errorMessage, completedAt, recovery.batchId, recovery.orderKey], tx);
      await this.run(`UPDATE fulfillment_idempotency SET status='needs_attention',completed_at=?
        WHERE order_key=? AND batch_id=?`, [completedAt, recovery.orderKey, recovery.batchId], tx);
      return true;
    });
  }

  async finishBatch(batchId, status, finishedAt) {
    await this.run("UPDATE fulfillment_batches SET status=?,finished_at=? WHERE id=?", [status, finishedAt, batchId]);
    return this.getBatch(batchId);
  }

  async updateBatchTimings(batchId, timings) {
    await this.run("UPDATE fulfillment_batches SET timings_json=? WHERE id=?", [json(timings), batchId]);
  }

  async getBatch(id) {
    const row = await this.row(`SELECT b.*,p.shop_id,p.shop_name FROM fulfillment_batches b
      JOIN fulfillment_previews p ON p.id=b.preview_id WHERE b.id=?`, [id]);
    if (!row) return null;
    const orders = await this.rows(`SELECT * FROM fulfillment_batch_orders
      WHERE batch_id=? ORDER BY display_order_id`, [id]);
    return {
      id: row.id,
      previewId: row.preview_id,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      shop: { id: row.shop_id, name: row.shop_name },
      timings: parse(row.timings_json, null),
      orders: orders.map((order) => ({
        orderKey: order.order_key,
        displayOrderId: order.display_order_id,
        status: order.status,
        trackingNumberMasked: order.tracking_number_masked,
        errorCode: order.error_code,
        errorMessage: order.error_message,
        beforeStatus: order.before_status,
        afterStatus: order.after_status,
        timings: parse(order.timings_json, null),
      })),
    };
  }

  async getDashboardSummary({ todayStartIso, trendStartIso, endIso, dayWindows }) {
    const activeRecoveryStatuses = "'waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset'";
    const activeRecoveryRows = await this.rows(`SELECT order_key FROM fulfillment_tracking_recoveries
      WHERE status IN (${activeRecoveryStatuses})`);
    const activeRecoveryKeys = new Set(activeRecoveryRows.map((row) => row.order_key));
    const rawOrderRows = await this.rows(`SELECT b.id AS batch_id,b.created_at,b.status AS batch_status,
      p.shop_id,p.shop_name,o.order_key,o.status,o.error_code,o.timings_json
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      WHERE b.created_at>=? AND b.created_at<? ORDER BY b.created_at`, [trendStartIso, endIso]);
    const latestOrders = new Map();
    for (const row of rawOrderRows) latestOrders.set(row.order_key, row);
    const orderRows = [...latestOrders.values()];
    const windows = Array.isArray(dayWindows) ? dayWindows : [];
    const trend = windows.map((window) => ({ date: window.date, total: 0, success: 0, running: 0, exceptions: 0, shops: [] }));
    const trendByDate = new Map(trend.map((item) => [item.date, item]));
    const trendShops = new Map();
    const todayShops = new Map();
    const exceptionMap = new Map();
    const isToday = (createdAt) => createdAt >= todayStartIso && createdAt < endIso;
    const classify = (row) => activeRecoveryKeys.has(row.order_key) ? "running" : row.status === "success" ? "success"
      : ["queued", "running"].includes(row.status) ? "running" : "exceptions";
    const windowFor = (createdAt) => windows.find((window) => createdAt >= window.fromIso && createdAt < window.toIso);
    const shopBucket = (map, shopId, shopName) => {
      if (!map.has(shopId)) map.set(shopId, {
        shopId,
        shopName,
        total: 0,
        success: 0,
        running: 0,
        exceptions: 0,
        totalMsSum: 0,
        trackingWaitMsSum: 0,
        timingSamples: 0,
      });
      return map.get(shopId);
    };
    const addOrder = (bucket, row) => {
      bucket.total += 1;
      bucket[classify(row)] += 1;
      const timings = parse(row.timings_json, {});
      const totalMs = Number(timings?.total ?? timings?.executorTotal);
      const trackingWaitMs = Number(timings?.trackingWait);
      if (Number.isFinite(totalMs) && totalMs >= 0) {
        bucket.totalMsSum += totalMs;
        bucket.trackingWaitMsSum += Number.isFinite(trackingWaitMs) && trackingWaitMs >= 0 ? trackingWaitMs : 0;
        bucket.timingSamples += 1;
      }
    };
    for (const row of orderRows) {
      const window = windowFor(row.created_at);
      if (window) {
        const day = trendByDate.get(window.date);
        day.total += 1;
        day[classify(row)] += 1;
        const key = `${window.date}:${row.shop_id}`;
        addOrder(shopBucket(trendShops, key, row.shop_name), row);
        trendShops.get(key).shopId = row.shop_id;
      }
      if (!isToday(row.created_at)) continue;
      addOrder(shopBucket(todayShops, row.shop_id, row.shop_name), row);
      if (classify(row) === "exceptions") {
        const code = row.error_code || row.status || "UNKNOWN_FULFILLMENT_ERROR";
        const key = `${row.shop_id}:${code}`;
        const current = exceptionMap.get(key) || { shopId: row.shop_id, code, count: 0 };
        current.count += 1;
        exceptionMap.set(key, current);
      }
    }
    for (const [key, bucket] of trendShops) {
      trendByDate.get(key.slice(0, 10))?.shops.push(bucket);
    }

    const excludedRows = await this.rows(`SELECT p.shop_id,o.order_key,o.exclusion_json,p.created_at
      FROM fulfillment_preview_orders o JOIN fulfillment_previews p ON p.id=o.preview_id
      WHERE o.eligible=0 AND p.created_at>=? AND p.created_at<? ORDER BY p.created_at DESC`, [todayStartIso, endIso]);
    const seenExcluded = new Set();
    for (const row of excludedRows) {
      if (seenExcluded.has(row.order_key)) continue;
      seenExcluded.add(row.order_key);
      const codes = parse(row.exclusion_json, []);
      for (const code of codes.length ? codes : ["ORDER_EXCLUDED"]) {
        if (code === "ALREADY_FULFILLED") continue;
        const key = `${row.shop_id}:${code}`;
        const current = exceptionMap.get(key) || { shopId: row.shop_id, code, count: 0 };
        current.count += 1;
        exceptionMap.set(key, current);
      }
    }

    const recoveryRows = await this.rows(`SELECT shop_id,status,COUNT(*) AS count FROM fulfillment_tracking_recoveries
      WHERE status IN (${activeRecoveryStatuses}) GROUP BY shop_id,status`);
    const manualRows = await this.rows(`SELECT p.shop_id,COUNT(*) AS count FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention'
      AND NOT EXISTS (SELECT 1 FROM fulfillment_tracking_recoveries r WHERE r.order_key=o.order_key
        AND r.status IN (${activeRecoveryStatuses})) GROUP BY p.shop_id`);
    return {
      generatedAt: endIso,
      todayStartAt: todayStartIso,
      trendStartAt: trendStartIso,
      shops: [...todayShops.values()],
      trend,
      exceptions: [...exceptionMap.values()].sort((a, b) => b.count - a.count),
      queues: {
        tracking: recoveryRows.map((row) => ({ shopId: row.shop_id, status: row.status, count: Number(row.count || 0) })),
        manual: manualRows.map((row) => ({ shopId: row.shop_id, count: Number(row.count || 0) })),
      },
    };
  }

  async close() {
    await this.db.close();
  }
}
