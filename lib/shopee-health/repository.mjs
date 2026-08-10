import { randomUUID } from "node:crypto";
import { resolveSqliteProvider } from "../data/sqlite/sqlite-provider.mjs";

function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : String(value); }
function parseJson(value, fallback) { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function bool(value) { return Boolean(Number(value)); }

function settingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tokenConfigured: Boolean(row.encrypted_token_key),
    tokenHint: row.token_hint || "",
    tokenVerifiedAt: row.token_verified_at,
    tokenShopCount: Number(row.token_shop_count || 0),
    scheduleTime: row.schedule_time,
    timezone: row.timezone,
    retryCount: Number(row.retry_count),
    warningRatio: Number(row.warning_ratio),
    dingtalkConfigId: row.dingtalk_config_id,
    siteNotificationsEnabled: bool(row.site_notifications_enabled),
    dingtalkNotificationsEnabled: bool(row.dingtalk_notifications_enabled) && Boolean(row.dingtalk_config_id),
    enabled: bool(row.enabled),
    lastKeyError: row.last_key_error,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function snapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, snapshotDate: row.snapshot_date,
    shopId: row.shop_id, shopCode: row.shop_code, shopName: row.shop_name, country: row.country,
    status: row.status, overallRating: row.overall_rating == null ? null : Number(row.overall_rating),
    fulfillmentFailed: Number(row.fulfillment_failed), listingFailed: Number(row.listing_failed),
    customerServiceFailed: Number(row.customer_service_failed), warningCount: Number(row.warning_count),
    criticalCount: Number(row.critical_count), penaltyPoints: Number(row.penalty_points),
    ongoingPunishments: Number(row.ongoing_punishments), issueListingCount: Number(row.issue_listing_count),
    lateOrderCount: Number(row.late_order_count), metrics: parseJson(row.metrics_json, []), collectedAt: row.collected_at,
  };
}

function issueRow(row) {
  if (!row) return null;
  return {
    id: row.id, fingerprint: row.fingerprint, shopId: row.shop_id, shopCode: row.shop_code,
    shopName: row.shop_name, country: row.country, issueType: row.issue_type, severity: row.severity,
    title: row.title, reason: row.reason, referenceId: row.reference_id, metricId: row.metric_id,
    currentValue: row.current_value, targetValue: row.target_value, comparator: row.comparator,
    details: parseJson(row.details_json, {}), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at, status: row.status, updatedAt: row.updated_at,
  };
}

function appealRow(row) {
  if (!row) return null;
  return {
    id: row.id, issueId: row.issue_id, shopId: row.shop_id, title: row.title, status: row.status,
    assigneeUserId: row.assignee_user_id, assigneeName: row.assignee_name, dueDate: row.due_date,
    sellerCenterReference: row.seller_center_reference, evidence: parseJson(row.evidence_json, []),
    notes: row.notes, resolution: row.resolution, createdBy: row.created_by, createdAt: row.created_at,
    updatedAt: row.updated_at, submittedAt: row.submitted_at, resolvedAt: row.resolved_at,
  };
}

export class ShopeeHealthRepository {
  constructor({ provider }) {
    this.provider = resolveSqliteProvider(provider);
    this.db = this.provider.connection;
  }

  getSettings({ includeSecret = false } = {}) {
    const row = this.db.prepare("SELECT * FROM shopee_health_settings WHERE id='default'").get();
    const result = settingRow(row);
    if (includeSecret && result) result.encryptedTokenKey = row.encrypted_token_key;
    return result;
  }

