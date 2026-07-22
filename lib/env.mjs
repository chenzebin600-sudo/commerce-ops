import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadLocalEnv(rootDir = process.cwd(), {
  filenames = [".env.local", ".env"],
  required = false,
  override = false,
} = {}) {
  const loaded = [];
  for (const filename of filenames) {
    const filePath = path.join(rootDir, filename);
    if (!existsSync(filePath)) continue;
    loaded.push(filePath);
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (!override && process.env[key]) continue;
      process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  if (required && loaded.length === 0) {
    throw new Error(`Required environment file is missing: ${filenames.join(" or ")}`);
  }
  return loaded;
}
