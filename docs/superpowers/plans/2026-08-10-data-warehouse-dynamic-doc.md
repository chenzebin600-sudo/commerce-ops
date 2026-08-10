# Standalone Data Warehouse Dynamic Document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dependency-free Windows tool that opens from `启动数据仓库文档.bat`, accepts a `zndr_` Key in memory, safely proxies the three approved data API routes, renders dynamic query forms and tables, paginates, and exports Excel-compatible CSV.

**Architecture:** A Node.js HTTP server bound only to `127.0.0.1` serves a static browser application and forwards a strict allowlist of API calls to `http://10.110.80.95:8788`. Browser state owns the Key and query results; shared pure modules own validation, result accumulation, and CSV serialization so they can be tested with Node's built-in test runner.

**Tech Stack:** Node.js ESM using built-in `http`, `fs`, `path`, `url`, `child_process`, `node:test`; native HTML, CSS, and browser JavaScript; Windows batch launcher; no npm dependencies and no CDN resources.

## Global Constraints

- Create only `deliverables/data-warehouse-dynamic-doc/`; do not integrate with existing routes, menus, databases, services, or runtime configuration.
- Bind the HTTP listener to `127.0.0.1` only.
- Keep the Key only in current-page memory; never use files, cookies, `localStorage`, `sessionStorage`, query strings, logs, or error messages for it.
- Proxy only `GET /api/data/me`, `GET /api/data/catalog`, and `POST /api/data/query` through fixed local routes.
- The query body may contain only `产品`, `参数`, `页大小`, and `游标`.
- Supported products are `日销`, `库存`, `产品包`, and `控价`; page size is an integer from 1 through 2000; 日销 spans no more than 92 inclusive calendar days.
- Use UTF-8 throughout and prepend a UTF-8 BOM to exported CSV.
- Do not add runtime packages or load CDN assets.
- The batch window remains open while the tool runs; closing it stops the listener.

---

## File Map

- `deliverables/data-warehouse-dynamic-doc/shared/query-model.mjs`: product definitions, input normalization, client/server query validation, result-page accumulation.
- `deliverables/data-warehouse-dynamic-doc/shared/csv.mjs`: deterministic CSV field ordering, cell escaping, Blob download helper.
- `deliverables/data-warehouse-dynamic-doc/server.mjs`: static server, proxy allowlist, no-store headers, loopback binding, port fallback, browser launch.
- `deliverables/data-warehouse-dynamic-doc/public/index.html`: semantic application shell and accessible controls.
- `deliverables/data-warehouse-dynamic-doc/public/app.css`: responsive internal-tool visual system and all interaction states.
- `deliverables/data-warehouse-dynamic-doc/public/app.js`: in-memory state, API calls, dynamic form rendering, table rendering, pagination, export, status handling.
- `deliverables/data-warehouse-dynamic-doc/启动数据仓库文档.bat`: Windows entry point and Node.js availability check.
- `deliverables/data-warehouse-dynamic-doc/README.md`: user instructions, security behavior, troubleshooting, and stop procedure.
- `deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs`: validation and pagination-state tests.
- `deliverables/data-warehouse-dynamic-doc/tests/csv.test.mjs`: CSV quoting, ordering, BOM, and line-ending tests.
- `deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs`: static delivery, proxy policy, Key secrecy, header forwarding, and upstream error tests.

---

### Task 1: Shared Query Model

**Files:**
- Create: `deliverables/data-warehouse-dynamic-doc/shared/query-model.mjs`
- Create: `deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs`

**Interfaces:**
- Produces: `PRODUCTS`, `COUNTRIES`, `PLATFORMS`, `validateKey(value)`, `buildQueryRequest(input)`, `validateQueryPayload(payload)`, `mergeResultPage(state, response)`, and `emptyResultState()`.
- `buildQueryRequest(input)` returns `{ ok: true, value }` or `{ ok: false, errors: string[] }`.
- `mergeResultPage(state, response)` returns `{ rows, cursor, hasMore, meta }` without mutating either argument.

- [ ] **Step 1: Write failing validation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQueryRequest,
  emptyResultState,
  mergeResultPage,
  validateKey,
  validateQueryPayload,
} from "../shared/query-model.mjs";

