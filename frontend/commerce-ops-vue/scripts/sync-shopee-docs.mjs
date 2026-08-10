import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = 2;
const BASE_URL = "https://open.shopee.com/opservice/api/v1";
const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "shopee-official-docs.generated.json");

async function fetchJson(route, attempt = 1) {
  const response = await fetch(`${BASE_URL}${route}`, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      return fetchJson(route, attempt + 1);
    }
    throw new Error(`${response.status} ${response.statusText}: ${route}`);
  }

  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`${payload.error}: ${payload.msg || route}`);
  }
  return payload;
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeApi(api) {
  const definition = parseJson(api.define, {});
  const parameters = parseJson(api.params, {});
  const commonParameters = parseJson(api.common_params, []);
  const requestSample = parseJson(api.request_sample, api.request_sample || null);
  const responseSample = parseJson(api.response_sample, api.response_sample || null);
  const errorExample = parseJson(api.error_example, api.error_example || null);

  return {
    id: api.api_id,
    name: api.api_name,
    moduleId: api.module_id,
    moduleName: api.module_name || api.api_type,
    method: api.method === 2 ? "GET" : "POST",
    path: api.path,
    url: api.url,
    testUrl: api.test_url,
    descriptionHtml: definition.content || "",
    description: definition.raw_content || [],
    commonParameters,
    parameters,
    requestSample,
    responseSample,
    errors: api.error_list || [],
    commonErrors: api.common_error_list || [],
    errorExample,
    permissions: api.api_permission || [],
    rateLimit: api.rate_limit || "",
    updateLogs: api.update_log_list || [],
    relatedDocuments: api.related_documents || {},
    priority: api.priority,
    updatedAt: api.perm_mtime || null,
  };
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await worker(items[index], index);
      if ((index + 1) % 25 === 0 || index + 1 === items.length) {
        console.log(`Synced ${index + 1}/${items.length} API documents`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, run));
  return output;
}

const modulePayload = await fetchJson(`/doc/module/?version=${VERSION}`);
const allModules = modulePayload.modules || [];
const apiModules = allModules.filter((module) => module.type === 1);
const guideModules = allModules.filter((module) => module.type === 2);
const apiItems = apiModules.flatMap((module) =>
  (module.items || []).map((item) => ({ ...item, moduleId: module.module_id, moduleName: module.module_name })),
);

const apiDocuments = await mapConcurrent(apiItems, 12, async (item) => {
  const api = await fetchJson(`/doc/api/?version=${VERSION}&api_name=${encodeURIComponent(item.name)}`);
  return normalizeApi(api);
});

const apiByName = new Map(apiDocuments.map((api) => [api.name, api]));
const modules = apiModules.map((module) => ({
  id: module.module_id,
  name: module.module_name,
  priority: module.priority,
  items: (module.items || []).map((item) => apiByName.get(item.name)).filter(Boolean),
}));

const pushPayload = await fetchJson("/push/category");
const pushItems = (pushPayload.category || []).flatMap((category) =>
  (category.push || []).map((push) => ({ ...push, categoryId: category.category_id, categoryName: category.category_name })),
);
const pushDocuments = await mapConcurrent(pushItems, 8, async (item) => {
  const detail = await fetchJson(`/push/doc?push_api_id=${item.push_api_id}`);
  return { categoryId: item.categoryId, categoryName: item.categoryName, ...detail };
});

const output = {
  source: "Shopee Open Platform",
  sourceUrl: "https://open.shopee.com/documents/v2/v2.shop.get_shop_info?module=1&type=1",
  fetchedAt: new Date().toISOString(),
  version: VERSION,
  stats: {
    modules: modules.length,
    apis: apiDocuments.length,
    guideSections: guideModules.reduce((total, module) => total + (module.items?.length || 0), 0),
    pushCategories: pushPayload.category?.length || 0,
    pushEvents: pushDocuments.length,
  },
  guideModules,
  modules,
  pushCategories: pushPayload.category || [],
  pushDocuments,
};

await mkdir(OUTPUT_DIR, { recursive: true });
await writeFile(OUTPUT_FILE, `${JSON.stringify(output)}\n`, "utf8");
console.log(`Wrote ${OUTPUT_FILE}`);
console.log(JSON.stringify(output.stats));
