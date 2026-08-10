import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";

export const PRODUCT_KNOWLEDGE_MIGRATION_VERSION = "018_shared_product_knowledge.sql";
export const PRODUCT_KNOWLEDGE_MIGRATION_SHA256 = "7c9244fafee77c847cde8d044b68f5f962c70dd19dabecdafbc85c821617f687";
export const PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION = "SHARED_PRODUCT_KNOWLEDGE_V1";
export const PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION =
  "DROP_EMPTY_PRODUCT_KNOWLEDGE_TABLES_AND_REAPPLY_018";
export const PRODUCT_KNOWLEDGE_LEGACY_SHA256 =
  "13ebb9178e1c426d2c1a606228b97c4e01941e089296e80673d3b326ab057804";

export const PRODUCT_KNOWLEDGE_TABLES = Object.freeze([
  "product_knowledge_import_batches",
  "product_knowledge_candidates",
  "product_knowledge_reviews",
  "product_knowledge_claims",
  "product_knowledge_claim_scopes",
  "product_accessory_relations",
  "customer_service_policy_versions",
  "customer_service_playbook_versions",
  "product_knowledge_releases",
  "product_knowledge_release_items",
  "product_accessory_release_items",
  "customer_service_policy_release_items",
  "customer_service_playbook_release_items",
]);

export const PRODUCT_KNOWLEDGE_LEGACY_TABLES = Object.freeze(
  PRODUCT_KNOWLEDGE_TABLES.filter((name) => !new Set([
    "product_accessory_release_items",
    "customer_service_policy_release_items",
    "customer_service_playbook_release_items",
  ]).has(name)),
);

export const PRODUCT_KNOWLEDGE_INDEXES = Object.freeze([
  "idx_pk_import_candidates_review",
  "idx_pk_import_candidates_subject",
  "idx_pk_claims_subject",
  "idx_pk_claim_scopes_resolver",
  "idx_pk_releases_resolver",
  "idx_pk_release_items_claim",
  "idx_pk_release_items_accessory",
  "idx_pk_release_items_policy",
  "idx_pk_release_items_playbook",
]);

export const PRODUCT_KNOWLEDGE_LEGACY_INDEXES = Object.freeze(
  PRODUCT_KNOWLEDGE_INDEXES.filter((name) => !new Set([
    "idx_pk_release_items_accessory",
    "idx_pk_release_items_policy",
    "idx_pk_release_items_playbook",
  ]).has(name)),
);

export const PRODUCT_KNOWLEDGE_LEGACY_DROP_SQL = `DROP TABLE ${PRODUCT_KNOWLEDGE_LEGACY_TABLES
  .map((name) => `app.${quoteIdentifier(name)}`)
  .join(", ")} RESTRICT`;

export const PRODUCT_KNOWLEDGE_CONSTRAINT_COUNTS = Object.freeze({
  "FOREIGN KEY": 24,
  "PRIMARY KEY": 13,
  UNIQUE: 16,
  CHECK: 22,
});

export const PRODUCT_KNOWLEDGE_APP_PRIVILEGES = Object.freeze([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
]);

const rootDir = path.resolve(import.meta.dirname, "..");
const KNOWLEDGE_OBJECT_PREDICATE = `(
  c.relname LIKE 'product_knowledge_%'
  OR c.relname LIKE 'product_accessory_%'
  OR c.relname LIKE 'customer_service_policy_%'
  OR c.relname LIKE 'customer_service_playbook_%'
)`;

function option(argv, name) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactNames(actual, expected, label) {
  const actualNames = sorted(actual);
  const expectedNames = sorted(expected);
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `${label} mismatch; expected ${expectedNames.join(", ") || "none"}; found ${actualNames.join(", ") || "none"}`,
    );
  }
}

