import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../../lib/env.mjs";
import {
  LazadaOAuthRepository,
  createLazadaOAuthHandler,
  ensureTokenEncryptionKey,
  resolveLazadaOAuthConfig,
} from "./lazada-oauth-service.mjs";

const integrationDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(integrationDir, "../..");
loadLocalEnv(rootDir);

let config = resolveLazadaOAuthConfig({ rootDir, env: process.env });
await ensureTokenEncryptionKey(config);
config = resolveLazadaOAuthConfig({ rootDir, env: process.env });
const repository = new LazadaOAuthRepository(config.databasePath, {
  defaultAppId: config.defaultAppId,
  encryptionKey: config.tokenEncryptionKey,
});
const handler = createLazadaOAuthHandler({ config, repository });
const server = http.createServer(handler);

server.listen(config.port, config.host, () => {
  console.log(`Lazada OAuth listening on http://${config.host}:${config.port}`);
  for (const app of config.apps) console.log(`${app.id} callback: ${app.callbackUrl || "not configured"}`);
  console.log(`Central manager: http://${config.host}:${config.port}/lazada/manager`);
  console.log("Credentials are never printed; check /lazada/status for non-secret state.");
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    repository.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
