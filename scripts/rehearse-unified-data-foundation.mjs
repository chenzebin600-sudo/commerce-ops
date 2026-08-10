import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadLocalEnv } from "../lib/env.mjs";
import { PostgresqlProvider } from "../lib/data/postgresql/postgresql-provider.mjs";
import { loadPostgresqlF1Config } from "../lib/postgresql/f1-config.mjs";
import { syncUnifiedFieldMappingCatalog } from "../lib/data-foundation/unified-field-mapping-store.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");
const rehearsalDatabase = "commerce_ops_unified_rehearsal";
const migrationPaths = [
  path.join(rootDir, "postgresql", "candidate-migrations", "013_unified_data_foundation_candidate.sql"),
  path.join(rootDir, "postgresql", "candidate-migrations", "014_identity_crosswalk_backfill_candidate.sql"),
];
const protectedRelations = Object.freeze([
  "growth_order_headers",
  "growth_order_lines",
  "growth_inventory_snapshots",
  "product_package_rows",
  "product_sku_current_prices",
  "commerce_shop_account_bindings",
]);
const governanceRelations = Object.freeze([
  "data_contract_versions",
  "data_source_field_catalog",
  "data_field_mappings",
  "data_identity_rule_catalog",
  "data_identity_mapping_runs",
  "data_identity_candidates",
  "data_identity_candidate_decisions",
  "data_identity_resolutions",
  "data_identity_mapping_issues",
]);

class RehearsalRollback extends Error {}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function migrationDefinitionFingerprint(sql) {
  const pattern = /(VALUES\s*\(\s*'014_identity_crosswalk_catalog_v2'\s*,\s*')([0-9a-f]{64})('\s*\)\s*;\s*COMMIT;)/m;
  const match = pattern.exec(sql);
  if (!match) throw new Error("014 migration definition fingerprint declaration is missing");
  const valueOffset = match.index + match[1].length;
  const normalized = `${sql.slice(0, valueOffset)}${"0".repeat(64)}${sql.slice(valueOffset + match[2].length)}`;
  const computed = sha256(normalized);
  assert.equal(match[2], computed, "014 declared definition fingerprint does not match its normalized SQL");
  return computed;
}

function clientEnv(config) {
  return {
    ...process.env,
    PGPASSWORD: config.adminPassword,
    PGSSLMODE: config.ssl ? "verify-full" : "disable",
    ...(config.sslCaFile ? { PGSSLROOTCERT: config.sslCaFile } : {}),
  };
}

function provider(config, database) {
  return new PostgresqlProvider({
    config: { ...config, schema: "app", statementTimeoutMs: 120_000 },
    database,
    user: config.adminUser,
    password: config.adminPassword,
  });
}

