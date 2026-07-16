export function successResponse(data, { requestId = null, legacy = {} } = {}) {
  return { success: true, data, request_id: requestId, error: null, ...legacy };
}

export function errorResponse(code, message, { requestId = null, legacy = {} } = {}) {
  return {
    success: false,
    data: null,
    request_id: requestId,
    error: { code: String(code || "REQUEST_FAILED"), message: String(message || "Request failed") },
    ...legacy,
  };
}

export function paginationResponse(items, { page, pageSize, total, requestId = null, legacy = {} }) {
  const normalizedPage = Math.max(1, Number(page) || 1);
  const normalizedSize = Math.max(1, Number(pageSize) || 20);
  const normalizedTotal = Math.max(0, Number(total) || 0);
  return successResponse({
    items,
    pagination: {
      page: normalizedPage,
      page_size: normalizedSize,
      total: normalizedTotal,
      total_pages: Math.max(1, Math.ceil(normalizedTotal / normalizedSize)),
    },
  }, { requestId, legacy });
}

export function asyncTaskResponse({ taskId = null, runId = null, status = "pending" }, options = {}) {
  return successResponse({ task_id: taskId, run_id: runId, status }, options);
}
