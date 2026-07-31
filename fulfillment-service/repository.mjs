import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const json = (value) => JSON.stringify(value ?? null);
const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value); } catch { return fallback; }
};

export class FulfillmentRepository {
  constructor(databasePath = ":memory:") {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.db.exec(`
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,started_at TEXT NOT NULL,finished_at TEXT NOT NULL,
        outcome TEXT NOT NULL,message TEXT NOT NULL,eligible_count INTEGER NOT NULL DEFAULT 0,
        excluded_count INTEGER NOT NULL DEFAULT 0,preview_id TEXT
      );
      CREATE TABLE IF NOT EXISTS fulfillment_manual_recovery_checks (
        order_key TEXT PRIMARY KEY,batch_id TEXT NOT NULL,pass_count INTEGER NOT NULL DEFAULT 0,
        first_passed_at TEXT NOT NULL,last_passed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fulfillment_tracking_recoveries (
        order_key TEXT PRIMARY KEY,batch_id TEXT NOT NULL,display_order_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,status TEXT NOT NULL,submitted_at TEXT NOT NULL,
        next_check_at TEXT NOT NULL,deadline_at TEXT NOT NULL,last_checked_at TEXT,
        reset_count INTEGER NOT NULL DEFAULT 0,last_reset_at TEXT,last_error_code TEXT,last_error_message TEXT,
        completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS fulfillment_agent_runs (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,status TEXT NOT NULL,model TEXT NOT NULL,
        step_count INTEGER NOT NULL DEFAULT 0,tool_trace_json TEXT NOT NULL DEFAULT '[]',
        error_code TEXT,started_at TEXT NOT NULL,finished_at TEXT
      );
    `);
    const previewOrderColumns = new Set(this.db.prepare("PRAGMA table_info(fulfillment_preview_orders)").all().map((row) => row.name));
    if (!previewOrderColumns.has("priority")) {
      this.db.exec("ALTER TABLE fulfillment_preview_orders ADD COLUMN priority INTEGER NOT NULL DEFAULT 0");
    }
    const batchColumns = new Set(this.db.prepare("PRAGMA table_info(fulfillment_batches)").all().map((row) => row.name));
    if (!batchColumns.has("timings_json")) this.db.exec("ALTER TABLE fulfillment_batches ADD COLUMN timings_json TEXT");
    const batchOrderColumns = new Set(this.db.prepare("PRAGMA table_info(fulfillment_batch_orders)").all().map((row) => row.name));
    if (!batchOrderColumns.has("timings_json")) this.db.exec("ALTER TABLE fulfillment_batch_orders ADD COLUMN timings_json TEXT");
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  startAgentRun({ id, conversationId, model, startedAt }) {
    this.db.prepare(`INSERT INTO fulfillment_agent_runs
      (id,conversation_id,status,model,started_at) VALUES (?,?,'running',?,?)`)
      .run(id, conversationId, model, startedAt);
  }

  finishAgentRun({ id, status, stepCount = 0, toolTrace = [], errorCode = null, finishedAt }) {
    this.db.prepare(`UPDATE fulfillment_agent_runs SET status=?,step_count=?,tool_trace_json=?,error_code=?,finished_at=?
      WHERE id=?`).run(status, stepCount, json(toolTrace), errorCode, finishedAt, id);
  }

  getAgentRun(id) {
    const row = this.db.prepare("SELECT * FROM fulfillment_agent_runs WHERE id=?").get(id);
    return row ? { id: row.id, conversationId: row.conversation_id, status: row.status, model: row.model,
      stepCount: Number(row.step_count || 0), toolTrace: parse(row.tool_trace_json, []), errorCode: row.error_code,
      startedAt: row.started_at, finishedAt: row.finished_at } : null;
  }

  createPreview(preview, orders) {
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO fulfillment_previews
        (id,status,shop_id,shop_name,channel_id,channel_name,confirmation_hash,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(preview.id, preview.status, preview.shopId, preview.shopName,
        preview.channelId, preview.channelName, preview.confirmationHash, preview.expiresAt, preview.createdAt);
      const insert = this.db.prepare(`INSERT INTO fulfillment_preview_orders
        (preview_id,order_key,display_order_id,trade_number,warehouse,sku_count,eligible,exclusion_json,snapshot_json,priority)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      orders.forEach((order, priority) => insert.run(preview.id, order.orderKey, order.displayOrderId, order.tradeNumber,
        order.warehouse, order.skuCount, order.eligible ? 1 : 0, json(order.exclusions), json(order.snapshot), priority));
      return this.getPreview(preview.id);
    });
  }

  getPreview(id) {
    const row = this.db.prepare("SELECT * FROM fulfillment_previews WHERE id=?").get(id);
    if (!row) return null;
    const orders = this.db.prepare("SELECT * FROM fulfillment_preview_orders WHERE preview_id=? ORDER BY priority,display_order_id").all(id);
    return {
      id: row.id, status: row.status, shopId: row.shop_id, shopName: row.shop_name,
      channelId: row.channel_id, channelName: row.channel_name, confirmationHash: row.confirmation_hash,
      expiresAt: row.expires_at, createdAt: row.created_at,
      orders: orders.map((order) => ({
        orderKey: order.order_key, displayOrderId: order.display_order_id, tradeNumber: order.trade_number,
        warehouse: order.warehouse, skuCount: order.sku_count, eligible: Boolean(order.eligible),
        exclusions: parse(order.exclusion_json, []), snapshot: parse(order.snapshot_json, {}),
      })),
    };
  }

  isCompleted(orderKey) {
    return Boolean(this.db.prepare("SELECT 1 FROM fulfillment_idempotency WHERE order_key=? AND status IN ('success','needs_attention')").get(orderKey));
  }

  quarantineFailedOrders(errorCode, updatedAt) {
    const candidates = this.db.prepare(`SELECT i.order_key,i.batch_id
      FROM fulfillment_idempotency i
      JOIN fulfillment_batch_orders o ON o.batch_id=i.batch_id AND o.order_key=i.order_key
      WHERE i.status='failed' AND o.status='failed' AND o.error_code=?`).all(errorCode);
    if (!candidates.length) return 0;
    return this.transaction(() => {
      const updateOrder = this.db.prepare(`UPDATE fulfillment_batch_orders SET status='needs_attention',updated_at=?
        WHERE batch_id=? AND order_key=? AND status='failed' AND error_code=?`);
      const updateReservation = this.db.prepare(`UPDATE fulfillment_idempotency SET status='needs_attention',completed_at=?
        WHERE order_key=? AND batch_id=? AND status='failed'`);
      let changed = 0;
      for (const candidate of candidates) {
        const orderResult = updateOrder.run(updatedAt, candidate.batch_id, candidate.order_key, errorCode);
        const reservationResult = updateReservation.run(updatedAt, candidate.order_key, candidate.batch_id);
        if (Number(orderResult.changes) === 1 && Number(reservationResult.changes) === 1) changed += 1;
      }
      return changed;
    });
  }

  migratePendingTrackingRecoveries({ nowIso, checkSeconds = 300, deadlineHours = 24 }) {
    const candidates = this.db.prepare(`SELECT o.batch_id,o.order_key,o.display_order_id,o.tracking_number_masked,
      o.updated_at,o.timings_json,p.shop_id
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention' AND o.error_code='VERIFY_FAILED'
      AND COALESCE(o.after_status,'') LIKE '%待处理%'`).all().filter((row) => {
        const timings = parse(row.timings_json, {});
        return Number(timings?.submitRequest || 0) > 0 && Number(timings?.distributionRequest || 0) === 0;
      });
    if (!candidates.length) return 0;
    return this.transaction(() => {
      let changed = 0;
      for (const row of candidates) {
        const submittedAt = row.updated_at || nowIso;
        const nextCheckAt = new Date(Math.max(Date.parse(nowIso), Date.parse(submittedAt) + checkSeconds * 1000)).toISOString();
        const deadlineAt = new Date(Date.parse(submittedAt) + deadlineHours * 3600000).toISOString();
        const hasTracking = Boolean(String(row.tracking_number_masked || '').trim());
        this.db.prepare(`UPDATE fulfillment_batch_orders SET error_code=?,error_message=?
          WHERE batch_id=? AND order_key=? AND error_code='VERIFY_FAILED'`).run(
            hasTracking ? 'DISTRIBUTION_PENDING' : 'TRACKING_NUMBER_PENDING',
            hasTracking
              ? '已取得运单号，等待按固定物流渠道转入配货中。'
              : '交运已提交，Shopee 运单号审批中；系统将持续回查，禁止重复交运。',
            row.batch_id, row.order_key,
          );
        this.db.prepare(`INSERT INTO fulfillment_tracking_recoveries
          (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at)
          VALUES (?,?,?,?,'waiting_tracking',?,?,?) ON CONFLICT(order_key) DO NOTHING`)
          .run(row.order_key, row.batch_id, row.display_order_id, row.shop_id, submittedAt, nextCheckAt, deadlineAt);
        changed += 1;
      }
      return changed;
    });
  }

  getManualReview(shopId, displayOrderId) {
    const row = this.db.prepare(`SELECT o.batch_id,o.order_key,o.display_order_id,o.error_code,o.error_message,o.updated_at,
      p.shop_id,p.shop_name
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE p.shop_id=? AND o.display_order_id=? AND o.status='needs_attention' AND i.status='needs_attention'
      AND o.error_code IN ('INVENTORY_UNKNOWN_BEFORE_SUBMIT','MULTI_WAREHOUSE_REQUIRES_REVIEW')
      ORDER BY o.updated_at DESC LIMIT 1`).get(shopId, displayOrderId);
    if (!row) return null;
    return {
      batchId: row.batch_id, orderKey: row.order_key, displayOrderId: row.display_order_id,
      errorCode: row.error_code, errorMessage: row.error_message, updatedAt: row.updated_at,
      shop: { id: row.shop_id, name: row.shop_name },
    };
  }

  listRecoverableManualReviews(shopId, limit = 5) {
    return this.db.prepare(`SELECT o.batch_id,o.order_key,o.display_order_id,o.error_code,o.error_message,o.updated_at,
      p.shop_id,p.shop_name,COALESCE(r.pass_count,0) AS recovery_pass_count,r.last_passed_at
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      LEFT JOIN fulfillment_manual_recovery_checks r ON r.order_key=o.order_key AND r.batch_id=o.batch_id
      WHERE p.shop_id=? AND o.status='needs_attention' AND i.status='needs_attention'
      AND o.error_code IN ('INVENTORY_UNKNOWN_BEFORE_SUBMIT','MULTI_WAREHOUSE_REQUIRES_REVIEW')
      ORDER BY o.updated_at ASC LIMIT ?`).all(shopId, Math.max(1, Math.min(Number(limit) || 5, 10))).map((row) => ({
        batchId: row.batch_id, orderKey: row.order_key, displayOrderId: row.display_order_id,
        errorCode: row.error_code, errorMessage: row.error_message, updatedAt: row.updated_at,
        recoveryPassCount: Number(row.recovery_pass_count || 0), recoveryLastPassedAt: row.last_passed_at || null,
        shop: { id: row.shop_id, name: row.shop_name },
      }));
  }

  recordManualRecoveryPass(review, checkedAt) {
    return this.transaction(() => {
      const locked = this.db.prepare(`SELECT 1 FROM fulfillment_idempotency
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`).get(review.orderKey, review.batchId);
      if (!locked) return null;
      const current = this.db.prepare(`SELECT pass_count,batch_id,first_passed_at
        FROM fulfillment_manual_recovery_checks WHERE order_key=?`).get(review.orderKey);
      const continuePrevious = current?.batch_id === review.batchId;
      const passCount = continuePrevious ? Math.min(2, Number(current.pass_count || 0) + 1) : 1;
      const firstPassedAt = continuePrevious ? current.first_passed_at : checkedAt;
      this.db.prepare(`INSERT INTO fulfillment_manual_recovery_checks
        (order_key,batch_id,pass_count,first_passed_at,last_passed_at) VALUES (?,?,?,?,?)
        ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,pass_count=excluded.pass_count,
        first_passed_at=excluded.first_passed_at,last_passed_at=excluded.last_passed_at`)
        .run(review.orderKey, review.batchId, passCount, firstPassedAt, checkedAt);
      return { passCount, firstPassedAt, lastPassedAt: checkedAt };
    });
  }

  resetManualRecovery(review) {
    return Number(this.db.prepare(`DELETE FROM fulfillment_manual_recovery_checks
      WHERE order_key=? AND batch_id=?`).run(review.orderKey, review.batchId).changes) === 1;
  }

  releaseManualReview(review, updatedAt) {
    return this.transaction(() => {
      const result = this.db.prepare(`UPDATE fulfillment_idempotency SET status='failed',completed_at=NULL
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`).run(review.orderKey, review.batchId);
      if (Number(result.changes) !== 1) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET status='released',updated_at=?
        WHERE batch_id=? AND order_key=? AND status='needs_attention'`).run(updatedAt, review.batchId, review.orderKey);
      this.db.prepare("DELETE FROM fulfillment_manual_recovery_checks WHERE order_key=?").run(review.orderKey);
      return true;
    });
  }

