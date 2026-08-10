# Commerce Ops SQLite Tables 01

Snapshot date: 2026-08-05

This appendix records exact SQLite fields, keys, foreign keys, indexes, and row counts.

## dingtalk_robot_configs

- Rows: 4
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
name | type=TEXT | not_null=true | default=(none) | pk_order=0
encrypted_webhook_url | type=TEXT | not_null=true | default=(none) | pk_order=0
encrypted_secret | type=TEXT | not_null=false | default=(none) | pk_order=0
enabled | type=INTEGER | not_null=true | default=1 | pk_order=0
notify_on_success | type=INTEGER | not_null=true | default=1 | pk_order=0
notify_on_failure | type=INTEGER | not_null=true | default=1 | pk_order=0
notify_on_empty | type=INTEGER | not_null=true | default=1 | pk_order=0
at_all | type=INTEGER | not_null=true | default=0 | pk_order=0
at_mobiles_json | type=TEXT | not_null=true | default='[]' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- none

Indexes:
- `sqlite_autoindex_dingtalk_robot_configs_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## export_files

- Rows: 20
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
file_type | type=TEXT | not_null=true | default='excel' | pk_order=0
source_type | type=TEXT | not_null=true | default=(none) | pk_order=0
task_id | type=TEXT | not_null=false | default=(none) | pk_order=0
run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
request_key | type=TEXT | not_null=false | default=(none) | pk_order=0
original_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
storage_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
relative_path | type=TEXT | not_null=true | default=(none) | pk_order=0
mime_type | type=TEXT | not_null=true | default='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' | pk_order=0
file_size | type=INTEGER | not_null=true | default=0 | pk_order=0
file_hash | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='available' | pk_order=0
expires_at | type=TEXT | not_null=false | default=(none) | pk_order=0
missing_at | type=TEXT | not_null=false | default=(none) | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `run_id` -> `scheduled_export_runs.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `task_id` -> `scheduled_export_tasks.id` (id=1, seq=0, on_update=NO ACTION, on_delete=SET NULL)