test("accepts a valid narrowed daily-sales query", () => {
  assert.deepEqual(buildQueryRequest({
    product: "日销",
    pageSize: 500,
    params: { 开始: "2026-08-01", 结束: "2026-08-09", 国家: "MY", 店编: "" },
  }), {
    ok: true,
    value: { 产品: "日销", 参数: { 开始: "2026-08-01", 结束: "2026-08-09", 国家: "MY" }, 页大小: 500 },
  });
});

test("rejects a daily-sales window longer than 92 inclusive days", () => {
  const result = buildQueryRequest({
    product: "日销",
    pageSize: 500,
    params: { 开始: "2026-01-01", 结束: "2026-04-03" },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /92/);
});

test("rejects unknown fields and invalid enum values", () => {
  const result = buildQueryRequest({
    product: "控价",
    pageSize: 500,
    params: { 平台: "AMAZON", 国家: "US", sql: "select 1" },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /平台|国家|参数/);
});

test("validates the data-key prefix without returning the key", () => {
  assert.deepEqual(validateKey(["zndr", "example123"].join("_")), { ok: true });
  assert.equal(validateKey("zntk_wrong").ok, false);
});

test("rejects forbidden top-level API fields", () => {
  const result = validateQueryPayload({ 产品: "库存", 参数: {}, 页大小: 500, sql: "select 1" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /顶层字段/);
});

test("appends a page and retains server metadata", () => {
  const next = mergeResultPage(emptyResultState(), {
    产品: "库存", 角色: "储高", 行数: 1, 耗时ms: 12,
    范围版本: "v1", 水位: "2026-08-10 07:06:24",
    游标: "opaque", 还有更多: true, rows: [{ stock_sku: "A1" }],
  });
  assert.deepEqual(next.rows, [{ stock_sku: "A1" }]);
  assert.equal(next.cursor, "opaque");
  assert.equal(next.hasMore, true);
  assert.equal(next.meta.product, "库存");
});
```

- [ ] **Step 2: Run tests and confirm the missing-module failure**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `shared/query-model.mjs`.

- [ ] **Step 3: Implement product schemas and pure functions**

Implement frozen definitions with these exact parameter names:

```js
export const COUNTRIES = Object.freeze(["TH", "PH", "ID", "MY", "VN", "SG", "TW"]);
export const PLATFORMS = Object.freeze(["SHOPEE", "SHOPEE_MALL", "LAZADA", "LAZADA_MALL", "TIKTOK"]);
export const PRODUCTS = Object.freeze({
  日销: { required: ["开始", "结束"], optional: ["店编", "国家", "大品类"] },
  库存: { required: [], optional: ["国家", "大品类", "SKU", "款号", "只看有货"] },
  产品包: { required: [], optional: ["国家", "大品类", "SKU", "款号"] },
  控价: { required: [], optional: ["平台", "国家", "大品类", "SKU"] },
});
```

`buildQueryRequest` must trim strings, omit blank optional values, preserve boolean `false` only when semantically needed, default 控价 platform to `SHOPEE`, validate dates in UTC calendar arithmetic, reject unknown parameter names, and add `游标` only when it is a non-empty string. `validateQueryPayload` accepts the already-normalized Chinese API shape, rejects any top-level key outside `产品`、`参数`、`页大小`、`游标`, reuses the same product/parameter/date/enum rules, and returns a sanitized copy rather than the original object.

- [ ] **Step 4: Run the query-model tests**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit the shared query model**

```powershell
git add -- deliverables/data-warehouse-dynamic-doc/shared/query-model.mjs deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs
git commit -m "feat: add data warehouse query model"
```

---

### Task 2: CSV Serialization

**Files:**
- Create: `deliverables/data-warehouse-dynamic-doc/shared/csv.mjs`
- Create: `deliverables/data-warehouse-dynamic-doc/tests/csv.test.mjs`

**Interfaces:**
- Produces: `collectColumns(rows)`, `serializeCsv(rows)`, and `downloadCsv(rows, filename, browserApi = globalThis)`.
- `serializeCsv(rows)` returns a string beginning with `\uFEFF` and using CRLF row endings.

- [ ] **Step 1: Write failing CSV tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { collectColumns, serializeCsv } from "../shared/csv.mjs";

test("collects columns in first-seen order", () => {
  assert.deepEqual(collectColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }]), ["a", "b", "c"]);
});

test("writes BOM, CRLF, quotes, commas, newlines, nulls, and objects", () => {
  const csv = serializeCsv([{ name: "A,B", note: "say \"hi\"\nnow", empty: null, meta: { x: 1 } }]);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /^\uFEFFname,note,empty,meta\r\n/);
  assert.match(csv, /"A,B"/);
  assert.match(csv, /"say ""hi""\nnow"/);
  assert.match(csv, /,"\{""x"":1\}"\r\n$/);
});
```

- [ ] **Step 2: Run tests and confirm the missing-module failure**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/csv.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `shared/csv.mjs`.

- [ ] **Step 3: Implement CSV helpers**

Use `String(value)` for primitives, `JSON.stringify` for arrays and objects, an empty cell for `null` or `undefined`, doubled double-quotes inside quoted cells, and quotes around cells containing comma, quote, CR, or LF. `downloadCsv` must create a Blob with `text/csv;charset=utf-8`, click a temporary anchor, revoke the object URL, and throw `没有可导出的数据` when rows are empty.

- [ ] **Step 4: Run CSV tests**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/csv.test.mjs`

Expected: all tests PASS.

- [ ] **Step 5: Commit CSV support**

```powershell
git add -- deliverables/data-warehouse-dynamic-doc/shared/csv.mjs deliverables/data-warehouse-dynamic-doc/tests/csv.test.mjs
git commit -m "feat: add data warehouse csv export"
```

---

### Task 3: Loopback Static Server and Restricted Proxy

**Files:**
- Create: `deliverables/data-warehouse-dynamic-doc/server.mjs`
- Create: `deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs`

**Interfaces:**
- Consumes: `validateQueryPayload(payload)` from `shared/query-model.mjs` for server-side defense in depth.
- Produces: `createApp({ upstreamBaseUrl, fetchImpl, logger })`, `listenOnAvailablePort(server, { host, preferredPort, attempts })`, and `openBrowser(url, platform)`.
- Local routes: `GET /health`, `GET /proxy/me`, `GET /proxy/catalog`, `POST /proxy/query`, and static `GET`/`HEAD` routes only.

- [ ] **Step 1: Write failing proxy-policy tests**

Use an ephemeral test listener and an injected `fetchImpl`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createApp, listenOnAvailablePort } from "../server.mjs";

async function withServer(fetchImpl, run) {
  const server = createApp({ upstreamBaseUrl: "http://warehouse.test", fetchImpl, logger: { log() {}, error() {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try { await run(`http://127.0.0.1:${port}`); } finally { server.close(); await once(server, "close"); }
}

test("forwards only the data key to the fixed me endpoint", async () => {
  let observed;
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async (url, options) => {
    observed = { url, options };
    return new Response(JSON.stringify({ ok: true, 角色: "运营" }), { status: 200, headers: { "content-type": "application/json" } });
  }, async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": testKey, "x-extra": "drop-me" } });
    assert.equal(response.status, 200);
  });
  assert.equal(observed.url, "http://warehouse.test/api/data/me");
  assert.equal(observed.options.headers["X-Data-Key"], testKey);
  assert.equal(observed.options.headers["x-extra"], undefined);
});