function assertGovernanceOnlySql(sql) {
  assert.doesNotMatch(sql, /\bCREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i, "014 must not create views");
  assert.doesNotMatch(sql, /\bdata_identity_backfill_[a-z0-9_]*\b/i, "014 must not create a backfill ledger");
  assert.doesNotMatch(sql, /\bdata_dataset_module_bindings\b/i, "014 must not change module bindings");
  for (const relation of protectedRelations) {
    const qualified = `(?:"?app"?\\.)?"?${relation}"?`;
    assert.doesNotMatch(sql, new RegExp(`\\bALTER\\s+TABLE\\s+(?:ONLY\\s+)?${qualified}\\b`, "i"),
      `014 must not alter app.${relation}`);
    assert.doesNotMatch(sql, new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|MERGE\\s+INTO)\\s+${qualified}\\b`, "i"),
      `014 must not write app.${relation}`);
  }
  return Object.freeze({
    noFactAlterOrWrite: true,
    noViews: true,
    noBackfillLedger: true,
    noModuleBindingMutation: true,
    migrationSha256: sha256(sql),
    definitionSha256: migrationDefinitionFingerprint(sql),
  });
}

async function structureFingerprint(database, relationNames) {
  const result = await database.query(`
    SELECT object_type,table_name,object_name,definition
    FROM (
      SELECT 'COLUMN'::text AS object_type,relation.relname AS table_name,attribute.attname AS object_name,
             concat_ws('|',attribute.attnum::text,format_type(attribute.atttypid,attribute.atttypmod),
               attribute.attnotnull::text,COALESCE(pg_get_expr(default_value.adbin,default_value.adrelid),''),
               attribute.attidentity,attribute.attgenerated) AS definition
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid=relation.oid AND default_value.adnum=attribute.attnum
      WHERE namespace.nspname='app' AND relation.relname=ANY($1::text[])
        AND attribute.attnum>0 AND NOT attribute.attisdropped
      UNION ALL
      SELECT 'CONSTRAINT',relation.relname,constraint_row.conname,
             pg_get_constraintdef(constraint_row.oid,true)
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid=constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='app' AND relation.relname=ANY($1::text[])
      UNION ALL
      SELECT 'INDEX',index_row.tablename,index_row.indexname,index_row.indexdef
      FROM pg_indexes index_row
      WHERE index_row.schemaname='app' AND index_row.tablename=ANY($1::text[])
      UNION ALL
      SELECT 'TRIGGER',relation.relname,trigger_row.tgname,pg_get_triggerdef(trigger_row.oid,true)
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='app' AND relation.relname=ANY($1::text[]) AND NOT trigger_row.tgisinternal
    ) inventory
    ORDER BY table_name,object_type,object_name,definition
  `, [relationNames]);
  return sha256(JSON.stringify(result.rows));
}

async function factRowFingerprint(database) {
  const statement = protectedRelations.map((relation) =>
    `SELECT '${relation}'::text AS relation_name,count(*)::text AS row_count FROM app.${relation}`).join(" UNION ALL ");
  const result = await database.query(`${statement} ORDER BY relation_name`);
  return sha256(JSON.stringify(result.rows));
}

async function viewFingerprint(database) {
  const result = await database.query(`
    SELECT viewname,definition FROM pg_views WHERE schemaname='app' ORDER BY viewname
  `);
  return {
    fingerprint: sha256(JSON.stringify(result.rows)),
    names: result.rows.map((row) => row.viewname),
  };
}

async function moduleBindingFingerprint(database) {
  const result = await database.query(`
    SELECT dataset_code,module_code,contract_version,access_mode,usage_role,dependency_level,
           join_contract_json::text,status,created_at::text,updated_at::text
    FROM app.data_dataset_module_bindings
    ORDER BY dataset_code,module_code
  `);
  return sha256(JSON.stringify(result.rows));
}

async function expectRejected(tx, checks, name, statement, values, expectation) {
  const savepoint = `rehearsal_${checks.length + 1}`;
  await tx.execute(`SAVEPOINT ${savepoint}`);
  let caught = null;
  try {
    await tx.query(statement, values);
  } catch (error) {
    caught = error;
  }
  await tx.execute(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await tx.execute(`RELEASE SAVEPOINT ${savepoint}`);
  if (!caught) throw new Error(`Expected governance constraint rejection: ${name}`);
  const expected = typeof expectation === "string"
    ? caught.code === expectation
    : !expectation || expectation.test(String(caught.message || caught));
  if (!expected) {
    throw new Error(`Unexpected rejection for ${name}: ${String(caught.message || caught).slice(0, 300)}`);
  }
  checks.push(name);
}

async function exerciseGovernanceConstraints(database) {
  const checks = [];
  try {
    await database.transaction(async (tx) => {
      await tx.execute(`
        INSERT INTO app.commerce_shop_registry (
          id,platform,provider_shop_id,shop_name,normalized_shop_name,source_country_code,site_code,
          first_seen_at,last_seen_at,created_at,updated_at
        ) VALUES
          ('rehearsal-shop-1','SHOPEE','rehearsal-provider-1','Rehearsal Shop','rehearsal shop','MY','MY',
           CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('rehearsal-shop-2','SHOPEE','rehearsal-provider-2','Rehearsal Shop 2','rehearsal shop 2','MY','MY',
           CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      `);

      await expectRejected(tx, checks, "mapping-run-fingerprint-format", `
        INSERT INTO app.data_identity_mapping_runs (
          id,rule_code,rule_version,mapping_set_code,mapping_version,source_snapshot_fingerprint,
          mapping_set_fingerprint,input_fingerprint,mode,status,requested_by,started_at
        ) VALUES ('invalid-run','SHOP_MABANG_TO_CANONICAL_V1','2.0.0','COMMERCE_OPS_UNIFIED_FIELDS','2.0.0',
          'invalid','${"2".repeat(64)}','${"3".repeat(64)}','PREVIEW','RUNNING','rehearsal',CURRENT_TIMESTAMP)
      `, [], "23514");

      await tx.execute(`
        INSERT INTO app.data_identity_mapping_runs (
          id,rule_code,rule_version,mapping_set_code,mapping_version,source_snapshot_fingerprint,
          mapping_set_fingerprint,input_fingerprint,mode,status,requested_by,started_at
        ) VALUES
          ('rehearsal-run','SHOP_MABANG_TO_CANONICAL_V1','2.0.0','COMMERCE_OPS_UNIFIED_FIELDS','2.0.0',
           '${"1".repeat(64)}','${"2".repeat(64)}','${"3".repeat(64)}','PREVIEW','RUNNING','rehearsal',CURRENT_TIMESTAMP),
          ('relationship-run','PRICE_TO_SHOP_SCOPE_V1','2.0.0','COMMERCE_OPS_UNIFIED_FIELDS','2.0.0',
           '${"4".repeat(64)}','${"5".repeat(64)}','${"6".repeat(64)}','PREVIEW','RUNNING','rehearsal',CURRENT_TIMESTAMP)
      `);

      const sourceKey = JSON.stringify({ platform: "SHOPEE", normalized_source_shop_name: "rehearsal shop" });
      await expectRejected(tx, checks, "name-match-never-auto-approved", `
        INSERT INTO app.data_identity_candidates (
          id,mapping_run_id,source_entity_key_json,canonical_entity_type,canonical_entity_id,
          match_method,confidence,candidate_rank,eligibility,candidate_fingerprint
        ) VALUES ('auto-name-candidate','rehearsal-run',$1::jsonb,'SHOP','rehearsal-shop-2',
          'PLATFORM_COUNTRY_NAME',1,2,'AUTO_ELIGIBLE',$2)
      `, [sourceKey, "7".repeat(64)], "23514");

      await expectRejected(tx, checks, "relationship-rule-cannot-create-identity-candidate", `
        INSERT INTO app.data_identity_candidates (
          id,mapping_run_id,source_entity_key_json,canonical_entity_type,canonical_entity_id,
          match_method,confidence,candidate_rank,eligibility,candidate_fingerprint
        ) VALUES ('relationship-candidate','relationship-run',$1::jsonb,'SHOP','rehearsal-shop-1',
          'PLATFORM_COUNTRY_SHOP_TYPE',1,1,'HUMAN_REQUIRED',$2)
      `, [sourceKey, "8".repeat(64)], /relationship rules do not create/i);

      await tx.query(`
        INSERT INTO app.data_identity_candidates (
          id,mapping_run_id,source_entity_key_json,canonical_entity_type,canonical_entity_id,
          match_method,confidence,candidate_rank,eligibility,candidate_fingerprint
        ) VALUES ('rehearsal-candidate','rehearsal-run',$1::jsonb,'SHOP','rehearsal-shop-1',
          'PLATFORM_COUNTRY_NAME',1,1,'HUMAN_REQUIRED',$2)
      `, [sourceKey, "9".repeat(64)]);

      await expectRejected(tx, checks, "candidate-is-append-only",
        "UPDATE app.data_identity_candidates SET confidence=0.5 WHERE id='rehearsal-candidate'", [], /append-only/i);

      await tx.execute(`
        UPDATE app.data_identity_mapping_runs
        SET status='PREVIEW_READY',finished_at=CURRENT_TIMESTAMP,output_fingerprint='${"a".repeat(64)}'
        WHERE id='rehearsal-run'
      `);

      await expectRejected(tx, checks, "human-required-candidate-rejects-policy-approval", `
        INSERT INTO app.data_identity_candidate_decisions (
          id,candidate_id,decision,actor_type,actor_identifier,reason_code,reason,
          expected_candidate_fingerprint,idempotency_key,decided_at
        ) VALUES ('policy-decision','rehearsal-candidate','APPROVE','POLICY','rehearsal-policy',
          'AUTO','policy attempted approval',$1,'policy-decision',CURRENT_TIMESTAMP)
      `, ["9".repeat(64)], /human-required candidate cannot be policy-approved/i);

      await tx.query(`
        INSERT INTO app.data_identity_candidate_decisions (
          id,candidate_id,decision,actor_type,actor_identifier,reason_code,reason,
          expected_candidate_fingerprint,idempotency_key,decided_at
        ) VALUES ('human-decision','rehearsal-candidate','APPROVE','HUMAN','rehearsal-user',
          'MANUAL_REVIEW','isolated rehearsal approval',$1,'human-decision',CURRENT_TIMESTAMP)
      `, ["9".repeat(64)]);

      await expectRejected(tx, checks, "candidate-has-single-approval", `
        INSERT INTO app.data_identity_candidate_decisions (
          id,candidate_id,decision,actor_type,actor_identifier,reason_code,reason,
          expected_candidate_fingerprint,idempotency_key,decided_at
        ) VALUES ('duplicate-approval','rehearsal-candidate','APPROVE','HUMAN','rehearsal-user-2',
          'DUPLICATE','duplicate approval',$1,'duplicate-approval',CURRENT_TIMESTAMP)
      `, ["9".repeat(64)], "23505");

      await tx.query(`
        INSERT INTO app.data_identity_resolutions (
          id,candidate_id,approval_decision_id,canonical_entity_type,canonical_entity_id,
          source_dataset_code,source_key_version,source_entity_key_json,mapping_run_id,status,revision,
          effective_from,confirmed_by,confirmed_at
        ) VALUES ('rehearsal-resolution','rehearsal-candidate','human-decision','SHOP','rehearsal-shop-1',
          'MABANG_ORDER_FACTS','shop_platform_name_v1',$1::jsonb,'rehearsal-run','ACTIVE',1,
          CURRENT_TIMESTAMP,'rehearsal-user',CURRENT_TIMESTAMP)
      `, [sourceKey]);

      await expectRejected(tx, checks, "resolution-revoke-cannot-mutate-evidence", `
        UPDATE app.data_identity_resolutions
        SET status='REVOKED',effective_to=CURRENT_TIMESTAMP,evidence_json='{"tampered":true}'::jsonb
        WHERE id='rehearsal-resolution'
      `, [], /may only revoke/i);

      await tx.execute(`
        UPDATE app.data_identity_resolutions
        SET status='REVOKED',effective_to=CURRENT_TIMESTAMP
        WHERE id='rehearsal-resolution'
      `);
      checks.push("resolution-valid-revoke");

      await expectRejected(tx, checks, "open-issue-cannot-have-resolved-time", `
        INSERT INTO app.data_identity_mapping_issues (
          id,mapping_run_id,source_entity_key_json,issue_code,severity,status,resolved_at
        ) VALUES ('invalid-open-issue','rehearsal-run',$1::jsonb,'NO_CANDIDATE','ERROR','OPEN',CURRENT_TIMESTAMP)
      `, [sourceKey], "23514");

      throw new RehearsalRollback("rollback isolated governance fixtures");
    });
  } catch (error) {
    if (!(error instanceof RehearsalRollback)) throw error;
  }
  return checks;
}

function assertReplayRejected(config, environment, sql) {
  try {
    execFileSync("psql", [
      "--host", config.host,
      "--port", String(config.port),
      "--username", config.adminUser,
      "--dbname", rehearsalDatabase,
      "--set", "ON_ERROR_STOP=1",
      "--quiet",
    ], { env: environment, input: sql, maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const message = `${error?.stdout || ""}\n${error?.stderr || ""}`;
    if (/already been applied; replay is forbidden/i.test(message)) return true;
    throw new Error(`014 replay failed for an unexpected reason: ${message.trim().slice(0, 500)}`);
  }
  throw new Error("014 replay unexpectedly succeeded");
}

async function main() {
  if (!process.argv.includes("--confirm=CREATE_AND_DROP_ISOLATED_REHEARSAL")) {
    throw new Error("Exact isolated rehearsal confirmation is required");
  }
  const migrationSql = migrationPaths.map((migrationPath) => fs.readFileSync(migrationPath, "utf8"));
  const staticBoundary = assertGovernanceOnlySql(migrationSql[1]);
  loadLocalEnv(rootDir);
  const config = loadPostgresqlF1Config({ rootDir, env: process.env });
  const admin = provider(config, config.database);
  let created = false;
  try {
    const existing = await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [rehearsalDatabase]);
    if (existing.rowCount) throw new Error(`${rehearsalDatabase} already exists; refusing to overwrite it`);
    await admin.query(`CREATE DATABASE ${rehearsalDatabase}`);
    created = true;

    const environment = clientEnv(config);
    const dump = execFileSync("pg_dump", [
      "--host", config.host,
      "--port", String(config.port),
      "--username", config.adminUser,
      "--dbname", config.database,
      "--schema", "app",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
    ], { env: environment, maxBuffer: 32 * 1024 * 1024 });
    execFileSync("psql", [
      "--host", config.host,
      "--port", String(config.port),
      "--username", config.adminUser,
      "--dbname", rehearsalDatabase,
      "--set", "ON_ERROR_STOP=1",
      "--quiet",
    ], { env: environment, input: dump, maxBuffer: 32 * 1024 * 1024 });

    const target = provider(config, rehearsalDatabase);
    try {
      await target.executeScript(`
        INSERT INTO app.foundation_source_systems
          (code,source_type,display_name,status,metadata_json,created_at,updated_at)
        VALUES
          ('mabang','erp','Mabang ERP','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('shopee','marketplace','Shopee','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('lazada','marketplace','Lazada','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('tiktok_shop','marketplace','TikTok Shop','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('company_product_center','internal','Legacy Product Center','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('commerce_ops','internal','Commerce Ops','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP),
          ('ai_project_a','ai_provider','AI Project A','active','{}'::jsonb,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT (code) DO NOTHING;
      `);

      await target.executeScript(migrationSql[0]);
      const baseline = {
        structure: await structureFingerprint(target, protectedRelations),
        rows: await factRowFingerprint(target),
        views: await viewFingerprint(target),
        moduleBindings: await moduleBindingFingerprint(target),
      };

      await target.executeScript(migrationSql[1]);
      const after014 = {
        structure: await structureFingerprint(target, protectedRelations),
        rows: await factRowFingerprint(target),
        views: await viewFingerprint(target),
        moduleBindings: await moduleBindingFingerprint(target),
      };
      assert.equal(after014.structure, baseline.structure, "014 changed protected table structure");
      assert.equal(after014.rows, baseline.rows, "014 changed protected table rows");
      assert.equal(after014.views.fingerprint, baseline.views.fingerprint, "014 created or changed app views");
      assert.equal(after014.moduleBindings, baseline.moduleBindings, "014 changed module bindings");

      const catalog = await syncUnifiedFieldMappingCatalog({ provider: target, status: "DRAFT" });
      const afterCatalog = {
        structure: await structureFingerprint(target, protectedRelations),
        rows: await factRowFingerprint(target),
        views: await viewFingerprint(target),
        moduleBindings: await moduleBindingFingerprint(target),
      };
      assert.equal(afterCatalog.structure, baseline.structure, "DRAFT catalog sync changed protected table structure");
      assert.equal(afterCatalog.rows, baseline.rows, "DRAFT catalog sync changed protected table rows");
      assert.equal(afterCatalog.views.fingerprint, baseline.views.fingerprint, "DRAFT catalog sync created or changed app views");
      assert.equal(afterCatalog.moduleBindings, baseline.moduleBindings, "DRAFT catalog sync changed module bindings");

      const constraints = await exerciseGovernanceConstraints(target);
      const replayRejected = assertReplayRejected(config, environment, migrationSql[1]);
      const result = await target.query(`
        SELECT
          current_database() AS database,
          (SELECT count(*) FROM app.data_source_registry) AS sources,
          (SELECT count(*) FROM app.data_dataset_registry) AS datasets,
          (SELECT count(*) FROM app.data_dataset_module_bindings) AS bindings,
          (SELECT count(*) FROM information_schema.views
            WHERE table_schema='app' AND table_name LIKE 'canonical\\_%' ESCAPE '\\') AS canonical_views,
          (SELECT count(*) FROM information_schema.views
            WHERE table_schema='app' AND table_name LIKE 'canonical\\_%\\_v2' ESCAPE '\\') AS v2_views,
          (SELECT count(*) FROM pg_class relation
            JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname='app' AND relation.relname LIKE 'data_identity_backfill\\_%' ESCAPE '\\') AS backfill_relations,
          (SELECT count(*) FROM app.data_field_mappings WHERE status='DRAFT') AS draft_field_mappings,
          (SELECT count(*) FROM app.data_identity_rule_catalog WHERE status='DRAFT') AS draft_identity_rules,
          (SELECT count(*) FROM app.data_contract_versions WHERE status='DRAFT') AS draft_contracts,
          (SELECT count(*) FROM app.data_contract_versions
            WHERE status='DRAFT' AND relation_name IS NOT NULL) AS materialized_draft_contracts,
          (SELECT count(*) FROM app.data_contract_versions
            WHERE contract_version='2.0.0' AND status='PUBLISHED') AS published_v2_contracts,
          (SELECT count(*) FROM app.data_candidate_migration_history
            WHERE migration_id='014_identity_crosswalk_catalog_v2') AS migration_history_rows
      `);
      const counts = result.rows[0];
      assert.equal(Number(counts.v2_views), 0, "014 must leave zero V2 views");
      assert.equal(Number(counts.backfill_relations), 0, "014 must leave zero backfill ledger relations");
      assert.equal(Number(counts.draft_contracts), 8, "014 must register eight DRAFT contracts");
      assert.equal(Number(counts.materialized_draft_contracts), 0, "DRAFT contracts must not materialize relations");
      assert.equal(Number(counts.published_v2_contracts), 0, "014 must not publish V2 contracts");
      assert.equal(Number(counts.migration_history_rows), 1, "014 migration history must contain one row");
      for (const relation of governanceRelations) {
        const present = await target.query("SELECT to_regclass($1)::text AS relation_name", [`app.${relation}`]);
        assert.equal(present.rows[0]?.relation_name, relation, `Governance relation is missing: app.${relation}`);
      }

      return {
        status: "PASS",
        database: counts.database,
        sources: Number(counts.sources),
        datasets: Number(counts.datasets),
        bindings: Number(counts.bindings),
        canonicalViews: Number(counts.canonical_views),
        catalog,
        boundaries: {
          ...staticBoundary,
          protectedStructureUnchanged: true,
          protectedRowsUnchanged: true,
          appViewsUnchanged: true,
          moduleBindingsUnchanged: true,
          v2Views: Number(counts.v2_views),
          backfillRelations: Number(counts.backfill_relations),
          materializedDraftContracts: Number(counts.materialized_draft_contracts),
          publishedV2Contracts: Number(counts.published_v2_contracts),
          replayRejected,
        },
        governanceConstraints: { passed: constraints.length, checks: constraints },
        productionWrites: 0,
      };
    } finally {
      await target.close();
    }
  } finally {
    if (created) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [rehearsalDatabase]);
      await admin.query(`DROP DATABASE ${rehearsalDatabase}`);
    }
    await admin.close();
  }
}

main()
  .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
  .catch((error) => {
    process.stderr.write(`Unified data migration rehearsal failed: ${String(error?.message || error).split(/\r?\n/)[0].slice(0, 500)}\n`);
    process.exitCode = 1;
  });
