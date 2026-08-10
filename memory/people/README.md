---
memory_type: people-index
updated_at: 2026-08-04
---

# People Profiles

Create a profile only for a person whose durable role, responsibilities, or
communication preferences materially affect the work.

- Use `memory/people/<stable-slug>.md`.
- Store only durable profile facts and their provenance.
- Never store passwords, tokens, private contact details, customer PII, or
  sensitive HR information.
- Put dated interactions in the daily log and point to the profile.
- If a person's role changes, update the profile's canonical fact rather than
  adding a contradictory copy.

Template:

```markdown
---
memory_type: person
person: stable-slug
updated_at: YYYY-MM-DD
---

# Display Name

<!-- fact-id: person.stable-slug.role -->
- Durable role or responsibility.
```

