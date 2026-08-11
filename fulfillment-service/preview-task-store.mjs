import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TASK_VERSION = 1;

function text(value) { return String(value ?? "").trim(); }
function stable(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}
function fingerprint(kind, input) {
  const normalizedInput = input && typeof input === "object" && Array.isArray(input.orderReferences)
    ? { ...input, orderReferences: [...new Set(input.orderReferences.map(text).filter(Boolean))].sort() }
    : input;
  return crypto.createHash("sha256").update(stable({ kind, input: normalizedInput })).digest("hex");
}
function safeError(error) {
  const rawCode = text(error?.code);
  const code = /^[A-Z0-9_]{1,120}$/.test(rawCode) ? rawCode : "PREVIEW_TASK_FAILED";
  const rawMessage = text(error?.message || "预览任务失败").slice(0, 300);
  const message = /(password|passwd|cookie|authorization|token|secret|密码|凭证)/i.test(rawMessage)
    ? "预览任务失败，详细原因已安全隐藏，请查看服务日志"
    : rawMessage;
  return { code, message };
}

export class PreviewTaskStore {
  constructor({ rootDir, now = () => new Date(), randomUUID = () => crypto.randomUUID() } = {}) {
    this.now = now;
    this.randomUUID = randomUUID;
    this.directory = path.join(rootDir, "storage", "preview-tasks");
    this.running = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
    this.reconcileInterrupted();
  }

  start({ kind, input, run }) {
    const normalizedKind = text(kind);
    if (!/^[a-z0-9-]{3,80}$/.test(normalizedKind) || typeof run !== "function") {
      throw Object.assign(new Error("预览任务参数无效"), { code: "PREVIEW_TASK_INVALID" });
    }
    const requestFingerprint = fingerprint(normalizedKind, input);
    const existing = this.list().find((task) => task.kind === normalizedKind
      && task.fingerprint === requestFingerprint && ["QUEUED", "RUNNING"].includes(task.state));
    if (existing) return existing;
    const taskId = this.randomUUID();
    const task = { version: TASK_VERSION, taskId, kind: normalizedKind, fingerprint: requestFingerprint,
      state: "QUEUED", createdAt: this.now().toISOString(), startedAt: null, finishedAt: null,
      progress: null, result: null, error: null };
    this.write(task);
    const promise = Promise.resolve().then(async () => {
      task.state = "RUNNING";
      task.startedAt = this.now().toISOString();
      this.write(task);
      try {
        task.result = await run((progress) => {
          task.progress = progress && typeof progress === "object" ? progress : null;
          this.write(task);
        });
        task.state = "SUCCEEDED";
      } catch (error) {
        task.state = "FAILED";
        task.error = safeError(error);
      }
      task.finishedAt = this.now().toISOString();
      this.write(task);
      return task;
    }).finally(() => this.running.delete(taskId));
    this.running.set(taskId, promise);
    return task;
  }

  wait(taskId) { return this.running.get(text(taskId)) || Promise.resolve(this.get(taskId)); }

  get(taskId) {
    const id = text(taskId);
    if (!/^[A-Za-z0-9-]{1,80}$/.test(id)) return null;
    const file = path.join(this.directory, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  list() {
    return fs.readdirSync(this.directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.get(entry.name.slice(0, -5))).filter(Boolean);
  }

  reconcileInterrupted() {
    for (const task of this.list()) {
      if (!["QUEUED", "RUNNING"].includes(task.state)) continue;
      task.state = "FAILED";
      task.finishedAt = this.now().toISOString();
      task.error = { code: "PREVIEW_TASK_INTERRUPTED", message: "服务重启时预览仍在运行，请重新发起只读预览" };
      this.write(task);
    }
  }

  write(task) {
    const file = path.join(this.directory, `${task.taskId}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(task, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, file);
  }
}
