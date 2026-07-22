export const MABANG_IMAGE_PERMISSIONS = Object.freeze([
  "mabang_images.view",
  "mabang_images.collect",
  "mabang_images.retry",
  "mabang_images.link",
  "mabang_images.set_primary",
]);

function csv(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

export function createMabangImageAccessPolicy(env = {}) {
  const configured = csv(env.MABANG_IMAGE_PERMISSIONS);
  const permissions = new Set(configured.length ? configured : MABANG_IMAGE_PERMISSIONS);
  const has = (permission) => permissions.has(permission);
  const assert = (permission) => {
    if (!has(permission)) {
      const error = new Error("当前会话没有执行此马帮图片操作的权限。 ");
      error.code = "MABANG_IMAGE_PERMISSION_DENIED";
      error.status = 403;
      throw error;
    }
    return true;
  };
  return Object.freeze({
    has,
    assert,
    publicCapabilities: () => ({ permissions: Object.fromEntries(MABANG_IMAGE_PERMISSIONS.map((item) => [item, has(item)])) }),
  });
}
