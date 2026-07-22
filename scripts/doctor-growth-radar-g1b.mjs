import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
loadLocalEnv(rootDir, {
  filenames: [".env.growth-radar-g1b.local"],
  required: true,
  override: true,
});
await import("./doctor.mjs");
