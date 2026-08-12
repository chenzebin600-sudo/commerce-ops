import { randomUUID } from "node:crypto";

function iso(value = new Date()) { return value instanceof Date ? value.toISOString() : String(value); }
function bool(value) { return typeof value === "boolean" ? value : Boolean(Number(value)); }
function json(value, fallback) {
  if (value && typeof value === "object") return value;
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function settingRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tokenConfigured: Boolean(row.encrypted_token_key),
    tokenHint: row.token_hint || "",
    tokenVerifiedAt: row.token_verified_at || null,
    tokenShopCount: Number(row.token_shop_count || 0),
    scheduleTime: row.schedule_time,
    timezone: row.timezone,
    retryCount: Number(row.retry_count || 0),
    warningRatio: Number(row.warning_ratio || 0),
    dingtalkConfigId: row.dingtalk_config_id || null,
    siteNotificationsEnabled: bool(row.site_notifications_enabled),
    dingtalkNotificationsEnabled: bool(row.dingtalk_notifications_enabled) && Boolean(row.dingtalk_config_id),
    enabled: bool(row.enabled),
    lastKeyError: row.last_key_error || null,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function snapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, snapshotDate: row.snapshot_date, shopId: row.shop_id,
    shopCode: row.shop_code, shopName: row.shop_name, country: row.country, status: row.status,
    overallRating: row.overall_rating == null ? null : Number(row.overall_rating),
    fulfillmentFailed: Number(row.fulfillment_failed), listingFailed: Number(row.listing_failed),
    customerServiceFailed: Number(row.customer_service_failed), warningCount: Number(row.warning_count),
    criticalCount: Number(row.critical_count), penaltyPoints: Number(row.penalty_points),
    ongoingPunishments: Number(row.ongoing_punishments), issueListingCount: Number(row.issue_listing_count),
    lateOrderCount: Number(row.late_order_count), metrics: json(row.metrics_json, []), collectedAt: row.collected_at,
  };
}

function issueRow(row) {
  if (!row) return null;
  return {
    id: row.id, fingerprint: row.fingerprint, shopId: row.shop_id, shopCode: row.shop_code,
    shopName: row.shop_name, country: row.country, issueType: row.issue_type, severity: row.severity,
    title: row.title, reason: row.reason, referenceId: row.reference_id, metricId: row.metric_id,
    currentValue: row.current_value, targetValue: row.target_value, comparator: row.comparator,
    details: json(row.details_json, {}), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
    resolvedAt: row.resolved_at, status: row.status, updatedAt: row.updated_at,
  };
}

function appealRow(row) {
  if (!row) return null;
  return {
    id: row.id, issueId: row.issue_id, shopId: row.shop_id, title: row.title, status: row.status,
    assigneeUserId: row.assignee_user_id, assigneeName: row.assignee_name, dueDate: row.due_date,
    sellerCenterReference: row.seller_center_reference, evidence: json(row.evidence_json, []),
    notes: row.notes, resolution: row.resolution, createdBy: row.created_by, createdAt: row.created_at,
    updatedAt: row.updated_at, submittedAt: row.submitted_at, resolvedAt: row.resolved_at,
  };
}

export class PostgresqlShopeeHealthRepository {
  constructor({ provider }) {
    if (!provider?.query || !provider?.execute) throw new TypeError("PostgreSQL health provider is required");
    this.provider = provider;
    this.schema = provider.config?.schema || "app";
  }

  table(name) { return `"${this.schema}"."${name}"`; }