test("rejects unknown local proxy paths without calling upstream", async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; }, async (base) => {
    const response = await fetch(`${base}/proxy/http://evil.test`);
    assert.equal(response.status, 404);
  });
  assert.equal(calls, 0);
});

test("rejects forbidden query keys before calling upstream", async () => {
  let calls = 0;
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async () => { calls += 1; }, async (base) => {
    const response = await fetch(`${base}/proxy/query`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-data-key": testKey },
      body: JSON.stringify({ 产品: "库存", 参数: {}, 页大小: 500, sql: "select 1" }),
    });
    assert.equal(response.status, 400);
  });
  assert.equal(calls, 0);
});

test("preserves supported upstream error status and JSON", async () => {
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async () => new Response(JSON.stringify({ ok: false, error: "权限不足" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }), async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": testKey } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: "权限不足" });
    assert.match(response.headers.get("cache-control"), /no-store/);
  });
});

test("sanitizes upstream network failures", async () => {
  const testKey = ["zndr", "secret"].join("_");
  await withServer(async () => { throw new Error(`connect failed ${testKey}`); }, async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": testKey } });
    const body = await response.text();
    assert.equal(response.status, 502);
    assert.doesNotMatch(body, /secret/);
  });
});
```

Add these policy and port-fallback tests in the same file:

```js
test("rejects unsupported method and path combinations", async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; }, async (base) => {
    for (const [method, path, expected] of [
      ["POST", "/proxy/me", 405],
      ["GET", "/proxy/query", 405],
      ["GET", "/unknown", 404],
    ]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, expected);
    }
  });
  assert.equal(calls, 0);
});

