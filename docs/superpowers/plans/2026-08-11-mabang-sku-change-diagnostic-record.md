# Mabang SKU Change Diagnostic Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve and display a bounded, secret-free diagnostic for every Mabang SKU-change HTTP 409 or uncertain write so the operator can distinguish request-field problems from business restrictions and read-back failures.

**Architecture:** Build the diagnostic at the Python HTTP boundary, transport it through the worker error contract, normalize it again at the Node trust boundary, and persist it with single and batch execution records. The API exposes the same normalized object in 409 `details`, while the Vue page renders a small expandable field list. No component may store or render a raw response body.

**Tech Stack:** Python 3 `unittest`, Node.js 24 test runner, Vue 3/TypeScript, existing fulfillment JSON files and HTTP service.

## Global Constraints

- This change only adds observability; it must not change `orderItemId`, `stockId`, `type`, endpoint selection, confirmation requirements, or retry behavior.
- No real SKU write is part of this implementation plan.
- A later live write requires separate explicit confirmation and remains limited to one request with no retry.
- Never store or return credentials, cookies, authorization headers, request headers, full HTML, full response bodies, stack traces, or arbitrary nested response values.
- Diagnostics share the existing SKU execution-record lifetime and do not create a separate log stream.

---

### Task 1: Build a bounded Python diagnostic at the Mabang boundary

**Files:**
- Modify: `scripts/mabang_order_source.py`
- Modify: `tests/test_mabang_fulfillment_safety.py`

**Interfaces:**
- Produces: `SkuReplacementOperationError(code: str, message: str, diagnostic: dict)`.
- Produces: `build_sku_change_diagnostic(response, result, request_fields, *, body_kind="json", text_preview="") -> dict`.
- Produces: `with_sku_verification(diagnostic, before_sku, target_sku, after_sku, result) -> dict`.
- Keeps: `MabangClient.change_order_item_sku(...)` sends exactly one unchanged POST request.

- [ ] **Step 1: Write failing allowlist and redaction tests**

Extend the current `FakeResponse` with headers and add literal tests:

```python
def test_sku_diagnostic_keeps_request_contract_and_json_field_names_only(self):
    response = FakeResponse(status_code=409)
    response.headers = {'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': 'secret'}
    diagnostic = build_sku_change_diagnostic(response, {
        'success': False, 'code': 'FIELD_INVALID', 'message': 'type 字段无效',
        'token': 'must-not-appear', 'html': '<input name="password" value="secret">',
    }, {'orderItemId': '477372993', 'stockId': '2679193', 'type': '2'})
    self.assertEqual(diagnostic['request'], {
        'fieldNames': ['orderItemId', 'stockId', 'type'],
        'orderItemId': '477372993', 'stockId': '2679193', 'type': '2',
    })
    self.assertEqual(diagnostic['response']['httpStatus'], 409)
    self.assertEqual(diagnostic['response']['contentType'], 'application/json; charset=utf-8')
    self.assertEqual(diagnostic['response']['fieldNames'], ['code', 'html', 'message', 'success', 'token'])
    self.assertEqual(diagnostic['response']['code'], 'FIELD_INVALID')
    self.assertEqual(diagnostic['response']['message'], 'type 字段无效')
    self.assertNotIn('secret', json.dumps(diagnostic, ensure_ascii=False))

def test_html_body_is_never_preserved(self):
    response = FakeResponse(status_code=409, text='<html><input name="password" value="secret"></html>')
    response.headers = {'Content-Type': 'text/html'}
    diagnostic = build_sku_change_diagnostic(response, None,
        {'orderItemId': '1', 'stockId': '2', 'type': '2'}, body_kind='non_json', text_preview=response.text)
    self.assertEqual(diagnostic['response']['bodyKind'], 'non_json')
    self.assertEqual(diagnostic['response']['bodyLength'], len(response.text))
    self.assertNotIn('textPreview', diagnostic['response'])
```

- [ ] **Step 2: Run the new tests and verify RED**

Run:

```powershell
& 'D:\znwx-ai\.venv\Scripts\python.exe' -m unittest \
  tests.test_mabang_fulfillment_safety.MabangFulfillmentSafetyTests.test_sku_diagnostic_keeps_request_contract_and_json_field_names_only \
  tests.test_mabang_fulfillment_safety.MabangFulfillmentSafetyTests.test_html_body_is_never_preserved -v
```

