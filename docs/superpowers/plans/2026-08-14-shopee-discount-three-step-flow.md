# Shopee Discount Three-Step Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the existing Shopee discount-control page into a clear three-step guided flow without changing pricing, approval, execution, or backend behavior.

**Architecture:** Add a small framework-independent step-flow controller beside the existing request guards, then bind the current Vue page to it. Keep all existing API calls and safety gates intact; restructure only the page hierarchy, progressive disclosure, state transitions, and responsive presentation.

**Tech Stack:** Vue 3 Composition API, TypeScript, Element Plus, existing `@lucide/vue` icons, Node test runner, Vite.

## Global Constraints

- Preserve all existing pricing, SKU matching, rounding, 1% off, approval, execution, and write-security semantics.
- Do not add dependencies or backend routes.
- Keep exactly one visually primary action in each main step.
- Any input that changes the preview request must invalidate the preview, confirmation, and execution eligibility through the existing request-generation guard.
- Desktop and mobile layouts must both expose the current step and the reason a next action is unavailable.

---

### Task 1: Add a deterministic three-step flow controller

**Files:**
- Modify: `frontend/commerce-ops-vue/src/services/shopee-discount.ts:237-320`
- Test: `tests/shopee-discount-frontend-contract.test.mjs`

**Interfaces:**
- Consumes: existing `DiscountPageFlowController` and page state flags.
- Produces: `DiscountWizardStep = 1 | 2 | 3` and `DiscountWizardController` with `currentStep`, `goTo`, `advanceFromScope`, `previewStarted`, `previewSucceeded`, `previewFailed`, `planInvalidated`, and `restoreExecution`.

- [ ] **Step 1: Write failing controller tests**

Add executable tests that import the production client module and assert:

```js
const wizard = new DiscountWizardController();
assert.equal(wizard.currentStep, 1);
assert.equal(wizard.goTo(3, { scopeValid: true, hasPreview: false }), false);
assert.equal(wizard.advanceFromScope({ scopeValid: true }), true);
assert.equal(wizard.currentStep, 2);
wizard.previewStarted();
assert.equal(wizard.currentStep, 2);
wizard.previewSucceeded();
assert.equal(wizard.currentStep, 3);
wizard.planInvalidated();
assert.equal(wizard.currentStep, 2);
wizard.restoreExecution();
assert.equal(wizard.currentStep, 3);
```

Also assert that an invalid scope cannot leave step 1 and that a preview failure remains on step 2.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```powershell
node --test tests/shopee-discount-frontend-contract.test.mjs
```

Expected: failure because `DiscountWizardController` is not exported.

- [ ] **Step 3: Implement the minimal controller**

Add a state-only class with no Vue dependency:

```ts
export type DiscountWizardStep = 1 | 2 | 3;

export class DiscountWizardController {
  currentStep: DiscountWizardStep = 1;

  goTo(step: DiscountWizardStep, state: { scopeValid: boolean; hasPreview: boolean }) {
    if (step === 1 || (step === 2 && state.scopeValid) || (step === 3 && state.hasPreview)) {
      this.currentStep = step;
      return true;
    }
    return false;
  }

  advanceFromScope(state: { scopeValid: boolean }) {
    if (!state.scopeValid) return false;
    this.currentStep = 2;
    return true;
  }

  previewStarted() { this.currentStep = 2; }
  previewSucceeded() { this.currentStep = 3; }
  previewFailed() { this.currentStep = 2; }
  planInvalidated() { if (this.currentStep === 3) this.currentStep = 2; }
  restoreExecution() { this.currentStep = 3; }
}
```

- [ ] **Step 4: Run the focused test and observe GREEN**

Run the same test command. Expected: all frontend contract tests pass.

- [ ] **Step 5: Commit the controller slice**

```powershell
git add frontend/commerce-ops-vue/src/services/shopee-discount.ts tests/shopee-discount-frontend-contract.test.mjs
git commit -m "feat: model discount wizard steps"
```

---

### Task 2: Restructure the page into three visible steps

**Files:**
- Modify: `frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue:1-780`
- Test: `tests/shopee-discount-frontend-contract.test.mjs`

