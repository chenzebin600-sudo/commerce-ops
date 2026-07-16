function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[char]);
}

export function auditEventViewModel(event = {}) {
  const relation = event.taskId ? `任务 ${event.taskId}` : event.runId ? `执行 ${event.runId}` : event.fileId ? `文件 ${event.fileId}` : "-";
  return {
    id: String(event.id || ""),
    time: event.occurredAt ? new Date(event.occurredAt).toLocaleString("zh-CN", { hour12: false }) : "-",
    module: String(event.module || "-"),
    action: String(event.actionLabel || event.action || "-"),
    actionCode: String(event.action || "-"),
    status: event.status === "success" ? "成功" : "失败",
    statusCode: event.status === "success" ? "success" : "failed",
    duration: Number.isFinite(Number(event.durationMs)) ? `${Number(event.durationMs)} ms` : "-",
    source: String(event.source || "-"),
    relation,
    error: String(event.errorSummary || "-"),
    requestId: String(event.requestId || "-"),
    methodPath: [event.httpMethod, event.requestPath].filter(Boolean).join(" ") || "-",
    actor: String(event.actorIdentifier || "-"),
    errorCode: String(event.errorCode || "-"),
    metadata: event.metadata && typeof event.metadata === "object" ? event.metadata : {},
  };
}

export function renderAuditEventRow(event) {
  const view = auditEventViewModel(event);
  return `<tr>
    <td>${escapeHtml(view.time)}</td>
    <td><span class="audit-module">${escapeHtml(view.module)}</span></td>
    <td><strong>${escapeHtml(view.action)}</strong><small>${escapeHtml(view.actionCode)}</small></td>
    <td><span class="run-status ${escapeHtml(view.statusCode)}">${escapeHtml(view.status)}</span></td>
    <td>${escapeHtml(view.duration)}</td>
    <td>${escapeHtml(view.source)}</td>
    <td>${escapeHtml(view.relation)}</td>
    <td class="audit-error">${escapeHtml(view.error)}</td>
    <td><button type="button" class="button-secondary" data-audit-detail="${escapeHtml(view.id)}">详情</button></td>
  </tr>`;
}

async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

export function createAuditPage({ documentObject = document, authorizedFetch, onError = () => {} } = {}) {
  const byId = (id) => documentObject.getElementById(id);
  const state = { page: 1, totalPages: 1, loading: false };

  function filters() {
    const params = new URLSearchParams({ page: String(state.page), pageSize: "50" });
    for (const [id, key] of [
      ["auditStart", "start"], ["auditEnd", "end"], ["auditModule", "module"],
      ["auditStatus", "status"], ["auditAction", "action"],
    ]) {
      const value = byId(id)?.value?.trim();
      if (value) params.set(key, value);
    }
    return params;
  }

  function renderSummary(summary = {}) {
    const modules = (summary.byModule || []).slice(0, 4).map((item) => `${item.module} ${item.count}`).join(" · ") || "暂无模块数据";
    byId("auditSummary").innerHTML = `
      <div class="mabang-summary-item"><span>记录总数</span><strong>${Number(summary.total || 0)}</strong></div>
      <div class="mabang-summary-item"><span>成功</span><strong>${Number(summary.byStatus?.success || 0)}</strong></div>
      <div class="mabang-summary-item"><span>失败</span><strong>${Number(summary.byStatus?.failed || 0)}</strong></div>
      <div class="mabang-summary-item"><span>主要模块</span><strong class="audit-summary-modules">${escapeHtml(modules)}</strong></div>`;
  }

  function renderEvents(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    byId("auditTableBody").innerHTML = events.length
      ? events.map(renderAuditEventRow).join("")
      : '<tr><td colspan="9" class="audit-empty">暂无符合条件的操作记录</td></tr>';
    state.totalPages = Number(data.totalPages || 1);
    byId("auditPageInfo").textContent = `第 ${Number(data.page || 1)} / ${state.totalPages} 页，共 ${Number(data.total || 0)} 条`;
    byId("auditPrevPage").disabled = state.page <= 1;
    byId("auditNextPage").disabled = state.page >= state.totalPages;
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    byId("auditRefreshBtn").disabled = true;
    try {
      const params = filters();
      const [events, summary] = await Promise.all([
        authorizedFetch(`/api/audit/events?${params}`).then(responseJson),
        authorizedFetch("/api/audit/summary").then(responseJson),
      ]);
      renderEvents(events);
      renderSummary(summary.summary);
    } catch (error) {
      onError(error);
    } finally {
      state.loading = false;
      byId("auditRefreshBtn").disabled = false;
    }
  }

  async function showDetail(id) {
    try {
      const data = await authorizedFetch(`/api/audit/events/${encodeURIComponent(id)}`).then(responseJson);
      const view = auditEventViewModel(data.event);
      const metadata = Object.entries(view.metadata).map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`).join("");
      byId("auditDetailContent").innerHTML = `<dl class="run-detail-grid">
        <dt>时间</dt><dd>${escapeHtml(view.time)}</dd>
        <dt>操作</dt><dd>${escapeHtml(view.action)} <small>${escapeHtml(view.actionCode)}</small></dd>
        <dt>请求</dt><dd>${escapeHtml(view.methodPath)}</dd>
        <dt>请求 ID</dt><dd>${escapeHtml(view.requestId)}</dd>
        <dt>状态</dt><dd>${escapeHtml(view.status)}</dd>
        <dt>耗时</dt><dd>${escapeHtml(view.duration)}</dd>
        <dt>来源</dt><dd>${escapeHtml(view.source)}</dd>
        <dt>主体</dt><dd>${escapeHtml(view.actor)}</dd>
        <dt>关联</dt><dd>${escapeHtml(view.relation)}</dd>
        <dt>错误码</dt><dd>${escapeHtml(view.errorCode)}</dd>
        <dt>错误摘要</dt><dd>${escapeHtml(view.error)}</dd>
        ${metadata}
      </dl>`;
      byId("auditDetailDialog").showModal();
    } catch (error) {
      onError(error);
    }
  }

  async function recordClientAction(action, kind) {
    try {
      await authorizedFetch("/api/audit/client-action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, kind }),
      });
    } catch {
      // A client-side audit failure must not block the requested export.
    }
  }

  function initialize() {
    byId("auditFilterForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      state.page = 1;
      load();
    });
    byId("auditRefreshBtn")?.addEventListener("click", () => load());
    byId("auditPrevPage")?.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; load(); } });
    byId("auditNextPage")?.addEventListener("click", () => { if (state.page < state.totalPages) { state.page += 1; load(); } });
    byId("auditTableBody")?.addEventListener("click", (event) => {
      const button = event.target.closest("[data-audit-detail]");
      if (button) showDetail(button.dataset.auditDetail);
    });
    byId("auditDetailClose")?.addEventListener("click", () => byId("auditDetailDialog").close());
  }

  return { initialize, load, recordClientAction };
}