export function resolveProductKnowledgeMigrationInvocation(config, argv = process.argv.slice(2)) {
  const database = option(argv, "database") || config.testDatabase;
  if (!new Set([config.testDatabase, config.database]).has(database)) {
    throw new Error(`Product Knowledge migration target is not allowed: ${database}`);
  }
  const apply = argv.includes("--apply");
  const confirmedDatabase = option(argv, "confirm-database");
  const confirmedMigration = option(argv, "confirm-migration");
  const replaceEmptyRehearsal = argv.includes("--replace-empty-rehearsal");
  const confirmedEmptyReplace = option(argv, "confirm-empty-replace");

  if (apply && (
    confirmedDatabase !== database
    || confirmedMigration !== PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION
  )) {
    throw new Error(
      `Apply requires --confirm-database=${database} --confirm-migration=${PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION}`,
    );
  }
  if (replaceEmptyRehearsal && (
    !apply
    || database !== config.testDatabase
    || confirmedEmptyReplace !== PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION
  )) {
    throw new Error(
      "Empty Product Knowledge replacement requires the configured test database "
      + `and --confirm-empty-replace=${PRODUCT_KNOWLEDGE_EMPTY_REPLACE_CONFIRMATION}`,
    );
  }
  return Object.freeze({
    database,
    apply,
    confirmedDatabase,
    confirmedMigration,
    replaceEmptyRehearsal,
    confirmedEmptyReplace,
  });
}

export async function readProductKnowledgeInventory(provider) {
  const objects = (await provider.query(
    `SELECT c.relname object_name,c.relkind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='app'
       AND c.relkind IN ('r','p','v','m','f')
       AND ${KNOWLEDGE_OBJECT_PREDICATE}
     ORDER BY c.relname`,
  )).rows;
  const indexes = (await provider.query(
    `SELECT c.relname index_name,i.indisvalid
     FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_index i ON i.indexrelid=c.oid
     WHERE n.nspname='app' AND c.relname LIKE 'idx_pk_%'
     ORDER BY c.relname`,
  )).rows;
  return Object.freeze({ objects, indexes });
}

export async function assertCleanProductKnowledgePrestate(provider) {
  const inventory = await readProductKnowledgeInventory(provider);
  if (inventory.objects.length || inventory.indexes.length) {
    throw new Error(
      "Product Knowledge migration requires a clean prestate; found "
      + `${inventory.objects.length} relation(s) and ${inventory.indexes.length} index(es)`,
    );
  }
  return Object.freeze({ relations: 0, indexes: 0 });
}