**Interfaces:**
- Consumes: `DiscountWizardController`, existing computed validation, override arrays, preview data, and request guards.
- Produces: a single-page stepper with `activeStep`, `openStep(step)`, `continueToOverrides()`, and semantic step sections.

- [ ] **Step 1: Add failing page-contract assertions**

Assert the production SFC contains the exact user-facing hierarchy:

```js
for (const text of [
  "第 1 步", "选择任务与范围",
  "第 2 步", "配置例外并生成预览",
  "第 3 步", "人工确认并执行",
  "新建或续期折扣活动", "修正现有折扣活动",
  "例外与高级设置", "运行与异常",
]) assert.ok(page.includes(text), `missing ${text}`);
```

Assert that the template wires `continueToOverrides`, `openStep`, `activeStep`, and an Element Plus step indicator.

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```powershell
node --test tests/shopee-discount-frontend-contract.test.mjs
```

Expected: failure on the new step labels and bindings.

- [ ] **Step 3: Bind wizard state in script setup**

Import `DiscountWizardController`, instantiate it once, mirror its value through `activeStep`, and implement:

```ts
function syncWizardStep() { activeStep.value = wizard.currentStep; }
function openStep(step: DiscountWizardStep) {
  wizard.goTo(step, { scopeValid: scopeValid.value, hasPreview: Boolean(preview.value) });
  syncWizardStep();
}
function continueToOverrides() {
  if (!wizard.advanceFromScope({ scopeValid: scopeValid.value })) return;
  syncWizardStep();
  nextTick(() => stepTwoSection.value?.focus());
}
```

Keep the existing `DiscountPageFlowController` responsible for asynchronous ownership; the wizard controls navigation only.

- [ ] **Step 4: Rebuild the template hierarchy**

Add a sticky or prominent `el-steps` header and three semantic `section` elements:

```vue
<el-steps :active="activeStep - 1" finish-status="success" align-center>
  <el-step title="选择任务与范围" description="确定店铺、任务和默认价格" />
  <el-step title="配置例外并生成预览" description="按需覆盖并检查价格" />
  <el-step title="人工确认并执行" description="复核差异后提交执行" />
</el-steps>
```

Step 1 contains scope and workflow fields plus one primary `下一步：配置例外` button. Rename workflow labels only; retain enum values.

Step 2 begins with a plain-language default-rule summary. Wrap shop, link, activity, and CSV controls in one `el-collapse` item titled `例外与高级设置`, showing configured counts. Keep `生成价格预览` as the only primary action.

Step 3 contains preview summary, table, operator confirmation, and execution action. When there is no preview, show a button returning to step 2 instead of an executable-looking empty panel.

Move settings into a collapsed secondary panel and move execution/history/UNKNOWN/renewal tabs under a separate `运行与异常` heading below the main flow.

- [ ] **Step 5: Add focused responsive styles**

Use existing page variables and Element Plus components. Add styles for `.wizard-shell`, `.wizard-steps`, `.wizard-step`, `.wizard-step--active`, `.step-actions`, `.default-rule-summary`, and `.operations-section`. At the existing mobile breakpoint, switch the step header to a compact vertical layout and keep actions full-width. Do not add fonts, packages, gradients, or decorative imagery.

- [ ] **Step 6: Run contract and type checks**

Run:

```powershell
node --test tests/shopee-discount-frontend-contract.test.mjs
Set-Location frontend/commerce-ops-vue
npm.cmd run check
```

Expected: contract tests and Vue/TypeScript checks pass.

- [ ] **Step 7: Commit the structural slice**

```powershell
git add frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue tests/shopee-discount-frontend-contract.test.mjs
git commit -m "feat: guide discount setup in three steps"
```

---

### Task 3: Connect preview, invalidation, restoration, and inline guidance

**Files:**
- Modify: `frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue:150-570`
- Modify: `frontend/commerce-ops-vue/src/services/shopee-discount.ts`
- Test: `tests/shopee-discount-frontend-contract.test.mjs`

**Interfaces:**
- Consumes: wizard controller from Task 1 and existing async request tickets.
- Produces: correct navigation for preview success/failure, plan invalidation, execution restore, and visible disabled-action explanations.

- [ ] **Step 1: Add failing interaction tests**

Add controller tests covering these sequences:

```js
wizard.advanceFromScope({ scopeValid: true });
wizard.previewStarted();
wizard.previewFailed();
assert.equal(wizard.currentStep, 2);
wizard.previewSucceeded();
assert.equal(wizard.currentStep, 3);
wizard.planInvalidated();
assert.equal(wizard.currentStep, 2);
wizard.restoreExecution();
assert.equal(wizard.currentStep, 3);
```

Add SFC contract assertions that `generatePreview` calls `previewStarted`, commits `previewSucceeded` only for the current request ticket, calls `previewFailed` only for the current request, `resetPlan` calls `planInvalidated`, and `restorePlan` calls `restoreExecution` only after the restored plan is accepted.

- [ ] **Step 2: Run focused tests and observe RED**

Run the frontend contract suite. Expected: page-wiring assertions fail.

- [ ] **Step 3: Wire lifecycle transitions without weakening guards**

At preview start, keep step 2 active. After the existing request guard accepts the response, move to step 3 and focus its heading. On a current-request error, remain on step 2 and display `errorMessage` inline. Stale success, error, and `finally` branches must not change steps.

In `resetPlan`, call `wizard.planInvalidated()` after the existing request invalidation. In `restorePlan`, call `wizard.restoreExecution()` only after `loadDiscountPreview` and items are committed by the current restore ticket.

- [ ] **Step 4: Add explicit blocked-action copy**

Under step 1's next button show the missing scope reason. Under step 2's preview button reuse `previewBlockedReason`. Under step 3's approval and execution controls retain the existing exact-confirmation and gate reason messages. Do not introduce generic “操作失败” copy when a known reason code exists.

- [ ] **Step 5: Run focused tests and type checks**

Run:

```powershell
node --test tests/shopee-discount-frontend-contract.test.mjs
Set-Location frontend/commerce-ops-vue
npm.cmd run check
```

Expected: all pass.

- [ ] **Step 6: Commit the behavior slice**

```powershell
git add frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue frontend/commerce-ops-vue/src/services/shopee-discount.ts tests/shopee-discount-frontend-contract.test.mjs
git commit -m "fix: keep discount wizard state trustworthy"
```

---

### Task 4: Verify the completed flow at production quality

**Files:**
- Modify if required by discovered regressions: `frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue`
- Modify if required by discovered regressions: `tests/shopee-discount-frontend-contract.test.mjs`

**Interfaces:**
- Consumes: completed three-step page.
- Produces: verified desktop/mobile UI with no backend or execution regression.

- [ ] **Step 1: Run the Shopee frontend and API regressions**

```powershell
node --test tests/shopee-discount-frontend-contract.test.mjs tests/shopee-discount-api.test.mjs tests/shopee-discount-service.test.mjs tests/shopee-discount-executor.test.mjs
```

Expected: zero failures.

- [ ] **Step 2: Run Vue production verification**

```powershell
Set-Location frontend/commerce-ops-vue
npm.cmd run check
npm.cmd run build
```

Expected: type check and Vite build exit 0; the existing large-chunk warning is acceptable.

- [ ] **Step 3: Perform browser checks**

Using the local Commerce Ops frontend and fake/read-only data paths, verify at approximately 1280×900 and 390×844:

- Step 1 names the two workflows clearly and exposes one primary next action.
- Step 2 keeps advanced overrides collapsed by default and shows their configured count.
- Preview success moves to step 3; preview failure remains in step 2 with an inline reason.
- Changing country, shop, workflow, tier, renewal time, or overrides removes the old preview and confirmation.
- A restored running plan opens step 3.
- The page has no horizontal overflow, clipped controls, dead buttons, or console errors.

- [ ] **Step 4: Review and commit only scoped fixes**

```powershell
git diff --check -- frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue frontend/commerce-ops-vue/src/services/shopee-discount.ts tests/shopee-discount-frontend-contract.test.mjs
git add frontend/commerce-ops-vue/src/pages/ShopeeDiscountPage.vue frontend/commerce-ops-vue/src/services/shopee-discount.ts tests/shopee-discount-frontend-contract.test.mjs
git commit -m "test: verify discount three-step workflow"
```

Do not stage existing unrelated workspace changes or generated `public/vue-preview` assets.
