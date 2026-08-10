import * as queryModel from "/shared/query-model.mjs";
import { collectColumns, downloadCsv } from "/shared/csv.mjs";

const {
  COUNTRIES,
  PLATFORMS,
  PRODUCTS,
  buildQueryRequest,
  completeSuccessfulExport,
  emptyResultState,
  mergeResultPage,
  productSwitch,
  readCatalog,
  validateKey,
  validateResultPage,
} = queryModel;

const STATUS_MESSAGES = Object.freeze({
  400: "查询参数不正确，请检查填写内容。",
  403: "Key 无效、权限已停用、产品未开通，或查询超出授权范围。",
  429: "数仓查询队列已满，请稍后重试。",
  502: "已连接中转服务，但数仓查询失败。",
});
const NETWORK_MESSAGE = "无法连接本地工具或公司内网服务。";
const CATALOG_MESSAGE = "产品目录缺失或格式不正确，无法确认查询字段；请查看最新接口文档。";
const PRODUCT_NAMES = Object.freeze(Object.keys(PRODUCTS));
const FIELD_IDS = Object.freeze({
  开始: "query-start",
  结束: "query-end",
  店编: "query-store-code",
  国家: "query-country",
  大品类: "query-category",
  SKU: "query-sku",
  款号: "query-style-code",
  只看有货: "query-in-stock-only",
  平台: "query-platform",
});

const state = {
  key: null,
  me: null,
  catalog: null,
  product: "日销",
  formValues: createInitialFormValues(),
  result: emptyResultState(),
  busy: false,
  error: null,
};

let currentQuery = null;

const elements = {
  connectionForm: document.querySelector("#connection-form"),
  keyInput: document.querySelector("#key-input"),
  toggleKey: document.querySelector("#toggle-key"),
  connectButton: document.querySelector("#connect-button"),
  connectionStatus: document.querySelector("#connection-status"),
  scopeSummary: document.querySelector("#scope-summary"),
  productTabs: document.querySelector("#product-tabs"),
  queryForm: document.querySelector("#query-form"),
  queryParameters: document.querySelector("#query-parameters"),
  queryButton: document.querySelector("#query-button"),
  queryErrors: document.querySelector("#query-errors"),
  resultsPanel: document.querySelector(".results-panel"),
  resultMeta: document.querySelector("#result-meta"),
  resultTable: document.querySelector("#result-table"),
  emptyState: document.querySelector("#empty-state"),
  loadMoreButton: document.querySelector("#load-more-button"),
  exportButton: document.querySelector("#export-button"),
};

elements.connectionForm.addEventListener("submit", connect);
elements.toggleKey.addEventListener("click", toggleKeyVisibility);
elements.productTabs.addEventListener("click", selectProduct);
elements.queryParameters.addEventListener("input", saveFormValue);
elements.queryParameters.addEventListener("change", saveFormValue);
elements.queryForm.addEventListener("submit", runNewQuery);
elements.loadMoreButton.addEventListener("click", loadNextPage);
elements.exportButton.addEventListener("click", exportRows);

render();

