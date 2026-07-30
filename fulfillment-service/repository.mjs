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
        excluded_count INTEGER NOT NULL DEFAULT 0,preview_id TEXT,details_json TEXT
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
        completed_at TEXT,manual_resolution_detected_at TEXT,manual_confirmed_at TEXT,
        tracking_number_masked TEXT,observed_order_status TEXT,origin_error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS fulfillment_alert_notifications (
        fingerprint TEXT PRIMARY KEY,alert_type TEXT NOT NULL,last_notified_at TEXT NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1
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
    const scanRunColumns = new Set(this.db.prepare("PRAGMA table_info(fulfillment_scan_runs)").all().map((row) => row.name));
    if (!scanRunColumns.has("details_json")) this.db.exec("ALTER TABLE fulfillment_scan_runs ADD COLUMN details_json TEXT");
    const trackingRecoveryColumns = new Set(this.db.prepare("PRAGMA table_info(fulfillment_tracking_recoveries)").all().map((row) => row.name));
    if (!trackingRecoveryColumns.has("manual_resolution_detected_at")) this.db.exec("ALTER TABLE fulfillment_tracking_recoveries ADD COLUMN manual_resolution_detected_at TEXT");
    if (!trackingRecoveryColumns.has("manual_confirmed_at")) this.db.exec("ALTER TABLE fulfillment_tracking_recoveries ADD COLUMN manual_confirmed_at TEXT");
    if (!trackingRecoveryColumns.has("tracking_number_masked")) this.db.exec("ALTER TABLE fulfillment_tracking_recoveries ADD COLUMN tracking_number_masked TEXT");
    if (!trackingRecoveryColumns.has("observed_order_status")) this.db.exec("ALTER TABLE fulfillment_tracking_recoveries ADD COLUMN observed_order_status TEXT");
    if (!trackingRecoveryColumns.has("origin_error_code")) this.db.exec("ALTER TABLE fulfillment_tracking_recoveries ADD COLUMN origin_error_code TEXT");
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
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
    const candidates = this.db.prepare(`WITH ranked AS (
      SELECT i.order_key,i.batch_id,i.status AS reservation_status,o.status AS order_status,o.error_code,
        ROW_NUMBER() OVER (PARTITION BY i.order_key ORDER BY COALESCE(o.updated_at,'') DESC,i.rowid DESC) AS position
      FROM fulfillment_idempotency i
      JOIN fulfillment_batch_orders o ON o.batch_id=i.batch_id AND o.order_key=i.order_key
    ) SELECT order_key,batch_id FROM ranked
      WHERE position=1 AND reservation_status='failed' AND order_status='failed' AND error_code=?`).all(errorCode);
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
    const candidates = this.db.prepare(`SELECT o.batch_id,o.order_key,o.display_order_id,o.updated_at,o.timings_json,
      o.error_code,o.tracking_number_masked,p.shop_id
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention'
      AND (o.error_code='SERVICE_RESTARTED_DURING_BATCH'
        OR (o.error_code='VERIFY_FAILED' AND COALESCE(o.after_status,'') LIKE '%待处理%'))`).all().filter((row) => {
        if (row.error_code === "SERVICE_RESTARTED_DURING_BATCH") return true;
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
        this.db.prepare(`UPDATE fulfillment_batch_orders SET
          error_code=CASE WHEN error_code='SERVICE_RESTARTED_DURING_BATCH' THEN 'INTERRUPTED_RECOVERY_PENDING'
            WHEN tracking_number_masked IS NULL THEN 'TRACKING_NUMBER_PENDING'
            ELSE 'DISTRIBUTION_RECOVERY_PENDING' END,
          error_message=CASE WHEN error_code='SERVICE_RESTARTED_DURING_BATCH'
            THEN '服务中断恢复中：系统将先核对运单号和交运记录，再选择安全恢复动作。'
            WHEN tracking_number_masked IS NULL
            THEN '交运已提交，Shopee 运单号审批中；系统将持续回查，禁止重复交运。'
            ELSE '已取得运单号，系统将核对现有运单号后仅执行转入配货中，禁止重复交运。' END
          WHERE batch_id=? AND order_key=? AND error_code=?`).run(row.batch_id, row.order_key, row.error_code);
        this.db.prepare(`INSERT INTO fulfillment_tracking_recoveries
          (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at,origin_error_code)
          VALUES (?,?,?,?,'waiting_tracking',?,?,?,?) ON CONFLICT(order_key) DO NOTHING`)
          .run(row.order_key, row.batch_id, row.display_order_id, row.shop_id, submittedAt, nextCheckAt, deadlineAt, row.error_code);
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
      AND o.error_code IN ('INVENTORY_UNKNOWN_BEFORE_SUBMIT','MULTI_WAREHOUSE_REQUIRES_REVIEW',
        'CHANNEL_NOT_AVAILABLE_BEFORE_SUBMIT')
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
      (started_at,finished_at,outcome,message,eligible_count,excluded_count,preview_id,details_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(run.startedAt, run.finishedAt, run.outcome, run.message,
      run.eligibleCount || 0, run.excludedCount || 0, run.previewId || null, json(run.details || null));
  }

  listRecentScanRuns(limit = 10) {
    return this.db.prepare("SELECT * FROM fulfillment_scan_runs ORDER BY id DESC LIMIT ?").all(limit).map((row) => ({
      startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome, message: row.message,
      eligibleOrderCount: Number(row.eligible_count || 0), excludedOrderCount: Number(row.excluded_count || 0),
      previewId: row.preview_id, details: parse(row.details_json, null),
    }));
  }

  claimAlertNotification({ fingerprint, alertType, nowIso, cooldownMinutes = 360 }) {
    const key = String(fingerprint || "").slice(0, 300);
    if (!key) return false;
    const current = this.db.prepare("SELECT last_notified_at,occurrence_count FROM fulfillment_alert_notifications WHERE fingerprint=?").get(key);
    const previousMs = Date.parse(current?.last_notified_at || "");
    const nowMs = Date.parse(nowIso);
    const due = !current || !Number.isFinite(previousMs) || !Number.isFinite(nowMs)
      || nowMs - previousMs >= Math.max(1, Number(cooldownMinutes) || 360) * 60000;
    if (!current) {
      this.db.prepare(`INSERT INTO fulfillment_alert_notifications
        (fingerprint,alert_type,last_notified_at,occurrence_count) VALUES (?,?,?,1)`).run(key, alertType, nowIso);
    } else if (due) {
      this.db.prepare(`UPDATE fulfillment_alert_notifications SET alert_type=?,last_notified_at=?,
        occurrence_count=occurrence_count+1 WHERE fingerprint=?`).run(alertType, nowIso, key);
    } else {
      this.db.prepare("UPDATE fulfillment_alert_notifications SET occurrence_count=occurrence_count+1 WHERE fingerprint=?").run(key);
    }
    return due;
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

  registerTrackingRecovery({ orderKey, batchId, displayOrderId, shopId, submittedAt, nextCheckAt, deadlineAt,
    originErrorCode = null }) {
    this.db.prepare(`INSERT INTO fulfillment_tracking_recoveries
      (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at,origin_error_code)
      VALUES (?,?,?,?,'waiting_tracking',?,?,?,?)
      ON CONFLICT(order_key) DO UPDATE SET batch_id=excluded.batch_id,display_order_id=excluded.display_order_id,
      shop_id=excluded.shop_id,status='waiting_tracking',submitted_at=excluded.submitted_at,
      next_check_at=excluded.next_check_at,deadline_at=excluded.deadline_at,last_checked_at=NULL,
      reset_count=0,last_reset_at=NULL,last_error_code=NULL,last_error_message=NULL,completed_at=NULL,
      manual_resolution_detected_at=NULL,manual_confirmed_at=NULL,tracking_number_masked=NULL,observed_order_status=NULL,
      origin_error_code=excluded.origin_error_code`)
      .run(orderKey, batchId, displayOrderId, shopId, submittedAt, nextCheckAt, deadlineAt, originErrorCode);
  }

  listDueTrackingRecoveries(nowIso, limit = 10, shopId = null, displayOrderId = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 10));
    const orderId = String(displayOrderId || "").trim();
    const rows = shopId && orderId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','verifying_unsubmitted','ready_to_resubmit','resubmitting','waiting_after_reset')
          AND shop_id=? AND display_order_id=?
          ORDER BY next_check_at ASC LIMIT ?`).all(shopId, orderId, boundedLimit)
      : shopId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','verifying_unsubmitted','ready_to_resubmit','resubmitting','waiting_after_reset') AND next_check_at<=? AND shop_id=?
          ORDER BY next_check_at ASC LIMIT ?`).all(nowIso, shopId, boundedLimit)
      : orderId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','verifying_unsubmitted','ready_to_resubmit','resubmitting','waiting_after_reset')
          AND display_order_id=?
          ORDER BY next_check_at ASC LIMIT ?`).all(orderId, boundedLimit)
      : this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status IN ('waiting_tracking','verifying_unsubmitted','ready_to_resubmit','resubmitting','waiting_after_reset') AND next_check_at<=?
          ORDER BY next_check_at ASC LIMIT ?`).all(nowIso, boundedLimit);
    return rows.map((row) => ({
        orderKey: row.order_key, batchId: row.batch_id, displayOrderId: row.display_order_id, shopId: row.shop_id,
        status: row.status, submittedAt: row.submitted_at, nextCheckAt: row.next_check_at, deadlineAt: row.deadline_at,
        lastCheckedAt: row.last_checked_at || null, resetCount: Number(row.reset_count || 0),
        lastResetAt: row.last_reset_at || null, lastErrorCode: row.last_error_code || null,
        lastErrorMessage: row.last_error_message || null, completedAt: row.completed_at || null,
        manualResolutionDetectedAt: row.manual_resolution_detected_at || null,
        manualConfirmedAt: row.manual_confirmed_at || null, trackingNumberMasked: row.tracking_number_masked || null,
        observedOrderStatus: row.observed_order_status || null, originErrorCode: row.origin_error_code || null,
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
        manualResolutionDetectedAt: row.manual_resolution_detected_at || null,
        manualConfirmedAt: row.manual_confirmed_at || null, trackingNumberMasked: row.tracking_number_masked || null,
        observedOrderStatus: row.observed_order_status || null, originErrorCode: row.origin_error_code || null,
      }));
  }

  listManualAttentionTrackingRecoveries(checkBeforeIso, limit = 5, shopId = null, displayOrderId = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 5, 10));
    const orderId = String(displayOrderId || "").trim();
    const rows = orderId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status='manual_attention' AND shop_id=? AND display_order_id=? LIMIT ?`).all(shopId, orderId, boundedLimit)
      : this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
          WHERE status='manual_attention' AND shop_id=? AND (last_checked_at IS NULL OR last_checked_at<=?)
          ORDER BY COALESCE(last_checked_at,submitted_at) ASC LIMIT ?`).all(shopId, checkBeforeIso, boundedLimit);
    return rows.map((row) => ({
      orderKey: row.order_key, batchId: row.batch_id, displayOrderId: row.display_order_id, shopId: row.shop_id,
      status: row.status, submittedAt: row.submitted_at, nextCheckAt: row.next_check_at, deadlineAt: row.deadline_at,
      lastCheckedAt: row.last_checked_at || null, resetCount: Number(row.reset_count || 0),
      lastResetAt: row.last_reset_at || null, lastErrorCode: row.last_error_code || null,
      lastErrorMessage: row.last_error_message || null, completedAt: row.completed_at || null,
    }));
  }

  recordManualTrackingInspection(recovery, { checkedAt, nextCheckAt, resolved = false,
    trackingNumberMasked = null, observedOrderStatus = null }) {
    if (!resolved) {
      return Number(this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET last_checked_at=?,next_check_at=?,
        observed_order_status=? WHERE order_key=? AND status='manual_attention'`)
        .run(checkedAt, nextCheckAt, observedOrderStatus || null, recovery.orderKey).changes) === 1;
    }
    return this.transaction(() => {
      const message = "系统已检测到订单进入配货中或后续状态，请业务人员确认后标记已处理。";
      const updated = this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET status='awaiting_manual_confirmation',
        last_checked_at=?,next_check_at=?,manual_resolution_detected_at=?,tracking_number_masked=?,observed_order_status=?,
        last_error_code='MANUAL_RESOLUTION_AWAITING_CONFIRMATION',last_error_message=?
        WHERE order_key=? AND status='manual_attention'`)
        .run(checkedAt, nextCheckAt, checkedAt, trackingNumberMasked || null, observedOrderStatus || null, message, recovery.orderKey);
      if (Number(updated.changes) !== 1) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET status='needs_attention',
        error_code='MANUAL_RESOLUTION_AWAITING_CONFIRMATION',error_message=?,tracking_number_masked=?,after_status=?,updated_at=?
        WHERE batch_id=? AND order_key=?`).run(message, trackingNumberMasked || null, observedOrderStatus || null,
        checkedAt, recovery.batchId, recovery.orderKey);
      return true;
    });
  }

  acknowledgeTrackingRecoveries(items, confirmedAt) {
    const unique = new Map(items.map((item) => [`${item.shopId}:${item.orderId}`, item]));
    return this.transaction(() => {
      const acknowledged = [];
      const notReady = [];
      const find = this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
        WHERE shop_id=? AND display_order_id=? LIMIT 1`);
      const updateRecovery = this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET status='acknowledged',
        manual_confirmed_at=? WHERE order_key=? AND status='awaiting_manual_confirmation'`);
      for (const item of unique.values()) {
        const row = find.get(item.shopId, item.orderId);
        if (!row || Number(updateRecovery.run(confirmedAt, row.order_key).changes) !== 1) {
          notReady.push({ shopId:item.shopId,orderId:item.orderId });
          continue;
        }
        this.db.prepare(`UPDATE fulfillment_batch_orders SET status='success',error_code=NULL,error_message=NULL,
          tracking_number_masked=COALESCE(?,tracking_number_masked),after_status=COALESCE(?,after_status),updated_at=?
          WHERE batch_id=? AND order_key=?`).run(row.tracking_number_masked || null, row.observed_order_status || null,
          confirmedAt, row.batch_id, row.order_key);
        this.db.prepare(`UPDATE fulfillment_idempotency SET status='success',completed_at=?
          WHERE order_key=? AND batch_id=?`).run(confirmedAt, row.order_key, row.batch_id);
        const batchCounts = this.db.prepare(`SELECT COUNT(*) AS total,
          SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) AS success_count
          FROM fulfillment_batch_orders WHERE batch_id=?`).get(row.batch_id);
        if (Number(batchCounts?.total || 0) > 0) {
          const batchStatus = Number(batchCounts.success_count || 0) === Number(batchCounts.total) ? "success" : "partial_success";
          this.db.prepare(`UPDATE fulfillment_batches SET status=?,finished_at=COALESCE(finished_at,?) WHERE id=?`)
            .run(batchStatus, confirmedAt, row.batch_id);
        }
        acknowledged.push({ shopId:item.shopId,orderId:item.orderId,confirmedAt });
      }
      return { acknowledged, notReady };
    });
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

  releaseInterruptedRecovery(recovery, completedAt) {
    return this.transaction(() => {
      const updated = this.db.prepare(`UPDATE fulfillment_tracking_recoveries SET status='released_unsubmitted',
        completed_at=?,last_checked_at=?,last_error_code=NULL,last_error_message=NULL
        WHERE order_key=? AND status='verifying_unsubmitted' AND completed_at IS NULL`)
        .run(completedAt, completedAt, recovery.orderKey);
      if (Number(updated.changes) !== 1) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET status='released',error_code=NULL,error_message=NULL,
        after_status='待处理',updated_at=? WHERE batch_id=? AND order_key=?`)
        .run(completedAt, recovery.batchId, recovery.orderKey);
      this.db.prepare(`UPDATE fulfillment_idempotency SET status='failed',completed_at=NULL
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`)
        .run(recovery.orderKey, recovery.batchId);
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

  getDashboardSummary({ todayStartIso, trendStartIso, endIso, dayWindows, trackingDelayMinutes = 30 }) {
    const activeRecoveryStatuses = "'waiting_tracking','verifying_unsubmitted','ready_to_resubmit','resubmitting','waiting_after_reset'";
    const activeRecoveryKeys = new Set(this.db.prepare(`SELECT order_key FROM fulfillment_tracking_recoveries
      WHERE status IN (${activeRecoveryStatuses})`).all().map((row) => row.order_key));
    const rawOrderRows = this.db.prepare(`SELECT b.id AS batch_id,b.created_at,b.status AS batch_status,
      p.shop_id,p.shop_name,o.order_key,o.display_order_id,o.status,o.error_code,o.error_message,o.updated_at,o.timings_json
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
    const alertMap = new Map();
    const alertTypeFor = (code) => ["OUT_OF_STOCK", "OUT_OF_STOCK_BEFORE_SUBMIT", "INVENTORY_UNKNOWN", "INVENTORY_UNKNOWN_BEFORE_SUBMIT"].includes(code)
      ? "inventory" : code === "MULTI_WAREHOUSE_REQUIRES_REVIEW" ? "multi_warehouse" : null;
    const addAlert = (alert) => {
      if (!alert?.type) return;
      const id = `${alert.type}:${alert.shopId || "account"}:${alert.orderId || alert.code || "general"}`;
      const current = alertMap.get(id);
      if (!current || String(alert.detectedAt || "") >= String(current.detectedAt || "")) alertMap.set(id, { id, status: "open", ...alert });
    };
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
        const type = alertTypeFor(code);
        if (type) addAlert({ type, severity: type === "multi_warehouse" ? "critical" : "warning",
          shopId: row.shop_id, shopName: row.shop_name, orderId: row.display_order_id, code,
          title: type === "multi_warehouse" ? "订单包含多个仓库" : code.includes("UNKNOWN") ? "库存状态无法确认" : "订单库存不足",
          message: row.error_message || (type === "multi_warehouse" ? "系统已阻止自动发货，需要先统一 SKU 仓库。" : "系统已阻止自动发货，请核对库存。"),
          action: type === "multi_warehouse" ? "在马帮统一仓库后重新核对" : "补充库存或修正库存状态后重新扫描",
          detectedAt: row.updated_at || row.created_at, canRecheck: type === "multi_warehouse" || code === "INVENTORY_UNKNOWN_BEFORE_SUBMIT" });
      }
    }
    for (const [key, bucket] of trendShops) {
      const date = key.slice(0, 10);
      trendByDate.get(date)?.shops.push(bucket);
    }

    const excludedRows = this.db.prepare(`SELECT p.shop_id,p.shop_name,o.order_key,o.display_order_id,o.exclusion_json,o.snapshot_json,p.created_at
      FROM fulfillment_preview_orders o JOIN fulfillment_previews p ON p.id=o.preview_id
      WHERE o.eligible=0 AND p.created_at>=? AND p.created_at<?
      AND NOT EXISTS (SELECT 1 FROM fulfillment_idempotency i WHERE i.order_key=o.order_key AND i.status='success')
      ORDER BY p.created_at DESC`)
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
        const type = alertTypeFor(code);
        if (type) {
          const snapshot = parse(row.snapshot_json, {});
          const warehouseCount = Array.isArray(snapshot.warehouses) ? snapshot.warehouses.length : 0;
          addAlert({ type, severity: type === "multi_warehouse" ? "critical" : "warning",
            shopId: row.shop_id, shopName: row.shop_name, orderId: row.display_order_id, code,
            title: type === "multi_warehouse" ? `多仓订单${warehouseCount ? `（${warehouseCount} 个仓库）` : ""}`
              : code === "INVENTORY_UNKNOWN" ? "库存状态未知" : "库存不足",
            message: type === "multi_warehouse" ? "同一订单中的 SKU 分属不同仓库，系统未提交发货。"
              : code === "INVENTORY_UNKNOWN" ? "马帮未返回可确认的库存状态，系统未提交发货。" : "库存低于订单需求量，系统未提交发货。",
            action: type === "multi_warehouse" ? "统一仓库后将订单改回待处理并重新核对" : "补充库存后等待下一轮扫描",
            detectedAt: row.created_at, canRecheck: false });
        }
      }
    }

    const deadlineRows = this.db.prepare(`SELECT p.shop_id,p.shop_name,o.order_key,o.display_order_id,o.snapshot_json,p.created_at
      FROM fulfillment_preview_orders o JOIN fulfillment_previews p ON p.id=o.preview_id
      WHERE p.created_at>=? AND p.created_at<?
      AND NOT EXISTS (SELECT 1 FROM fulfillment_idempotency i WHERE i.order_key=o.order_key AND i.status='success')
      ORDER BY p.created_at DESC`).all(todayStartIso, endIso);
    const seenDeadlines = new Set();
    const deadlineNowMs = Date.parse(endIso);
    for (const row of deadlineRows) {
      if (seenDeadlines.has(row.order_key)) continue;
      seenDeadlines.add(row.order_key);
      const deadlineAt = parse(row.snapshot_json, {})?.shippingDeadlineAt;
      const deadlineMs = Date.parse(deadlineAt || "");
      if (!Number.isFinite(deadlineNowMs) || !Number.isFinite(deadlineMs)) continue;
      const remainingMinutes = Math.ceil((deadlineMs - deadlineNowMs) / 60000);
      if (remainingMinutes > 1440) continue;
      const overdue = remainingMinutes <= 0;
      const critical = overdue || remainingMinutes <= 120;
      const warning = !critical && remainingMinutes <= 360;
      addAlert({ type: "shipping_deadline", severity: critical ? "critical" : warning ? "warning" : "info",
        shopId: row.shop_id, shopName: row.shop_name, orderId: row.display_order_id,
        code: overdue ? "SHIPPING_DEADLINE_OVERDUE" : critical ? "SHIPPING_DEADLINE_CRITICAL"
          : warning ? "SHIPPING_DEADLINE_URGENT" : "SHIPPING_DEADLINE_DUE_SOON",
        title: overdue ? "订单已超过发货期限" : critical ? "发货期限不足 2 小时"
          : warning ? "发货期限不足 6 小时" : "发货期限不足 24 小时",
        message: overdue ? `已超过最后发货期限 ${Math.abs(remainingMinutes)} 分钟。`
          : `距离最后发货期限剩余 ${remainingMinutes} 分钟。`,
        action: "优先处理；库存、仓库、状态和物流检查仍必须全部通过",
        detectedAt: row.created_at, shippingDeadlineAt: deadlineAt, shippingRemainingMinutes: remainingMinutes, canRecheck: false });
    }

    const recoveryRows = this.db.prepare(`SELECT shop_id,status,COUNT(*) AS count FROM fulfillment_tracking_recoveries
      WHERE status IN (${activeRecoveryStatuses}) GROUP BY shop_id,status`).all();
    const recoveryAlerts = this.db.prepare(`SELECT r.*,p.shop_name FROM fulfillment_tracking_recoveries r
      LEFT JOIN fulfillment_previews p ON p.id=(SELECT b.preview_id FROM fulfillment_batches b WHERE b.id=r.batch_id)
      WHERE r.status IN (${activeRecoveryStatuses}) ORDER BY r.submitted_at`).all();
    const nowMs = Date.parse(endIso);
    for (const row of recoveryAlerts) {
      const submittedMs = Date.parse(row.submitted_at);
      const ageMinutes = Number.isFinite(nowMs) && Number.isFinite(submittedMs) ? Math.max(0, Math.floor((nowMs - submittedMs) / 60000)) : null;
      if (ageMinutes != null && ageMinutes < Math.max(1, Number(trackingDelayMinutes) || 30)) continue;
      const critical = Number(row.reset_count || 0) > 0 || ["ready_to_resubmit", "resubmitting", "waiting_after_reset"].includes(row.status);
      addAlert({ type: "tracking_delay", severity: critical ? "critical" : "warning",
        shopId: row.shop_id, shopName: row.shop_name || row.shop_id, orderId: row.display_order_id,
        code: row.last_error_code || "TRACKING_DELAY", title: critical ? "运单重新交运后仍在等待" : "运单号获取超时",
        message: row.last_error_message || `运单号已等待 ${ageMinutes == null ? "较长时间" : `${ageMinutes} 分钟`}，系统正在持续回查。`,
        action: critical ? "关注 Shopee 审批结果；超过 24 小时将转人工" : "无需重复交运，等待系统自动回查",
        detectedAt: row.submitted_at, ageMinutes, recoveryStatus: row.status, resetCount: Number(row.reset_count || 0), canRecheck: false });
    }
    const latestScan = this.db.prepare("SELECT * FROM fulfillment_scan_runs ORDER BY id DESC LIMIT 1").get();
    if (latestScan && ["scan_failed", "partial_scan_failed"].includes(latestScan.outcome)) {
      const failures = parse(latestScan.details_json, {})?.failures || [];
      for (const failure of failures.filter((item) => item.category === "login")) {
        addAlert({ type: "login", severity: "critical", shopId: failure.shopId || null, shopName: failure.shopName || "马帮账号",
          orderId: null, code: failure.code || "MABANG_LOGIN_REQUIRED", title: "马帮登录状态异常",
          message: failure.message || "系统无法读取马帮订单，请重新登录后刷新。", action: "打开马帮完成登录，再执行一次安全扫描",
          detectedAt: latestScan.finished_at, canRecheck: false });
      }
    }
    const manualRows = this.db.prepare(`SELECT p.shop_id,COUNT(*) AS count FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention'
      AND NOT EXISTS (SELECT 1 FROM fulfillment_tracking_recoveries r WHERE r.order_key=o.order_key
        AND r.status IN (${activeRecoveryStatuses})) GROUP BY p.shop_id`).all();
    const alerts = [...alertMap.values()].sort((left, right) => {
      const severity = { critical: 0, warning: 1, info: 2 };
      return (severity[left.severity] ?? 3) - (severity[right.severity] ?? 3)
        || String(right.detectedAt || "").localeCompare(String(left.detectedAt || ""));
    });
    return {
      generatedAt: endIso, todayStartAt: todayStartIso, trendStartAt: trendStartIso,
      shops: [...todayShops.values()], trend,
      exceptions: [...exceptionMap.values()].sort((a, b) => b.count - a.count),
      alerts,
      alertSummary: alerts.reduce((summary, alert) => {
        summary.total += 1; summary[alert.type] = (summary[alert.type] || 0) + 1;
        summary[alert.severity] = (summary[alert.severity] || 0) + 1; return summary;
      }, { total: 0, critical: 0, warning: 0, info: 0, inventory: 0, multi_warehouse: 0,
        tracking_delay: 0, shipping_deadline: 0, login: 0 }),
      queues: {
        tracking: recoveryRows.map((row) => ({ shopId: row.shop_id, status: row.status, count: Number(row.count || 0) })),
        manual: manualRows.map((row) => ({ shopId: row.shop_id, count: Number(row.count || 0) })),
      },
    };
  }

  close() { this.db.close(); }
}
