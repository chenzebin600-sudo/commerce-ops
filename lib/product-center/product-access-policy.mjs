export const PRODUCT_PERMISSIONS = Object.freeze([
  "product.view",
  "product.edit",
  "product.delete",
  "product.restore",
  "product.ai.generate",
  "product.ai.confirm",
  "product.ai.view_history",
]);

function csv(value) {
  return [...new Set(String(value || "").split(",").map((item) => item.trim()).filter(Boolean))];
}

function normalizedScope(values) {
  return new Set(values.map((value) => value.toLocaleLowerCase("zh-CN")));
}

function inScope(allowed, value) {
  if (!allowed.size) return true;
  return allowed.has(String(value || "").trim().toLocaleLowerCase("zh-CN"));
}

function accessError() {
  return Object.assign(new Error("当前会话没有执行此产品操作的权限。"), {
    code: "PRODUCT_PERMISSION_DENIED",
    status: 403,
  });
}

export function createProductAccessPolicy(env = {}) {
  const configuredPermissions = csv(env.PRODUCT_PERMISSIONS);
  const permissions = new Set(configuredPermissions.length ? configuredPermissions : PRODUCT_PERMISSIONS);
  const countries = csv(env.PRODUCT_ALLOWED_COUNTRIES);
  const categoryL1 = csv(env.PRODUCT_ALLOWED_CATEGORY_L1);
  const categoryL2 = csv(env.PRODUCT_ALLOWED_CATEGORY_L2);
  const countryScope = normalizedScope(countries);
  const categoryL1Scope = normalizedScope(categoryL1);
  const categoryL2Scope = normalizedScope(categoryL2);

  function has(permission) {
    return permissions.has(permission);
  }

  function productInScope(product) {
    return inScope(countryScope, product?.country)
      && inScope(categoryL1Scope, product?.categoryL1)
      && inScope(categoryL2Scope, product?.categoryL2);
  }

  function assert(permission, product = null) {
    if (!has(permission) || (product && !productInScope(product))) throw accessError();
    return true;
  }

  return Object.freeze({
    has,
    assert,
    productInScope,
    listScope: Object.freeze({ countries, categoryL1, categoryL2 }),
    publicCapabilities: () => Object.freeze({
      permissions: Object.fromEntries(PRODUCT_PERMISSIONS.map((permission) => [permission, has(permission)])),
      scopes: { countries, categoryL1, categoryL2 },
    }),
  });
}