  saveSettings(input, now = new Date()) {
    const current = this.db.prepare("SELECT * FROM shopee_health_settings WHERE id='default'").get();
    if (!current) throw new Error("店铺健康配置尚未初始化。");
    const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
    this.db.prepare(`UPDATE shopee_health_settings SET
      encrypted_token_key=?,token_hint=?,token_verified_at=?,token_shop_count=?,schedule_time=?,timezone=?,
      retry_count=?,warning_ratio=?,dingtalk_config_id=?,site_notifications_enabled=?,
      dingtalk_notifications_enabled=?,enabled=?,last_key_error=?,updated_by=?,updated_at=? WHERE id='default'`)
      .run(
        value("encryptedTokenKey", current.encrypted_token_key), value("tokenHint", current.token_hint),
        value("tokenVerifiedAt", current.token_verified_at), value("tokenShopCount", current.token_shop_count),
        value("scheduleTime", current.schedule_time), value("timezone", current.timezone),
        value("retryCount", current.retry_count), value("warningRatio", current.warning_ratio),
        value("dingtalkConfigId", current.dingtalk_config_id), Number(value("siteNotificationsEnabled", bool(current.site_notifications_enabled))),
        Number(value("dingtalkNotificationsEnabled", bool(current.dingtalk_notifications_enabled))), Number(value("enabled", bool(current.enabled))),
        value("lastKeyError", current.last_key_error), value("updatedBy", current.updated_by), iso(now),
      );
    return this.getSettings();
  }

  listThresholds() {
    return this.db.prepare("SELECT * FROM shopee_health_thresholds ORDER BY metric_id").all().map((row) => ({
      metricId: Number(row.metric_id), metricName: row.metric_name, warningValue: row.warning_value,
      enabled: bool(row.enabled), updatedAt: row.updated_at,
    }));
  }

