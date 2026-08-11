# Mabang SKU Change Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one backend Mabang SKU change observable and verifiable, then safely test `20213797082782605624288044` changing item `477372993` from `T5AA3413198` to `T3AA1673198` exactly once.

**Architecture:** Keep the existing Mabang internal endpoint, but normalize only bounded non-secret response fields and treat the post-write order read as the source of truth. Propagate structured worker error codes so uncertain writes become manual review rather than ordinary failures. The live canary is a separate final task and runs only after all automated tests pass.

**Tech Stack:** Python 3 `unittest`, `requests`, Node.js test runner, existing Mabang worker and fulfillment service.

## Global Constraints

- The only live order in scope is `20213797082782605624288044`, item `477372993`.
- The only permitted live change is `T5AA3413198` to `T3AA1673198`.
- Send at most one live SKU-change request. Never retry automatically.
- Do not fall back to the full order-edit form and do not operate the other three orders.
- Only a read-back of `T3AA1673198` is success.
- A timeout, unreadable response, missing item, or third SKU is manual review.
- Never persist or print cookies, request headers, credentials, or full response HTML.

---

### Task 1: Normalize the Mabang response and always verify the order

**Files:**
- Modify: `scripts/mabang_order_source.py:247-266,896-931`
- Modify: `tests/test_mabang_fulfillment_safety.py:1-17,450-463`

**Interfaces:**
- Produces: `normalize_sku_change_response(response, result) -> dict` with `confirmed`, `httpStatus`, `code`, and `message`.
- Produces: `MabangClient.change_order_item_sku(...) -> dict` with `changed`, `stockId`, `before`, `after`, and `writeResponse` when read-back reaches the target.
- Errors: `SKU_REPLACEMENT_REJECTED` only when a parsed rejection is followed by read-back of the original SKU; `SKU_REPLACEMENT_VERIFY_FAILED` for every uncertain state.

- [ ] **Step 1: Write failing response-normalization tests**

Add imports and literal assertions to `tests/test_mabang_fulfillment_safety.py`:

```python
from scripts.mabang_order_source import normalize_sku_change_response

class FakeResponse:
    def __init__(self, url='', text='', status_code=200):
        self.url = url
        self.text = text
        self.status_code = status_code

def test_sku_change_response_keeps_only_bounded_diagnostics(self):
    response = FakeResponse(status_code=409)
    result = normalize_sku_change_response(response, {
        'success': False,
        'code': 'ORDER_ITEM_LOCKED',
        'message': '订单商品已锁定',
        'html': '<input name="password" value="secret">',
    })
    self.assertEqual(result, {
        'confirmed': False,
        'httpStatus': 409,
        'code': 'ORDER_ITEM_LOCKED',
        'message': '订单商品已锁定',
    })

def test_sku_change_response_accepts_known_success_values(self):
    for value in (True, 1, '1'):
        self.assertTrue(normalize_sku_change_response(
            FakeResponse(status_code=200), {'success': value, 'message': '修改成功'}
        )['confirmed'])
```

- [ ] **Step 2: Run the normalization tests and verify RED**

Run:

```powershell
python -m unittest tests.test_mabang_fulfillment_safety.MabangFulfillmentSafetyTests.test_sku_change_response_keeps_only_bounded_diagnostics tests.test_mabang_fulfillment_safety.MabangFulfillmentSafetyTests.test_sku_change_response_accepts_known_success_values -v
```

Expected: import failure because `normalize_sku_change_response` does not exist.

- [ ] **Step 3: Implement minimal bounded normalization**

Add a pure function near `safe_json` in `scripts/mabang_order_source.py`:

```python
def normalize_sku_change_response(response, result):
    result = result if isinstance(result, dict) else {}
    success = result.get('success')
    raw_code = result.get('code') or result.get('errorCode') or result.get('status') or ''
    code = str(raw_code).strip()[:80] if isinstance(raw_code, (str, int, float, bool)) else ''
    raw_message = result.get('message') or result.get('msg') or result.get('error') or ''
    message = re.sub(r'[\x00-\x1f\x7f]+', ' ', raw_message if isinstance(raw_message, str) else '').strip()[:300]
    status = getattr(response, 'status_code', None)
    return {
        'confirmed': success is True or success == 1 or success == '1',
        'httpStatus': int(status) if isinstance(status, int) else None,
        'code': code,
        'message': message,
    }
```