  createBatch(batch, orders) {
    return this.transaction(() => {
      const activeBatch = this.db.prepare("SELECT id FROM fulfillment_batches WHERE status IN ('queued','running') LIMIT 1").get();
      if (activeBatch) {
        const error = new Error(`已有发货批次正在运行：${activeBatch.id}`); error.code = "BATCH_ALREADY_RUNNING"; throw error;
      }
      const confirmation = this.db.prepare("UPDATE fulfillment_previews SET status='confirmed' WHERE id=? AND status='pending'").run(batch.previewId);
      if (Number(confirmation.changes) !== 1) {
        const error = new Error("预览已经确认或失效"); error.code = "PREVIEW_ALREADY_USED"; throw error;
      }
      this.db.prepare("INSERT INTO fulfillment_batches (id,preview_id,status,created_at) VALUES (?,?,?,?)")
        .run(batch.id, batch.previewId, batch.status, batch.createdAt);
      const insert = this.db.prepare(`INSERT INTO fulfillment_batch_orders
        (batch_id,order_key,display_order_id,status,before_status,updated_at) VALUES (?,?,?,?,?,?)`);
      const reserve = this.db.prepare(`INSERT INTO fulfillment_idempotency (order_key,batch_id,status,completed_at)
        VALUES (?,?,?,NULL)
        ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,status='running',completed_at=NULL
        WHERE fulfillment_idempotency.status='failed'`);
      for (const order of orders) {
        insert.run(batch.id, order.orderKey, order.displayOrderId, "queued", order.snapshot.orderStatus, batch.createdAt);
        const reservation = reserve.run(order.orderKey, batch.id, "running");
        if (Number(reservation.changes) !== 1) {
          const existing = this.db.prepare("SELECT status FROM fulfillment_idempotency WHERE order_key=?").get(order.orderKey);
          const error = new Error(existing?.status === "success" ? "订单已经成功发货，禁止重复提交" : "订单已有正在执行的发货批次");
          error.code = "IDEMPOTENCY_CONFLICT";
          throw error;
        }
      }
      return this.getBatch(batch.id);
    });
  }

