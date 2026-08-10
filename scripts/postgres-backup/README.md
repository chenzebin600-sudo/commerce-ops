# PostgreSQL physical backup operations

These scripts operate on the current Commerce Ops PostgreSQL production
cluster without stopping the application. They never delete archived WAL.

## Create and verify a physical base backup

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\postgres-backup\backup.ps1 `
  -ConfirmDatabase commerce_ops
```

The default destination is
`D:\PostgreSQLBackups\base_backup\YYYY-MM-DD`. The backup uses PostgreSQL 18
`pg_basebackup`, tar format, client-side Zstandard level 6 compression, streamed
WAL, a SHA-256 backup manifest, and `pg_verifybackup`. Logs and metadata are
written beside the backup root. Existing non-empty destinations are never
overwritten. Directories beyond the latest four are only reported as retention
candidates; they are not deleted automatically.

For tar-format backups, manifest and file checksums are verified with
`pg_verifybackup --no-parse-wal` because `pg_waldump` cannot read tar files.
The separate restore test extracts the streamed WAL and starts PostgreSQL,
which supplies the end-to-end WAL usability check.

## Verify a restore

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\postgres-backup\restore_test.ps1 `
  -BackupDirectory D:\PostgreSQLBackups\base_backup\YYYY-MM-DD `
  -ConfirmDatabase commerce_ops
```

The default isolated restore root is `C:\PostgreSQL_restore_test` to preserve
D-drive headroom while the WAL archive remains large. The test instance uses
port 55432, disables archiving and SSL only inside the restored copy, validates
six business domains against production row counts, and is stopped after the
test. The restored directory is retained as evidence and is never deleted by
the script.

The restore accepts PostgreSQL's streamed-WAL tar output as either
`pg_wal.tar` or `pg_wal.tar.zst`; the main cluster archive remains
`base.tar.zst`.

After a restore test is PASS, the test instance is stopped, and an official
VERIFIED backup remains intact, the restore copy can be removed with the
separate guarded cleanup command:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\postgres-backup\remove_restore_test.ps1 `
  -ConfirmTarget "C:\PostgreSQL_restore_test\2026-08-10"
```

The cleanup refuses the restore root itself, reparse points, a listening test
port, process references, incomplete evidence, or a missing official backup.
It writes a JSON deletion audit under `D:\PostgreSQLBackups\cleanup-audit` and
does not touch archived WAL.

## Monitor WAL size

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\postgres-backup\check_wal.ps1 -NoFail
```

The monitor writes `latest.json` and append-only `history.ndjson` evidence under
`D:\PostgreSQLBackups\monitor`. Status is `WARNING` at 50 GiB and `CRITICAL` at
80 GiB. Without `-NoFail`, warning exits 1 and critical exits 2 for scheduler
integration. It also reports files older than the seven-day retention window as
candidates. The monitor is read-only and contains no cleanup command.

## Install Windows scheduled tasks

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\postgres-backup\install_tasks.ps1
```

This registers weekly physical backup (Sunday 03:00), weekly isolated restore
validation of the latest VERIFIED backup (Sunday 05:00), and a WAL monitor every
15 minutes. Tasks run only in the current user's interactive session and use
limited privileges. Registration is idempotent. No task deletes backups, restore
directories, or archived WAL.

## Deletion boundary

- Do not delete WAL until a verified physical base backup defines a recovery
  boundary and the cleanup recommendation has explicit human approval.
- Do not point restore testing at the production data directory or production
  port.
- Do not put PostgreSQL passwords in task arguments, logs, reports, or scripts;
  the scripts read the existing ACL-protected `.env.postgres.local` file.
