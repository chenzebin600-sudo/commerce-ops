export const GROWTH_RADAR_PERMISSIONS = Object.freeze([
  "growth_radar.data.view",
  "growth_radar.data.import",
  "growth_radar.shop.manage",
  "growth_radar.mapping.view",
  "growth_radar.mapping.confirm",
  "growth_radar.quality.view",
]);

function csv(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function permissionError() {
  return Object.assign(new Error("当前会话没有执行此增长雷达操作的权限。"), {
    code: "GROWTH_RADAR_PERMISSION_DENIED",
    status: 403,
  });
}

export function createGrowthRadarAccessPolicy(env = {}) {
  const configured = csv(env.GROWTH_RADAR_PERMISSIONS);
  const permissions = new Set(configured.length ? configured : GROWTH_RADAR_PERMISSIONS);
  const allowedShopIds = new Set(csv(env.GROWTH_RADAR_ALLOWED_SHOP_IDS));

  function has(permission) { return permissions.has(permission); }
  function shopInScope(shopId) { return !allowedShopIds.size || (shopId && allowedShopIds.has(shopId)); }
  function assert(permission, shopId = null) {
    if (!has(permission) || (shopId && !shopInScope(shopId))) throw permissionError();
    return true;
  }

  return Object.freeze({
    has,
    assert,
    shopInScope,
    publicCapabilities: () => Object.freeze({
      permissions: Object.fromEntries(GROWTH_RADAR_PERMISSIONS.map((permission) => [permission, has(permission)])),
      shopScopeConfigured: allowedShopIds.size > 0,
    }),
  });
}
