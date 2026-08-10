import {
  FIELD_MAPPING_MODE,
  UNIFIED_IDENTITY_RULES,
  UNIFIED_SOURCE_FIELD_MAPPINGS,
  validateUnifiedFieldMappings,
} from "./unified-field-mappings.mjs";
import { DATASET_CODES } from "./unified-data-contracts.mjs";

const MAPPING_SET_CODE = "COMMERCE_OPS_UNIFIED_FIELDS";
const requiredRank = Object.freeze({ OPTIONAL: 0, CONDITIONAL: 1, REQUIRED: 2 });
const sensitivityRank = Object.freeze({ PUBLIC: 0, INTERNAL: 1, CONFIDENTIAL: 2, RESTRICTED: 3 });

// These columns are produced by governed transforms/identity resolution rather
// than copied one-for-one from a physical source column. Keeping them in the
// contract catalogue makes every identity-rule key independently verifiable.
const DERIVED_DATASET_COLUMNS = Object.freeze([
  Object.freeze({
    datasetCode: DATASET_CODES.PRODUCT_MASTER_CURRENT,
    columnName: "product.country_code",
    dataType: "text",
    requiredLevel: "REQUIRED",
    nullSemantics: "FORBIDDEN",
    identityRole: "BUSINESS_KEY",
    sensitivity: "INTERNAL",
    description: "Canonical country code resolved from the authoritative product-package row.",
  }),
  Object.freeze({
    datasetCode: DATASET_CODES.PRODUCT_MASTER_CURRENT,
    columnName: "product.sku_code_normalized",
    dataType: "text",
    requiredLevel: "REQUIRED",
    nullSemantics: "FORBIDDEN",
    identityRole: "BUSINESS_KEY",
    sensitivity: "INTERNAL",
    description: "Canonical NFKC/uppercase SKU used by the product identity bridge.",
  }),
  Object.freeze({
    datasetCode: DATASET_CODES.PRODUCT_MASTER_CURRENT,
    columnName: "product.canonical_product_id",
    dataType: "text",
    requiredLevel: "REQUIRED",
    nullSemantics: "FORBIDDEN",
    identityRole: "CANONICAL_ID",
    sensitivity: "INTERNAL",
    description: "Resolved immutable product identity; candidates never populate this field.",
  }),
  ...["platform", "shop_type", "price_type"].map((name) => Object.freeze({
    datasetCode: DATASET_CODES.PRICE_CONTROL_CURRENT,
    columnName: `price.${name}`,
    dataType: "text",
    requiredLevel: "REQUIRED",
    nullSemantics: "FORBIDDEN",
    identityRole: name === "price_type" ? "NONE" : "BUSINESS_KEY",
    sensitivity: "INTERNAL",
    description: `Long-form price discriminator derived from the source price column (${name}).`,
  })),
]);

function sqlMappingKind(mode) {
  return mode === FIELD_MAPPING_MODE.REDACT ? "DROP" : mode;
}

function mappingRole(identityRole) {
  return identityRole === "NONE" ? "VALUE" : "IDENTITY_KEY";
}

function nullPolicy(item) {
  if (item.mode === FIELD_MAPPING_MODE.REDACT || item.nullSemantics === "NOT_APPLICABLE") return "NOT_APPLICABLE";
  if (item.nullSemantics === "FORBIDDEN") return "REJECT";
  if (item.nullSemantics === "CARRY_FORWARD") return "CARRY_FORWARD";
  return "PRESERVE_NULL";
}

function inferDataType(item) {
  const transform = String(item.transformCode || "").toLowerCase();
  if (transform.includes("datetime") || transform.includes("_utc")) return "timestamptz";
  if (transform.startsWith("date_")) return "date";
  if (transform.includes("decimal") || transform.includes("number") || transform.includes("integer")
      || transform.startsWith("price_wide_to_long")) return "numeric";
  if (transform.includes("boolean")) return "boolean";
  if (item.sourceField.endsWith("_json") || item.canonicalField.endsWith(".metadata")) return "jsonb";
  return "text";
}