Indexes:
- `idx_export_files_request_key` (unique=true, origin=c, partial=true): [request_key]; CREATE UNIQUE INDEX idx_export_files_request_key   ON export_files(request_key)   WHERE request_key IS NOT NULL
- `idx_export_files_status` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_export_files_status   ON export_files(status, created_at DESC)
- `idx_export_files_run_id` (unique=false, origin=c, partial=false): [run_id]; CREATE INDEX idx_export_files_run_id   ON export_files(run_id)
- `idx_export_files_task_id` (unique=false, origin=c, partial=false): [task_id, created_at DESC]; CREATE INDEX idx_export_files_task_id   ON export_files(task_id, created_at DESC)
- `idx_export_files_source_type` (unique=false, origin=c, partial=false): [source_type, created_at DESC]; CREATE INDEX idx_export_files_source_type   ON export_files(source_type, created_at DESC)
- `idx_export_files_created_at` (unique=false, origin=c, partial=false): [created_at DESC]; CREATE INDEX idx_export_files_created_at   ON export_files(created_at DESC)
- `idx_export_files_expiry` (unique=false, origin=c, partial=false): [status, expires_at]; CREATE INDEX idx_export_files_expiry   ON export_files(status, expires_at)
- `sqlite_autoindex_export_files_3` (unique=true, origin=u, partial=false): [relative_path]; (implicit)
- `sqlite_autoindex_export_files_2` (unique=true, origin=u, partial=false): [run_id]; (implicit)
- `sqlite_autoindex_export_files_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## file_lifecycle_items

- Rows: 14
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
scan_id | type=TEXT | not_null=true | default=(none) | pk_order=0
classification | type=TEXT | not_null=true | default=(none) | pk_order=0
categories_json | type=TEXT | not_null=true | default='[]' | pk_order=0
scope | type=TEXT | not_null=true | default=(none) | pk_order=0
source_type | type=TEXT | not_null=false | default=(none) | pk_order=0
file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
task_id | type=TEXT | not_null=false | default=(none) | pk_order=0
run_id | type=TEXT | not_null=false | default=(none) | pk_order=0
masked_filename | type=TEXT | not_null=true | default=(none) | pk_order=0
file_size | type=INTEGER | not_null=true | default=0 | pk_order=0
file_created_at | type=TEXT | not_null=false | default=(none) | pk_order=0
file_modified_at | type=TEXT | not_null=false | default=(none) | pk_order=0
database_status | type=TEXT | not_null=false | default=(none) | pk_order=0
physical_status | type=TEXT | not_null=true | default=(none) | pk_order=0
suggest_quarantine | type=INTEGER | not_null=true | default=0 | pk_order=0
suggest_cleanup | type=INTEGER | not_null=true | default=0 | pk_order=0
reason_code | type=TEXT | not_null=true | default=(none) | pk_order=0
short_hash | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
detected_file_type | type=TEXT | not_null=false | default=(none) | pk_order=0
review_status | type=TEXT | not_null=true | default='pending_review' | pk_order=0
reviewed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
reviewed_by | type=TEXT | not_null=false | default=(none) | pk_order=0
review_reason | type=TEXT | not_null=false | default=(none) | pk_order=0
root_key | type=TEXT | not_null=false | default=(none) | pk_order=0
relative_path | type=TEXT | not_null=false | default=(none) | pk_order=0
full_hash | type=TEXT | not_null=false | default=(none) | pk_order=0
job_id | type=TEXT | not_null=false | default=(none) | pk_order=0
mime_type | type=TEXT | not_null=false | default=(none) | pk_order=0
signature_code | type=TEXT | not_null=false | default=(none) | pk_order=0
detection_reason_code | type=TEXT | not_null=false | default=(none) | pk_order=0
managed_file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
original_relative_path | type=TEXT | not_null=false | default=(none) | pk_order=0
quarantine_relative_path | type=TEXT | not_null=false | default=(none) | pk_order=0
quarantined_at | type=TEXT | not_null=false | default=(none) | pk_order=0
restored_at | type=TEXT | not_null=false | default=(none) | pk_order=0
deleted_at | type=TEXT | not_null=false | default=(none) | pk_order=0
```

Foreign keys:
- `scan_id` -> `file_lifecycle_scans.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_lifecycle_items_review` (unique=false, origin=c, partial=false): [scan_id, review_status, detected_file_type]; CREATE INDEX idx_lifecycle_items_review   ON file_lifecycle_items(scan_id, review_status, detected_file_type)
- `idx_lifecycle_items_file` (unique=false, origin=c, partial=false): [file_id]; CREATE INDEX idx_lifecycle_items_file ON file_lifecycle_items(file_id)
- `idx_lifecycle_items_source` (unique=false, origin=c, partial=false): [scan_id, source_type]; CREATE INDEX idx_lifecycle_items_source ON file_lifecycle_items(scan_id, source_type)
- `idx_lifecycle_items_scan` (unique=false, origin=c, partial=false): [scan_id, classification, created_at DESC]; CREATE INDEX idx_lifecycle_items_scan ON file_lifecycle_items(scan_id, classification, created_at DESC)
- `sqlite_autoindex_file_lifecycle_items_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## file_lifecycle_protected_files

- Rows: 2
- Primary key: `file_id`

Columns:

```text
file_id | type=TEXT | not_null=false | default=(none) | pk_order=1
reason | type=TEXT | not_null=true | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `file_id` -> `export_files.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `sqlite_autoindex_file_lifecycle_protected_files_1` (unique=true, origin=pk, partial=false): [file_id]; (implicit)

## file_lifecycle_scans

- Rows: 1
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
status | type=TEXT | not_null=true | default=(none) | pk_order=0
scopes_json | type=TEXT | not_null=true | default='[]' | pk_order=0
summary_json | type=TEXT | not_null=true | default='{}' | pk_order=0
scope_errors_json | type=TEXT | not_null=true | default='[]' | pk_order=0
total_files | type=INTEGER | not_null=true | default=0 | pk_order=0
total_bytes | type=INTEGER | not_null=true | default=0 | pk_order=0
truncated | type=INTEGER | not_null=true | default=0 | pk_order=0
report_file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
error_code | type=TEXT | not_null=false | default=(none) | pk_order=0
started_at | type=TEXT | not_null=true | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `report_file_id` -> `export_files.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)

