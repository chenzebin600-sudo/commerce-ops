# Commerce Ops Migration Number Governance

> Status: frozen governance rule
> Date: 2026-07-27
> Scope: migration numbering from 015 onward

## 1. Registered sequence

| Version | File | Status |
| --- | --- | --- |
| 015 | `015_mabang_sku_image_collector.sql` | Applied |
| 016 | No file | Intentionally unused |
| 017 | `017_mabang_full_image_sync.sql` | Applied |
| 018 | `018_mabang_image_collection_performance.sql` | Applied |
| 019 | `019_growth_radar_v2_analysis.sql` | Candidate |
| 020 | `020_growth_radar_direction_contract.sql` | Candidate |
| 021 | `021_growth_radar_task_lifecycle.sql` | Candidate |

## 2. Why 016 remains unused

Migration 016 was explicitly prohibited during the earlier protected project phase. Later approved work resumed with migrations 017 and 018. The gap is therefore an intentional project-history decision, not a missing migration.

No empty, no-op, or backfilled migration may be created for 016. Creating one would change the repository migration history without adding a schema change and would make previously applied environments inconsistent.

## 3. Runner and test rules

- Migration execution is ordered by the numeric filename prefix.
- A numeric gap is valid when it is recorded in this document.
- Tests must reject any future `016_*.sql` file.
- Tests should verify the registered 017-021 sequence instead of requiring every integer from 001 through the latest migration.
- The next migration number after the current candidates is 022 unless a separate architecture decision changes the register.
- Existing migration files must never be renumbered to close a gap.

## 4. Release rule

019, 020, and 021 remain candidate migrations until a separate formal-database approval. Rehearsal on an isolated database or a formal-database copy does not change their release status.