  startBatch(batchId) {
    this.db.prepare("UPDATE fulfillment_batches SET status='running' WHERE id=? AND status='queued'").run(batchId);
    return this.getBatch(batchId);
  }

  getActiveBatch() {
    const row = this.db.prepare("SELECT id FROM fulfillment_batches WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1").get();
    return row ? this.getBatch(row.id) : null;
  }

  getLatestPendingPreview(nowIso, shopId = null) {
    const row = shopId ? this.db.prepare(`SELECT p.id FROM fulfillment_previews p
      WHERE p.status='pending' AND p.expires_at>?
      AND p.shop_id=?
      AND EXISTS (SELECT 1 FROM fulfillment_preview_orders o WHERE o.preview_id=p.id AND o.eligible=1)
      ORDER BY p.created_at DESC LIMIT 1`).get(nowIso, shopId) : this.db.prepare(`SELECT p.id FROM fulfillment_previews p
      WHERE p.status='pending' AND p.expires_at>?
      AND EXISTS (SELECT 1 FROM fulfillment_preview_orders o WHERE o.preview_id=p.id AND o.eligible=1)
      ORDER BY p.created_at DESC LIMIT 1`).get(nowIso);
    return row ? this.getPreview(row.id) : null;
  }

  listPendingPreviewSummaries(nowIso, limit = 20) {
    return this.db.prepare(`SELECT p.id AS preview_id,p.shop_id,p.shop_name,p.created_at,p.expires_at,
      SUM(CASE WHEN o.eligible=1 THEN 1 ELSE 0 END) AS eligible_count,
      SUM(CASE WHEN o.eligible=0 THEN 1 ELSE 0 END) AS excluded_count
      FROM fulfillment_previews p JOIN fulfillment_preview_orders o ON o.preview_id=p.id
      WHERE p.status='pending' AND p.expires_at>?
      GROUP BY p.id ORDER BY p.created_at DESC LIMIT ?`).all(nowIso, limit).map((row) => ({
      previewId: row.preview_id, createdAt: row.created_at, expiresAt: row.expires_at,
      shop: { id: row.shop_id, name: row.shop_name },
        eligibleOrderCount: Number(row.eligible_count || 0), excludedOrderCount: Number(row.excluded_count || 0),
      }));
  }