Indexes:
- `idx_lifecycle_scans_status` (unique=false, origin=c, partial=false): [status, created_at DESC]; CREATE INDEX idx_lifecycle_scans_status ON file_lifecycle_scans(status, created_at DESC)
- `idx_lifecycle_scans_created` (unique=false, origin=c, partial=false): [created_at DESC]; CREATE INDEX idx_lifecycle_scans_created ON file_lifecycle_scans(created_at DESC)
- `sqlite_autoindex_file_lifecycle_scans_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## file_quarantine_records

- Rows: 0
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
lifecycle_item_id | type=TEXT | not_null=true | default=(none) | pk_order=0
managed_file_id | type=TEXT | not_null=false | default=(none) | pk_order=0
root_key | type=TEXT | not_null=true | default=(none) | pk_order=0
original_relative_path | type=TEXT | not_null=true | default=(none) | pk_order=0
quarantine_relative_path | type=TEXT | not_null=true | default=(none) | pk_order=0
file_size | type=INTEGER | not_null=true | default=(none) | pk_order=0
file_hash | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
quarantined_at | type=TEXT | not_null=true | default=(none) | pk_order=0
quarantined_by | type=TEXT | not_null=true | default=(none) | pk_order=0
quarantine_reason | type=TEXT | not_null=true | default=(none) | pk_order=0
restored_at | type=TEXT | not_null=false | default=(none) | pk_order=0
restored_by | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `managed_file_id` -> `managed_files.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `lifecycle_item_id` -> `file_lifecycle_items.id` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_quarantine_records_status` (unique=false, origin=c, partial=false): [status, quarantined_at DESC]; CREATE INDEX idx_quarantine_records_status   ON file_quarantine_records(status, quarantined_at DESC)
- `sqlite_autoindex_file_quarantine_records_2` (unique=true, origin=u, partial=false): [quarantine_relative_path]; (implicit)
- `sqlite_autoindex_file_quarantine_records_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## foundation_account_capabilities

- Rows: 10
- Primary key: `account_id`, `capability_code`

Columns:

```text
account_id | type=TEXT | not_null=true | default=(none) | pk_order=1
capability_code | type=TEXT | not_null=true | default=(none) | pk_order=2
status | type=TEXT | not_null=true | default='active' | pk_order=0
config_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `account_id` -> `foundation_integration_accounts.id` (id=0, seq=0, on_update=NO ACTION, on_delete=CASCADE)

Indexes:
- `idx_foundation_capabilities_lookup` (unique=false, origin=c, partial=false): [capability_code, status, account_id]; CREATE INDEX idx_foundation_capabilities_lookup   ON foundation_account_capabilities(capability_code, status, account_id)
- `sqlite_autoindex_foundation_account_capabilities_1` (unique=true, origin=pk, partial=false): [account_id, capability_code]; (implicit)

## foundation_identity_links

- Rows: 24,983
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
entity_type | type=TEXT | not_null=true | default=(none) | pk_order=0
entity_id | type=TEXT | not_null=true | default=(none) | pk_order=0
source_system_code | type=TEXT | not_null=true | default=(none) | pk_order=0
source_entity_type | type=TEXT | not_null=true | default=(none) | pk_order=0
external_key | type=TEXT | not_null=true | default=(none) | pk_order=0
normalized_external_key | type=TEXT | not_null=true | default=(none) | pk_order=0
match_status | type=TEXT | not_null=true | default='confirmed' | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
first_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
last_seen_at | type=TEXT | not_null=true | default=(none) | pk_order=0
confirmed_by | type=TEXT | not_null=false | default=(none) | pk_order=0
confirmed_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_system_code` -> `foundation_source_systems.code` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_foundation_identity_entity` (unique=false, origin=c, partial=false): [entity_type, entity_id, match_status]; CREATE INDEX idx_foundation_identity_entity   ON foundation_identity_links(entity_type, entity_id, match_status)
- `sqlite_autoindex_foundation_identity_links_2` (unique=true, origin=u, partial=false): [source_system_code, source_entity_type, normalized_external_key]; (implicit)
- `sqlite_autoindex_foundation_identity_links_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## foundation_integration_accounts