async function connect(event) {
  event.preventDefault();
  const validation = validateKey(elements.keyInput.value.trim());
  if (!validation.ok) {
    clearConnection();
    state.error = validation.errors.join(" ");
    render();
    return;
  }

  state.key = elements.keyInput.value.trim();
  elements.keyInput.value = "";
  hideKeyInput();
  state.me = null;
  state.catalog = null;
  state.result = emptyResultState();
  currentQuery = null;
  state.error = null;
  state.busy = true;
  render();

  try {
    const me = await requestJson("/proxy/me");
    const catalog = await requestJson("/proxy/catalog");
    state.me = isPlainObject(me) ? me : {};
    state.catalog = catalog;
    state.error = null;
    chooseAvailableProduct();
  } catch (error) {
    clearConnection();
    state.error = messageFromError(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function requestJson(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json", "X-Data-Key": state.key };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new RequestFailure(0, NETWORK_MESSAGE);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const base = STATUS_MESSAGES[response.status] || "请求失败，请稍后重试。";
    const upstream = sanitizeServerMessage(payload?.error ?? payload?.message);
    throw new RequestFailure(response.status, upstream ? `${base} ${upstream}` : base);
  }
  if (payload === null) {
    throw new RequestFailure(502, STATUS_MESSAGES[502]);
  }
  return payload;
}

function clearConnection() {
  state.key = null;
  state.me = null;
  state.catalog = null;
  state.result = emptyResultState();
  currentQuery = null;
}

function toggleKeyVisibility() {
  const show = elements.keyInput.type === "password";
  elements.keyInput.type = show ? "text" : "password";
  elements.toggleKey.setAttribute("aria-pressed", String(show));
  elements.toggleKey.textContent = show ? "隐藏" : "显示";
}

function hideKeyInput() {
  elements.keyInput.type = "password";
  elements.toggleKey.setAttribute("aria-pressed", "false");
  elements.toggleKey.textContent = "显示";
}

function selectProduct(event) {
  const button = event.target.closest("button[data-product]");
  if (!button || button.disabled || !Object.hasOwn(PRODUCTS, button.dataset.product)) return;
  const next = productSwitch(state.product, button.dataset.product, state.result, currentQuery);
  state.product = next.product;
  state.result = next.result;
  currentQuery = next.currentQuery;
  state.error = null;
  render();
}

function saveFormValue(event) {
  const control = event.target.closest("[data-parameter]");
  if (!control) return;
  const value = control.type === "checkbox" ? control.checked : control.value;
  state.formValues[state.product][control.dataset.parameter] = value;
}

async function runNewQuery(event) {
  event.preventDefault();
  const validation = buildCurrentFormQuery();
  if (!validation.ok) {
    state.error = validation.errors.join(" ");
    render();
    return;
  }

  state.result = emptyResultState();
  currentQuery = null;
  render();
  await fetchQueryPage(validation.value, true);
}

async function loadNextPage() {
  if (!currentQuery || !state.result.hasMore) return;
  const validation = buildQueryRequest({
    product: currentQuery.产品,
    params: currentQuery.参数,
    pageSize: currentQuery.页大小,
    cursor: state.result.cursor,
  });
  if (!validation.ok) {
    state.error = validation.errors.join(" ");
    render();
    return;
  }
  await fetchQueryPage(validation.value, false);
}

async function fetchQueryPage(query, isNewQuery) {
  if (state.busy || !selectedProductIsQueryable()) return;
  state.busy = true;
  state.error = null;
  render();

  try {
    const payload = await requestJson("/proxy/query", { method: "POST", body: query });
    let response;
    try {
      response = validateResultPage(payload, state.key);
    } catch {
      throw new RequestFailure(502, `${STATUS_MESSAGES[502]} 返回数据格式不正确。`);
    }
    state.result = mergeResultPage(isNewQuery ? emptyResultState() : state.result, response);
    currentQuery = {
      产品: query.产品,
      参数: { ...query.参数 },
      页大小: query.页大小,
    };
  } catch (error) {
    state.error = messageFromError(error);
  } finally {
    state.busy = false;
    render();
  }
}

function buildCurrentFormQuery() {
  const values = state.formValues[state.product];
  const params = {};
  const schema = PRODUCTS[state.product];
  for (const name of [...schema.required, ...schema.optional]) params[name] = values[name];
  return buildQueryRequest({ product: state.product, params, pageSize: Number(values.pageSize) });
}

function exportRows() {
  if (!state.result.rows.length || !currentQuery) return;
  try {
    downloadCsv(state.result.rows, `数仓-${currentQuery.产品}-${formatTimestamp(new Date())}.csv`);
    completeSuccessfulExport(state, render);
  } catch (error) {
    state.error = messageFromError(error);
    render();
  }
}

function render() {
  const catalog = readCatalog(state.catalog);
  renderConnection(catalog);
  renderProductTabs(catalog);
  renderQueryParameters(catalog);
  renderErrors(catalog);
  renderResults();
  renderBusyState(catalog);
}

function renderConnection(catalog) {
  delete elements.connectionStatus.dataset.state;
  if (state.busy && !state.me) {
    elements.connectionStatus.textContent = "正在连接…";
  } else if (state.me) {
    elements.connectionStatus.textContent = "已连接";
    elements.connectionStatus.dataset.state = "success";
  } else if (state.error) {
    elements.connectionStatus.textContent = "连接失败";
    elements.connectionStatus.dataset.state = "error";
  } else {
    elements.connectionStatus.textContent = "尚未连接";
  }

  if (!state.me) {
    elements.scopeSummary.textContent = "连接后将显示你的数据范围。";
    return;
  }

  const role = firstDefined(state.me, ["角色", "role"]);
  const storeCount = firstDefined(state.me, ["店铺数", "门店数", "storeCount", "shopCount"])
    ?? countArray(state.me, ["店铺", "stores", "shops"]);
  const scopeVersion = firstDefined(state.me, ["范围版本", "scopeVersion"]);
  const openProducts = listValue(firstDefined(state.me, ["已开放产品", "开放产品", "products"]))
    || (catalog.valid ? catalog.enabledProducts.join("、") : "");
  const warnings = warningValues(firstDefined(state.me, ["范围警告", "警告", "warnings"]));
  const parts = [
    summaryPart("角色", role),
    summaryPart("店铺数", storeCount),
    summaryPart("范围版本", scopeVersion),
    summaryPart("已开放产品", openProducts),
  ].filter(Boolean);
  if (warnings.length) parts.push(`范围警告：${warnings.join("；")}`);
  elements.scopeSummary.textContent = parts.length ? parts.join(" · ") : "权限已读取。";
}

function renderProductTabs(catalog) {
  const names = catalog.valid ? catalog.enabledProducts : PRODUCT_NAMES;
  const fragment = document.createDocumentFragment();
  for (const name of names) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "product-tab";
    button.dataset.product = name;
    button.textContent = name;
    button.disabled = state.busy || !state.me;
    button.setAttribute("aria-busy", String(state.busy));
    button.setAttribute("aria-pressed", String(name === state.product));
    if (name === state.product) button.classList.add("is-selected");
    fragment.append(button);
  }
  elements.productTabs.replaceChildren(fragment);
}

function renderQueryParameters(catalog) {
  const fragment = document.createDocumentFragment();
  const schema = PRODUCTS[state.product];
  const disabled = state.busy || !state.me || !catalog.valid || !selectedProductIsQueryable(catalog);
  if (schema) {
    for (const name of [...schema.required, ...schema.optional]) {
      fragment.append(createParameterField(name, schema.required.includes(name), disabled));
    }
  }
  fragment.append(createPageSizeField(disabled));
  elements.queryParameters.replaceChildren(fragment);
}

function createParameterField(name, required, disabled) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  const id = FIELD_IDS[name];
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = required ? `${name}（必填）` : name;
  wrapper.append(label);

  let control;
  if (name === "国家") {
    control = createSelect(id, name, [{ value: "", label: "全部国家" }, ...COUNTRIES.map(option)]);
  } else if (name === "平台") {
    control = createSelect(id, name, PLATFORMS.map(option));
  } else {
    control = document.createElement("input");
    control.id = id;
    control.name = name;
    control.dataset.parameter = name;
    control.type = name === "开始" || name === "结束" ? "date" : name === "只看有货" ? "checkbox" : "text";
  }
  if (required) control.required = true;
  control.disabled = disabled;
  if (control.type === "checkbox") control.checked = state.formValues[state.product][name] === true;
  else control.value = state.formValues[state.product][name] ?? "";
  wrapper.append(control);
  return wrapper;
}