export async function assertLegacyEmptyProductKnowledgePrestate(provider) {
  const inventory = await readProductKnowledgeInventory(provider);
  if (inventory.objects.some((row) => !new Set(["r", "p"]).has(row.relkind))) {
    throw new Error("Legacy Product Knowledge rehearsal contains a non-table relation");
  }
  assertExactNames(
    inventory.objects.map((row) => row.object_name),
    PRODUCT_KNOWLEDGE_LEGACY_TABLES,
    "Legacy Product Knowledge table inventory",
  );
  assertExactNames(
    inventory.indexes.filter((row) => row.indisvalid).map((row) => row.index_name),
    PRODUCT_KNOWLEDGE_LEGACY_INDEXES,
    "Legacy Product Knowledge index inventory",
  );
  if (inventory.indexes.some((row) => !row.indisvalid)) {
    throw new Error("Legacy Product Knowledge rehearsal contains an invalid index");
  }

  const qualifiedTables = PRODUCT_KNOWLEDGE_LEGACY_TABLES.map((name) => `app.${quoteIdentifier(name)}`).join(", ");
  await provider.executeScript(`LOCK TABLE ${qualifiedTables} IN ACCESS EXCLUSIVE MODE`);
  const lockedInventory = await readProductKnowledgeInventory(provider);
  assertExactNames(
    lockedInventory.objects.map((row) => row.object_name),
    PRODUCT_KNOWLEDGE_LEGACY_TABLES,
    "Locked legacy Product Knowledge table inventory",
  );
  assertExactNames(
    lockedInventory.indexes.filter((row) => row.indisvalid).map((row) => row.index_name),
    PRODUCT_KNOWLEDGE_LEGACY_INDEXES,
    "Locked legacy Product Knowledge index inventory",
  );
  if (lockedInventory.objects.some((row) => !new Set(["r", "p"]).has(row.relkind))
    || lockedInventory.indexes.some((row) => !row.indisvalid)) {
    throw new Error("Locked legacy Product Knowledge rehearsal inventory changed or became invalid");
  }
  const rowCounts = {};
  for (const table of PRODUCT_KNOWLEDGE_LEGACY_TABLES) {
    rowCounts[table] = Number((await provider.query(
      `SELECT COUNT(*)::integer count FROM app.${quoteIdentifier(table)}`,
    )).rows[0].count);
  }
  const nonEmpty = Object.entries(rowCounts).filter(([, count]) => count !== 0).map(([table]) => table);
  if (nonEmpty.length) {
    throw new Error(`Empty Product Knowledge replacement refused non-empty tables: ${nonEmpty.join(", ")}`);
  }

  const externalForeignKeys = (await provider.query(
    `WITH knowledge AS (
       SELECT c.oid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='app' AND c.relname = ANY($1::text[])
     )
     SELECT constraint_row.conname,
       constraint_row.conrelid::regclass::text referencing_relation,
       constraint_row.confrelid::regclass::text referenced_relation
     FROM pg_constraint constraint_row
     WHERE constraint_row.contype='f'
       AND constraint_row.confrelid IN (SELECT oid FROM knowledge)
       AND constraint_row.conrelid NOT IN (SELECT oid FROM knowledge)
     ORDER BY referencing_relation,constraint_row.conname`,
    [PRODUCT_KNOWLEDGE_LEGACY_TABLES],
  )).rows;
  if (externalForeignKeys.length) {
    throw new Error("Empty Product Knowledge replacement refused external foreign-key dependencies");
  }
  return Object.freeze({ tables: PRODUCT_KNOWLEDGE_LEGACY_TABLES.length, rowCounts, externalForeignKeys: 0 });
}