  recordScanRun(run) {
    this.db.prepare(`INSERT INTO fulfillment_scan_runs
      (started_at,finished_at,outcome,message,eligible_count,excluded_count,preview_id)
      VALUES (?,?,?,?,?,?,?)`).run(run.startedAt, run.finishedAt, run.outcome, run.message,
      run.eligibleCount || 0, run.excludedCount || 0, run.previewId || null);
  }

  listRecentScanRuns(limit = 10) {
    return this.db.prepare("SELECT * FROM fulfillment_scan_runs ORDER BY id DESC LIMIT ?").all(limit).map((row) => ({
      startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome, message: row.message,
      eligibleOrderCount: Number(row.eligible_count || 0), excludedOrderCount: Number(row.excluded_count || 0),
      previewId: row.preview_id,
    }));
  }

  listRecentBatches(limit = 20) {
    return this.db.prepare("SELECT id FROM fulfillment_batches ORDER BY created_at DESC LIMIT ?").all(limit)
      .map(({ id }) => this.getBatch(id));
  }

  updatePreviewConfirmationHash(previewId, confirmationHash) {
    const result = this.db.prepare("UPDATE fulfillment_previews SET confirmation_hash=? WHERE id=? AND status='pending'")
      .run(confirmationHash, previewId);
    return Number(result.changes) === 1;
  }