- [ ] **Step 4: Run normalization tests and verify GREEN**

Run the Step 2 command. Expected: both tests pass.

- [ ] **Step 5: Write failing write/read-back behavior tests**

Create controlled `MabangClient` instances in `tests/test_mabang_fulfillment_safety.py`. Mock only network/order lookup boundaries, with complete item fields used by production:

```python
def sku_form(stock_sku):
    return {
        'trackNumber': '',
        'items': [{
            'itemId': '477372993', 'stockSku': stock_sku, 'quantity': 1,
            'stockWarehouseName': '印尼KSB-A仓-1308/3', 'isCombo': False,
            'title': '5E-60*28学习桌不带脚踏白柳色矮款',
        }],
    }

def test_rejected_response_is_success_only_when_readback_is_target(self):
    client = MabangClient()
    client.read_order_warehouse_form = MagicMock(side_effect=[sku_form('T5AA3413198'), sku_form('T3AA1673198')])
    client.resolve_stock_sku = MagicMock(return_value={'stockId': 'target-1', 'stockSku': 'T3AA1673198'})
    response = MagicMock(status_code=200, url='https://example.test/change', text='{"success":false}')
    response.json.return_value = {'success': False, 'code': 'LEGACY_SCHEMA', 'message': '未返回成功标记'}
    client.session.post = MagicMock(return_value=response)
    changed = client.change_order_item_sku(
        '20213797082782605624288044', '477372993', 'T5AA3413198', 'T3AA1673198', 1,
        '印尼KSB-A仓-1308/3', 'target-1')
    self.assertTrue(changed['changed'])
    self.assertEqual(changed['after']['stockSku'], 'T3AA1673198')
    client.session.post.assert_called_once()

def test_rejected_response_with_original_readback_reports_business_rejection(self):
    client = MabangClient()
    client.read_order_warehouse_form = MagicMock(side_effect=[sku_form('T5AA3413198'), sku_form('T5AA3413198')])
    client.resolve_stock_sku = MagicMock(return_value={'stockId': 'target-1', 'stockSku': 'T3AA1673198'})
    response = MagicMock(status_code=409, url='https://example.test/change', text='{"success":false}')
    response.json.return_value = {'success': False, 'code': 'ORDER_ITEM_LOCKED', 'message': '订单商品已锁定'}
    client.session.post = MagicMock(return_value=response)
    with self.assertRaisesRegex(Exception, 'SKU_REPLACEMENT_REJECTED.*ORDER_ITEM_LOCKED.*订单商品已锁定'):
        client.change_order_item_sku(
            '20213797082782605624288044', '477372993', 'T5AA3413198', 'T3AA1673198', 1,
            '印尼KSB-A仓-1308/3', 'target-1')
    client.session.post.assert_called_once()

def test_timeout_with_original_readback_requires_manual_review(self):
    client = MabangClient()
    client.read_order_warehouse_form = MagicMock(side_effect=[sku_form('T5AA3413198'), sku_form('T5AA3413198')])
    client.resolve_stock_sku = MagicMock(return_value={'stockId': 'target-1', 'stockSku': 'T3AA1673198'})
    client.session.post = MagicMock(side_effect=TimeoutError('timed out'))
    with self.assertRaisesRegex(Exception, 'SKU_REPLACEMENT_VERIFY_FAILED'):
        client.change_order_item_sku(
            '20213797082782605624288044', '477372993', 'T5AA3413198', 'T3AA1673198', 1,
            '印尼KSB-A仓-1308/3', 'target-1')
    client.session.post.assert_called_once()
```

- [ ] **Step 6: Run behavior tests and verify RED**

Run the three named tests with `python -m unittest ... -v`.

Expected: the first test raises `SKU_REPLACEMENT_REJECTED` before read-back; the rejection lacks bounded Mabang details; timeout exits without verification.

- [ ] **Step 7: Implement write-once and read-back-as-truth**

Refactor `change_order_item_sku` after target resolution:

