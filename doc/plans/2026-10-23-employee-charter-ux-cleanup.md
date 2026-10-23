# PAP-6 cleanup and UX implementation map — 2026-10-23

Baseline: d1d7b68b8bffce31370e1a2696f142af1166b687. Branch: feat/employee-charter-ux-cleanup.

## Architecture

- Reuse Agent instruction files, canonical instruction revisions and per-run instruction receipts for Role / Contract. No second role prose in runtime Context Packs.
- Extract only policy, capability/service exposure, subscriptions and review schedule from employee_contracts into dedicated employee organization settings. Preserve scope checks, optimistic concurrency and existing routing/wake behavior.
- Forward migration after 0301; retain shipped migrations and immutable historical packs/events. Inspect instruction storage modes before selecting a safe prose transition. No silent loss or overwrite of existing AGENTS.md.
- Remove old Contract routes/types/editors and update all consumers, OpenAPI and fixtures.
- Reuse native instruction editor/history; add Services & Automation and Permissions destinations. Keep existing Goals.
- Use native dialogs for Receipt/Mission/Knowledge actions; keep domain APIs unchanged.
- Rework native Audit Timeline presentation; inspect usage aggregation and canonical evidence IDs before changing semantics. Raw audit remains available.

## Verification

Focused DB forward-migration, policy/routing/wake/context tests, UI flows, timeline accounting/idempotency, typechecks/builds, and isolated browser screenshots. Record exact failures and limits. No full-suite-green claim without a full uninterrupted run.

## Boundaries

Development only. No production migrations, activation, service restart, routing/configuration changes, backup/workspace deletion or merge. Final delivery will include commit, migration, evidence and risks for a separate deployment review.