  recoverInterruptedBatches(nowIso) {
    return this.transaction(() => {
      const batches = this.db.prepare("SELECT id FROM fulfillment_batches WHERE status IN ('queued','running') ORDER BY created_at").all();
      for (const { id } of batches) {
        const uncertain = this.db.prepare("SELECT order_key FROM fulfillment_batch_orders WHERE batch_id=? AND status='queued'").all(id);
        this.db.prepare(`UPDATE fulfillment_batch_orders SET status='needs_attention',
          error_code='SERVICE_RESTARTED_DURING_BATCH',
          error_message='服务中断时订单是否已提交无法确定，请在马帮核对后人工处理。',updated_at=?
          WHERE batch_id=? AND status='queued'`).run(nowIso, id);
        const updateReservation = this.db.prepare("UPDATE fulfillment_idempotency SET status='needs_attention',completed_at=? WHERE order_key=?");
        for (const order of uncertain) updateReservation.run(nowIso, order.order_key);
        const successful = this.db.prepare("SELECT 1 FROM fulfillment_batch_orders WHERE batch_id=? AND status='success' LIMIT 1").get(id);
        this.db.prepare("UPDATE fulfillment_batches SET status=?,finished_at=? WHERE id=?")
          .run(successful ? "partial_success" : "failed", nowIso, id);
      }
      return batches.map(({ id }) => this.getBatch(id));
    });
  }

