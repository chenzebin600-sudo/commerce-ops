import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { openProviderRuntimeDataAccess } from "../lib/data/provider-runtime-data-access.mjs";
import { resolveRuntimeConfig, runtimeEnvironment } from "../lib/runtime-config.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { PHASE3D_PRODUCTION_MODE_SCOPE } from "../lib/postgresql/phase3d-production-candidate.mjs";
import {
  planSharedKnowledgePackage,
  readSharedKnowledgeCandidates,
} from "../lib/product-knowledge/shared-knowledge-package.mjs";
import { resolveProductKnowledgeImportTarget } from "../lib/product-knowledge/product-knowledge-import-safety.mjs";

function argument(name) {
  const direct = process.argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageDir = path.resolve(argument("--package") || "");
if (!argument("--package")) {
  throw new Error("Usage: node scripts/import-shared-product-knowledge.mjs --package <directory> [--apply --database=<database> --confirm-database=<database> --confirm-digest=<sha256>]");
}
const plan = await planSharedKnowledgePackage(packageDir);
const summary = {
  mode: process.argv.includes("--apply") ? "APPLY" : "PLAN_ONLY",
  package: plan.packageName,
  contractVersion: plan.contractVersion,
  packageDigest: plan.packageDigest,
  totalCandidates: plan.totalCandidates,
  declaredCounts: plan.quality.counts,
  files: plan.files.map(({ name, lineCount, sha256 }) => ({ name, lineCount, sha256 })),
  productionMutationPerformed: false,
};

if (!process.argv.includes("--apply")) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

if (argument("--confirm-digest") !== plan.packageDigest) {
  throw new Error(`Apply requires --confirm-digest=${plan.packageDigest}`);
}

loadLocalEnv(rootDir);
const runtimeConfig = resolveRuntimeConfig({ bootstrapRoot: rootDir, env: process.env });
const runtimeEnv = { ...process.env, ...runtimeEnvironment(runtimeConfig) };
const postgresqlConfig = loadPostgresqlF1Config({ rootDir: runtimeConfig.appRoot, env: runtimeEnv });
const importTarget = resolveProductKnowledgeImportTarget({
  argv: process.argv.slice(2),
  configuredDatabase: postgresqlConfig.database,
});
const providerEnv = {
  ...runtimeEnv,
  DATABASE_PROVIDER: "postgres",
  POSTGRES_SHADOW_MODE: "false",
  POSTGRES_STAGING_MODE: "false",
  POSTGRES_CUTOVER_REHEARSAL_MODE: "false",
  POSTGRES_PRODUCTION_CANDIDATE_MODE: "false",
  POSTGRES_PRODUCTION_MODE: "true",
  POSTGRES_PRODUCTION_CONFIRM_DATABASE: importTarget.database,
  POSTGRES_PRODUCTION_CONFIRM_SCOPE: PHASE3D_PRODUCTION_MODE_SCOPE,
};
const access = openProviderRuntimeDataAccess({
  rootDir: runtimeConfig.appRoot,
  databasePath: runtimeConfig.databasePath,
  env: providerEnv,
  postgresqlConfig,
});

try {
  if (access.provider.dialect !== "postgresql") {
    throw new Error("Shared Product Knowledge production import requires the active PostgreSQL provider");
  }
  const identity = (await access.provider.query("SELECT current_database() database")).rows[0];
  if (identity?.database !== importTarget.database) {
    throw new Error("Product Knowledge import database identity does not match the explicit confirmation");
  }
  if (!await access.repositories.productKnowledge.isReady()) {
    throw new Error("Shared Product Knowledge migration is not applied; import remains fail-closed");
  }
  const now = new Date().toISOString();
  const result = await access.repositories.productKnowledge.importPackage({
    batch: {
      id: `pkib_${plan.packageDigest.slice(0, 40)}`,
      contractVersion: plan.contractVersion,
      packageDigest: plan.packageDigest,
      packageName: plan.packageName,
      declaredCounts: plan.quality.counts,
      manifest: plan.manifest,
      createdBy: "shared-product-knowledge-cli",
      createdAt: now,
      completedAt: now,
    },
    candidates: readSharedKnowledgeCandidates(plan, { now }),
  });
  process.stdout.write(`${JSON.stringify({
    ...summary,
    storageProvider: access.name,
    target: access.target,
    database: importTarget.database,
    productionMutationPerformed: !result.duplicate,
    result,
  }, null, 2)}\n`);
} finally {
  await access.close();
}
