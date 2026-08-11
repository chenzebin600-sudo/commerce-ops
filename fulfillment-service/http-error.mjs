export function presentFulfillmentError(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  if (status === 500) {
    return {
      status,
      body: { success: false, error: { code: "INTERNAL_ERROR", message: "服务内部错误" } },
    };
  }
  const errorBody = {
    code: String(error?.code || "REQUEST_FAILED").slice(0, 80),
    message: String(error?.message || "请求失败").slice(0, 1000),
  };
  if (error?.details !== undefined) errorBody.details = error.details;
  return { status, body: { success: false, error: errorBody } };
}