```python
diagnostic = {'confirmed': False, 'httpStatus': None, 'code': '', 'message': ''}
request_uncertain = False
try:
    response = self.session.post(...)
    result = safe_json(response)
    diagnostic = normalize_sku_change_response(response, result)
    if response_looks_unauthenticated(response, result):
        request_uncertain = True
        diagnostic['code'] = 'MABANG_AUTH_EXPIRED_DURING_SKU_CHANGE'
except Exception as error:
    request_uncertain = True
    diagnostic['code'] = type(error).__name__[:80]
    diagnostic['message'] = '马帮写入请求未正常完成'

verified = self.read_order_warehouse_form(order_reference)
after = next((item for item in verified['items'] if item['itemId'] == current['itemId']), None)
if after and after['stockSku'].strip().upper() == str(replacement_sku).strip().upper():
    return {'changed': True, 'stockId': target['stockId'], 'before': current, 'after': after,
            'writeResponse': diagnostic}
if request_uncertain or diagnostic['confirmed'] or not after or after['stockSku'].strip().upper() != str(original_sku).strip().upper():
    raise Exception('SKU_REPLACEMENT_VERIFY_FAILED: 写入结果无法确认，请在马帮人工核对，禁止重试。')
details = ' / '.join(value for value in (diagnostic['code'], diagnostic['message']) if value)
raise Exception(f'SKU_REPLACEMENT_REJECTED: 马帮拒绝 SKU 更换。{details[:300]}')
```

Keep the existing pre-write checks and exact request payload unchanged. Do not add a retry loop.

- [ ] **Step 8: Run targeted Python tests and the full safety file**

Run:

```powershell
python -m unittest tests.test_mabang_fulfillment_safety -v
```

Expected: all tests pass with no secret-bearing diagnostics.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- scripts/mabang_order_source.py tests/test_mabang_fulfillment_safety.py
git commit -m "fix: verify Mabang SKU writes by readback"
```

---

### Task 2: Preserve uncertain worker error codes for manual review

**Files:**
- Modify: `lib/mabang-worker-runner.mjs:1-63`
- Create: `tests/mabang-worker-runner.test.mjs`
- Modify: `tests/sku-replacement.test.mjs:158-188`

**Interfaces:**
- Produces: `workerResultError(result) -> Error`, extracting only a leading uppercase error code from `result.error`.
- Consumes: Python worker output `{ ok: false, error: "SKU_REPLACEMENT_VERIFY_FAILED: ..." }`.
- Produces: `error.code === "SKU_REPLACEMENT_VERIFY_FAILED"`, allowing the batch service to persist `MANUAL_REVIEW`.

- [ ] **Step 1: Write failing worker error parsing tests**

Create `tests/mabang-worker-runner.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { workerResultError } from "../lib/mabang-worker-runner.mjs";

test("preserves a bounded leading worker safety code", () => {
  const error = workerResultError({ ok: false, error: "SKU_REPLACEMENT_VERIFY_FAILED: 写入结果无法确认" });
  assert.equal(error.code, "SKU_REPLACEMENT_VERIFY_FAILED");
  assert.equal(error.message, "SKU_REPLACEMENT_VERIFY_FAILED: 写入结果无法确认");
});

