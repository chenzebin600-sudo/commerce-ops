import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const sourcePath = path.join(projectRoot, "dist", "server", "wrangler.json");
const outputDir = path.join(projectRoot, "work");
const outputPath = path.join(outputDir, "wrangler.local.json");

const config = JSON.parse(await readFile(sourcePath, "utf8"));
config.main = "../dist/server/index.js";
config.assets = {
  ...(config.assets ?? {}),
  directory: "../dist/client",
};
config.dev = {
  ...(config.dev ?? {}),
  ip: "127.0.0.1",
  local_protocol: "http",
};

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, JSON.stringify(config), "utf8");