function requiredText(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

function stronger(current, incoming, rank) {
  return (rank[incoming] ?? 0) > (rank[current] ?? 0) ? incoming : current;
}

function targetColumns() {
  const columns = new Map();
  for (const item of UNIFIED_SOURCE_FIELD_MAPPINGS) {
    const key = `${item.datasetCode}\u0000${item.canonicalField}`;
    const existing = columns.get(key);
    if (!existing) {
      columns.set(key, {
        datasetCode: item.datasetCode,
        columnName: item.canonicalField,
        dataType: inferDataType(item),
        requiredLevel: item.requiredLevel,
        nullSemantics: item.nullSemantics,
        identityRole: item.identityRole,
        sensitivity: item.sensitivity,
        description: item.description || `Canonical field mapped from ${item.sourceCode}.`,
      });
      continue;
    }
    existing.requiredLevel = stronger(existing.requiredLevel, item.requiredLevel, requiredRank);
    existing.sensitivity = stronger(existing.sensitivity, item.sensitivity, sensitivityRank);
    if (existing.identityRole === "NONE" && item.identityRole !== "NONE") existing.identityRole = item.identityRole;
    if (existing.nullSemantics !== item.nullSemantics) existing.nullSemantics = "UNKNOWN";
    if (existing.dataType !== inferDataType(item)) existing.dataType = "text";
  }
  for (const column of DERIVED_DATASET_COLUMNS) {
    const key = `${column.datasetCode}\u0000${column.columnName}`;
    if (columns.has(key)) throw new TypeError(`derived dataset column duplicates a mapped field: ${key}`);
    columns.set(key, { ...column });
  }
  return [...columns.values()];
}

function validateIdentityRuleKeys(columns) {
  const availableColumns = new Set(columns.map((column) => `${column.datasetCode}\u0000${column.columnName}`));
  for (const rule of UNIFIED_IDENTITY_RULES) {
    for (const key of rule.sourceKeys) {
      if (!availableColumns.has(`${rule.sourceDatasetCode}\u0000${key}`)) {
        throw new TypeError(`identity rule ${rule.code} has undeclared source key ${rule.sourceDatasetCode}.${key}`);
      }
    }
    for (const key of rule.targetKeys) {
      if (!availableColumns.has(`${rule.targetDatasetCode}\u0000${key}`)) {
        throw new TypeError(`identity rule ${rule.code} has undeclared target key ${rule.targetDatasetCode}.${key}`);
      }
    }
  }
}

async function validateActivationContracts(provider, mappingVersion, columns) {
  const datasetCodes = [...new Set([
    ...columns.map((column) => column.datasetCode),
    ...UNIFIED_IDENTITY_RULES.flatMap((rule) => [rule.sourceDatasetCode, rule.targetDatasetCode]),
  ])];
  const result = await provider.query(`
    SELECT registry.dataset_code,registry.current_contract_version,contract.status,
           contract.relation_name,contract.quality_run_id
    FROM app.data_dataset_registry registry
    LEFT JOIN app.data_contract_versions contract
      ON contract.dataset_code=registry.dataset_code AND contract.contract_version=$1
    WHERE registry.dataset_code = ANY($2::text[])
  `, [mappingVersion, datasetCodes]);
  const valid = new Set(result.rows.filter((row) =>
    row.current_contract_version === mappingVersion
      && new Set(["VALIDATED", "PUBLISHED"]).has(row.status)
      && String(row.relation_name || "").trim()
      && String(row.quality_run_id || "").trim()
  ).map((row) => row.dataset_code));
  const invalid = datasetCodes.filter((datasetCode) => !valid.has(datasetCode));
  if (invalid.length) {
    throw new Error(`Cannot activate unified mappings before validated current contracts exist: ${invalid.join(", ")}`);
  }
}

async function relationExists(provider, relation) {
  const result = await provider.query("SELECT to_regclass($1)::text AS relation_name", [relation]);
  return Boolean(result.rows[0]?.relation_name);
}

async function validatePhysicalTargets(provider) {
  const targets = new Map();
  for (const item of UNIFIED_SOURCE_FIELD_MAPPINGS) {
    if (!item.targetRelation || !item.targetColumn) continue;
    targets.set(`${item.targetRelation}\u0000${item.targetColumn}`, item);
  }
  for (const item of targets.values()) {
    const [schemaName, tableName] = item.targetRelation.split(".");
    const result = await provider.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema=$1 AND table_name=$2 AND column_name=$3
    `, [schemaName, tableName, item.targetColumn]);
    if (!result.rowCount) throw new Error(`Physical mapping target is missing: ${item.targetRelation}.${item.targetColumn}`);
  }
  return targets.size;
}

export async function syncUnifiedFieldMappingCatalog({
  provider,
  mappingVersion = "2.0.0",
  status = "DRAFT",
} = {}) {
  if (!provider) throw new TypeError("provider is required");
  requiredText(mappingVersion, "mappingVersion");
  if (!new Set(["DRAFT", "ACTIVE"]).has(status)) throw new TypeError("status must be DRAFT or ACTIVE");
  validateUnifiedFieldMappings();
  for (const relation of [
    "app.data_contract_versions",
    "app.data_source_field_catalog",
    "app.data_dataset_columns",
    "app.data_field_mappings",
    "app.data_identity_rule_catalog",
  ]) {
    if (!await relationExists(provider, relation)) throw new Error(`Unified field mapping relation is missing: ${relation}`);
  }
  const physicalTargetsValidated = await validatePhysicalTargets(provider);
  const columns = targetColumns();
  validateIdentityRuleKeys(columns);
  if (status === "ACTIVE") await validateActivationContracts(provider, mappingVersion, columns);

  return provider.transaction(async (tx) => {
    await tx.execute(`
      UPDATE app.data_source_field_catalog SET status='RETIRED',updated_at=CURRENT_TIMESTAMP
      WHERE mapping_set_code=$1 AND mapping_version=$2
    `, [MAPPING_SET_CODE, mappingVersion]);
    await tx.execute(`
      UPDATE app.data_field_mappings SET status='RETIRED',valid_to=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE mapping_set_code=$1 AND mapping_version=$2
    `, [MAPPING_SET_CODE, mappingVersion]);
    await tx.execute(`
      UPDATE app.data_identity_rule_catalog SET status='RETIRED',updated_at=CURRENT_TIMESTAMP
      WHERE rule_version=$1
    `, [mappingVersion]);

    let sourceFields = 0;
    for (const item of UNIFIED_SOURCE_FIELD_MAPPINGS) {
      const values = [
        MAPPING_SET_CODE, mappingVersion, item.sourceCode, item.datasetCode, item.sourceRelation, item.sourceField,
        inferDataType(item), item.requiredLevel, item.nullSemantics, item.identityRole, item.sensitivity,
        item.publicationScope, item.description, status,
      ];
      await tx.execute(`
        INSERT INTO app.data_source_field_catalog (
          mapping_set_code,mapping_version,source_code,source_dataset_code,source_relation,source_field_path,
          source_data_type,required_level,null_semantics,identity_role,sensitivity,publication_scope,description,status
        ) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})
        ON CONFLICT (mapping_set_code,mapping_version,source_code,source_dataset_code,source_relation,source_field_path)
        DO UPDATE SET source_data_type=EXCLUDED.source_data_type,required_level=EXCLUDED.required_level,
          null_semantics=EXCLUDED.null_semantics,identity_role=EXCLUDED.identity_role,
          sensitivity=EXCLUDED.sensitivity,publication_scope=EXCLUDED.publication_scope,
          description=EXCLUDED.description,status=EXCLUDED.status,updated_at=CURRENT_TIMESTAMP
      `, values);
      sourceFields += 1;
    }

    let datasetColumns = 0;
    for (const column of columns) {
      const values = [column.datasetCode, mappingVersion, column.columnName, column.dataType, column.requiredLevel,
        column.nullSemantics, column.identityRole, column.sensitivity, column.description];
      await tx.execute(`
        INSERT INTO app.data_dataset_columns (
          dataset_code,contract_version,column_name,data_type,required_level,null_semantics,
          identity_role,sensitivity,description
        ) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})
        ON CONFLICT (dataset_code,contract_version,column_name) DO UPDATE SET
          data_type=EXCLUDED.data_type,required_level=EXCLUDED.required_level,
          null_semantics=EXCLUDED.null_semantics,identity_role=EXCLUDED.identity_role,
          sensitivity=EXCLUDED.sensitivity,description=EXCLUDED.description
      `, values);
      datasetColumns += 1;
    }

    let fieldMappings = 0;
    for (const item of UNIFIED_SOURCE_FIELD_MAPPINGS) {
      const id = `${mappingVersion}:${item.id}`;
      const values = [
        id, MAPPING_SET_CODE, mappingVersion, item.sourceCode, item.datasetCode, item.sourceRelation,
        item.sourceField, item.rawTarget, item.datasetCode, mappingVersion, item.canonicalField,
        item.targetRelation, item.targetColumn, mappingRole(item.identityRole), sqlMappingKind(item.mode),
        item.transformCode, item.requiredLevel, nullPolicy(item), item.sensitivity, item.publicationScope,
        item.cardinality, item.description, status,
      ];
      await tx.execute(`
        INSERT INTO app.data_field_mappings (
          id,mapping_set_code,mapping_version,source_code,source_dataset_code,source_relation,source_field_path,
          raw_target_path,target_dataset_code,target_contract_version,canonical_field_path,target_relation,target_column_name,
          mapping_role,mapping_kind,transform_code,required_level,null_policy,sensitivity,publication_scope,
          cardinality,description,status
        ) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})
        ON CONFLICT (id) DO UPDATE SET
          raw_target_path=EXCLUDED.raw_target_path,target_relation=EXCLUDED.target_relation,
          target_column_name=EXCLUDED.target_column_name,mapping_role=EXCLUDED.mapping_role,
          mapping_kind=EXCLUDED.mapping_kind,transform_code=EXCLUDED.transform_code,
          required_level=EXCLUDED.required_level,null_policy=EXCLUDED.null_policy,
          sensitivity=EXCLUDED.sensitivity,publication_scope=EXCLUDED.publication_scope,
          cardinality=EXCLUDED.cardinality,description=EXCLUDED.description,status=EXCLUDED.status,
          valid_to=NULL,updated_at=CURRENT_TIMESTAMP
      `, values);
      fieldMappings += 1;
    }

    let identityRules = 0;
    for (const rule of UNIFIED_IDENTITY_RULES) {
      const values = [
        rule.code, mappingVersion, rule.ruleKind, rule.canonicalEntityType, rule.sourceDatasetCode,
        rule.targetDatasetCode, rule.sourceKeyVersion, JSON.stringify(rule.sourceKeys), JSON.stringify(rule.targetKeys),
        JSON.stringify(rule.allowedMatchMethods), rule.cardinality, rule.acceptance, rule.conflict, status,
      ];
      await tx.execute(`
        INSERT INTO app.data_identity_rule_catalog (
          rule_code,rule_version,rule_kind,canonical_entity_type,source_dataset_code,target_dataset_code,
          source_key_version,source_keys_json,target_keys_json,allowed_match_methods_json,
          cardinality,acceptance_policy,conflict_policy,status
        ) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})
        ON CONFLICT (rule_code,rule_version) DO UPDATE SET
          rule_kind=EXCLUDED.rule_kind,canonical_entity_type=EXCLUDED.canonical_entity_type,
          source_dataset_code=EXCLUDED.source_dataset_code,target_dataset_code=EXCLUDED.target_dataset_code,
          source_key_version=EXCLUDED.source_key_version,source_keys_json=EXCLUDED.source_keys_json,
          target_keys_json=EXCLUDED.target_keys_json,allowed_match_methods_json=EXCLUDED.allowed_match_methods_json,
          cardinality=EXCLUDED.cardinality,acceptance_policy=EXCLUDED.acceptance_policy,
          conflict_policy=EXCLUDED.conflict_policy,status=EXCLUDED.status,updated_at=CURRENT_TIMESTAMP
      `, values);
      identityRules += 1;
    }

    if (status === "ACTIVE") {
      await tx.execute(`
        UPDATE app.data_field_mappings SET status='RETIRED',valid_to=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
        WHERE mapping_set_code=$1 AND mapping_version<>$2 AND status='ACTIVE'
      `, [MAPPING_SET_CODE, mappingVersion]);
      await tx.execute(`
        UPDATE app.data_identity_rule_catalog SET status='RETIRED',updated_at=CURRENT_TIMESTAMP
        WHERE rule_version<>$1 AND status='ACTIVE'
      `, [mappingVersion]);
    }

    const integrity = await tx.query(`
      SELECT count(*) AS mapping_count,
             count(source_field.source_field_path) AS source_contract_count,
             count(target_column.column_name) AS target_contract_count
      FROM app.data_field_mappings mapping
      LEFT JOIN app.data_source_field_catalog source_field
        ON source_field.mapping_set_code=mapping.mapping_set_code
       AND source_field.mapping_version=mapping.mapping_version
       AND source_field.source_code=mapping.source_code
       AND source_field.source_dataset_code=mapping.source_dataset_code
       AND source_field.source_relation=mapping.source_relation
       AND source_field.source_field_path=mapping.source_field_path
      LEFT JOIN app.data_dataset_columns target_column
        ON target_column.dataset_code=mapping.target_dataset_code
       AND target_column.contract_version=mapping.target_contract_version
       AND target_column.column_name=mapping.canonical_field_path
      WHERE mapping.mapping_set_code=$1 AND mapping.mapping_version=$2 AND mapping.status=$3
    `, [MAPPING_SET_CODE, mappingVersion, status]);
    const counts = integrity.rows[0] || {};
    if (Number(counts.mapping_count) !== fieldMappings
        || Number(counts.source_contract_count) !== fieldMappings
        || Number(counts.target_contract_count) !== fieldMappings) {
      throw new Error("Unified field mapping catalogue failed source/target contract integrity validation");
    }

    return Object.freeze({
      mappingSetCode: MAPPING_SET_CODE,
      mappingVersion,
      status,
      sourceFields,
      datasetColumns,
      fieldMappings,
      identityRules,
      physicalTargetsValidated,
    });
  });
}