test("does not promote arbitrary response text to an error code", () => {
  const error = workerResultError({ ok: false, error: "https://example.test failed" });
  assert.equal(error.code, undefined);
  assert.equal(error.message, "https://example.test failed");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```powershell
node --test tests/mabang-worker-runner.test.mjs
```

Expected: import failure because `workerResultError` does not exist.

- [ ] **Step 3: Implement bounded worker error conversion**

Add to `lib/mabang-worker-runner.mjs`:

```js
export function workerResultError(result) {
  const message = String(result?.error || "马帮采集失败，请检查账号、密码和网络。").slice(0, 1000);
  const error = new Error(message);
  const matched = message.match(/^([A-Z][A-Z0-9_]{2,79}):/);
  if (matched) error.code = matched[1];
  return error;
}
```

Replace `reject(new Error(result.error || ...))` with `reject(workerResultError(result))`.

- [ ] **Step 4: Run worker tests and verify GREEN**

Run the Step 2 command. Expected: both tests pass.

- [ ] **Step 5: Add a failing batch manual-review regression test**

Append to `tests/sku-replacement.test.mjs`:

```js
test("an uncertain SKU write is persisted as manual review and is not retried", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "sku-replacement-uncertain-"));
  let writes = 0;
  const single = {
    createPlan: async (selection) => batchPlanRecord(selection, 1),
    restorePlan() {},
    execute: async () => {
      writes += 1;
      throw Object.assign(new Error("写入结果无法确认"), { code: "SKU_REPLACEMENT_VERIFY_FAILED" });
    },
  };
  const service = new SkuReplacementBatchService({ rootDir, skuReplacementService: single,
    now: () => new Date("2026-08-11T04:00:00.000Z"), randomUUID: () => "task-uncertain" });
  const plan = await service.createPlan({ selections: [
    { orderReference: "ORDER_10001", itemId: "1", replacementSku: "SKU-A" },
  ] });
  const task = service.createExecution({ batchHash: plan.batchHash, approvalText: plan.approvalText });
  await service.runExecution(task.taskId);
  const completed = service.getExecution(task.taskId);
  assert.equal(writes, 1);
  assert.equal(completed.items[0].status, "MANUAL_REVIEW");
  assert.equal(completed.items[0].code, "SKU_REPLACEMENT_VERIFY_FAILED");
});
```

- [ ] **Step 6: Run the regression test and confirm whether it is already GREEN**

Run:

```powershell
node --test --test-name-pattern="uncertain SKU write" tests/sku-replacement.test.mjs
```

Expected: pass because the batch service already classifies a preserved `VERIFY_FAILED` code. This is a characterization test for the worker-code boundary added in Step 3, not the RED test for that production change.

- [ ] **Step 7: Run all automated tests**

Run:

```powershell
python -m unittest tests.test_mabang_fulfillment_safety -v
npm test
```

Expected: both suites pass.

- [ ] **Step 8: Commit Task 2**

```powershell
git add -- lib/mabang-worker-runner.mjs tests/mabang-worker-runner.test.mjs tests/sku-replacement.test.mjs
git commit -m "fix: preserve uncertain Mabang worker outcomes"
```

---

### Task 3: Execute the approved live canary exactly once

**Files:**
- No production files.
- Read/write evidence: existing `storage/sku-replacements/` execution records.

**Interfaces:**
- Consumes: fulfillment service endpoints `POST /api/fulfillment/sku-replacements/plan` and `POST /api/fulfillment/sku-replacements/execute`.
- Produces: one persisted execution result plus a final read-only SKU observation.

- [ ] **Step 1: Restart the fulfillment service safely and verify health**

Run:

```powershell
npm run restart:fulfillment:safe
Invoke-RestMethod -Uri 'http://127.0.0.1:3112/health' -TimeoutSec 15
```

Expected: service health is successful. If restart or health fails, stop without creating a plan.

- [ ] **Step 2: Create a fresh plan and assert the immutable canary fields**

Run a PowerShell block that POSTs this exact payload once to the plan endpoint:

```json
{
  "orderReference": "20213797082782605624288044",
  "itemId": "477372993",
  "replacementSku": "T3AA1673198"
}
```

Before any execute request, assert the returned plan contains:

```text
order.platformOrderId = 20213797082782605624288044
item.itemId = 477372993
item.originalSku = T5AA3413198
replacement.sku = T3AA1673198
item.quantity = 1
order.orderStatus = 2
```

Also assert the fresh order has no tracking number through the existing read-only inspection. If any assertion fails, stop without executing.

- [ ] **Step 3: Send one execute request**

POST exactly once to `/api/fulfillment/sku-replacements/execute` using only the returned `planHash` and exact `approvalText`. Do not wrap the request in a retry, loop, recovery action, or batch call.

Expected outcomes:

- HTTP success with `result.after.stockSku = T3AA1673198`; or
- a structured rejection containing the bounded Mabang code/message; or
- `SKU_REPLACEMENT_VERIFY_FAILED`, which requires immediate stop and manual review.

- [ ] **Step 4: Perform an independent read-only final check**

POST the single order reference to `/api/fulfillment/sku-replacements/batch-preview` and inspect item `477372993`.

Expected success: `originalSku` is `T3AA1673198`.

Expected confirmed rejection: `originalSku` remains `T5AA3413198` and the execute result was a parsed business rejection.

Any other combination: report manual review; do not send another write.

- [ ] **Step 5: Report evidence and stop**

Report:

```text
Order: 20213797082782605624288044
Item: 477372993
Before: T5AA3413198
Target: T3AA1673198
Write requests sent: 1
HTTP/response code: the actual bounded code, or `none`
Mabang message: the actual bounded non-secret message, or `none`
Final read-back SKU: the actual SKU returned by the independent check
Verdict: SUCCESS | REJECTED | MANUAL_REVIEW
```

Do not retry regardless of verdict.