export async function validateProductKnowledgeSchema(provider, { version, sha256, appUser }) {
  const inventory = await readProductKnowledgeInventory(provider);
  if (inventory.objects.some((row) => !new Set(["r", "p"]).has(row.relkind))) {
    throw new Error("Product Knowledge schema contains a non-table relation");
  }
  assertExactNames(
    inventory.objects.map((row) => row.object_name),
    PRODUCT_KNOWLEDGE_TABLES,
    "Product Knowledge table inventory",
  );
  if (inventory.indexes.some((row) => !row.indisvalid)) {
    throw new Error("Product Knowledge schema contains an invalid index");
  }
  assertExactNames(
    inventory.indexes.map((row) => row.index_name),
    PRODUCT_KNOWLEDGE_INDEXES,
    "Product Knowledge index inventory",
  );

  const constraintRows = (await provider.query(
    `SELECT CASE constraint_row.contype
       WHEN 'f' THEN 'FOREIGN KEY'
       WHEN 'p' THEN 'PRIMARY KEY'
       WHEN 'u' THEN 'UNIQUE'
       WHEN 'c' THEN 'CHECK'
     END constraint_type,
     COUNT(*)::integer count
     FROM pg_constraint constraint_row
     JOIN pg_class relation ON relation.oid=constraint_row.conrelid
     JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname='app'
       AND relation.relname = ANY($1::text[])
       AND constraint_row.contype IN ('f','p','u','c')
     GROUP BY constraint_row.contype ORDER BY constraint_row.contype`,
    [PRODUCT_KNOWLEDGE_TABLES],
  )).rows;
  const constraintCounts = Object.fromEntries(
    constraintRows.map((row) => [row.constraint_type, Number(row.count)]),
  );
  for (const [type, expected] of Object.entries(PRODUCT_KNOWLEDGE_CONSTRAINT_COUNTS)) {
    if (Number(constraintCounts[type] || 0) !== expected) {
      throw new Error(
        `Product Knowledge ${type} constraint count mismatch: expected ${expected}, found ${constraintCounts[type] || 0}`,
      );
    }
  }

  const ledger = (await provider.query(
    "SELECT sha256,applied_at FROM shadow_meta.schema_migrations WHERE version=$1",
    [version],
  )).rows[0];
  if (!ledger || ledger.sha256 !== sha256) {
    throw new Error(`Product Knowledge migration ledger mismatch: ${version}`);
  }

  const grantRows = (await provider.query(
    `SELECT table_name,privilege_type
     FROM information_schema.role_table_grants
     WHERE table_schema='app' AND grantee=$1 AND table_name = ANY($2::text[])
     ORDER BY table_name,privilege_type`,
    [appUser, PRODUCT_KNOWLEDGE_TABLES],
  )).rows;
  const grants = new Set(grantRows.map((row) => `${row.table_name}:${row.privilege_type}`));
  const missingGrants = PRODUCT_KNOWLEDGE_TABLES.flatMap((table) =>
    PRODUCT_KNOWLEDGE_APP_PRIVILEGES
      .filter((privilege) => !grants.has(`${table}:${privilege}`))
      .map((privilege) => `${table}:${privilege}`));
  if (missingGrants.length) {
    throw new Error(`Product Knowledge application-role CRUD grants are incomplete: ${missingGrants.join(", ")}`);
  }

  return Object.freeze({
    tables: inventory.objects.length,
    indexes: inventory.indexes.length,
    constraints: constraintCounts,
    appCrudGrants: PRODUCT_KNOWLEDGE_TABLES.length * PRODUCT_KNOWLEDGE_APP_PRIVILEGES.length,
    ledger: { version, sha256, appliedAt: ledger.applied_at },
  });
}

async function prepareMigrationTransaction(tx) {
  await tx.query("SET LOCAL lock_timeout='10s'");
  await tx.query("SET LOCAL statement_timeout='600s'");
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [PRODUCT_KNOWLEDGE_MIGRATION_VERSION]);
}

