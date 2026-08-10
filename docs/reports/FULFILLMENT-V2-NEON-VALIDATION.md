# Fulfillment V2 Neon Validation

## Scope

- Date: 2026-08-05
- Environment: isolated Neon PostgreSQL test project
- Project: `flat-violet-38124721`
- Branch: `main` (`br-summer-resonance-av2w00gb`)
- Database: `neondb`
- Production data: none

No connection credentials are stored in this report or in repository files.

## Schema execution

`docs/design/fulfillment-v2-postgresql-schema.sql` executed successfully as one transaction after removing its outer `BEGIN` and `COMMIT` statements for the connector-managed transaction.

Observed catalog state:

- fulfillment tables: 19
- foreign keys: 31
- unvalidated constraints: 0
- latest schema migration: `FULFILLMENT_V2_FOUNDATION_001`

## Positive workflow

The following records were created and joined successfully:

1. authenticated human actor;
2. scheduler service actor;
3. shop and shipping channel;
4. immutable manual policy version;
5. scan run and immutable order candidate;
6. preview and preview item;
7. manual approval with operator subject, display-name snapshot, authentication source, request ID, IP address, and user agent;
8. approval state projection;
9. job and job item;
10. idempotency reservation;
11. job-item event.

The persisted manual approval resolved to the expected human actor and the job remained bound to the approved preview.

## Revocation workflow

An automatic approval was created with a service actor under an automatic policy. The test then:

1. appended a revocation decision referencing the original approval;
2. moved the approval state projection from version 1 to version 2;
3. returned the unexecuted, unexpired preview to `pending`;
4. appended a new approval decision;
5. moved the projection to version 3 and restored the preview to `approved`.

Final evidence:

- approvals in the tested chain: 2
- revocations in the tested chain: 1
- current approval state: `approved`
- current state version: 3

## Negative constraint tests

The database rejected all of the following:

- manual approval attributed to a service actor;
- job using an approval decision belonging to another preview;
- second idempotency reservation for the same shop and order scope;
- second job generated from the same preview.

Post-test checks confirmed that none of the rejected rows persisted.

## Local regression

- existing fulfillment and agent tests: 69 passed, 0 failed;
- fulfillment V2 schema contract tests: 5 passed, 0 failed;
- `git diff --check`: passed for the added design and test files.

## Finding applied during validation

The initial candidate allowed separate approval decisions to create more than one job for the same preview. The schema was tightened so `fulfillment.jobs.preview_id` is unique. The isolated Neon database was altered to match, and a duplicate-job attempt was rejected by `uq_fulfillment_jobs_preview`.

## Result

The candidate schema executes on PostgreSQL and the tested approval, revocation, idempotency, and cross-preview integrity paths behave as designed. This validates the database foundation only; production service integration and legacy SQLite migration remain separate implementation phases.
