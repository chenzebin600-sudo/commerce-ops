import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_BATCH_ITEMS = 100;
const BATCH_PLAN_TTL_MS = 10 * 60 * 1000;

function text(value) { return String(value ?? "").trim(); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }

function normalizedSelection(raw) {
  const selection = { orderReference: text(raw?.orderReference), itemId: text(raw?.itemId),
    replacementSku: text(raw?.replacementSku).toUpperCase().replace(/\s+/g, "") };
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(selection.orderReference) || !/^\d{1,40}$/.test(selection.itemId)
      || !selection.replacementSku || selection.replacementSku.length > 160) {
    throw coded("SKU_REPLACEMENT_BATCH_SELECTION_INVALID", "批量更换中存在无效的订单、商品行或替换 SKU");
  }
  return selection;
}

export class SkuReplacementBatchService {
  constructor({ rootDir, skuReplacementService, now = () => new Date(), randomUUID = () => crypto.randomUUID() }) {
    this.rootDir = rootDir;
    this.skuReplacementService = skuReplacementService;
    this.now = now;
    this.randomUUID = randomUUID;
    this.historyDir = path.join(rootDir, "storage", "sku-replacements");
    this.activeRuns = new Map();
  }

  async createPlan({ selections = [] } = {}) {
    if (!Array.isArray(selections) || !selections.length || selections.length > MAX_BATCH_ITEMS) {
      throw coded("SKU_REPLACEMENT_BATCH_SELECTION_INVALID", `请选择 1-${MAX_BATCH_ITEMS} 个需要更换的商品行`);
    }
    const normalized = selections.map(normalizedSelection);
    const itemKeys = new Set();
    for (const selection of normalized) {
      const key = `${selection.orderReference}\u0000${selection.itemId}`;
      if (itemKeys.has(key)) throw coded("SKU_REPLACEMENT_BATCH_ITEM_DUPLICATE", "每个商品行只能选择一个替换 SKU");
      itemKeys.add(key);
    }
    const items = [];
    const failures = [];
    for (const selection of normalized) {
      try {
        items.push({ selection, plan: await this.skuReplacementService.createPlan(selection) });
      } catch (error) {
        failures.push({ ...selection, code: text(error?.code || "SKU_REPLACEMENT_PLAN_FAILED"),
          message: text(error?.message || "替换 SKU 计划生成失败").slice(0, 300) });
      }
    }
    const createdAt = this.now();
    const semantic = { version: 1, createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + BATCH_PLAN_TTL_MS).toISOString(), items, failures };
    const batchHash = hash(semantic);
    const record = { ...semantic, batchHash, approvalText: `确认批量更换SKU ${items.length}项`,
      summary: { requested: normalized.length, executable: items.length, failed: failures.length } };
    this.write("batch-plans", batchHash, record);
    return record;
  }

  createExecution({ batchHash, approvalText } = {}) {
    const normalizedHash = text(batchHash);
    if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw coded("SKU_REPLACEMENT_BATCH_NOT_FOUND", "批量更换计划不存在，请重新生成");
    const plan = this.read("batch-plans", normalizedHash);
    if (!plan) throw coded("SKU_REPLACEMENT_BATCH_NOT_FOUND", "批量更换计划不存在，请重新生成");
    const semantic = { version: plan.version, createdAt: plan.createdAt, expiresAt: plan.expiresAt, items: plan.items, failures: plan.failures };
    const expectedApproval = `确认批量更换SKU ${(plan.items || []).length}项`;
    if (hash(semantic) !== normalizedHash || text(plan.approvalText) !== expectedApproval) {
      throw coded("SKU_REPLACEMENT_BATCH_HASH_INVALID", "批量更换计划校验失败，请重新生成");
    }
    if (this.now().getTime() >= Date.parse(plan.expiresAt)) throw coded("SKU_REPLACEMENT_BATCH_EXPIRED", "批量更换计划已过期，请重新生成");
    if (text(approvalText) !== plan.approvalText) {
      throw coded("SKU_REPLACEMENT_BATCH_APPROVAL_INVALID", `请输入完整确认文字：${plan.approvalText}`);
    }
    if (plan.executionTaskId) {
      const existing = this.getExecution(plan.executionTaskId);
      if (existing) return existing;
    }
    if (!plan.items.length) throw coded("SKU_REPLACEMENT_BATCH_EMPTY", "没有通过重新验证的可执行商品行");
    const createdAt = this.now().toISOString();
    const taskId = this.randomUUID();
    const task = {
      version: 1, taskId, batchHash: plan.batchHash, status: "QUEUED", createdAt, startedAt: null, finishedAt: null,
      currentItem: null, prevalidationFailures: plan.failures || [],
      items: plan.items.map(({ selection, plan: itemPlan }) => ({
        orderReference: selection.orderReference, itemId: selection.itemId, originalSku: itemPlan.item.originalSku,
        replacementSku: selection.replacementSku, planHash: itemPlan.planHash, plan: itemPlan, status: "PENDING",
        startedAt: null, finishedAt: null, code: null, message: null, diagnostic: null, result: null,
      })),
    };
    task.summary = this.summary(task);
    this.write("batch-executions", taskId, task);
    this.write("batch-plans", normalizedHash, { ...plan, executionTaskId: taskId });
    return task;
  }

  runExecution(taskId) {
    const normalizedTaskId = text(taskId);
    if (this.activeRuns.has(normalizedTaskId)) return this.activeRuns.get(normalizedTaskId);
    const promise = this.runExecutionSerial(normalizedTaskId).finally(() => this.activeRuns.delete(normalizedTaskId));
    this.activeRuns.set(normalizedTaskId, promise);
    return promise;
  }

  async runExecutionSerial(taskId) {
    const task = this.getExecution(taskId);
    if (!task) throw coded("SKU_REPLACEMENT_TASK_NOT_FOUND", "批量更换任务不存在");
    if (["COMPLETED", "COMPLETED_WITH_FAILURES"].includes(task.status)) return task;
    task.status = "RUNNING";
    task.startedAt ||= this.now().toISOString();
    this.persistTask(task);
    for (let index = 0; index < task.items.length; index += 1) {
      const item = task.items[index];
      if (item.status !== "PENDING") continue;
      task.currentItem = index;
      item.status = "RUNNING";
      item.startedAt = this.now().toISOString();
      this.persistTask(task);
      try {
        this.skuReplacementService.restorePlan(item.plan);
        item.result = await this.skuReplacementService.execute({ planHash: item.plan.planHash, approvalText: item.plan.approvalText });
        item.status = "COMPLETED";
      } catch (error) {
        item.code = text(error?.code || "SKU_REPLACEMENT_EXECUTE_FAILED");
        item.message = text(error?.message || "SKU 更换失败").slice(0, 300);
        item.diagnostic = error?.diagnostic || null;
        item.status = /VERIFY_FAILED$/.test(item.code) ? "MANUAL_REVIEW" : "FAILED";
      }
      item.finishedAt = this.now().toISOString();
      this.persistTask(task);
    }
    task.currentItem = null;
    task.finishedAt = this.now().toISOString();
    task.summary = this.summary(task);
    task.status = task.summary.failed || task.summary.manualReview || task.summary.notExecuted || task.summary.prevalidationFailed
      ? "COMPLETED_WITH_FAILURES" : "COMPLETED";
    this.persistTask(task);
    return task;
  }

  getExecution(taskId) {
    const normalizedTaskId = text(taskId);
    if (!/^[A-Za-z0-9-]{1,80}$/.test(normalizedTaskId)) throw coded("SKU_REPLACEMENT_TASK_ID_INVALID", "批量更换任务 ID 无效");
    return this.read("batch-executions", normalizedTaskId);
  }

  reconcileInterruptedExecutions() {
    const directory = path.join(this.historyDir, "batch-executions");
    if (!fs.existsSync(directory)) return [];
    const recovered = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const task = this.read("batch-executions", entry.name.slice(0, -5));
      if (!task || !["QUEUED", "RUNNING"].includes(task.status)) continue;
      for (const item of task.items || []) {
        if (item.status === "RUNNING") {
          item.status = "MANUAL_REVIEW";
          item.code = "SKU_REPLACEMENT_EXECUTION_INTERRUPTED";
          item.message = "服务中断时该项正在写入，请在马帮人工核对，禁止自动重试";
          item.finishedAt = this.now().toISOString();
        } else if (item.status === "PENDING") {
          item.status = "NOT_EXECUTED";
          item.code = "SKU_REPLACEMENT_NOT_EXECUTED";
          item.message = "服务中断前尚未开始，可重新创建批量计划";
          item.finishedAt = this.now().toISOString();
        }
      }
      task.currentItem = null;
      task.finishedAt = this.now().toISOString();
      task.summary = this.summary(task);
      task.status = "COMPLETED_WITH_FAILURES";
      this.persistTask(task);
      recovered.push(task);
    }
    return recovered;
  }

  summary(task) {
    const items = task.items || [];
    const count = (status) => items.filter((item) => item.status === status).length;
    return { total: items.length, processed: items.filter((item) => !["PENDING", "RUNNING"].includes(item.status)).length,
      completed: count("COMPLETED"), failed: count("FAILED"), manualReview: count("MANUAL_REVIEW"),
      notExecuted: count("NOT_EXECUTED"), prevalidationFailed: (task.prevalidationFailures || []).length };
  }

  persistTask(task) {
    task.summary = this.summary(task);
    this.write("batch-executions", task.taskId, task);
  }

  read(folder, id) {
    const file = path.join(this.historyDir, folder, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  write(folder, id, value) {
    const directory = path.join(this.historyDir, folder);
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  }
}