function createPageSizeField(disabled) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  const label = document.createElement("label");
  label.htmlFor = "query-page-size";
  label.textContent = "每页行数";
  const input = document.createElement("input");
  input.id = "query-page-size";
  input.name = "pageSize";
  input.dataset.parameter = "pageSize";
  input.type = "number";
  input.min = "1";
  input.max = "2000";
  input.step = "1";
  input.required = true;
  input.disabled = disabled;
  input.value = state.formValues[state.product].pageSize;
  wrapper.append(label, input);
  return wrapper;
}

function createSelect(id, name, options) {
  const select = document.createElement("select");
  select.id = id;
  select.name = name;
  select.dataset.parameter = name;
  for (const item of options) {
    const node = document.createElement("option");
    node.value = item.value;
    node.textContent = item.label;
    select.append(node);
  }
  return select;
}

function renderErrors(catalog) {
  let message = state.error;
  if (!message && state.me && !catalog.valid) message = CATALOG_MESSAGE;
  if (!message && state.me && catalog.valid && !catalog.enabledProducts.length) {
    message = "当前 Key 未开放此工具支持的数据产品。";
  }
  if (!message && state.me && catalog.mismatches.has(state.product)) {
    message = `“${state.product}” 的目录参数与内置表单不一致，已禁用查询；请查看最新接口文档。`;
  }
  elements.queryErrors.hidden = !message;
  elements.queryErrors.textContent = message || "";
}

function renderResults() {
  const rows = state.result.rows;
  const columns = collectColumns(rows);
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  const body = document.createElement("tbody");

  if (columns.length) {
    for (const column of columns) {
      const cell = document.createElement("th");
      cell.scope = "col";
        cell.textContent = String(column);
      headRow.append(cell);
    }
    for (const row of rows) {
      const rowElement = document.createElement("tr");
      for (const column of columns) {
        const cell = document.createElement("td");
        cell.textContent = row[column] === null || row[column] === undefined ? "" : String(row[column]);
        rowElement.append(cell);
      }
      body.append(rowElement);
    }
  } else {
    const heading = document.createElement("th");
    heading.scope = "col";
    heading.textContent = state.result.meta ? "无结果" : "等待查询";
    headRow.append(heading);
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.textContent = state.result.meta ? "本次查询未返回数据。" : "提交查询后，结果将显示在这里。";
    row.append(cell);
    body.append(row);
  }
  head.append(headRow);
  const caption = elements.resultTable.querySelector("caption");
  elements.resultTable.replaceChildren(caption, head, body);

  const meta = state.result.meta;
  elements.resultMeta.textContent = meta
    ? [
        summaryPart("产品", meta.product),
        summaryPart("角色", meta.role),
        summaryPart("行数", meta.rowCount),
        `已加载：${rows.length}`,
        summaryPart("耗时", meta.durationMs === undefined ? undefined : `${meta.durationMs} ms`),
        summaryPart("水位", meta.watermark),
        summaryPart("范围版本", meta.scopeVersion),
      ].filter(Boolean).join(" · ")
    : "尚无结果";

  elements.emptyState.hidden = rows.length > 0;
  const emptyTitle = elements.emptyState.querySelector("h3");
  const emptyCopy = elements.emptyState.querySelector("p");
  if (meta) {
    emptyTitle.textContent = "查询完成，没有匹配数据";
    emptyCopy.textContent = "可调整筛选条件后重新查询。";
  } else {
    emptyTitle.textContent = "准备好查询数据";
    emptyCopy.textContent = "先连接数据仓库，然后选择产品和筛选条件。";
  }

  elements.loadMoreButton.hidden = !state.result.hasMore;
  elements.loadMoreButton.textContent = "加载下一页";
}

