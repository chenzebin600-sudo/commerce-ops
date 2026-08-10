import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { resolveFulfillmentConfig } from "../fulfillment-service/config.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir);
const config = resolveFulfillmentConfig({ rootDir });
const baseUrl = `http://${config.host}:${config.port}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const response = await fetch(`${baseUrl}/api/fulfillment/maintenance/restart`, {
  method: "POST",
  headers: { "x-fulfillment-maintenance": "drain-and-restart" },
  signal: AbortSignal.timeout(10_000),
});
const payload = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(payload?.error?.message || `安全重启请求失败 (${response.status})`);
console.log(payload.data?.message || "履约服务已进入排空模式");
if (payload.data?.activeOperations) console.log(`等待 ${payload.data.activeOperations} 个任务结束，其中写入任务 ${payload.data.activeWriteOperations} 个。`);

const deadline = Date.now() + 35 * 60 * 1000;
let sawUnavailable = false;
let restarted = false;
while (Date.now() < deadline) {
  await sleep(2000);
  try {
    const healthResponse = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    const health = await healthResponse.json();
    if (sawUnavailable && healthResponse.ok && health.success && !health.draining) {
      console.log("履约服务已安全重启并恢复健康。");
      restarted = true;
      break;
    }
  } catch { sawUnavailable = true; }
}
if (!restarted) throw new Error("履约服务安全重启等待超时；没有强制终止正在运行的任务。");