  async getSettings({ includeSecret = false } = {}) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_settings")} WHERE id='default'`);
    const row = result.rows[0];
    const settings = settingRow(row);
    if (includeSecret && settings) settings.encryptedTokenKey = row.encrypted_token_key;
    return settings;
  }

  async saveSettings(input, now = new Date()) {
    const currentResult = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_settings")} WHERE id='default'`);
    const current = currentResult.rows[0];
    if (!current) throw new Error("店铺健康配置尚未初始化。");
    const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
    const values = [
      value("encryptedTokenKey", current.encrypted_token_key), value("tokenHint", current.token_hint),
      value("tokenVerifiedAt", current.token_verified_at), value("tokenShopCount", current.token_shop_count),
      value("scheduleTime", current.schedule_time), value("timezone", current.timezone),
      value("retryCount", current.retry_count), value("warningRatio", current.warning_ratio),
      value("dingtalkConfigId", current.dingtalk_config_id), Boolean(value("siteNotificationsEnabled", bool(current.site_notifications_enabled))),
      Boolean(value("dingtalkNotificationsEnabled", bool(current.dingtalk_notifications_enabled))), Boolean(value("enabled", bool(current.enabled))),
      value("lastKeyError", current.last_key_error), value("updatedBy", current.updated_by), iso(now),
    ];
    const result = await this.provider.query(`UPDATE ${this.table("shopee_health_settings")} SET
      encrypted_token_key=$1,token_hint=$2,token_verified_at=$3,token_shop_count=$4,schedule_time=$5,timezone=$6,
      retry_count=$7,warning_ratio=$8,dingtalk_config_id=$9,site_notifications_enabled=$10,
      dingtalk_notifications_enabled=$11,enabled=$12,last_key_error=$13,updated_by=$14,updated_at=$15
      WHERE id='default' RETURNING *`, values);
    return settingRow(result.rows[0]);
  }

  async listThresholds() {
    const result = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_thresholds")} ORDER BY metric_id`);
    return result.rows.map((row) => ({
      metricId: Number(row.metric_id), metricName: row.metric_name, warningValue: row.warning_value,
      enabled: bool(row.enabled), updatedAt: row.updated_at,
    }));
  }

  async saveThresholds(items, actor = "current-user", now = new Date()) {
    await this.provider.transaction(async (transaction) => {
      for (const item of items) await transaction.execute(`INSERT INTO ${this.table("shopee_health_thresholds")}
        (metric_id,metric_name,warning_value,enabled,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(metric_id) DO UPDATE SET metric_name=EXCLUDED.metric_name,warning_value=EXCLUDED.warning_value,
        enabled=EXCLUDED.enabled,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`, [
        Number(item.metricId), String(item.metricName || `Metric ${item.metricId}`),
        item.warningValue == null || item.warningValue === "" ? null : Number(item.warningValue),
        item.enabled !== false, actor, iso(now),
      ]);
    });
    return this.listThresholds();
  }

  async createRun({ triggerType, scheduledFor = null, shopTotal = 0 }, now = new Date()) {
    const id = randomUUID();
    const result = await this.provider.query(`INSERT INTO ${this.table("shopee_health_runs")}
      (id,trigger_type,scheduled_for,status,shop_total,created_at,updated_at) VALUES ($1,$2,$3,'pending',$4,$5,$5)
      RETURNING *`, [id, triggerType, scheduledFor, shopTotal, iso(now)]);
    return result.rows[0] || null;
  }

  async getRun(id) { return (await this.provider.query(`SELECT * FROM ${this.table("shopee_health_runs")} WHERE id=$1`, [id])).rows[0] || null; }
  async latestRun() { return (await this.provider.query(`SELECT * FROM ${this.table("shopee_health_runs")} ORDER BY created_at DESC LIMIT 1`)).rows[0] || null; }
  async listRuns(limit = 20) {
    const bounded = Math.min(100, Math.max(1, Number(limit) || 20));
    return (await this.provider.query(`SELECT * FROM ${this.table("shopee_health_runs")} ORDER BY created_at DESC LIMIT $1`, [bounded])).rows;
  }
  async hasRunForDate(date) {
    const result = await this.provider.query(`SELECT 1 FROM ${this.table("shopee_health_runs")}
      WHERE trigger_type='scheduled' AND LEFT(COALESCE(scheduled_for,created_at::text),10)=$1
      AND status IN ('pending','running','success','partial') LIMIT 1`, [date]);
    return result.rows.length > 0;
  }
  async activeRun() {
    return (await this.provider.query(`SELECT * FROM ${this.table("shopee_health_runs")}
      WHERE status IN ('pending','running') ORDER BY created_at DESC LIMIT 1`)).rows[0] || null;
  }
  async updateRun(id, fields, now = new Date()) {
    const mapping = { status: "status", attemptCount: "attempt_count", shopSuccess: "shop_success", shopFailed: "shop_failed",
      warningCount: "warning_count", criticalCount: "critical_count", errorMessage: "error_message",
      startedAt: "started_at", finishedAt: "finished_at" };
    const entries = Object.entries(fields).filter(([key]) => mapping[key]);
    if (!entries.length) return this.getRun(id);
    const values = entries.map(([, value]) => value);
    values.push(iso(now), id);
    const sets = entries.map(([key], index) => `${mapping[key]}=$${index + 1}`).join(",");
    const result = await this.provider.query(`UPDATE ${this.table("shopee_health_runs")} SET ${sets},updated_at=$${entries.length + 1}
      WHERE id=$${entries.length + 2} RETURNING *`, values);
    return result.rows[0] || null;
  }

  async upsertSnapshot(input, now = new Date()) {
    const id = randomUUID();
    const values = [id, input.runId, input.snapshotDate, input.shopId, input.shopCode, input.shopName, input.country,
      input.status, input.overallRating, input.fulfillmentFailed, input.listingFailed, input.customerServiceFailed,
      input.warningCount, input.criticalCount, input.penaltyPoints, input.ongoingPunishments,
      input.issueListingCount, input.lateOrderCount, JSON.stringify(input.metrics || []), input.collectedAt, iso(now)];
    const result = await this.provider.query(`INSERT INTO ${this.table("shopee_health_snapshots")} (
      id,run_id,snapshot_date,shop_id,shop_code,shop_name,country,status,overall_rating,fulfillment_failed,
      listing_failed,customer_service_failed,warning_count,critical_count,penalty_points,ongoing_punishments,
      issue_listing_count,late_order_count,metrics_json,collected_at,created_at,updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21,$21)
    ON CONFLICT(snapshot_date,shop_id) DO UPDATE SET run_id=EXCLUDED.run_id,status=EXCLUDED.status,
      overall_rating=EXCLUDED.overall_rating,fulfillment_failed=EXCLUDED.fulfillment_failed,
      listing_failed=EXCLUDED.listing_failed,customer_service_failed=EXCLUDED.customer_service_failed,
      warning_count=EXCLUDED.warning_count,critical_count=EXCLUDED.critical_count,penalty_points=EXCLUDED.penalty_points,
      ongoing_punishments=EXCLUDED.ongoing_punishments,issue_listing_count=EXCLUDED.issue_listing_count,
      late_order_count=EXCLUDED.late_order_count,metrics_json=EXCLUDED.metrics_json,collected_at=EXCLUDED.collected_at,
      updated_at=EXCLUDED.updated_at RETURNING *`, values);
    return snapshotRow(result.rows[0]);
  }

  async latestSnapshots() {
    const result = await this.provider.query(`SELECT DISTINCT ON (shop_id) * FROM ${this.table("shopee_health_snapshots")}
      ORDER BY shop_id,snapshot_date DESC`);
    return result.rows.map(snapshotRow).sort((a, b) => `${a.country}:${a.shopCode}`.localeCompare(`${b.country}:${b.shopCode}`));
  }

  async trend(days = 30) {
    const bounded = Math.max(1, Math.min(3650, Number(days) || 30));
    const result = await this.provider.query(`SELECT snapshot_date AS date,COUNT(*)::int AS shops,
      COUNT(*) FILTER (WHERE status='healthy')::int AS healthy,
      COUNT(*) FILTER (WHERE status='warning')::int AS warning,
      COUNT(*) FILTER (WHERE status='critical')::int AS critical,
      COALESCE(SUM(penalty_points),0) AS penalty_points,COALESCE(SUM(ongoing_punishments),0) AS punishments
      FROM ${this.table("shopee_health_snapshots")} WHERE snapshot_date>=CURRENT_DATE-($1::int * INTERVAL '1 day')
      GROUP BY snapshot_date ORDER BY snapshot_date`, [bounded]);
    return result.rows.map((row) => ({ date: row.date, shops: Number(row.shops), healthy: Number(row.healthy),
      warning: Number(row.warning), critical: Number(row.critical), penaltyPoints: Number(row.penalty_points),
      punishments: Number(row.punishments) }));
  }

  async upsertIssue(input, now = new Date()) {
    return this.provider.transaction(async (transaction) => {
      const current = (await transaction.query(`SELECT * FROM ${this.table("shopee_health_issues")} WHERE fingerprint=$1 FOR UPDATE`, [input.fingerprint])).rows[0];
      const id = current?.id || randomUUID();
      const terminal = current && (await transaction.query(`SELECT 1 FROM ${this.table("shopee_health_appeals")}
        WHERE issue_id=$1 AND status IN ('approved','closed') LIMIT 1`, [current.id])).rows.length > 0;
      const nextStatus = terminal ? "resolved" : current?.status === "in_appeal" ? "in_appeal" : "open";
      const result = await transaction.query(`INSERT INTO ${this.table("shopee_health_issues")} (
        id,fingerprint,shop_id,shop_code,shop_name,country,issue_type,severity,title,reason,reference_id,metric_id,
        current_value,target_value,comparator,details_json,first_seen_at,last_seen_at,resolved_at,status,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$18)
      ON CONFLICT(fingerprint) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,reason=EXCLUDED.reason,
        current_value=EXCLUDED.current_value,target_value=EXCLUDED.target_value,comparator=EXCLUDED.comparator,
        details_json=EXCLUDED.details_json,last_seen_at=EXCLUDED.last_seen_at,
        resolved_at=CASE WHEN EXCLUDED.status='resolved' THEN ${this.table("shopee_health_issues")}.resolved_at ELSE NULL END,
        status=EXCLUDED.status,updated_at=EXCLUDED.updated_at RETURNING *`, [
        id, input.fingerprint, input.shopId, input.shopCode, input.shopName, input.country, input.issueType,
        input.severity, input.title, input.reason || null, input.referenceId || null, input.metricId || null,
        input.currentValue ?? null, input.targetValue ?? null, input.comparator || null, JSON.stringify(input.details || {}),
        current?.first_seen_at || iso(now), iso(now), current?.resolved_at || null, nextStatus, current?.created_at || iso(now),
      ]);
      return { issue: issueRow(result.rows[0]), isNew: !current };
    });
  }

  async resolveMissingIssues(shopId, fingerprints, now = new Date()) {
    const result = await this.provider.query(`UPDATE ${this.table("shopee_health_issues")} SET status='resolved',resolved_at=$1,updated_at=$1
      WHERE shop_id=$2 AND status='open' AND NOT (fingerprint = ANY($3::text[]))`, [iso(now), shopId, fingerprints]);
    return Number(result.rowCount || 0);
  }

  async listIssues({ status = "active", severity = "", country = "", shopId = "", limit = 200 } = {}) {
    const clauses = [], values = [];
    const bind = (value) => { values.push(value); return `$${values.length}`; };
    if (status === "active") clauses.push("status IN ('open','in_appeal')"); else if (status) clauses.push(`status=${bind(status)}`);
    if (severity) clauses.push(`severity=${bind(severity)}`);
    if (country) clauses.push(`country=${bind(country)}`);
    if (shopId) clauses.push(`shop_id=${bind(shopId)}`);
    const limitParameter = bind(Math.min(500, Math.max(1, Number(limit) || 200)));
    const result = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_issues")}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END,last_seen_at DESC LIMIT ${limitParameter}`, values);
    return result.rows.map(issueRow);
  }

  async createNotification(input, now = new Date()) {
    const id = randomUUID();
    await this.provider.execute(`INSERT INTO ${this.table("shopee_health_notifications")}
      (id,notification_type,severity,title,message,shop_id,issue_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.notificationType, input.severity, input.title, input.message, input.shopId || null, input.issueId || null, iso(now)]);
    return id;
  }
  async listNotifications(limit = 30) {
    const bounded = Math.min(100, Math.max(1, Number(limit) || 30));
    const result = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_notifications")} ORDER BY created_at DESC LIMIT $1`, [bounded]);
    return result.rows.map((row) => ({ id: row.id, notificationType: row.notification_type, severity: row.severity,
      title: row.title, message: row.message, shopId: row.shop_id, issueId: row.issue_id, readAt: row.read_at, createdAt: row.created_at }));
  }
  async unreadNotificationCount() {
    const row = (await this.provider.query(`SELECT COUNT(*)::int AS count FROM ${this.table("shopee_health_notifications")} WHERE read_at IS NULL`)).rows[0];
    return Number(row?.count || 0);
  }
  async markNotificationsRead(id = null, now = new Date()) {
    const result = id
      ? await this.provider.execute(`UPDATE ${this.table("shopee_health_notifications")} SET read_at=$1 WHERE id=$2`, [iso(now), id])
      : await this.provider.execute(`UPDATE ${this.table("shopee_health_notifications")} SET read_at=$1 WHERE read_at IS NULL`, [iso(now)]);
    return Number(result.rowCount || 0);
  }

  async createAppeal(input, now = new Date()) {
    return this.provider.transaction(async (transaction) => {
      const issue = (await transaction.query(`SELECT * FROM ${this.table("shopee_health_issues")} WHERE id=$1 FOR UPDATE`, [input.issueId])).rows[0];
      if (!issue) throw new Error("异常记录不存在。");
      const existing = (await transaction.query(`SELECT * FROM ${this.table("shopee_health_appeals")} WHERE issue_id=$1`, [input.issueId])).rows[0];
      if (existing) return appealRow(existing);
      const id = randomUUID(), timestamp = iso(now);
      await transaction.execute(`INSERT INTO ${this.table("shopee_health_appeals")} (
        id,issue_id,shop_id,title,status,assignee_user_id,assignee_name,due_date,evidence_json,notes,created_by,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,'pending_review',$5,$6,$7,$8::jsonb,$9,$10,$11,$11)`, [
        id, issue.id, issue.shop_id, input.title || issue.title, input.assigneeUserId || null, input.assigneeName || null,
        input.dueDate || null, JSON.stringify(input.evidence || []), input.notes || null, input.createdBy || "current-user", timestamp,
      ]);
      await transaction.execute(`UPDATE ${this.table("shopee_health_issues")} SET status='in_appeal',updated_at=$1 WHERE id=$2`, [timestamp, issue.id]);
      await this.addAppealEvent(id, { eventType: "created", toStatus: "pending_review", note: input.notes,
        actorUserId: input.createdBy, actorName: input.assigneeName }, now, transaction);
      return appealRow((await transaction.query(`SELECT * FROM ${this.table("shopee_health_appeals")} WHERE id=$1`, [id])).rows[0]);
    });
  }
  async getAppeal(id) { return appealRow((await this.provider.query(`SELECT * FROM ${this.table("shopee_health_appeals")} WHERE id=$1`, [id])).rows[0]); }
  async listAppeals({ status = "", assigneeUserId = "", limit = 100 } = {}) {
    const clauses = [], values = [];
    if (status) { values.push(status); clauses.push(`status=$${values.length}`); }
    if (assigneeUserId) { values.push(assigneeUserId); clauses.push(`assignee_user_id=$${values.length}`); }
    values.push(Math.min(300, Math.max(1, Number(limit) || 100)));
    const result = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_appeals")}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY due_date NULLS LAST,updated_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(appealRow);
  }
  async updateAppeal(id, input, actor = {}, now = new Date()) {
    return this.provider.transaction(async (transaction) => {
      const current = (await transaction.query(`SELECT * FROM ${this.table("shopee_health_appeals")} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
      if (!current) throw new Error("申诉工单不存在。");
      const allowed = new Set(["pending_review", "preparing", "submitted", "waiting_result", "approved", "rejected", "closed"]);
      const status = input.status || current.status;
      if (!allowed.has(status)) throw new Error("申诉状态无效。");
      const value = (key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
      const resolved = ["approved", "rejected", "closed"].includes(status), timestamp = iso(now);
      const result = await transaction.query(`UPDATE ${this.table("shopee_health_appeals")} SET status=$1,assignee_user_id=$2,
        assignee_name=$3,due_date=$4,seller_center_reference=$5,evidence_json=$6::jsonb,notes=$7,resolution=$8,
        submitted_at=$9,resolved_at=$10,updated_at=$11 WHERE id=$12 RETURNING *`, [
        status, value("assigneeUserId", current.assignee_user_id), value("assigneeName", current.assignee_name),
        value("dueDate", current.due_date), value("sellerCenterReference", current.seller_center_reference),
        JSON.stringify(value("evidence", json(current.evidence_json, []))), value("notes", current.notes),
        value("resolution", current.resolution), status === "submitted" ? current.submitted_at || timestamp : current.submitted_at,
        resolved ? current.resolved_at || timestamp : null, timestamp, id,
      ]);
      if (status !== current.status || input.eventNote) await this.addAppealEvent(id, {
        eventType: status !== current.status ? "status_changed" : "note_added", fromStatus: current.status,
        toStatus: status, note: input.eventNote || input.notes || "", actorUserId: actor.userId, actorName: actor.name,
      }, now, transaction);
      if (resolved) await transaction.execute(`UPDATE ${this.table("shopee_health_issues")}
        SET status='resolved',resolved_at=$1,updated_at=$1 WHERE id=$2`, [timestamp, current.issue_id]);
      return appealRow(result.rows[0]);
    });
  }
  async addAppealEvent(appealId, input, now = new Date(), client = this.provider) {
    const id = randomUUID();
    await client.execute(`INSERT INTO ${this.table("shopee_health_appeal_events")} (
      id,appeal_id,event_type,from_status,to_status,note,actor_user_id,actor_name,created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, appealId, input.eventType, input.fromStatus || null,
      input.toStatus || null, input.note || null, input.actorUserId || null, input.actorName || null, iso(now)]);
    return id;
  }
  async listAppealEvents(appealId) {
    const result = await this.provider.query(`SELECT * FROM ${this.table("shopee_health_appeal_events")}
      WHERE appeal_id=$1 ORDER BY created_at DESC`, [appealId]);
    return result.rows.map((row) => ({ id: row.id, eventType: row.event_type, fromStatus: row.from_status,
      toStatus: row.to_status, note: row.note, actorUserId: row.actor_user_id, actorName: row.actor_name, createdAt: row.created_at }));
  }
}