- Rows: 3
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system_code | type=TEXT | not_null=true | default=(none) | pk_order=0
display_name | type=TEXT | not_null=true | default=(none) | pk_order=0
credential_ref_type | type=TEXT | not_null=true | default=(none) | pk_order=0
credential_ref_id | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='active' | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
last_verified_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_system_code` -> `foundation_source_systems.code` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_foundation_accounts_source_status` (unique=false, origin=c, partial=false): [source_system_code, status, display_name]; CREATE INDEX idx_foundation_accounts_source_status   ON foundation_integration_accounts(source_system_code, status, display_name)
- `sqlite_autoindex_foundation_integration_accounts_2` (unique=true, origin=u, partial=false): [source_system_code, credential_ref_type, credential_ref_id]; (implicit)
- `sqlite_autoindex_foundation_integration_accounts_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## foundation_owners

- Rows: 22
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
display_name | type=TEXT | not_null=true | default=(none) | pk_order=0
source_system_code | type=TEXT | not_null=false | default=(none) | pk_order=0
external_key | type=TEXT | not_null=false | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default='active' | pk_order=0
metadata_json | type=TEXT | not_null=true | default='{}' | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `source_system_code` -> `foundation_source_systems.code` (id=0, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_foundation_owners_status_name` (unique=false, origin=c, partial=false): [status, display_name]; CREATE INDEX idx_foundation_owners_status_name   ON foundation_owners(status, display_name)
- `sqlite_autoindex_foundation_owners_2` (unique=true, origin=u, partial=false): [source_system_code, external_key]; (implicit)
- `sqlite_autoindex_foundation_owners_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

## foundation_source_runs

- Rows: 5
- Primary key: `id`

Columns:

```text
id | type=TEXT | not_null=false | default=(none) | pk_order=1
source_system_code | type=TEXT | not_null=true | default=(none) | pk_order=0
account_id | type=TEXT | not_null=false | default=(none) | pk_order=0
domain | type=TEXT | not_null=true | default=(none) | pk_order=0
source_ref_type | type=TEXT | not_null=true | default=(none) | pk_order=0
source_ref_id | type=TEXT | not_null=true | default=(none) | pk_order=0
status | type=TEXT | not_null=true | default=(none) | pk_order=0
watermark_at | type=TEXT | not_null=false | default=(none) | pk_order=0
input_fingerprint | type=TEXT | not_null=false | default=(none) | pk_order=0
evidence_json | type=TEXT | not_null=true | default='{}' | pk_order=0
started_at | type=TEXT | not_null=false | default=(none) | pk_order=0
finished_at | type=TEXT | not_null=false | default=(none) | pk_order=0
created_at | type=TEXT | not_null=true | default=(none) | pk_order=0
updated_at | type=TEXT | not_null=true | default=(none) | pk_order=0
```

Foreign keys:
- `account_id` -> `foundation_integration_accounts.id` (id=0, seq=0, on_update=NO ACTION, on_delete=SET NULL)
- `source_system_code` -> `foundation_source_systems.code` (id=1, seq=0, on_update=NO ACTION, on_delete=RESTRICT)

Indexes:
- `idx_foundation_source_runs_status` (unique=false, origin=c, partial=false): [domain, status, created_at DESC]; CREATE INDEX idx_foundation_source_runs_status   ON foundation_source_runs(domain, status, created_at DESC)
- `sqlite_autoindex_foundation_source_runs_2` (unique=true, origin=u, partial=false): [domain, source_ref_type, source_ref_id]; (implicit)
- `sqlite_autoindex_foundation_source_runs_1` (unique=true, origin=pk, partial=false): [id]; (implicit)

