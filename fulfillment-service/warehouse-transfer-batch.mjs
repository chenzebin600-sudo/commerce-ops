import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_BATCH_ORDERS = 100;
const BATCH_TTL_MS = 10 * 60 * 1000;

function text(value) { return String(value ?? "").trim(); }
function coded(code, message) { const error = new Error(message); error.code = code; return error; }
function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(stable(value)).digest("hex"); }

export class WarehouseTransferBatchService {
  constructor({ rootDir, warehouseTransferService, now = () => new Date(), randomUUID = () => crypto.randomUUID() }) {
    this.warehouseTransferService = warehouseTransferService;
    this.now = now;
    this.randomUUID = randomUUID;
    this.historyDir = path.join(rootDir, "storage", "warehouse-transfers");
    this.activeRuns = new Map();
  }

  async createPlan({ orderReferences = [] } = {}) {
    const references = [...new Set((Array.isArray(orderReferences) ? orderReferences : []).map(text).filter(Boolean))];
    if (!references.length || references.length > MAX_BATCH_ORDERS
        || references.some((reference) => !/^[A-Za-z0-9_-]{4,100}$/.test(reference))) {
      throw coded("WAREHOUSE_BATCH_ORDERS_INVALID", `请输入 1-${MAX_BATCH_ORDERS} 个有效订单号`);
    }
    const items = [];
    const failures = [];
    const reservations = new Map();
    for (const orderReference of references) {
      try {
        items.push({ orderReference, plan: await this.warehouseTransferService.preview({ orderReference }, { reservations }) });
      } catch (error) {
        failures.push({ orderReference, code: text(error?.code || "WAREHOUSE_PREVIEW_FAILED"),
          message: text(error?.message || "换仓预览失败").slice(0, 300) });
      }
    }
    const createdAt = this.now();
    const semantic = { version: 1, createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + BATCH_TTL_MS).toISOString(), items, failures };
    const batchHash = hash(semantic);
    const record = { ...semantic, batchHash, approvalText: `确认批量换仓 ${items.length} 单`,
      summary: { requested: references.length, executable: items.length, failed: failures.length } };
    this.write("batch-plans", batchHash, record);
    return record;
  }

  createExecution({ batchHash, approvalText } = {}) {
    const normalizedHash = text(batchHash);
    const plan = this.read("batch-plans", normalizedHash);
    if (!plan) throw coded("WAREHOUSE_BATCH_NOT_FOUND", "批量换仓计划不存在，请重新生成");
    const semantic = { version: plan.version, createdAt: plan.createdAt, expiresAt: plan.expiresAt,
      items: plan.items, failures: plan.failures };
    const expectedApproval = `确认批量换仓 ${(plan.items || []).length} 单`;
    if (hash(semantic) !== normalizedHash || text(plan.approvalText) !== expectedApproval) {
      throw coded("WAREHOUSE_BATCH_HASH_INVALID", "批量换仓计划校验失败，请重新生成");
    }
    if (this.now().getTime() >= Date.parse(plan.expiresAt)) {
      throw coded("WAREHOUSE_BATCH_EXPIRED", "批量换仓计划已过期，请重新生成");
    }
    if (text(approvalText) !== expectedApproval) {
      throw coded("WAREHOUSE_BATCH_APPROVAL_INVALID", `请输入完整确认文字：${expectedApproval}`);
    }
    if (plan.executionTaskId) {
      const existing = this.getExecution(plan.executionTaskId);
      if (existing) return existing;
    }
    if (!plan.items.length) throw coded("WAREHOUSE_BATCH_EMPTY", "没有通过校验的可执行订单");
    const taskId = this.randomUUID();
    const createdAt = this.now().toISOString();
    const task = {
      version: 1, taskId, batchHash: normalizedHash, status: "QUEUED", createdAt,
      startedAt: null, finishedAt: null, currentItem: null, prevalidationFailures: plan.failures || [],
      items: plan.items.map(({ orderReference, plan: itemPlan }) => ({
        orderReference, planHash: itemPlan.planHash, plan: itemPlan, targetWarehouse: itemPlan.targetWarehouse,
        status: "PENDING", startedAt: null, finishedAt: null, code: null, message: null, result: null,
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
    const run = this.runExecutionSerial(normalizedTaskId).finally(() => this.activeRuns.delete(normalizedTaskId));
    this.activeRuns.set(normalizedTaskId, run);
    return run;
  }

  async runExecutionSerial(taskId) {
    const task = this.getExecution(taskId);
    if (!task) throw coded("WAREHOUSE_TASK_NOT_FOUND", "批量换仓任务不存在");
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
        this.warehouseTransferService.restorePlan(item.plan);
        item.result = await this.warehouseTransferService.execute({
          planHash: item.plan.planHash,
          approvalText: item.plan.approvalText,
        });
        item.status = "COMPLETED";
      } catch (error) {
        item.code = text(error?.code || "WAREHOUSE_EXECUTE_FAILED");
        item.message = text(error?.message || "换仓失败").slice(0, 300);
        item.status = /(VERIFY_FAILED|AUTH_EXPIRED|RESULT_UNKNOWN|INTERRUPTED)$/.test(item.code)
          ? "MANUAL_REVIEW" : "FAILED";
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
    if (!/^[A-Za-z0-9-]{1,80}$/.test(normalizedTaskId)) {
      throw coded("WAREHOUSE_TASK_ID_INVALID", "批量换仓任务 ID 无效");
    }
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
          item.code = "WAREHOUSE_EXECUTION_INTERRUPTED";
          item.message = "服务中断时该订单正在写入，请在马帮人工核对，禁止自动重试";
          item.finishedAt = this.now().toISOString();
        } else if (item.status === "PENDING") {
          item.status = "NOT_EXECUTED";
          item.code = "WAREHOUSE_NOT_EXECUTED";
          item.message = "服务中断前尚未执行，可重新生成换仓计划";
          item.finishedAt = this.now().toISOString();
        }
      }
      task.currentItem = null;
      task.finishedAt = this.now().toISOString();
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
