# Commerce Ops Storage Provider V1

Date: 2026-08-05  
Status: Contract only; not wired into production

## Goal

Keep current local-file behavior while defining a narrow boundary for a future MinIO migration.

## Contract

`StorageProvider` exposes:

- `put(key, data)`
- `get(key)`
- `exists(key)`
- `delete(key)`
- `stat(key)`

Storage keys are normalized relative keys. Absolute paths and traversal outside the configured root are rejected.

## Implementations

- `LocalStorageProvider` reads and writes beneath one configured local root.
- `MinioStorageProvider` uses an injected client and bucket; no MinIO dependency or credentials are added in Phase 1.

## Data rules

- Database rows should store metadata and storage keys, not machine-specific absolute paths.
- Existing files remain in their current local directories.
- No asset is copied, deleted, or rewritten during PostgreSQL Shadow migration.
- A future provider switch requires inventory, checksum, dual-read, and rollback validation.