test("health route is available without a key", async () => {
  await withServer(async () => { throw new Error("not expected"); }, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("rejects an invalid key without echoing it", async () => {
  const invalidKey = ["zntk", "not-data"].join("_");
  await withServer(async () => { throw new Error("not expected"); }, async (base) => {
    const response = await fetch(`${base}/proxy/me`, { headers: { "x-data-key": invalidKey } });
    const body = await response.text();
    assert.equal(response.status, 400);
    assert.equal(body.includes(invalidKey), false);
  });
});

test("falls back to the next loopback port", async () => {
  const blocker = createServer();
  blocker.listen(0, "127.0.0.1");
  await once(blocker, "listening");
  const preferredPort = blocker.address().port;
  assert.ok(preferredPort < 65535);
  const candidate = createServer((request, response) => response.end("ok"));
  const selected = await listenOnAvailablePort(candidate, {
    host: "127.0.0.1", preferredPort, attempts: 2,
  });
  try {
    assert.equal(selected.port, preferredPort + 1);
    assert.equal(selected.host, "127.0.0.1");
  } finally {
    const closed = [once(candidate, "close"), once(blocker, "close")];
    candidate.close();
    blocker.close();
    await Promise.all(closed);
  }
});
```

- [ ] **Step 2: Run tests and confirm the missing-module failure**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `server.mjs`.

- [ ] **Step 3: Implement the server and proxy**

Use an exact route table rather than URL concatenation:

```js
const PROXY_ROUTES = Object.freeze({
  "GET /proxy/me": { upstreamPath: "/api/data/me", method: "GET" },
  "GET /proxy/catalog": { upstreamPath: "/api/data/catalog", method: "GET" },
  "POST /proxy/query": { upstreamPath: "/api/data/query", method: "POST" },
});
```

Set `Cache-Control: no-store, max-age=0`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and a CSP allowing only self-hosted scripts/styles and same-origin connections. Limit request bodies to 64 KiB. Forward only `X-Data-Key`, `Content-Type`, the validated JSON body, and a 60-second abort timeout. Never print request headers or bodies.

Serve exact static paths for `/`, `/index.html`, `/app.css`, `/app.js`, `/shared/query-model.mjs`, and `/shared/csv.mjs`. Reject path traversal and all other paths.

`listenOnAvailablePort` must try ports 4788 through 4797 in order. The CLI entry point must open the browser only after listening, print the URL and stop instruction, handle `SIGINT`/`SIGTERM`, and exit nonzero when no port is available.

- [ ] **Step 4: Run server tests**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs`

Expected: all tests PASS and no test output contains the generated test Key.

- [ ] **Step 5: Commit the loopback server**

```powershell
git add -- deliverables/data-warehouse-dynamic-doc/server.mjs deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs
git commit -m "feat: add restricted warehouse proxy"
```

---

### Task 4: Accessible Interactive Document Shell

**Files:**
- Create: `deliverables/data-warehouse-dynamic-doc/public/index.html`
- Create: `deliverables/data-warehouse-dynamic-doc/public/app.css`

**Interfaces:**
- Produces stable DOM ids consumed by `app.js`: `key-input`, `toggle-key`, `connect-button`, `connection-status`, `scope-summary`, `product-tabs`, `query-form`, `query-button`, `query-errors`, `result-meta`, `result-table`, `empty-state`, `load-more-button`, and `export-button`.

- [ ] **Step 1: Add a failing static-shell assertion**

Append to `tests/server.test.mjs`:

```js
test("serves the semantic application shell with no external assets", async () => {
  await withServer(async () => new Response("{}"), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /id="key-input"/);
    assert.match(html, /id="query-form"/);
    assert.match(html, /id="result-table"/);
    assert.doesNotMatch(html, /https?:\/\//);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs`

Expected: FAIL because the application shell does not exist.

- [ ] **Step 3: Build the HTML shell**

Use a single `<main>` containing a connection `<section>`, query `<section>`, and results `<section>`. Every input must have a visible `<label>`. Use `aria-live="polite"` for connection state and result metadata, `aria-live="assertive"` for errors, `aria-busy` while requests run, and a real `<table>` with `<caption>`, `<thead>`, and `<tbody>`.

Load only:

```html
<link rel="stylesheet" href="/app.css">
<script type="module" src="/app.js"></script>
```

- [ ] **Step 4: Build the visual system**

Use CSS custom properties with one restrained blue accent, off-white surfaces, high-contrast charcoal text, an 8px input radius and 12px panel radius, a maximum content width of 1440px, two columns above 960px, and one column below it. Include visible `:focus-visible`, disabled, loading, empty, error, success, sticky-header table, horizontal overflow, `prefers-reduced-motion`, and print styles. Use system fonts and no images, gradients, outer glows, or decorative animations.

- [ ] **Step 5: Run static and server tests**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 6: Commit the document shell**

```powershell
git add -- deliverables/data-warehouse-dynamic-doc/public/index.html deliverables/data-warehouse-dynamic-doc/public/app.css deliverables/data-warehouse-dynamic-doc/tests/server.test.mjs
git commit -m "feat: add warehouse explorer interface"
```

---

### Task 5: Browser Controller, Dynamic Forms, Pagination, and Export

**Files:**
- Create: `deliverables/data-warehouse-dynamic-doc/public/app.js`
- Modify: `deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs`

**Interfaces:**
- Consumes: all exports from `/shared/query-model.mjs` and `downloadCsv` from `/shared/csv.mjs`.
- Internal state shape: `{ key, me, catalog, product, formValues, result, busy, error }`.
- All fetches use the helper `requestJson(path, { method = "GET", body } = {})`, which reads `state.key` at call time and never stores it elsewhere.

- [ ] **Step 1: Add result-reset and multi-page tests**

Append to `tests/query-model.test.mjs`:

```js
test("merges later pages without mutating earlier state", () => {
  const first = mergeResultPage(emptyResultState(), { rows: [{ id: 1 }], 游标: "a", 还有更多: true });
  const second = mergeResultPage(first, { rows: [{ id: 2 }], 游标: null, 还有更多: false });
  assert.deepEqual(first.rows, [{ id: 1 }]);
  assert.deepEqual(second.rows, [{ id: 1 }, { id: 2 }]);
  assert.equal(second.hasMore, false);
});

test("a fresh empty state has no rows, cursor, or metadata", () => {
  assert.deepEqual(emptyResultState(), { rows: [], cursor: null, hasMore: false, meta: null });
});
```

- [ ] **Step 2: Run query-model tests**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs`

Expected: PASS after adjusting the pure functions only if the new assertions expose a gap.

- [ ] **Step 3: Implement connection and catalog loading**

On submit of the connection form, validate the Key, set `state.key`, call `/proxy/me`, then `/proxy/catalog`. On either failure, clear `state.key`, `state.me`, and `state.catalog`. Render role, store count, scope version, open products, and scope warnings with text content only. Never interpolate server strings into `innerHTML`.

- [ ] **Step 4: Implement product-aware forms**

Render product buttons only for catalog-enabled products. If catalog data is absent or malformed, show all four known products but disable querying with a catalog-mismatch message. Render the exact fields from the design, default 日销 to the latest completed seven-day window and 控价 platform to `SHOPEE`, and preserve per-product form values while switching tabs.

- [ ] **Step 5: Implement querying and error mapping**

Use `buildQueryRequest` before every query. Map status codes to these messages while appending a sanitized upstream `error` or `message` string when present:

```js
const STATUS_MESSAGES = Object.freeze({
  400: "查询参数不正确，请检查填写内容。",
  403: "Key 无效、权限已停用、产品未开通，或查询超出授权范围。",
  429: "数仓查询队列已满，请稍后重试。",
  502: "已连接中转服务，但数仓查询失败。",
});
```

For network errors, show `无法连接本地工具或公司内网服务。` Disable action buttons and set `aria-busy="true"` while a request is active.

- [ ] **Step 6: Implement table, pagination, and CSV export**

Generate columns with `collectColumns(state.result.rows)`, create every cell with `textContent`, format `null` as an empty string, and preserve numeric precision via `String(value)`. “加载下一页” reuses the current normalized query and adds the opaque cursor. A new query starts from `emptyResultState()`. Export all loaded rows as `数仓-<产品>-YYYYMMDD-HHmmss.csv`.

- [ ] **Step 7: Run all automated tests**

Run: `node --test deliverables/data-warehouse-dynamic-doc/tests/*.test.mjs`

Expected: all tests PASS.

- [ ] **Step 8: Commit browser behavior**

```powershell
git add -- deliverables/data-warehouse-dynamic-doc/public/app.js deliverables/data-warehouse-dynamic-doc/tests/query-model.test.mjs
git commit -m "feat: make warehouse document interactive"
```

---

### Task 6: Windows Launcher, Documentation, and End-to-End Verification

**Files:**
- Create: `deliverables/data-warehouse-dynamic-doc/启动数据仓库文档.bat`
- Create: `deliverables/data-warehouse-dynamic-doc/README.md`

**Interfaces:**
- Consumes: the CLI entry point in `server.mjs`.
- Produces: one double-click entry point and complete operator guidance.

- [ ] **Step 1: Create the launcher**

Use this control flow, with Windows-safe quoting and `%~dp0` as the working directory:

```bat
@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请安装 Node.js 20 或更高版本后重试。
  pause
  exit /b 1
)
echo 数据仓库动态文档正在启动。
echo 关闭此窗口即可停止工具。
node server.mjs
if errorlevel 1 (
  echo.
  echo 工具异常退出，请查看上方提示。
  pause
)
```

- [ ] **Step 2: Write operator documentation**

Document: double-click startup, Node.js 20+ requirement, company-LAN requirement, `zndr_` versus `zntk_`, Key memory-only behavior, query workflow, pagination, CSV export, status-code troubleshooting, port range 4788-4797, and the rule that closing the batch window stops the tool. Do not include a real or example-like full Key.

- [ ] **Step 3: Run automated verification**

Run:

```powershell
node --test deliverables/data-warehouse-dynamic-doc/tests/*.test.mjs
node --check deliverables/data-warehouse-dynamic-doc/server.mjs
node --check deliverables/data-warehouse-dynamic-doc/public/app.js
node --check deliverables/data-warehouse-dynamic-doc/shared/query-model.mjs
node --check deliverables/data-warehouse-dynamic-doc/shared/csv.mjs
```

Expected: every test passes and every syntax check exits 0.

- [ ] **Step 4: Run a local smoke test without a Key**

Start `node deliverables/data-warehouse-dynamic-doc/server.mjs`, record the printed loopback URL, then verify in a second terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:4788/health
```

Expected: `{ "ok": true }`. If the server selected a fallback port, use the printed port. Confirm that stopping the server removes the listener.

- [ ] **Step 5: Inspect the interface in a browser**

Verify desktop and narrow widths, labels, keyboard focus, hidden Key by default, disabled query controls before connection, empty/error/loading states, table overflow, and no console errors. Do not enter a Key unless the user provides it through their local page.

- [ ] **Step 6: Run the pre-flight security scan**

Run:

```powershell
rg -n "localStorage|sessionStorage|document\.cookie|console\.(log|error).*key|zndr_[A-Za-z0-9]" deliverables/data-warehouse-dynamic-doc
```

Expected: no persistence APIs, no logging of Key values, and no embedded Key-like secret. Any intentional documentation mention of the `zndr_` prefix must not include a complete credential.

- [ ] **Step 7: Commit the completed standalone tool**

```powershell
git add -- deliverables/data-warehouse-dynamic-doc/启动数据仓库文档.bat deliverables/data-warehouse-dynamic-doc/README.md
git commit -m "docs: add warehouse explorer launcher guide"
```

- [ ] **Step 8: Final repository-scope check**

Run:

```powershell
git status --short
git log --oneline -6
```

Expected: all implementation commits contain only `deliverables/data-warehouse-dynamic-doc/**`; pre-existing unrelated working-tree changes remain untouched.
