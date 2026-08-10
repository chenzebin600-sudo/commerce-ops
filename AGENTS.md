# Commerce Ops Agent Instructions

## Cross-Session Memory

This repository uses the memory system rooted at `memory/`. Follow it for every
task in this workspace.

At the start of every session, read `memory/INDEX.md`,
`memory/PERMANENT.md`, and `memory/SOP.md`. The SOP is the single canonical
source for loading, fact routing, conflict handling, write-back, privacy, and
size rules; do not restate those rules in other files.

Before the final response of a task that changes project state, or when the user
says to end, pause, hand off, or summarize the session, execute the SOP's
write-back checklist and report the resulting memory changes to the user for
confirmation.