async function grantApplicationCrud(tx, appUser) {
  const qualifiedTables = PRODUCT_KNOWLEDGE_TABLES.map((name) => `app.${quoteIdentifier(name)}`).join(", ");
  await tx.executeScript(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE ${qualifiedTables} TO ${quoteIdentifier(appUser)}`,
  );
}

async function replaceLegacyEmptyRehearsal(tx, { sql, sha256, appUser }) {
  await assertLegacyEmptyProductKnowledgePrestate(tx);
  await tx.executeScript(PRODUCT_KNOWLEDGE_LEGACY_DROP_SQL);
  await tx.query("DELETE FROM shadow_meta.schema_migrations WHERE version=$1", [PRODUCT_KNOWLEDGE_MIGRATION_VERSION]);
  await tx.executeScript(sql);
  await grantApplicationCrud(tx, appUser);
  await tx.query(
    "INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)",
    [PRODUCT_KNOWLEDGE_MIGRATION_VERSION, sha256],
  );
  return validateProductKnowledgeSchema(tx, {
    version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
    sha256,
    appUser,
  });
}

export async function runProductKnowledgeMigration({ argv = process.argv.slice(2), projectRoot = rootDir } = {}) {
  loadLocalEnv(projectRoot);
  const config = loadPostgresqlF1Config({ rootDir: projectRoot });
  const invocation = resolveProductKnowledgeMigrationInvocation(config, argv);
  const migrationPath = path.join(
    projectRoot,
    "postgresql",
    "shadow",
    "migrations",
    PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
  );
  const sql = await fs.readFile(migrationPath, "utf8");
  const sha256 = crypto.createHash("sha256").update(sql).digest("hex");
  if (sha256 !== PRODUCT_KNOWLEDGE_MIGRATION_SHA256) {
    throw new Error(
      `Frozen Product Knowledge migration digest changed: expected ${PRODUCT_KNOWLEDGE_MIGRATION_SHA256}, found ${sha256}`,
    );
  }
  const applyCommand = `node scripts/apply-product-knowledge-migration.mjs --apply --database=${invocation.database} --confirm-database=${invocation.database} --confirm-migration=${PRODUCT_KNOWLEDGE_MIGRATION_CONFIRMATION}`;
  if (!invocation.apply) {
    return Object.freeze({
      status: "PLAN",
      database: invocation.database,
      production: invocation.database === config.database,
      version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
      sha256,
      applyCommand,
    });
  }

  const migrator = new PostgresqlProvider({
    config: Object.freeze({ ...config, statementTimeoutMs: 600_000 }),
    database: invocation.database,
    user: config.migratorUser,
    password: config.migratorPassword,
  });
  try {
    const identity = (await migrator.query(
      "SELECT current_database() database,current_user username",
    )).rows[0];
    if (identity.database !== invocation.database || identity.username !== config.migratorUser) {
      throw new Error("Migration identity does not match the approved database and migrator role");
    }
    const ledgerTable = (await migrator.query(
      "SELECT to_regclass('shadow_meta.schema_migrations')::text relation",
    )).rows[0]?.relation;
    if (!ledgerTable) throw new Error("Migration ledger shadow_meta.schema_migrations is missing");

    const outcome = await migrator.transaction(async (tx) => {
      await prepareMigrationTransaction(tx);
      const existing = (await tx.query(
        "SELECT sha256,applied_at FROM shadow_meta.schema_migrations WHERE version=$1 FOR UPDATE",
        [PRODUCT_KNOWLEDGE_MIGRATION_VERSION],
      )).rows[0];

      if (existing?.sha256 === sha256) {
        return Object.freeze({
          status: "ALREADY_APPLIED",
          validation: await validateProductKnowledgeSchema(tx, {
            version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
            sha256,
            appUser: config.appUser,
          }),
        });
      }
      if (existing) {
        if (!invocation.replaceEmptyRehearsal) {
          throw new Error(`Applied migration checksum changed: ${PRODUCT_KNOWLEDGE_MIGRATION_VERSION}`);
        }
        if (existing.sha256 !== PRODUCT_KNOWLEDGE_LEGACY_SHA256) {
          throw new Error(
            `Empty Product Knowledge replacement only accepts legacy digest ${PRODUCT_KNOWLEDGE_LEGACY_SHA256}`,
          );
        }
        return Object.freeze({
          status: "REHEARSAL_REAPPLIED",
          validation: await replaceLegacyEmptyRehearsal(tx, { sql, sha256, appUser: config.appUser }),
        });
      }
      if (invocation.replaceEmptyRehearsal) {
        throw new Error("Empty Product Knowledge replacement requires the known legacy migration ledger row");
      }

      await assertCleanProductKnowledgePrestate(tx);
      await tx.executeScript(sql);
      await grantApplicationCrud(tx, config.appUser);
      await tx.query(
        "INSERT INTO shadow_meta.schema_migrations(version,sha256) VALUES ($1,$2)",
        [PRODUCT_KNOWLEDGE_MIGRATION_VERSION, sha256],
      );
      return Object.freeze({
        status: "APPLIED",
        validation: await validateProductKnowledgeSchema(tx, {
          version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
          sha256,
          appUser: config.appUser,
        }),
      });
    });

    return Object.freeze({
      ...outcome,
      database: identity.database,
      production: identity.database === config.database,
      version: PRODUCT_KNOWLEDGE_MIGRATION_VERSION,
      sha256,
    });
  } finally {
    await migrator.close();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runProductKnowledgeMigration().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(
      `Product Knowledge migration failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`,
    );
    process.exitCode = 1;
  });
}