Expected: import or name failure because `build_sku_change_diagnostic` does not exist.

- [ ] **Step 3: Implement the minimal allowlisted diagnostic builder**

Add a dedicated exception and pure helpers near the existing SKU response normalization:

```python
class SkuReplacementOperationError(Exception):
    def __init__(self, code, message, diagnostic):
        super().__init__(f'{code}: {message}')
        self.code = str(code)[:80]
        self.diagnostic = diagnostic

def build_sku_change_diagnostic(response, result, request_fields, *, body_kind='json', text_preview=''):
    data = result if isinstance(result, dict) else {}
    content_type = str(getattr(response, 'headers', {}).get('Content-Type', ''))[:80]
    field_names = sorted(str(key)[:80] for key in data.keys())[:30]
    normalized = normalize_sku_change_response(response, data)
    response_data = {
        'httpStatus': normalized['httpStatus'], 'contentType': content_type,
        'success': data.get('success') if isinstance(data.get('success'), (bool, int, float, str)) else None,
        'code': normalized['code'], 'message': normalized['message'],
        'fieldNames': field_names, 'bodyKind': body_kind,
        'bodyLength': len(str(getattr(response, 'text', '') or '')),
    }
    preview = re.sub(r'(?i)(token|password|cookie|authorization)\s*[:=]\s*\S+', r'\1=<REDACTED>', str(text_preview))
    if body_kind == 'non_json' and 'html' not in content_type.lower() and '<html' not in preview.lower():
        response_data['textPreview'] = re.sub(r'[\x00-\x1f\x7f]+', ' ', preview).strip()[:200]
    return {
        'version': 1, 'capturedAt': datetime.now(timezone.utc).isoformat(),
        'stage': 'mabang_response', 'endpoint': 'order.doChanegOrderItem',
        'request': {'fieldNames': ['orderItemId', 'stockId', 'type'],
                    **{key: str(request_fields.get(key, ''))[:80] for key in ('orderItemId', 'stockId', 'type')}},
        'response': response_data,
        'verification': {'beforeSku': '', 'targetSku': '', 'afterSku': '', 'result': ''},
    }
```

Import `datetime, timezone` and keep the helper independent of session state.

- [ ] **Step 4: Run the tests and verify GREEN**

Run the Step 2 command. Expected: both tests pass.

- [ ] **Step 5: Write failing exception and verification tests**

Add tests proving a rejected response carries the diagnostic and a timeout has no response:

```python
def test_rejection_exception_carries_request_response_and_original_readback(self):
    # Use the existing controlled client fixture and a 409 JSON response.
    with self.assertRaises(SkuReplacementOperationError) as raised:
        client.change_order_item_sku('ORDER', '477372993', 'OLD', 'NEW', 1, '仓/0', '2679193')
    diagnostic = raised.exception.diagnostic
    self.assertEqual(raised.exception.code, 'SKU_REPLACEMENT_REJECTED')
    self.assertEqual(diagnostic['request']['type'], '2')
    self.assertEqual(diagnostic['response']['httpStatus'], 409)
    self.assertEqual(diagnostic['verification'], {
        'beforeSku': 'OLD', 'targetSku': 'NEW', 'afterSku': 'OLD', 'result': 'original',
    })
    client.session.post.assert_called_once()

def test_timeout_diagnostic_has_no_response_and_is_manual_review(self):
    with self.assertRaises(SkuReplacementOperationError) as raised:
        client.change_order_item_sku('ORDER', '477372993', 'OLD', 'NEW', 1, '仓/0', '2679193')
    self.assertEqual(raised.exception.code, 'SKU_REPLACEMENT_VERIFY_FAILED')
    self.assertEqual(raised.exception.diagnostic['stage'], 'mabang_request_uncertain')
    self.assertEqual(raised.exception.diagnostic['response']['bodyKind'], 'no_response')
    client.session.post.assert_called_once()
```

- [ ] **Step 6: Run the behavior tests and verify RED**

Expected: current exceptions have no `diagnostic` attribute.

- [ ] **Step 7: Attach diagnostics without changing the request**

In `change_order_item_sku`, define the unchanged payload once:

```python
request_fields = {'orderItemId': current['itemId'], 'stockId': target['stockId'], 'type': '2'}
```

