---
memory_type: procedure
updated_at: 2026-08-04
---

# Memory Operating Procedure

## Four Layers

| Layer | Location | Contains | Loading rule |
| --- | --- | --- | --- |
| Permanent | `memory/PERMANENT.md` | Stable identity, terms, source semantics, working rules | Every session |
| Timeline | `memory/daily/YYYY-MM-DD.md` | Dated events, temporary state, decisions, validation results | Today by default |
| On demand | `memory/people/`, `memory/projects/` | Complete profiles for important people and projects | Only when relevant |
| Procedure | `AGENTS.md`, `memory/SOP.md` | Start, routing, write-back, conflict, and cleanup rules | Every session |

## Fact Format

Every durable factual statement gets a stable marker immediately before it:

```markdown
<!-- fact-id-example: project.slug.frontend-policy -->
- New main-workbench frontend modules use Vue 3 and TypeScript.
```

Use lowercase dotted identifiers. Renaming a file must not change its fact IDs.
Events may use `event.YYYY-MM-DD.slug`; they remain canonical in that day's log.

## Pointer Format

When another file needs the fact, do not repeat it. Point to the canonical file:

```markdown
<!-- memory-pointer: memory/projects/commerce-ops.md -->
```

Pointers are repository-relative and must resolve to an existing file.

## Routing Rules

| New information | Canonical destination |
| --- | --- |
| Stable user identity, terminology, data-source meaning, working rule | `memory/PERMANENT.md` |
| Today's branch, HEAD, runtime state, test result, completed work, temporary blocker | `memory/daily/YYYY-MM-DD.md` |
| Durable Commerce Ops mission, module boundary, stack policy, canonical contract pointer | `memory/projects/commerce-ops.md` |
| Durable information about an important person | `memory/people/<slug>.md` |
| A repeatable memory workflow | `memory/SOP.md` or root `AGENTS.md` |

## Session Start

1. Read `memory/INDEX.md`, `memory/PERMANENT.md`, and this SOP.
2. Read the relevant project/person profile.
3. Read today's daily log if it exists.
4. Run `npm run memory:check` when memory integrity is uncertain.
5. Inspect Git and runtime state; do not assume an older daily event is still
   current.

## Session Write-Back

1. List newly learned or changed durable facts.
2. Route each fact to one canonical destination.
3. Add pointers wherever navigation is needed; do not copy fact text.
4. Update `updated_at` in every changed memory file.
5. When creating a new daily file, update the latest-daily pointer in
   `memory/INDEX.md`.
6. Run `npm run memory:check`.
7. Tell the user exactly what was written back and ask for confirmation.

Write-back is required before closing a substantive task, but never write
secrets or customer PII. If the app closes abruptly, recover from Git state and
the latest dated log at the next start.

## Conflict Rule

When duplicate `fact-id` values are found:

1. Compare each file's `updated_at`; use filesystem modification time as the
   tie-breaker.
2. Treat the newest file as temporarily authoritative.
3. Keep the older copy untouched until the user is informed, unless the correct
   canonical destination is unambiguous.
4. Report both paths and the temporary winner.
5. Resolve by retaining the fact in one canonical file and replacing other
   copies with pointers.

## Permanent-Memory Cleanup

The checker warns when `PERMANENT.md` exceeds 120 lines or 12 KiB and raises a
cleanup error at 180 lines or 18 KiB. During cleanup:

1. Move project-specific detail to a project profile.
2. Move dated history to daily records.
3. Move person detail to a person profile.
4. Keep a pointer only when future navigation needs it.
5. Merge redundant wording without merging distinct facts.