  updateBatchOrder(batchId, orderKey, patch) {
    this.db.prepare(`UPDATE fulfillment_batch_orders SET status=?,tracking_number_masked=?,error_code=?,error_message=?,
      after_status=?,timings_json=?,updated_at=? WHERE batch_id=? AND order_key=?`).run(patch.status, patch.trackingNumberMasked || null,
      patch.errorCode || null, patch.errorMessage || null, patch.afterStatus || null, json(patch.timings), patch.updatedAt, batchId, orderKey);
    this.db.prepare("UPDATE fulfillment_idempotency SET status=?,completed_at=? WHERE order_key=?")
      .run(patch.status === "success" ? "success" : patch.status === "needs_attention" ? "needs_attention" : "failed",
        patch.updatedAt, orderKey);
  }

  registerTrackingRecovery({ orderKey, batchId, displayOrderId, shopId, submittedAt, nextCheckAt, deadlineAt }) {
    this.db.prepare(`INSERT INTO fulfillment_tracking_recoveries
      (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at)
      VALUES (?,?,?,?,'waiting_tracking',?,?,?)
      ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,display_order_id=excluded.display_order_id,
      shop_id=excluded.shop_id,status='waiting_tracking',submitted_at=excluded.submitted_at,
      next_check_at=excluded.next_check_at,deadline_at=excluded.deadline_at,last_checked_at=NULL,
      reset_count=0,last_reset_at=NULL,last_error_code=NULL,last_error_message=NULL,completed_at=NULL`)
      .run(orderKey, batchId, displayOrderId, shopId, submittedAt, nextCheckAt, deadlineAt);
  }

