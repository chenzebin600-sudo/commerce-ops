import { spawn } from "node:child_process";
import path from "node:path";

const PUBLIC_CODES = new Set([
  "GROWTH_RADAR_SOURCE_FILE_MISSING",
  "GROWTH_RADAR_ROW_LIMIT_EXCEEDED",
  "GROWTH_RADAR_PARSE_FAILED",
  "GROWTH_RADAR_PARSE_TIMEOUT",
  "GROWTH_RADAR_PARSE_OUTPUT_LIMIT",
  "GROWTH_RADAR_PARSER_UNAVAILABLE",
]);

export class GrowthRadarParseError extends Error {
  constructor(code = "GROWTH_RADAR_PARSE_FAILED") {
    const safeCode = PUBLIC_CODES.has(code) ? code : "GROWTH_RADAR_PARSE_FAILED";
    super({
      GROWTH_RADAR_SOURCE_FILE_MISSING: "来源文件不存在。",
      GROWTH_RADAR_ROW_LIMIT_EXCEEDED: "来源文件超过安全处理行数上限。",
      GROWTH_RADAR_PARSE_TIMEOUT: "来源文件解析超时。",
      GROWTH_RADAR_PARSE_OUTPUT_LIMIT: "来源文件解析结果超过安全上限。",
      GROWTH_RADAR_PARSER_UNAVAILABLE: "增长雷达解析器不可用。",
    }[safeCode] || "来源文件无法解析。请确认文件为受支持的 Excel 导出。" );
    this.name = "GrowthRadarParseError";
    this.code = safeCode;
    this.status = safeCode === "GROWTH_RADAR_PARSER_UNAVAILABLE" ? 503 : 400;
  }
}

export function growthRadarParseOutputLimit(maxRows = 200000) {
  return Math.min(
    512 * 1024 * 1024,
    Math.max(128 * 1024 * 1024, Number(maxRows || 0) * 4096),
  );
}

export function parseGrowthRadarWorkbook({
  pythonExecutable,
  parserScript,
  filename,
  domain,
  maxRows = 200000,
  timeoutMs = 600000,
}) {
  if (!new Set(["order", "inventory"]).has(domain)) throw new TypeError("Growth radar parser domain is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [
      parserScript,
      filename,
      "--domain", domain,
      "--max-rows", String(maxRows),
    ], {
      cwd: path.dirname(parserScript),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let outputBytes = 0;
    let settled = false;
    const outputLimit = growthRadarParseOutputLimit(maxRows);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new GrowthRadarParseError("GROWTH_RADAR_PARSE_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        if (!settled) {
          settled = true;
          child.kill();
          clearTimeout(timer);
          reject(new GrowthRadarParseError("GROWTH_RADAR_PARSE_OUTPUT_LIMIT"));
        }
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GrowthRadarParseError("GROWTH_RADAR_PARSER_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reject(new GrowthRadarParseError());
        return;
      }
      if (code !== 0 || !payload?.ok) {
        reject(new GrowthRadarParseError(payload?.code));
        return;
      }
      resolve(payload);
    });
  });
}