function renderBusyState(catalog) {
  const queryable = selectedProductIsQueryable(catalog);
  elements.connectionForm.setAttribute("aria-busy", String(state.busy));
  elements.queryForm.setAttribute("aria-busy", String(state.busy));
  elements.resultsPanel.setAttribute("aria-busy", String(state.busy));
  elements.connectButton.disabled = state.busy;
  elements.connectButton.setAttribute("aria-busy", String(state.busy));
  elements.keyInput.disabled = state.busy;
  elements.toggleKey.disabled = state.busy;
  elements.toggleKey.setAttribute("aria-busy", String(state.busy));
  elements.queryButton.disabled = state.busy || !queryable;
  elements.queryButton.setAttribute("aria-busy", String(state.busy && Boolean(state.me)));
  elements.loadMoreButton.disabled = state.busy || !queryable || !state.result.hasMore;
  elements.loadMoreButton.setAttribute("aria-busy", String(state.busy && state.result.hasMore));
  elements.exportButton.disabled = state.busy || state.result.rows.length === 0;
  elements.exportButton.setAttribute("aria-busy", String(state.busy));
}

function selectedProductIsQueryable(catalog = readCatalog(state.catalog)) {
  return Boolean(
    state.me
    && catalog.valid
    && catalog.enabledProducts.includes(state.product)
    && !catalog.mismatches.has(state.product),
  );
}

function chooseAvailableProduct() {
  const catalog = readCatalog(state.catalog);
  if (catalog.valid && !catalog.enabledProducts.includes(state.product)) {
    state.product = catalog.enabledProducts[0] || "日销";
  }
}

function createInitialFormValues() {
  const formValues = {};
  for (const [product, schema] of Object.entries(PRODUCTS)) {
    formValues[product] = { pageSize: "500" };
    for (const name of [...schema.required, ...schema.optional]) {
      formValues[product][name] = name === "只看有货" ? false : "";
    }
  }
  const dailyWindow = completedSevenDayWindow(new Date());
  formValues.日销.开始 = dailyWindow.start;
  formValues.日销.结束 = dailyWindow.end;
  formValues.控价.平台 = "SHOPEE";
  return formValues;
}

function completedSevenDayWindow(now) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6, 12);
  return { start: formatDate(start), end: formatDate(end) };
}

function formatDate(date) {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
}

function formatTimestamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function option(value) {
  return { value, label: value };
}

function summaryPart(label, value) {
  return value === undefined || value === null || value === "" ? "" : `${label}：${sanitizeServerMessage(value)}`;
}

function listValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeServerMessage(
    isPlainObject(item) ? firstDefined(item, ["产品", "名称", "name", "product"]) : item,
  )).filter(Boolean).join("、");
  return value === undefined || value === null ? "" : sanitizeServerMessage(value);
}

function warningValues(value) {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return items.map((item) => sanitizeServerMessage(
    isPlainObject(item) ? firstDefined(item, ["警告", "message", "warning"]) : item,
  )).filter(Boolean);
}

function sanitizeServerMessage(value) {
  if (value === undefined || value === null || typeof value === "object") return "";
  let text = String(value).replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (state.key) text = text.split(state.key).join("[已隐藏]");
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function messageFromError(error) {
  return error instanceof RequestFailure ? error.message : "操作失败，请稍后重试。";
}

function firstDefined(value, keys) {
  if (!isPlainObject(value)) return undefined;
  for (const key of keys) if (Object.hasOwn(value, key)) return value[key];
  return undefined;
}

function countArray(value, keys) {
  const candidate = firstDefined(value, keys);
  return Array.isArray(candidate) ? candidate.length : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

class RequestFailure extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RequestFailure";
    this.status = status;
  }
}
