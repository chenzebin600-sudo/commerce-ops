# PostgreSQL F1 local initialization

F1 prepares an empty local PostgreSQL environment. Commerce Ops continues to use SQLite; F1 does not import SQLite data or switch `DATABASE_PROVIDER`.

## Local credentials

Create `.env.postgres.local` from the PostgreSQL section in `.env.example`. Keep the file outside Git and configure:

- the installer-defined `POSTGRES_ADMIN_PASSWORD`;
- a distinct password for `commerce_migrator`;
- a distinct password for `commerce_app`.

Do not paste these values into tickets, chat, logs or command-line arguments. Keep the local file protected and Git-ignored.

## Commands

```powershell
npm run postgres:f1:protect -- capture
npm run postgres:f1:init -- --apply
npm run postgres:f1:check
npm run postgres:f1:protect -- verify
```

Initialization is idempotent and applies only the two F1 databases, the `app` schema and the two application roles. Connectivity writes only a temporary probe table in `commerce_ops_migration_test` and removes it before completion.

## Privilege model

- `commerce_migrator` connects to both databases and owns the `app` schemas. It can perform DDL inside those schemas but is not a superuser and cannot create databases or roles.
- `commerce_app` connects to `commerce_ops`, can use its `app` schema, and receives DML plus sequence privileges on objects created by `commerce_migrator`. It cannot create schema objects, databases or roles.
- PostgreSQL remains bound to loopback. Web access configuration never opens port 5432.

## Rollback

Code can be reverted with the F1 Git commit. PostgreSQL objects require a local administrator connection and should be removed only after confirming Commerce Ops still uses SQLite:

```sql
DROP DATABASE IF EXISTS commerce_ops_migration_test;
DROP DATABASE IF EXISTS commerce_ops;
DROP ROLE IF EXISTS commerce_app;
DROP ROLE IF EXISTS commerce_migrator;
```

The existing SQLite database and registered files are not altered by F1 and remain the active runtime data.