Pass exactly `request_fields` to `session.post`. Build a diagnostic after JSON, non-JSON, no-response, and read-back outcomes. Raise `SkuReplacementOperationError` for rejected or uncertain states, and include the diagnostic as `writeResponse` on success. Do not add loops or additional POST calls.

- [ ] **Step 8: Run the complete Python safety suite**

Run:

```powershell
& 'D:\znwx-ai\.venv\Scripts\python.exe' -m unittest tests.test_mabang_fulfillment_safety -v
```

Expected: all tests pass and every request-count assertion remains `1`.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- scripts/mabang_order_source.py tests/test_mabang_fulfillment_safety.py
git commit -m "feat: capture bounded Mabang SKU diagnostics"
```

---

### Task 2: Transport and validate diagnostics across the worker boundary

**Files:**
- Modify: `scripts/mabang_worker.py`
- Modify: `lib/mabang-worker-runner.mjs`
- Modify: `tests/mabang-worker-runner.test.mjs`

**Interfaces:**
- Python failure output: `{ ok: false, error: string, code?: string, diagnostic?: object }`.
- Produces: `normalizeMabangSkuDiagnostic(value) -> object | null` in `lib/mabang-worker-runner.mjs`.
- Produces: `workerResultError(result).diagnostic` only for a valid allowlisted diagnostic.

- [ ] **Step 1: Write failing worker transport tests**

Add tests with a complete literal diagnostic and a malicious object containing `password`, `headers`, and nested HTML. Assert the valid object survives and forbidden fields do not:

```js
const error = workerResultError({ ok: false, error: "SKU_REPLACEMENT_REJECTED: rejected",
  code: "SKU_REPLACEMENT_REJECTED", diagnostic: fixtureDiagnostic });
assert.deepEqual(error.diagnostic, fixtureDiagnostic);
assert.equal(error.code, "SKU_REPLACEMENT_REJECTED");

const unsafe = workerResultError({ ok: false, error: "failed", diagnostic: {
  ...fixtureDiagnostic, password: "secret", response: { ...fixtureDiagnostic.response, html: "<b>secret</b>" },
} });
assert.equal(JSON.stringify(unsafe.diagnostic).includes("secret"), false);
```

- [ ] **Step 2: Run and verify RED**

Run `node --test tests/mabang-worker-runner.test.mjs`.

Expected: `error.diagnostic` is undefined.

- [ ] **Step 3: Emit structured Python failures**

Change `mabang_worker.py` error serialization to:

```python
failure = {'ok': False, 'error': str(error)}
if getattr(error, 'code', None): failure['code'] = str(error.code)[:80]
if isinstance(getattr(error, 'diagnostic', None), dict): failure['diagnostic'] = json_safe(error.diagnostic)
print(json.dumps(failure, ensure_ascii=False), flush=True)
```

- [ ] **Step 4: Normalize diagnostics in the Node runner**

Implement an explicit object reconstruction that copies only the documented keys and scalar limits. `workerResultError` must prefer `result.code` when it matches `/^[A-Z][A-Z0-9_]{2,79}$/`, fall back to the existing message-prefix parser, and attach only the normalized diagnostic.

- [ ] **Step 5: Run worker tests and the Python safety suite**

Run:

```powershell
node --test tests/mabang-worker-runner.test.mjs
& 'D:\znwx-ai\.venv\Scripts\python.exe' -m unittest tests.test_mabang_fulfillment_safety -v
```

Expected: both pass.

- [ ] **Step 6: Commit Task 2**

```powershell
git add -- scripts/mabang_worker.py lib/mabang-worker-runner.mjs tests/mabang-worker-runner.test.mjs
git commit -m "feat: transport SKU diagnostics through worker"
```

---

### Task 3: Persist failures and expose HTTP 409 details

**Files:**
- Modify: `fulfillment-service/sku-replacement.mjs`
- Modify: `fulfillment-service/sku-replacement-batch.mjs`
- Create: `fulfillment-service/http-error.mjs`
- Modify: `fulfillment-service/server.mjs`
- Modify: `tests/sku-replacement.test.mjs`
- Create: `tests/fulfillment-http-error.test.mjs`

**Interfaces:**
- Failure record: `{ ...plan, executedAt, status, code, message, diagnostic }` in `executions/<planHash>.json`.
- Batch item adds `diagnostic: object | null`.
- Produces: `presentFulfillmentError(error) -> { status, body }` where non-500 details survive.
- HTTP 409 shape: `{ success: false, error: { code, message, details: { diagnostic } } }`.

- [ ] **Step 1: Write failing service persistence tests**

Make the fake `order-sku-change` worker throw an error with a literal diagnostic. Assert `service.execute` rejects and the execution JSON exists:

```js
await assert.rejects(service.execute({ planHash: plan.planHash, approvalText: plan.approvalText }),
  (error) => error.code === "SKU_REPLACEMENT_REJECTED" && error.diagnostic.response.httpStatus === 409);