  listDueTrackingRecoveries(nowIso, limit = 10, shopId = null, displayOrderId = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 10));
    const orderId = String(displayOrderId || "").trim();
    const rows = shopId && orderId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset')
          AND shop_id=? AND display_order_id=?
          ORDER BY next_check_at ASC LIMIT ?`).all(shopId, orderId, boundedLimit)
      : shopId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset') AND next_check_at<=? AND shop_id=?
          ORDER BY next_check_at ASC LIMIT ?`).all(nowIso, shopId, boundedLimit)
      : orderId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset')
          AND display_order_id=?
          ORDER BY next_check_at ASC LIMIT ?`).all(orderId, boundedLimit)
      : this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset') AND next_check_at<=?
          ORDER BY next_check_at ASC LIMIT ?`).all(nowIso, boundedLimit);
    return rows.map((row) => ({
        orderKey: row.order_key, batchId: row.batch_id, displayOrderId: row.display_order_id, shopId: row.shop_id,
        status: row.status, submittedAt: row.submitted_at, nextCheckAt: row.next_check_at, deadlineAt: row.deadline_at,
        lastCheckedAt: row.last_checked_at || null, resetCount: Number(row.reset_count || 0),
        lastResetAt: row.last_reset_at || null, lastErrorCode: row.last_error_code || null,
        lastErrorMessage: row.last_error_message || null, completedAt: row.completed_at || null,
      }));
  }

  listTrackingRecoveries(limit = 50, shopId = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const rows = shopId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries WHERE shop_id=? ORDER BY submitted_at DESC LIMIT ?`)
          .all(shopId, boundedLimit)
      : this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries ORDER BY submitted_at DESC LIMIT ?`).all(boundedLimit);
    return rows.map((row) => ({
        orderKey: row.order_key, batchId: row.batch_id, displayOrderId: row.display_order_id, shopId: row.shop_id,
        status: row.status, submittedAt: row.submitted_at, nextCheckAt: row.next_check_at, deadlineAt: row.deadline_at,
        lastCheckedAt: row.last_checked_at || null, resetCount: Number(row.reset_count || 0),
        lastResetAt: row.last_reset_at || null, lastErrorCode: row.last_error_code || null,
        lastErrorMessage: row.last_error_message || null, completedAt: row.completed_at || null,
      }));
  }

  deferTrackingRecovery(orderKey, { status, checkedAt, nextCheckAt, errorCode = null, errorMessage = null,
    resetCount = null, lastResetAt = null }) {
    const current = this.db.prepare("SELECT reset_count,last_reset_at FROM fulfillment_tracking_recoveries WHERE order_key=?").get(orderKey);
    if (!current) return false;
    const result = this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET status=?,last_checked_at=?,next_check_at=?,
      reset_count=?,last_reset_at=?,last_error_code=?,last_error_message=? WHERE order_key=? AND completed_at IS NULL`)
      .run(status, checkedAt, nextCheckAt, resetCount == null ? current.reset_count : resetCount,
        lastResetAt == null ? current.last_reset_at : lastResetAt, errorCode, errorMessage, orderKey);
    return Number(result.changes) === 1;
  }

  completeTrackingRecovery(recovery, { completedAt, trackingNumberMasked, afterStatus }) {
    return this.transaction(() => {
      const updated = this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET status='completed',completed_at=?,
        last_checked_at=?,last_error_code=NULL,last_error_message=NULL WHERE order_key=? AND completed_at IS NULL`)
        .run(completedAt, completedAt, recovery.orderKey);
      if (Number(updated.changes) !== 1) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET status='success',tracking_number_masked=?,error_code=NULL,
        error_message=NULL,after_status=?,updated_at=? WHERE batch_id=? AND order_key=?`)
        .run(trackingNumberMasked || null, afterStatus || null, completedAt, recovery.batchId, recovery.orderKey);
      this.db.prepare(`UPDATE fulfillment_idempotency SET status='success',completed_at=? WHERE order_key=? AND batch_id=?`)
        .run(completedAt, recovery.orderKey, recovery.batchId);
      return true;
    });
  }

  expireTrackingRecovery(recovery, { completedAt, errorCode, errorMessage }) {
    return this.transaction(() => {
      const updated = this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET status='manual_attention',completed_at=?,
        last_checked_at=?,last_error_code=?,last_error_message=? WHERE order_key=? AND completed_at IS NULL`)
        .run(completedAt, completedAt, errorCode, errorMessage, recovery.orderKey);
      if (Number(updated.changes) !== 1) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET status='needs_attention',error_code=?,error_message=?,updated_at=?
        WHERE batch_id=? AND order_key=?`).run(errorCode, errorMessage, completedAt, recovery.batchId, recovery.orderKey);
      this.db.prepare(`UPDATE fulfillment_idempotency SET status='needs_attention',completed_at=? WHERE order_key=? AND batch_id=?`)
        .run(completedAt, recovery.orderKey, recovery.batchId);
      return true;
    });
  }

  finishBatch(batchId, status, finishedAt) {
    this.db.prepare("UPDATE fulfillment_batches SET status=?,finished_at=? WHERE id=?").run(status, finishedAt, batchId);
    return this.getBatch(batchId);
  }

  updateBatchTimings(batchId, timings) {
    this.db.prepare("UPDATE fulfillment_batches SET timings_json=? WHERE id=?").run(json(timings), batchId);
  }

  getBatch(id) {
    const row = this.db.prepare(`SELECT b.*,p.shop_id,p.shop_name FROM fulfillment_batches b
      JOIN fulfillment_previews p ON p.id=b.preview_id WHERE b.id=?`).get(id);
    if (!row) return null;
    const orders = this.db.prepare("SELECT * FROM fulfillment_batch_orders WHERE batch_id=? ORDER BY display_order_id").all(id);
    return {
      id: row.id, previewId: row.preview_id, status: row.status, createdAt: row.created_at, finishedAt: row.finished_at,
      shop: { id: row.shop_id, name: row.shop_name }, timings: parse(row.timings_json, null),
      orders: orders.map((order) => ({
        orderKey: order.order_key, displayOrderId: order.display_order_id, status: order.status,
        trackingNumberMasked: order.tracking_number_masked, errorCode: order.error_code,
        errorMessage: order.error_message, beforeStatus: order.before_status, afterStatus: order.after_status,
        timings: parse(order.timings_json, null),
      })),
    };
  }

  getDashboardSummary({ todayStartIso, trendStartIso, endIso, dayWindows }) {
    const activeRecoveryStatuses = "'waiting_tracking','ready_to_resubmit','resubmitting','waiting_after_reset'";
    const activeRecoveryKeys = new Set(this.db.prepare(`SELECT order_key FROM fulfillment_tracking_recoveries
      WHERE status IN (${activeRecoveryStatuses})`).all().map((row) => row.order_key));
    const rawOrderRows = this.db.prepare(`SELECT b.id AS batch_id,b.created_at,b.status AS batch_status,
      p.shop_id,p.shop_name,o.order_key,o.status,o.error_code,o.timings_json
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      WHERE b.created_at>=? AND b.created_at<? ORDER BY b.created_at`).all(trendStartIso, endIso);
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
      if (!map.has(shopId)) map.set(shopId, { shopId, shopName, total: 0, success: 0, running: 0, exceptions: 0,
        totalMsSum: 0, trackingWaitMsSum: 0, timingSamples: 0 });
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
      const date = key.slice(0, 10);
      trendByDate.get(date)?.shops.push(bucket);
    }

    const excludedRows = this.db.prepare(`SELECT p.shop_id,o.order_key,o.exclusion_json,p.created_at
      FROM fulfillment_preview_orders o JOIN fulfillment_previews p ON p.id=o.preview_id
      WHERE o.eligible=0 AND p.created_at>=? AND p.created_at<? ORDER BY p.created_at DESC`)
      .all(todayStartIso, endIso);
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

    const recoveryRows = this.db.prepare(`SELECT shop_id,status,COUNT(*) AS count FROM fulfillment_tracking_recoveries
      WHERE status IN (${activeRecoveryStatuses}) GROUP BY shop_id,status`).all();
    const manualRows = this.db.prepare(`SELECT p.shop_id,COUNT(*) AS count FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention'
      AND NOT EXISTS (SELECT 1 FROM fulfillment_tracking_recoveries r WHERE r.order_key=o.order_key
        AND r.status IN (${activeRecoveryStatuses})) GROUP BY p.shop_id`).all();
    return {
      generatedAt: endIso, todayStartAt: todayStartIso, trendStartAt: trendStartIso,
      shops: [...todayShops.values()], trend,
      exceptions: [...exceptionMap.values()].sort((a, b) => b.count - a.count),
      queues: {
        tracking: recoveryRows.map((row) => ({ shopId: row.shop_id, status: row.status, count: Number(row.count || 0) })),
        manual: manualRows.map((row) => ({ shopId: row.shop_id, count: Number(row.count || 0) })),
      },
    };
  }

  close() { this.db.close(); }
}
