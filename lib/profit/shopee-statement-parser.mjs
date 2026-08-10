import { spawn } from "node:child_process";
import path from "node:path";

const PUBLIC_CODES = new Set([
  "SHOPEE_COUNTRY_UNSUPPORTED",
  "SHOPEE_STATEMENT_FILE_MISSING",
  "SHOPEE_STATEMENT_PARSE_FAILED",
  "SHOPEE_STATEMENT_PARSE_TIMEOUT",
  "SHOPEE_STATEMENT_PARSE_OUTPUT_LIMIT",
  "SHOPEE_STATEMENT_PARSER_UNAVAILABLE",
]);

export class ShopeeStatementParseError extends Error {
  constructor(code = "SHOPEE_STATEMENT_PARSE_FAILED", reason = null) {
    const safeCode = PUBLIC_CODES.has(code) ? code : "SHOPEE_STATEMENT_PARSE_FAILED";
    super({
      SHOPEE_COUNTRY_UNSUPPORTED: "暂不支持该 Shopee 国家站点。",
      SHOPEE_STATEMENT_FILE_MISSING: "Shopee 账单文件不存在。",
      SHOPEE_STATEMENT_PARSE_TIMEOUT: "Shopee 账单解析超时。",
      SHOPEE_STATEMENT_PARSE_OUTPUT_LIMIT: "Shopee 账单解析结果超过安全上限。",
      SHOPEE_STATEMENT_PARSER_UNAVAILABLE: "Shopee 账单解析器不可用。",
    }[safeCode] || "Shopee 账单无法按已确认的国家规则解析。" );
    this.name = "ShopeeStatementParseError";
    this.code = safeCode;
    this.reason = /^[A-Z0-9_]{3,80}$/.test(String(reason || "")) ? String(reason) : null;
    this.status = safeCode === "SHOPEE_STATEMENT_PARSER_UNAVAILABLE" ? 503 : 400;
  }
}

export function parseShopeeStatementWorkbook({
  pythonExecutable,
  parserScript,
  filename,
  countryCode,
  summaryOnly = false,
  timeoutMs = 120_000,
}) {
  return new Promise((resolve, reject) => {
    const args = [parserScript, filename, "--country", String(countryCode || "")];
    if (summaryOnly) args.push("--summary-only");
    const child = spawn(pythonExecutable, args, {
      cwd: path.dirname(parserScript),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let outputBytes = 0;
    let settled = false;
    const outputLimit = 128 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ShopeeStatementParseError("SHOPEE_STATEMENT_PARSE_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        if (!settled) {
          settled = true;
          child.kill();
          clearTimeout(timer);
          reject(new ShopeeStatementParseError("SHOPEE_STATEMENT_PARSE_OUTPUT_LIMIT"));
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
      reject(new ShopeeStatementParseError("SHOPEE_STATEMENT_PARSER_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let payload;
      try { payload = JSON.parse(Buffer.concat(stdout).toString("utf8")); }
      catch { reject(new ShopeeStatementParseError()); return; }
      if (code !== 0 || !payload?.ok || !payload?.statement) {
        reject(new ShopeeStatementParseError(payload?.code, payload?.reason));
        return;
      }
      resolve(payload.statement);
    });
  });
}
