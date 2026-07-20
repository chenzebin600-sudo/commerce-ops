import { spawn } from "node:child_process";
import path from "node:path";

export class ProductPackageParseError extends Error {
  constructor(code = "PRODUCT_PACKAGE_PARSE_FAILED") {
    super(code === "PRODUCT_PACKAGE_ROW_LIMIT_EXCEEDED" ? "产品包数据行超过安全处理上限。" : "产品包无法解析，请确认文件来自公司商品中台。" );
    this.name = "ProductPackageParseError";
    this.code = code;
    this.status = 400;
  }
}
export function parseProductPackageXlsx({ pythonExecutable, parserScript, filename, maxRows = 20000, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonExecutable, [parserScript, filename, "--max-rows", String(maxRows)], {
      cwd: path.dirname(parserScript),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let outputBytes = 0;
    let settled = false;
    const outputLimit = 64 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new ProductPackageParseError("PRODUCT_PACKAGE_PARSE_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) {
        if (!settled) {
          settled = true;
          child.kill();
          clearTimeout(timer);
          reject(new ProductPackageParseError("PRODUCT_PACKAGE_PARSE_OUTPUT_LIMIT"));
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
      reject(new ProductPackageParseError("PRODUCT_PACKAGE_PARSER_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(stdout).toString("utf8"));
      } catch {
        reject(new ProductPackageParseError());
        return;
      }
      if (code !== 0 || !payload?.ok) {
        reject(new ProductPackageParseError(payload?.code));
        return;
      }
      resolve(payload);
    });
  });
}
