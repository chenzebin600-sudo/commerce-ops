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
      CREATE TABLE IF NOT EXISTS fulfillment_dispatch_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,preview_id TEXT NOT NULL UNIQUE,shop_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',batch_id TEXT,enqueued_at TEXT NOT NULL,started_at TEXT,
        finished_at TEXT,last_error_code TEXT,last_error_message TEXT,
        FOREIGN KEY (preview_id) REFERENCES fulfillment_previews(id),
        FOREIGN KEY (batch_id) REFERENCES fulfillment_batches(id)
      );
      CREATE INDEX IF NOT EXISTS fulfillment_dispatch_queue_status_id
        ON fulfillment_dispatch_queue(status,id);
      CREATE TABLE IF NOT EXISTS fulfillment_runtime_settings (
        setting_key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fulfillment_channel_catalog (
        channel_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,logistics_id TEXT NOT NULL,
        channel_source TEXT NOT NULL DEFAULT '1',channel_name TEXT NOT NULL,logistics_name TEXT,
        channel_value TEXT NOT NULL,platform_id TEXT,country_code TEXT,active INTEGER NOT NULL DEFAULT 1,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fulfillment_shop_policies (
        shop_id TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'manual',channel_id TEXT,
        warehouse_policy TEXT NOT NULL DEFAULT 'any_single_warehouse',allowed_warehouses_json TEXT NOT NULL DEFAULT '[]',
        min_order_age_minutes INTEGER NOT NULL DEFAULT 10,max_batch_size INTEGER NOT NULL DEFAULT 10,
        version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL DEFAULT 'bootstrap'
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

  initializeOperationalConfig(shops, nowIso = new Date().toISOString()) {
    return this.transaction(() => {
      const insertChannel = this.db.prepare(`INSERT OR IGNORE INTO fulfillment_channel_catalog
        (channel_id,provider_id,logistics_id,channel_source,channel_name,logistics_name,channel_value,platform_id,country_code,active,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?)`);
      const insertPolicy = this.db.prepare(`INSERT OR IGNORE INTO fulfillment_shop_policies
        (shop_id,mode,channel_id,warehouse_policy,allowed_warehouses_json,min_order_age_minutes,max_batch_size,updated_at,updated_by)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const shop of shops || []) {
        insertChannel.run(shop.channelId || "", shop.channelProviderId || "", shop.channelLogisticsId || "", shop.channelSource || "1",
          shop.channelName || "", "", shop.channelValue || "", shop.platformId || "", shop.countryCode || "", nowIso);
        insertPolicy.run(shop.shopId, shop.configuredAutoFulfillEnabled ? "auto" : "manual", shop.channelId,
          shop.allowedWarehouses?.length ? "allowlist" : "any_single_warehouse", json(shop.allowedWarehouses || []),
          Number(shop.minOrderAgeMinutes || 10), Number(shop.maxBatchSize || 10), nowIso, "bootstrap");
      }
    });
  }

  initializeSyncedShops(shops, nowIso = new Date().toISOString()) {
    const insertPolicy = this.db.prepare(`INSERT OR IGNORE INTO fulfillment_shop_policies
      (shop_id,mode,channel_id,warehouse_policy,allowed_warehouses_json,min_order_age_minutes,max_batch_size,updated_at,updated_by)
      VALUES (?,'paused',NULL,'any_single_warehouse','[]',10,2,?,'catalog_sync')`);
    return this.transaction(() => {
      for (const shop of shops || []) if (String(shop.shopId || "").trim()) insertPolicy.run(String(shop.shopId), nowIso);
    });
  }

  pauseShopPoliciesOutside(shopIds, { updatedAt = new Date().toISOString(), updatedBy = "catalog_access_revoked" } = {}) {
    const activeIds = [...new Set([...(shopIds || [])].map((value) => String(value || "").trim()).filter(Boolean))];
    const placeholders = activeIds.map(() => "?").join(",");
    const where = placeholders ? `shop_id NOT IN (${placeholders})` : "1=1";
    return this.db.prepare(`UPDATE fulfillment_shop_policies SET mode='paused',version=version+1,updated_at=?,updated_by=?
      WHERE mode<>'paused' AND ${where}`).run(updatedAt, String(updatedBy).slice(0, 120), ...activeIds).changes;
  }

  getRuntimeSetting(key, fallback = null) {
    const row = this.db.prepare("SELECT value_json FROM fulfillment_runtime_settings WHERE setting_key=?").get(String(key));
    return row ? parse(row.value_json, fallback) : fallback;
  }

  setRuntimeSetting(key, value, updatedAt = new Date().toISOString()) {
    this.db.prepare(`INSERT INTO fulfillment_runtime_settings(setting_key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(String(key), json(value), updatedAt);
    return value;
  }

  listChannelCatalog({ activeOnly = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM fulfillment_channel_catalog ${activeOnly ? "WHERE active=1" : ""}
      ORDER BY country_code,platform_id,channel_name`).all();
    return rows.map((row) => ({ channelId: row.channel_id, channelProviderId: row.provider_id,
      channelLogisticsId: row.logistics_id, channelSource: row.channel_source, channelName: row.channel_name,
      logisticsName: row.logistics_name || "", channelValue: row.channel_value, platformId: row.platform_id || "",
      countryCode: row.country_code || "", active: Boolean(row.active), lastSeenAt: row.last_seen_at }));
  }

  replaceChannelCatalog(channels, nowIso = new Date().toISOString()) {
    return this.transaction(() => {
      this.db.prepare("UPDATE fulfillment_channel_catalog SET active=0").run();
      const upsert = this.db.prepare(`INSERT INTO fulfillment_channel_catalog
        (channel_id,provider_id,logistics_id,channel_source,channel_name,logistics_name,channel_value,platform_id,country_code,active,last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(channel_id) DO UPDATE SET
        provider_id=excluded.provider_id,logistics_id=excluded.logistics_id,channel_source=excluded.channel_source,
        channel_name=excluded.channel_name,logistics_name=excluded.logistics_name,channel_value=excluded.channel_value,
        platform_id=excluded.platform_id,country_code=excluded.country_code,active=1,last_seen_at=excluded.last_seen_at`);
      for (const channel of channels || []) upsert.run(channel.channelId, channel.channelProviderId,
        channel.channelLogisticsId, channel.channelSource || "1", channel.channelName, channel.logisticsName || "",
        channel.channelValue, channel.platformId || "", channel.countryCode || "", nowIso);
      return this.listChannelCatalog();
    });
  }

  clearChannelCatalog() {
    return Number(this.db.prepare("DELETE FROM fulfillment_channel_catalog").run().changes);
  }

  listShopPolicies() {
    return this.db.prepare("SELECT * FROM fulfillment_shop_policies ORDER BY shop_id").all().map((row) => ({
      shopId: row.shop_id, mode: row.mode, channelId: row.channel_id || "", warehousePolicy: row.warehouse_policy,
      allowedWarehouses: parse(row.allowed_warehouses_json, []), minOrderAgeMinutes: Number(row.min_order_age_minutes),
      maxBatchSize: Number(row.max_batch_size), version: Number(row.version), updatedAt: row.updated_at, updatedBy: row.updated_by,
    }));
  }

  getShopPolicy(shopId) { return this.listShopPolicies().find((policy) => policy.shopId === String(shopId)) || null; }

  saveShopPolicy(policy, { updatedBy = "authenticated_session", updatedAt = new Date().toISOString() } = {}) {
    const current = this.getShopPolicy(policy.shopId);
    if (!current) throw new Error("店铺履约策略不存在");
    this.db.prepare(`UPDATE fulfillment_shop_policies SET mode=?,channel_id=?,warehouse_policy=?,
      allowed_warehouses_json=?,min_order_age_minutes=?,max_batch_size=?,version=version+1,updated_at=?,updated_by=? WHERE shop_id=?`)
      .run(policy.mode, policy.channelId || null, policy.warehousePolicy, json(policy.allowedWarehouses || []),
        policy.minOrderAgeMinutes, policy.maxBatchSize, updatedAt, String(updatedBy).slice(0, 120), policy.shopId);
    return this.getShopPolicy(policy.shopId);
  }

  listObservedWarehouses(shopId = null, limit = 200) {
    const rows = shopId == null
      ? this.db.prepare(`SELECT o.snapshot_json FROM fulfillment_preview_orders o
          JOIN fulfillment_previews p ON p.id=o.preview_id ORDER BY p.created_at DESC LIMIT 3000`).all()
      : this.db.prepare(`SELECT o.snapshot_json FROM fulfillment_preview_orders o
          JOIN fulfillment_previews p ON p.id=o.preview_id WHERE p.shop_id=? ORDER BY p.created_at DESC LIMIT 300`).all(String(shopId));
    const names = new Set();
    for (const row of rows) {
      const snapshot = parse(row.snapshot_json, {});
      for (const name of snapshot.warehouses || [snapshot.warehouse]) if (String(name || "").trim()) names.add(String(name).trim());
      for (const item of snapshot.items || []) for (const name of item.warehouses || [item.warehouse]) {
        if (String(name || "").trim()) names.add(String(name).trim());
      }
    }
    return [...names].sort((left, right) => left.localeCompare(right, "zh-CN")).slice(0, limit);
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
      AND o.error_code IN ('INVENTORY_UNKNOWN_BEFORE_SUBMIT','MULTI_WAREHOUSE_REQUIRES_REVIEW','SERVICE_RESTARTED_DURING_BATCH')
      ORDER BY o.updated_at ASC LIMIT ?`).all(shopId, Math.max(1, Math.min(Number(limit) || 5, 10))).map((row) => ({
        batchId: row.batch_id, orderKey: row.order_key, displayOrderId: row.display_order_id,
        errorCode: row.error_code, errorMessage: row.error_message, updatedAt: row.updated_at,
        recoveryPassCount: Number(row.recovery_pass_count || 0), recoveryLastPassedAt: row.last_passed_at || null,
        shop: { id: row.shop_id, name: row.shop_name },
      }));
  }

  listInterruptedManualReviews(shopId, limit = 5) {
    return this.db.prepare(`SELECT o.batch_id,o.order_key,o.display_order_id,o.error_code,o.error_message,o.updated_at,
      p.shop_id,p.shop_name
      FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id
      JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE p.shop_id=? AND o.status='needs_attention' AND i.status='needs_attention'
      AND o.error_code='SERVICE_RESTARTED_DURING_BATCH'
      ORDER BY o.updated_at ASC LIMIT ?`).all(shopId, Math.max(1, Math.min(Number(limit) || 5, 10))).map((row) => ({
        batchId: row.batch_id, orderKey: row.order_key, displayOrderId: row.display_order_id,
        errorCode: row.error_code, errorMessage: row.error_message, updatedAt: row.updated_at,
        shop: { id: row.shop_id, name: row.shop_name },
      }));
  }

  resolveInterruptedReviewAsSuccess(review, { completedAt, trackingNumberMasked = null, afterStatus = null }) {
    return this.transaction(() => {
      const reserved = this.db.prepare(`UPDATE fulfillment_idempotency SET status='success',completed_at=?
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`).run(completedAt, review.orderKey, review.batchId);
      if (Number(reserved.changes) !== 1) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET status='success',tracking_number_masked=?,error_code=NULL,
        error_message=NULL,after_status=?,updated_at=? WHERE batch_id=? AND order_key=? AND status='needs_attention'`)
        .run(trackingNumberMasked, afterStatus, completedAt, review.batchId, review.orderKey);
      const remaining = this.db.prepare("SELECT 1 FROM fulfillment_batch_orders WHERE batch_id=? AND status!='success' LIMIT 1")
        .get(review.batchId);
      this.db.prepare("UPDATE fulfillment_batches SET status=?,finished_at=? WHERE id=?")
        .run(remaining ? "partial_success" : "success", completedAt, review.batchId);
      this.db.prepare("DELETE FROM fulfillment_manual_recovery_checks WHERE order_key=?").run(review.orderKey);
      return true;
    });
  }

  moveInterruptedReviewToTrackingRecovery(review, { submittedAt, nextCheckAt, deadlineAt, trackingNumberMasked = null }) {
    return this.transaction(() => {
      const locked = this.db.prepare(`SELECT 1 FROM fulfillment_idempotency
        WHERE order_key=? AND batch_id=? AND status='needs_attention'`).get(review.orderKey, review.batchId);
      if (!locked) return false;
      this.db.prepare(`UPDATE fulfillment_batch_orders SET tracking_number_masked=?,error_code='TRACKING_NUMBER_PENDING',
        error_message='服务恢复对账发现订单已有交运痕迹，已转入运单恢复队列，禁止重复提交。',updated_at=?
        WHERE batch_id=? AND order_key=? AND status='needs_attention'`)
        .run(trackingNumberMasked, submittedAt, review.batchId, review.orderKey);
      this.db.prepare(`INSERT INTO fulfillment_tracking_recoveries
        (order_key,batch_id,display_order_id,shop_id,status,submitted_at,next_check_at,deadline_at)
        VALUES (?,?,?,?,'waiting_tracking',?,?,?)
        ON CONFLICT(order_key) DO UPDATE SET status='waiting_tracking',submitted_at=excluded.submitted_at,
        next_check_at=excluded.next_check_at,deadline_at=excluded.deadline_at,completed_at=NULL,
        last_error_code=NULL,last_error_message=NULL`)
        .run(review.orderKey, review.batchId, review.displayOrderId, review.shop.id, submittedAt, nextCheckAt, deadlineAt);
      return true;
    });
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

  queuePreviewDispatch(previewId, shopId, enqueuedAt) {
    this.db.prepare(`INSERT OR IGNORE INTO fulfillment_dispatch_queue
      (preview_id,shop_id,status,enqueued_at) SELECT id,shop_id,'queued',?
      FROM fulfillment_previews WHERE id=? AND shop_id=? AND status='pending'
      AND EXISTS (SELECT 1 FROM fulfillment_preview_orders WHERE preview_id=? AND eligible=1)
      AND NOT EXISTS (
        SELECT 1 FROM fulfillment_preview_orders candidate
        JOIN fulfillment_preview_orders active_order ON active_order.order_key=candidate.order_key
        JOIN fulfillment_dispatch_queue active_queue ON active_queue.preview_id=active_order.preview_id
        WHERE candidate.preview_id=? AND candidate.eligible=1 AND active_queue.status IN ('queued','running')
      )`)
      .run(enqueuedAt, previewId, shopId, previewId, previewId);
    return this.getDispatchByPreview(previewId);
  }

  listActiveDispatchOrderKeys(shopId = null) {
    const rows = shopId ? this.db.prepare(`SELECT DISTINCT o.order_key FROM fulfillment_dispatch_queue q
      JOIN fulfillment_preview_orders o ON o.preview_id=q.preview_id AND o.eligible=1
      WHERE q.status IN ('queued','running') AND q.shop_id=?`).all(shopId)
      : this.db.prepare(`SELECT DISTINCT o.order_key FROM fulfillment_dispatch_queue q
        JOIN fulfillment_preview_orders o ON o.preview_id=q.preview_id AND o.eligible=1
        WHERE q.status IN ('queued','running')`).all();
    return rows.map((row) => row.order_key);
  }

  getDispatchByPreview(previewId) {
    const row = this.db.prepare("SELECT * FROM fulfillment_dispatch_queue WHERE preview_id=?").get(previewId);
    return row ? this.presentDispatch(row) : null;
  }

  getNextQueuedDispatch() {
    const row = this.db.prepare(`SELECT q.* FROM fulfillment_dispatch_queue q
      JOIN fulfillment_previews p ON p.id=q.preview_id
      WHERE q.status='queued' AND p.status='pending' ORDER BY q.id LIMIT 1`).get();
    return row ? this.presentDispatch(row) : null;
  }

  markDispatchRunning(id, batchId, startedAt) {
    const result = this.db.prepare(`UPDATE fulfillment_dispatch_queue SET status='running',batch_id=?,started_at=?,
      last_error_code=NULL,last_error_message=NULL WHERE id=? AND status='queued'`).run(batchId, startedAt, id);
    return Number(result.changes) === 1;
  }

  finishDispatch(id, status, finishedAt, errorCode = null, errorMessage = null) {
    const result = this.db.prepare(`UPDATE fulfillment_dispatch_queue SET status=?,finished_at=?,
      last_error_code=?,last_error_message=? WHERE id=? AND status IN ('queued','running')`)
      .run(status, finishedAt, errorCode, errorMessage, id);
    return Number(result.changes) === 1;
  }

  cancelQueuedDispatches(nowIso, errorCode = "ACCOUNT_SCOPE_CHANGED",
    errorMessage = "马帮账号已切换，原账号的自动发货候选已取消。") {
    return Number(this.db.prepare(`UPDATE fulfillment_dispatch_queue SET status='failed',finished_at=?,
      last_error_code=?,last_error_message=? WHERE status='queued'`)
      .run(nowIso, errorCode, errorMessage).changes);
  }

  recoverInterruptedDispatches(nowIso) {
    return Number(this.db.prepare(`UPDATE fulfillment_dispatch_queue SET status='failed',finished_at=?,
      last_error_code='SERVICE_RESTARTED_DURING_DISPATCH',
      last_error_message='调度进程中断；关联批次已按安全规则转人工核查。' WHERE status='running'`)
      .run(nowIso).changes);
  }

  getDispatchQueueStatus(nowIso, limit = 20) {
    const counts = Object.fromEntries(this.db.prepare(`SELECT status,COUNT(*) AS count
      FROM fulfillment_dispatch_queue GROUP BY status`).all().map((row) => [row.status, Number(row.count)]));
    const oldest = this.db.prepare("SELECT enqueued_at FROM fulfillment_dispatch_queue WHERE status='queued' ORDER BY id LIMIT 1").get();
    const recent = this.db.prepare(`SELECT * FROM fulfillment_dispatch_queue ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(Number(limit) || 20, 100))).map((row) => this.presentDispatch(row));
    const activeOrders = this.db.prepare(`SELECT q.status,COUNT(DISTINCT o.order_key) AS count
      FROM fulfillment_dispatch_queue q JOIN fulfillment_preview_orders o ON o.preview_id=q.preview_id AND o.eligible=1
      WHERE q.status IN ('queued','running') GROUP BY q.status`).all();
    const orderCounts = Object.fromEntries(activeOrders.map((row) => [row.status, Number(row.count)]));
    const durationRows = this.db.prepare(`SELECT started_at,finished_at FROM fulfillment_dispatch_queue
      WHERE status IN ('completed','failed') AND started_at IS NOT NULL AND finished_at IS NOT NULL
      ORDER BY id DESC LIMIT 20`).all();
    const durations = durationRows.map((row) => Date.parse(row.finished_at) - Date.parse(row.started_at))
      .filter((value) => Number.isFinite(value) && value >= 0);
    const averageBatchMs = durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null;
    const activeBatchCount = (counts.queued || 0) + (counts.running || 0);
    const estimatedClearAt = averageBatchMs && activeBatchCount
      ? new Date(Date.parse(nowIso) + averageBatchMs * activeBatchCount).toISOString() : null;
    return { queued: counts.queued || 0, running: counts.running || 0, completed: counts.completed || 0,
      failed: counts.failed || 0, queuedOrders: orderCounts.queued || 0, runningOrders: orderCounts.running || 0,
      oldestQueuedAt: oldest?.enqueued_at || null, averageBatchMs, estimatedClearAt, checkedAt: nowIso, recent };
  }

  presentDispatch(row) {
    return { id: Number(row.id), previewId: row.preview_id, shopId: row.shop_id, status: row.status,
      batchId: row.batch_id || null, enqueuedAt: row.enqueued_at, startedAt: row.started_at || null,
      finishedAt: row.finished_at || null, errorCode: row.last_error_code || null,
      errorMessage: row.last_error_message || null };
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

  listRecentBatches(limit = 20, shopIds = null) {
    const scope = [...new Set((shopIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    const rows = Array.isArray(shopIds)
      ? scope.length
        ? this.db.prepare(`SELECT b.id FROM fulfillment_batches b JOIN fulfillment_previews p ON p.id=b.preview_id
            WHERE p.shop_id IN (${scope.map(() => "?").join(",")}) ORDER BY b.created_at DESC LIMIT ?`).all(...scope, limit)
        : []
      : this.db.prepare("SELECT id FROM fulfillment_batches ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows
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

  listTrackingRecoveries(limit = 50, shopId = null, shopIds = null) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
    const scope = [...new Set((shopIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    const rows = shopId
      ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries WHERE shop_id=? ORDER BY submitted_at DESC LIMIT ?`)
          .all(shopId, boundedLimit)
      : Array.isArray(shopIds)
      ? scope.length
        ? this.db.prepare(`SELECT * FROM fulfillment_tracking_recoveries
            WHERE shop_id IN (${scope.map(() => "?").join(",")}) ORDER BY submitted_at DESC LIMIT ?`)
            .all(...scope, boundedLimit)
        : []
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

  getDashboardSummary({ todayStartIso, trendStartIso, endIso, dayWindows }, shopIds = null) {
    const shopScope = Array.isArray(shopIds)
      ? new Set(shopIds.map((value) => String(value || "").trim()).filter(Boolean))
      : null;
    const inScope = (shopId) => !shopScope || shopScope.has(String(shopId || ""));
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
    const orderRows = [...latestOrders.values()].filter((row) => inScope(row.shop_id));
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
      if (!inScope(row.shop_id)) continue;
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
      WHERE status IN (${activeRecoveryStatuses}) GROUP BY shop_id,status`).all().filter((row) => inScope(row.shop_id));
    const manualRows = this.db.prepare(`SELECT p.shop_id,COUNT(*) AS count FROM fulfillment_batch_orders o
      JOIN fulfillment_batches b ON b.id=o.batch_id JOIN fulfillment_previews p ON p.id=b.preview_id
      JOIN fulfillment_idempotency i ON i.order_key=o.order_key AND i.batch_id=o.batch_id
      WHERE o.status='needs_attention' AND i.status='needs_attention'
      AND NOT EXISTS (SELECT 1 FROM fulfillment_tracking_recoveries r WHERE r.order_key=o.order_key
        AND r.status IN (${activeRecoveryStatuses})) GROUP BY p.shop_id`).all().filter((row) => inScope(row.shop_id));
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
