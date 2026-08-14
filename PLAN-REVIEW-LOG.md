# Plan Review Log: Shopee Discount 折扣价格匹配与活动续期
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.

## Act 2 — blocked before Round 1

- Reviewer model configured: `gpt-5.6-sol`.
- Reviewer executable resolved to the Codex desktop package under `C:\Program Files\WindowsApps\OpenAI.Codex_26.803.10989.0_x64__2p2nqsd0c76g0\app\resources\codex.exe`.
- `codex --version` failed with Windows `Access is denied`, including after an approved elevated attempt.
- No review round was consumed, no reviewer session was created, and no business code was written.
- Per the grill-me-codex safety rules, the review was not substituted, retried blindly, or marked approved.

## Act 2 — CLI recovered, external review awaiting explicit approval

- Installed reviewer verified: `codex-cli 0.147.0`.
- Reviewer model: `gpt-5.6-sol`.
- A read-only reviewer session was created, but its first turn failed before producing a verdict because sandboxed network access to OpenAI was blocked.
- Enabling the external review requires explicit user authorization to transmit `PLAN.md` and any relevant private repository content the reviewer chooses to inspect to OpenAI.
- Review rounds consumed: 0 of 5. No verdict was produced and no business code was written.

## Round 1 — Codex

1. Existing generic Shopee console can bypass confirmation if the relay gains write support; force it to a server-side read-only allowlist and use a fixed backend-only write adapter.
2. `discount.*` deployment capabilities are not user permissions under shared `APP_ACCESS_TOKEN`; a shared credential cannot distinguish or constrain individual operators.
3. Foundation summary hashes do not bind approval to millions of domain detail rows; use immutable ordered chunk hashes/Merkle root and verify before every batch.
4. Synchronous SQLite/`BEGIN IMMEDIATE` is not viable for ten million variants, two-year detail retention, and multi-worker writes; make PostgreSQL a production prerequisite.
5. Leases lack fencing; add monotonically increasing execution epochs, atomic claims, pre-write validation, and UNKNOWN reconciliation for stale workers.
6. Local idempotency cannot alone prevent duplicate remote activity creation after a lost response; store a unique operation UUID/target fingerprint/platform marker and never retry when readback is ambiguous.
7. A fixed T-24h window is unproven at the target scale; calculate capacity/SLO from real API limits and generate/require approval earlier or reject/split infeasible scope.
8. Money representation is undefined; use integer minor units/fixed decimal and prohibit floating-point calculation.
9. `country + SKU` uniqueness is an unverified source assumption; define normalization, validate uniqueness at one warehouse watermark, and block conflicts.
10. Long pagination is not a consistent snapshot; pin warehouse watermarks, use stable platform cursors/deduplication, incremental rescan, and pre-write revalidation.
11. Activity-overlap checks have a TOCTOU race; add store/time-window mutual exclusion and re-read immediately before every write batch.
12. A stale pipeline watermark must be a hard block; only old business approval timestamps may be warning/second-confirmation cases.
13. Reminder scheduling lacks persistence, timezone, idempotency, and downtime catch-up semantics; implement UTC persistent due-jobs with IANA shop timezones.
14. Request IDs alone are insufficient observability; add operational metrics, dashboards, alert thresholds, and automatic stop-write conditions.

VERDICT: REVISE

### Claude's response

- Accepted findings 1 and 3–14. `PLAN.md` now includes a hard read-only console allowlist, a backend-only fixed write adapter, immutable chunk hashes plus a Merkle approval root, PostgreSQL as a full-production prerequisite, lease fencing epochs, remote creation fingerprints, capacity-based dynamic lead time, integer minor-unit money, SKU uniqueness validation, stable-watermark scanning, TOCTOU locks/rechecks, hard pipeline-watermark blocking, persistent UTC reminders, and explicit operational metrics/stop conditions.
- Partially accepted finding 2. The plan now states plainly that `discount.*` flags are deployment gates rather than user permissions, forbids trusting request-body identities, defaults write/settings off, and limits real writes to a deployment where every key-holder is authorized. If that deployment assumption is false, a trusted proxy identity or separate execution credential becomes a hard prerequisite. Full user IAM/RBAC remains out of scope because the user explicitly locked that boundary.
- No code was written.

## Round 3 — Codex

Round 2 findings were mostly closed, leaving five write-security gaps:

1. In `separate_execute_identity` mode the privileged identity must protect final approval, not merely start an already shared-token-approved plan.
2. Security-sensitive settings and write-mode changes must also require the privileged identity.
3. Production relay writes currently risk plaintext HTTP credential/payload interception; require TLS/mTLS or signed timestamped nonce/body-hash requests with replay protection.
4. At-most-once creation needs a no-automatic-retry contract across every layer, not only the domain worker.
5. Manual UNKNOWN handling needs a closed audited state machine and must never requeue the original intent.

VERDICT: REVISE

### Claude's response

- Accepted all five findings. The plan now binds privileged final approval to the exact Merkle/policy hashes, protects all sensitive settings, requires authenticated production relay transport or signed replay-protected messages, prohibits hidden retries end-to-end for non-idempotent endpoints, and defines the only legal UNKNOWN resolutions plus fresh-approval requirements for replacement operations.
- No code was written.

## Round 2 — Codex

Round 1 findings were mostly closed and the locked no-RBAC scope was accepted, but seven execution details remained:

1. Pre-call epoch checks cannot stop an old stalled call after lease takeover; persist dispatch intent, renew continuously, and prohibit redispatch of dispatched-but-unreconciled UNKNOWN operations.
2. Shopee may not expose a reliable searchable creation marker; require API-supported idempotency/searchability or use at-most-once creation with manual ambiguous resolution.
3. The shared-token authorization fallback was conditional rather than fail-closed; require and validate an explicit production write-security mode at startup.
4. Technically successful but anomalously empty warehouse results could trigger mass 1% OFF fallback; validate schema/page completeness/status semantics and block abnormal missing rates against baselines.
5. Fallback rounding can create zero/below-minimum prices; revalidate all platform constraints after normalization and skip invalid results.
6. Database locks cannot close races caused by external Seller Center operators; use platform preconditions where available, immediate post-write readback, and stop the shop if a residual conflict is detected.
7. Merkle binding lacked a canonicalization contract; version exact leaf bytes, unique keys, duplicate rejection, tree/padding rules, and golden vectors while excluding mutable execution state.

VERDICT: REVISE

### Claude's response

- Accepted all seven findings. The plan now defines durable dispatch intents and UNKNOWN non-redispatch, capability-gated at-most-once creation, mandatory startup write-security modes, anomalous-empty result blocking, post-normalization price validation, residual external-race stop behavior, and a versioned canonical Merkle contract with golden tests.
- No code was written.
## Round 4

### Codex critique

All prior critiques are materially addressed. The remaining uncertainties—Shopee endpoint semantics, warehouse integration details, PostgreSQL tuning, and relay capabilities—are explicitly treated as fail-closed implementation prerequisites rather than unsafe assumptions. The locked V1 shared-token scope now has an enforceable deployment-mode boundary, with privileged approval and settings protection where separate identities are required.

No remaining material blocker prevents implementation under the stated staged rollout and acceptance gates.

VERDICT: APPROVED

### Resolution

接受。方案经过 4 轮只读对抗审查后获批；所有实现期未知项均已转化为 fail-closed 前置门禁，不允许以未验证假设进入生产写入链路。