const saved = JSON.parse(readFileSync(path.join(rootDir, "storage", "sku-replacements", "executions", `${plan.planHash}.json`), "utf8"));
assert.equal(saved.status, "FAILED");
assert.equal(saved.code, "SKU_REPLACEMENT_REJECTED");
assert.equal(saved.diagnostic.request.type, "2");
```

Extend the batch test to assert `completed.items[0].diagnostic` equals the normalized fixture after reload from disk.

- [ ] **Step 2: Run and verify RED**

Run `node --test tests/sku-replacement.test.mjs`.

Expected: no failure execution file and no batch diagnostic.

- [ ] **Step 3: Persist single and batch diagnostics**

Wrap the inventory recheck and worker call in `SkuReplacementService.execute`. On catch, derive `status` as `MANUAL_REVIEW` for `VERIFY_FAILED`, otherwise `FAILED`; write the failure record, then rethrow the same error. In `SkuReplacementBatchService`, assign `item.diagnostic = error.diagnostic || null` before persisting.

- [ ] **Step 4: Write failing HTTP error presentation tests**

Create `tests/fulfillment-http-error.test.mjs`:

```js
test("a non-500 SKU error exposes only normalized diagnostic details", () => {
  const error = Object.assign(new Error("马帮拒绝"), {
    status: 409, code: "SKU_REPLACEMENT_REJECTED", details: { diagnostic: fixtureDiagnostic },
  });
  assert.deepEqual(presentFulfillmentError(error), {
    status: 409,
    body: { success: false, error: { code: "SKU_REPLACEMENT_REJECTED", message: "马帮拒绝",
      details: { diagnostic: fixtureDiagnostic } } },
  });
});

test("a 500 error never exposes details", () => {
  const result = presentFulfillmentError(Object.assign(new Error("secret"), { diagnostic: fixtureDiagnostic }));
  assert.deepEqual(result, { status: 500, body: { success: false,
    error: { code: "INTERNAL_ERROR", message: "服务内部错误" } } });
});
```

- [ ] **Step 5: Implement and use the HTTP presenter**

Create `fulfillment-service/http-error.mjs` with `presentFulfillmentError`. Refactor the outer server catch to call it. In the SKU execute route, wrap an error diagnostic as:

```js
throw new FulfillmentError(error.code || "SKU_REPLACEMENT_EXECUTE_FAILED",
  error.message || "替换 SKU 执行失败", 409,
  error.diagnostic ? { diagnostic: error.diagnostic } : undefined);
```

- [ ] **Step 6: Run service and HTTP tests**

Run:

```powershell
node --test tests/sku-replacement.test.mjs tests/fulfillment-http-error.test.mjs
```

Expected: pass.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- fulfillment-service/sku-replacement.mjs fulfillment-service/sku-replacement-batch.mjs \
  fulfillment-service/http-error.mjs fulfillment-service/server.mjs tests/sku-replacement.test.mjs tests/fulfillment-http-error.test.mjs
git commit -m "feat: persist SKU failure diagnostics"
```

---

### Task 4: Render diagnostic details in the Vue workbench

**Files:**
- Modify: `frontend/commerce-ops-vue/src/services/api.ts`
- Modify: `frontend/commerce-ops-vue/src/services/warehouse-transfer.ts`
- Modify: `frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts`
- Modify: `frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue`
- Modify: `frontend/commerce-ops-vue/src/styles/warehouse-transfer.css`
- Modify: `tests/sku-replacement-selection.test.mjs`