  saveThresholds(items, actor = "current-user", now = new Date()) {
    const statement = this.db.prepare(`INSERT INTO shopee_health_thresholds
      (metric_id,metric_name,warning_value,enabled,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(metric_id) DO UPDATE SET metric_name=excluded.metric_name,warning_value=excluded.warning_value,
      enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
    this.provider.transactionManager.run(() => {
      for (const item of items) statement.run(
        Number(item.metricId), String(item.metricName || `Metric ${item.metricId}`),
        item.warningValue == null || item.warningValue === "" ? null : Number(item.warningValue),
        Number(item.enabled !== false), actor, iso(now), iso(now),
      );
    });
    return this.listThresholds();
  }

  createRun({ triggerType, scheduledFor = null, shopTotal = 0 }, now = new Date()) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO shopee_health_runs
      (id,trigger_type,scheduled_for,status,shop_total,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, triggerType, scheduledFor, "pending", shopTotal, iso(now), iso(now));
    return this.getRun(id);
  }

  getRun(id) { return this.db.prepare("SELECT * FROM shopee_health_runs WHERE id=?").get(id) || null; }
  latestRun() { return this.db.prepare("SELECT * FROM shopee_health_runs ORDER BY created_at DESC LIMIT 1").get() || null; }
  listRuns(limit = 20) { return this.db.prepare("SELECT * FROM shopee_health_runs ORDER BY created_at DESC LIMIT ?").all(Math.min(100, Math.max(1, Number(limit) || 20))); }
  hasRunForDate(date) {
    return Boolean(this.db.prepare("SELECT 1 FROM shopee_health_runs WHERE trigger_type='scheduled' AND substr(COALESCE(scheduled_for,created_at),1,10)=? AND status IN ('pending','running','success','partial') LIMIT 1").get(date));
  }
  activeRun() { return this.db.prepare("SELECT * FROM shopee_health_runs WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 1").get() || null; }
  updateRun(id, fields, now = new Date()) {
    const mapping = {
      status: "status", attemptCount: "attempt_count", shopSuccess: "shop_success", shopFailed: "shop_failed",
      warningCount: "warning_count", criticalCount: "critical_count", errorMessage: "error_message",
      startedAt: "started_at", finishedAt: "finished_at",
    };
    const entries = Object.entries(fields).filter(([key]) => mapping[key]);
    if (entries.length) this.db.prepare(`UPDATE shopee_health_runs SET ${entries.map(([key]) => `${mapping[key]}=?`).join(",")},updated_at=? WHERE id=?`)
      .run(...entries.map(([, value]) => value), iso(now), id);
    return this.getRun(id);
  }

  upsertSnapshot(input, now = new Date()) {
    const existing = this.db.prepare("SELECT id FROM shopee_health_snapshots WHERE snapshot_date=? AND shop_id=?").get(input.snapshotDate, input.shopId);
    const id = existing?.id || randomUUID();
    this.db.prepare(`INSERT INTO shopee_health_snapshots
      (id,run_id,snapshot_date,shop_id,shop_code,shop_name,country,status,overall_rating,fulfillment_failed,
       listing_failed,customer_service_failed,warning_count,critical_count,penalty_points,ongoing_punishments,
       issue_listing_count,late_order_count,metrics_json,collected_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_date,shop_id) DO UPDATE SET run_id=excluded.run_id,status=excluded.status,
       overall_rating=excluded.overall_rating,fulfillment_failed=excluded.fulfillment_failed,
       listing_failed=excluded.listing_failed,customer_service_failed=excluded.customer_service_failed,
       warning_count=excluded.warning_count,critical_count=excluded.critical_count,penalty_points=excluded.penalty_points,
       ongoing_punishments=excluded.ongoing_punishments,issue_listing_count=excluded.issue_listing_count,
       late_order_count=excluded.late_order_count,metrics_json=excluded.metrics_json,collected_at=excluded.collected_at,
       updated_at=excluded.updated_at`)
      .run(id, input.runId, input.snapshotDate, input.shopId, input.shopCode, input.shopName, input.country,
        input.status, input.overallRating, input.fulfillmentFailed, input.listingFailed, input.customerServiceFailed,
        input.warningCount, input.criticalCount, input.penaltyPoints, input.ongoingPunishments,
        input.issueListingCount, input.lateOrderCount, JSON.stringify(input.metrics || []), input.collectedAt,
        existing ? input.createdAt || iso(now) : iso(now), iso(now));
    return snapshotRow(this.db.prepare("SELECT * FROM shopee_health_snapshots WHERE id=?").get(id));
  }

  latestSnapshots() {
    return this.db.prepare(`SELECT s.* FROM shopee_health_snapshots s
      JOIN (SELECT shop_id,MAX(snapshot_date) snapshot_date FROM shopee_health_snapshots GROUP BY shop_id) latest
      ON latest.shop_id=s.shop_id AND latest.snapshot_date=s.snapshot_date ORDER BY s.country,s.shop_code`).all().map(snapshotRow);
  }

  trend(days = 30) {
    return this.db.prepare(`SELECT snapshot_date date,COUNT(*) shops,
      SUM(status='healthy') healthy,SUM(status='warning') warning,SUM(status='critical') critical,
      SUM(penalty_points) penalty_points,SUM(ongoing_punishments) punishments
      FROM shopee_health_snapshots WHERE snapshot_date>=date('now',?) GROUP BY snapshot_date ORDER BY snapshot_date`)
      .all(`-${Math.max(1, Math.min(3650, Number(days) || 30))} days`).map((row) => ({
        date: row.date, shops: Number(row.shops), healthy: Number(row.healthy), warning: Number(row.warning),
        critical: Number(row.critical), penaltyPoints: Number(row.penalty_points), punishments: Number(row.punishments),
      }));
  }

  upsertIssue(input, now = new Date()) {
    const current = this.db.prepare("SELECT * FROM shopee_health_issues WHERE fingerprint=?").get(input.fingerprint);
    const id = current?.id || randomUUID();
    const terminalAppeal = current && this.db.prepare("SELECT 1 FROM shopee_health_appeals WHERE issue_id=? AND status IN ('approved','closed') LIMIT 1").get(current.id);
    const nextStatus = terminalAppeal ? "resolved" : current?.status === "in_appeal" ? "in_appeal" : "open";
    this.db.prepare(`INSERT INTO shopee_health_issues
      (id,fingerprint,shop_id,shop_code,shop_name,country,issue_type,severity,title,reason,reference_id,metric_id,
       current_value,target_value,comparator,details_json,first_seen_at,last_seen_at,resolved_at,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(fingerprint) DO UPDATE SET severity=excluded.severity,title=excluded.title,reason=excluded.reason,
       current_value=excluded.current_value,target_value=excluded.target_value,comparator=excluded.comparator,
       details_json=excluded.details_json,last_seen_at=excluded.last_seen_at,
       resolved_at=CASE WHEN excluded.status='resolved' THEN shopee_health_issues.resolved_at ELSE NULL END,
       status=excluded.status,updated_at=excluded.updated_at`)
      .run(id, input.fingerprint, input.shopId, input.shopCode, input.shopName, input.country, input.issueType,
        input.severity, input.title, input.reason || null, input.referenceId || null, input.metricId || null,
        input.currentValue ?? null, input.targetValue ?? null, input.comparator || null, JSON.stringify(input.details || {}),
        current?.first_seen_at || iso(now), iso(now), current?.resolved_at || null, nextStatus,
        current?.created_at || iso(now), iso(now));
    return { issue: issueRow(this.db.prepare("SELECT * FROM shopee_health_issues WHERE id=?").get(id)), isNew: !current };
  }

  resolveMissingIssues(shopId, fingerprints, now = new Date()) {
    const active = this.db.prepare("SELECT id,fingerprint,status FROM shopee_health_issues WHERE shop_id=? AND status IN ('open','in_appeal')").all(shopId);
    const seen = new Set(fingerprints);
    const statement = this.db.prepare("UPDATE shopee_health_issues SET status='resolved',resolved_at=?,updated_at=? WHERE id=?");
    for (const row of active) if (!seen.has(row.fingerprint) && row.status !== "in_appeal") statement.run(iso(now), iso(now), row.id);
  }

  listIssues({ status = "active", severity = "", country = "", shopId = "", limit = 200 } = {}) {
    const clauses = [], values = [];
    if (status === "active") clauses.push("status IN ('open','in_appeal')");
    else if (status) { clauses.push("status=?"); values.push(status); }
    if (severity) { clauses.push("severity=?"); values.push(severity); }
    if (country) { clauses.push("country=?"); values.push(country); }
    if (shopId) { clauses.push("shop_id=?"); values.push(shopId); }
    values.push(Math.min(500, Math.max(1, Number(limit) || 200)));
    return this.db.prepare(`SELECT * FROM shopee_health_issues ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT ?`).all(...values).map(issueRow);
  }

  createNotification(input, now = new Date()) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO shopee_health_notifications
      (id,notification_type,severity,title,message,shop_id,issue_id,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, input.notificationType, input.severity, input.title, input.message, input.shopId || null, input.issueId || null, iso(now));
    return id;
  }
  listNotifications(limit = 30) {
    return this.db.prepare("SELECT * FROM shopee_health_notifications ORDER BY created_at DESC LIMIT ?").all(Math.min(100, Math.max(1, Number(limit) || 30))).map((row) => ({
      id: row.id, notificationType: row.notification_type, severity: row.severity, title: row.title,
      message: row.message, shopId: row.shop_id, issueId: row.issue_id, readAt: row.read_at, createdAt: row.created_at,
    }));
  }
  unreadNotificationCount() { return Number(this.db.prepare("SELECT COUNT(*) count FROM shopee_health_notifications WHERE read_at IS NULL").get().count); }
  markNotificationsRead(id = null, now = new Date()) {
    return id
      ? this.db.prepare("UPDATE shopee_health_notifications SET read_at=? WHERE id=?").run(iso(now), id).changes
      : this.db.prepare("UPDATE shopee_health_notifications SET read_at=? WHERE read_at IS NULL").run(iso(now)).changes;
  }

  createAppeal(input, now = new Date()) {
    const issue = this.db.prepare("SELECT * FROM shopee_health_issues WHERE id=?").get(input.issueId);
    if (!issue) throw new Error("异常记录不存在。");
    const existing = this.db.prepare("SELECT * FROM shopee_health_appeals WHERE issue_id=?").get(input.issueId);
    if (existing) return appealRow(existing);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO shopee_health_appeals
      (id,issue_id,shop_id,title,status,assignee_user_id,assignee_name,due_date,evidence_json,notes,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, issue.id, issue.shop_id, input.title || issue.title, "pending_review", input.assigneeUserId || null,
        input.assigneeName || null, input.dueDate || null, JSON.stringify(input.evidence || []), input.notes || null,
        input.createdBy || "current-user", iso(now), iso(now));
    this.db.prepare("UPDATE shopee_health_issues SET status='in_appeal',updated_at=? WHERE id=?").run(iso(now), issue.id);
    this.addAppealEvent(id, { eventType: "created", toStatus: "pending_review", note: input.notes, actorUserId: input.createdBy, actorName: input.assigneeName }, now);
    return this.getAppeal(id);
  }
  getAppeal(id) { return appealRow(this.db.prepare("SELECT * FROM shopee_health_appeals WHERE id=?").get(id)); }
  listAppeals({ status = "", assigneeUserId = "", limit = 100 } = {}) {
    const clauses = [], values = [];
    if (status) { clauses.push("a.status=?"); values.push(status); }
    if (assigneeUserId) { clauses.push("a.assignee_user_id=?"); values.push(assigneeUserId); }
    values.push(Math.min(300, Math.max(1, Number(limit) || 100)));
    return this.db.prepare(`SELECT a.* FROM shopee_health_appeals a ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY CASE WHEN a.due_date IS NULL THEN 1 ELSE 0 END,a.due_date,a.updated_at DESC LIMIT ?`).all(...values).map(appealRow);
  }
  updateAppeal(id, input, actor = {}, now = new Date()) {
    const current = this.db.prepare("SELECT * FROM shopee_health_appeals WHERE id=?").get(id);
    if (!current) throw new Error("申诉工单不存在。");
    const allowed = new Set(["pending_review", "preparing", "submitted", "waiting_result", "approved", "rejected", "closed"]);
    const status = input.status || current.status;
    if (!allowed.has(status)) throw new Error("申诉状态无效。");
    const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
    const resolved = ["approved", "rejected", "closed"].includes(status);
    this.db.prepare(`UPDATE shopee_health_appeals SET status=?,assignee_user_id=?,assignee_name=?,due_date=?,
      seller_center_reference=?,evidence_json=?,notes=?,resolution=?,submitted_at=?,resolved_at=?,updated_at=? WHERE id=?`)
      .run(status, value("assigneeUserId", current.assignee_user_id), value("assigneeName", current.assignee_name),
        value("dueDate", current.due_date), value("sellerCenterReference", current.seller_center_reference),
        JSON.stringify(value("evidence", parseJson(current.evidence_json, []))), value("notes", current.notes),
        value("resolution", current.resolution), status === "submitted" ? current.submitted_at || iso(now) : current.submitted_at,
        resolved ? current.resolved_at || iso(now) : null, iso(now), id);
    if (status !== current.status || input.eventNote) this.addAppealEvent(id, {
      eventType: status !== current.status ? "status_changed" : "note_added", fromStatus: current.status,
      toStatus: status, note: input.eventNote || input.notes || "", actorUserId: actor.userId, actorName: actor.name,
    }, now);
    if (resolved) this.db.prepare("UPDATE shopee_health_issues SET status='resolved',resolved_at=?,updated_at=? WHERE id=?")
      .run(iso(now), iso(now), current.issue_id);
    return this.getAppeal(id);
  }
  addAppealEvent(appealId, input, now = new Date()) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO shopee_health_appeal_events
      (id,appeal_id,event_type,from_status,to_status,note,actor_user_id,actor_name,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, appealId, input.eventType, input.fromStatus || null, input.toStatus || null, input.note || null,
        input.actorUserId || null, input.actorName || null, iso(now));
    return id;
  }
  listAppealEvents(appealId) {
    return this.db.prepare("SELECT * FROM shopee_health_appeal_events WHERE appeal_id=? ORDER BY created_at DESC").all(appealId).map((row) => ({
      id: row.id, eventType: row.event_type, fromStatus: row.from_status, toStatus: row.to_status,
      note: row.note, actorUserId: row.actor_user_id, actorName: row.actor_name, createdAt: row.created_at,
    }));
  }
}