**Interfaces:**
- `ApiError` adds `code: string` and `details: unknown` while preserving `message` and `status`.
- `SkuReplacementDiagnostic` mirrors the documented allowlisted object.
- Produces: `diagnosticRows(diagnostic) -> Array<{ label: string; value: string }>`.
- Produces: `taskItemFor(orderReference, itemId, task) -> SkuReplacementBatchTaskItem | null`.

- [ ] **Step 1: Write failing pure presentation tests**

Add tests that hand a literal diagnostic to `diagnosticRows` and assert exact safe rows:

```js
assert.deepEqual(diagnosticRows(fixtureDiagnostic), [
  { label: "阶段", value: "mabang_response" },
  { label: "HTTP", value: "409" },
  { label: "请求字段", value: "orderItemId=477372993 · stockId=2679193 · type=2" },
  { label: "业务码", value: "FIELD_INVALID" },
  { label: "马帮信息", value: "type 字段无效" },
  { label: "返回字段", value: "code · message · success" },
  { label: "回读", value: "OLD → NEW，最终 OLD（original）" },
]);
```

Assert empty values are omitted and `taskItemFor` matches the exact order/item pair.

- [ ] **Step 2: Run and verify RED**

Run `node --test tests/sku-replacement-selection.test.mjs`.

Expected: missing exports.

- [ ] **Step 3: Implement types and pure helpers**

Add the exact `SkuReplacementDiagnostic` interface and optional `diagnostic` on batch task items. Extend `ApiError` to retain the server error `code` and `details`. Implement the two pure helpers with string coercion and no HTML generation.

- [ ] **Step 4: Render an expandable diagnostic block**

For each shortage item, locate its task item. When status is `FAILED` or `MANUAL_REVIEW`, show code/message and a native `<details>` only when diagnostic rows exist:

```vue
<details v-if="diagnosticRows(taskItem.diagnostic).length" class="sku-diagnostic">
  <summary>查看接口诊断</summary>
  <dl><template v-for="row in diagnosticRows(taskItem.diagnostic)" :key="row.label">
    <dt>{{ row.label }}</dt><dd>{{ row.value }}</dd>
  </template></dl>
</details>
```

Use Vue text bindings only. Add compact responsive styles without `v-html`.

- [ ] **Step 5: Run frontend tests, type check, and production build**

Run:

```powershell
node --test tests/sku-replacement-selection.test.mjs
npm.cmd --prefix frontend/commerce-ops-vue run check
npm.cmd --prefix frontend/commerce-ops-vue run build
```

Expected: all pass.

- [ ] **Step 6: Commit Task 4**

```powershell
git add -- frontend/commerce-ops-vue/src/services/api.ts frontend/commerce-ops-vue/src/services/warehouse-transfer.ts \
  frontend/commerce-ops-vue/src/services/sku-replacement-selection.ts frontend/commerce-ops-vue/src/pages/WarehouseTransferPage.vue \
  frontend/commerce-ops-vue/src/styles/warehouse-transfer.css tests/sku-replacement-selection.test.mjs
git commit -m "feat: show SKU interface diagnostics"
```

---

### Task 5: Verify and deploy recording without a live SKU write

**Files:**
- No new source files.

**Interfaces:**
- Consumes the tested commits from Tasks 1-4.
- Produces a healthy 3112 service and updated Vue build.

- [ ] **Step 1: Run all test suites**

Run:

```powershell
& 'D:\znwx-ai\.venv\Scripts\python.exe' -m unittest tests.test_mabang_fulfillment_safety -v
$env:PYTHON_EXECUTABLE='D:\znwx-ai\.venv\Scripts\python.exe'
npm.cmd test
npm.cmd run build
```

Expected: zero failures.

- [ ] **Step 2: Apply tested commits to the active application branch**

Use normal merge or cherry-pick without overwriting unrelated working-tree changes. Confirm the target files are clean before applying.

- [ ] **Step 3: Restart fulfillment safely and verify health**

Run:

```powershell
npm.cmd run restart:fulfillment:safe
Invoke-RestMethod -Uri 'http://127.0.0.1:3112/health' -TimeoutSec 15
```

Expected: `success=true`, `draining=false`, and `activeOperations=0`.

- [ ] **Step 4: Stop before any real write**

Report that diagnostic recording is deployed. Ask for a new explicit confirmation before creating and executing a live SKU plan. Do not reuse the expired plan or the previous failed execution request.

