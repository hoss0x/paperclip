# Company OS foundation

Company OS extends existing companies, employees (agents), goals, runs, workspaces
and activity logging. It does not add an execution engine or replace tasks.
Use the native Agent Role / Contract and Services & Automation, Project Missions/Knowledge, Inbox receipts, Audit Timeline, and Run context surfaces. The former `/organization` application route redirects to Projects.

## Operator workflow

1. Create employees in Agents and configure their adapter and reporting line.
2. In Employee → Role / Contract, edit AGENTS.md: purpose, responsibilities,
   expected outcomes, decision rights and boundaries. The existing instruction
   editor owns file persistence. Services & Automation owns structured routing,
   subscriptions and review schedules. Permissions owns employee action restrictions.
   Machine settings use optimistic version checks.
3. Select wake subscriptions explicitly. A goal alone never starts a run.
   Requests normally use `receipt.received`; replies use
   `receipt.response_received`. Reviews, decisions and escalations have their
   own subscriptions. Scheduled reviews require a subscription and an interval
   of at least 15 minutes.
4. Create a mission with its objective, owner, participants, existing goals,
   projects, roadmap and success criteria. Add workstreams with explicit owners,
   dependencies and boundaries. Active overlapping boundaries return a conflict.
5. Send a receipt to a participant or a uniquely matching capability/service.
   Replies retain correlation and reverse the participants. Result/decision
   replies resolve the original request. The work owner stays unchanged and no
   task is created.
6. Inspect shared Knowledge, superseded relationships, the event Timeline and
   the immutable context pack recorded for each employee run.

## Data and API

`packages/db/src/schema/company_os.ts` defines employee organization settings,
missions, mission workstreams, organization receipts, context events, knowledge
entities and relationships, delivery outbox, run context packs and mission
context cursors. PostgreSQL remains the canonical store. No graph database or
Git runtime store is required.

Routes use `/api/companies/:companyId/organization`:

| Resource | Operations |
| --- | --- |
| `/employee-settings/:agentId` | GET current; PUT `{config, expectedVersion}` (board only) |
| `/operations-timeline` | GET filtered, cursor-paged Run/evidence projection |
| `/missions` | GET list; POST mission data |
| `/missions/:id` | GET; PUT `{data, expectedVersion}` |
| `/missions/:id/workstreams` | GET; POST workstream data |
| `/missions/:missionId/workstreams/:id` | PUT `{data, expectedVersion}` |
| `/receipts` | GET (mission/agent filter); POST request/reply |
| `/receipts/:id` | GET |
| `/receipts/:id/acknowledge` | POST |
| `/events` | GET (mission/entity/correlation/before filter); POST append |
| `/knowledge` | GET (`q` search); POST entity |
| `/knowledge/:id` | PUT `{data, expectedVersion}` |
| `/relationships` | GET (`history=true` includes superseded); POST relationship |
| `/context-packs/:runId` | GET persisted run input |

Exact validated fields are in `packages/shared/src/company-os.ts`. References
must belong to the route company. Agents send and acknowledge receipts as
themselves. Existing company membership and agent authentication apply.
Mutations commit domain state, causal events, delivery intent and activity in
one transaction. System-generated run completion events are derived evidence.

## Runtime

The existing heartbeat scheduler dispatches durable delivery intents into the
existing wake service. Retries use a stable delivery idempotency key. Paused
employees and budget/execution gates remain in that service. Organizational
wakes receive a fresh interaction session and do not require task checkout.
Traditional task wakes retain the existing task workflow.

Before execution, the context compiler loads structured employee settings, employee and
company goals, the triggering event (including company-wide events without a
mission), the mission, owned workstreams, incoming receipt, scoped knowledge,
recent events and project work products. Existing instruction files remain in
the adapter prompt. The immutable pack retains the effective instruction file hash
and audit snapshot; those bytes are excluded from the rendered model context.
Legacy packs retain their original Contract text in JSON. New packs carry no
second human-readable role object.
Successful runs advance mission cursors; failed runs preserve unconsumed deltas.
Run completion is recorded without recursively waking completion subscribers.

## Migration and deployment

Do not run migration experiments against production. First validate on a separate
PostgreSQL database, port, instance home, runtime storage and workspace.

For an approved deployment, back up the database, uploads and secrets key, stop
new run admission, apply the branch's generated migration using the normal
`pnpm db:migrate` workflow against the intended database, then deploy the matching
server/shared/UI build. Confirm health and the organization pages before enabling
employee subscriptions. Migration 0302 moves the latest machine configuration to
`employee_organization_settings`, drops `employee_contracts` and its indexes/FKs,
and removes the redundant `organization_context_packs.contract_version` column.
0300/0301 SQL remains unchanged. If a current legacy Contract contains prose,
0302 aborts atomically: move that prose into AGENTS.md using the old build, verify
the file, then clear only its old prose fields while keeping machine settings.
Do not apply this migration to production under the implementation task.

Application-only rollback to 0301 is unsafe after 0302: the old build expects
`employee_contracts`. A separately approved rollback requires restoring a
consistent pre-cutover database backup and matching application/runtime files.
Preserve post-cutover evidence before any restore; restore can lose newer writes.

## Initial limits

Lists and context neighborhoods are bounded; older events are accessible through
the `before` filter. Ownership boundaries warn by rejecting overlapping active
workstreams; they do not sandbox arbitrary provider file writes. Configure
existing execution workspaces for filesystem isolation. Knowledge types and
subscriptions are extensible strings. This version has no optional Git brain
projection or animated graph view. Board/company permissions do not imply
per-mission confidentiality within one company.

## Verification

Focused checks:

```sh
pnpm exec vitest run server/src/__tests__/company-os.integration.test.ts ui/src/pages/OrganizationPanels.test.tsx ui/src/lib/company-routes.test.ts
pnpm check:token-gates
```

The browser scenario creates a company through onboarding, then creates two employees through the existing setup UI, saves
a role charter and machine settings, creates a mission and owned workstream, then sends a
receipt without creating a task. Build the UI before using its focused config:

```sh
pnpm --filter @paperclipai/ui build --outDir ../server/ui-dist --emptyOutDir
pnpm exec playwright test --config tests/e2e/playwright-company-os.config.ts
```

For the live variant, first pass the deterministic tests. Set
`PAPERCLIP_COMPANY_OS_LIVE=1` and `PAPERCLIP_COMPANY_OS_MODEL` to a model returned
by the configured Antigravity account. The live test subscribes the specialist
and owner. Starting the mission wakes the owner, which requests the specialist
by capability. The test waits for a finding, correlated reply, automatic return
wake, acknowledgement and all three successful runs. It checks the mission-start
and receipt context packs, the returned knowledge and unchanged work ownership. The specialist is company-scoped and is not a Mission participant. It seeds 100 findings, drains them through successful real-agent runs without duplicate delivery, rejects a protected lifecycle spoof and a denied completion, and verifies two-way tenant boundaries. It writes `live-receipt-evidence.json` and a timeline
screenshot under the Playwright output directory.

The harness always uses a temporary instance home and a separate port. If
`DATABASE_URL` is set, it must identify a dedicated disposable test database.
Never supply the production connection. `PAPERCLIP_E2E_LOW_PROCESS=1` reduces
Chromium worker processes for constrained hosts. Run build, typecheck and browser
checks sequentially when the agent execution has a small thread budget.

When running workspace provisioning tests inside an agent shell, remove the
agent-specific `BASH_ENV` startup hook from the test process. That hook can add
the installed CLI to fixtures that intentionally restrict `PATH`, causing them
to use a real CLI instead of their isolated fallback. This is test-process
isolation; it does not change the instance or VPS settings.

The file-download concurrency fixture uses a named pipe. Keep at least two
libuv I/O workers (`UV_THREADPOOL_SIZE=2`) for that suite; one worker blocks
the reader while the writer is queued behind it. On hosts with a small thread
budget, run Vitest directly with one test worker to avoid extra package-manager
processes. Bound Git index threads only in the test process environment; do not
change production resource settings.


## Native integration correction (2026-10-19)

Company settings owns the long-term Company mission and employee action policy. This purpose is separate from Goals and operational Missions. Structured company and employee policies intersect normal authorization; they never grant additional Paperclip privileges. Supported restrictions are allowed, denied, owned_only, assigned_only, participant_only and approval_required. The latter fails closed for agents: a board operator reviews and performs the action through the authorized API; an arbitrary approved Issue cannot authorize it. Machine setting edits remain board-only.

Employee settings advertise mission, organization-subtree or company service exposure. Company specialists can receive/reply to a Mission receipt without becoming Mission participants. Receipt recipient identity grants context for that specific service interaction, not unrelated Mission access. Ambiguous eligible providers are rejected. An explicit exposure scope takes precedence over legacy Mission membership, so joining a Mission cannot broaden a restricted subtree service.

Context events carry origin and source identity. Reserved domain namespaces cannot be emitted through the observation API. Native state transitions emit system events; employee observations and explicit board observations retain separate origins. Canonical work-product, approval, project-workspace and execution-workspace audit evidence is ingested idempotently with source activity provenance. No deployment or code-change fact is inferred from a URL alone.

Migration0301 adds company mission/policy, event sequence/origin/source identity, and an ordered per-employee Mission cursor. Historical migrations are unchanged. Old ID-set cursors restart at sequence0, so old relevant events may be delivered again rather than silently lost. Each pack records its base and delivered stream position plus backlog indication. Successful runs compare-and-advance only through included events; failed/cancelled runs do not consume a page. Concurrent packs may repeat the same page; their settlement cannot skip an intervening page.

Knowledge context uses a replaceable deterministic retriever: explicit entity IDs and ownership keys, two current-relationship hops, scoped text matching, then Mission-scoped recent updates as fallback. Cross-company and unrelated project scope is excluded. All explicitly linked Mission Goals are included alongside relevant company/employee Goals. Selected records retain their full meaningful text. No aggregate character budget or model context/reasoning/output cap is introduced. Knowledge retrieval and event pages remain selective. Each delivered event advances the existing ordered cursor only after success.

This correction is not approved for master merge or production deployment. Apply only to isolated development while validation is in progress. For an eventual approved deployment, use the existing backup, matching-build and forward migration workflow. Roll back application code after stopping new organizational runs; retain the additive tables/columns and immutable evidence.

Scoped policy read modes resolve ownership from stored Mission, Receipt, employee settings or Run Context records. Unscoped collection reads fail closed for owned/assigned/participant-only policies; use a resource endpoint or a Mission-scoped event query. Caller-provided ownership query hints do not confer authority.

On the validation VPS, live browser workers use 512 MiB per agent and two agent admission slots in the throwaway instance. Live adapter timeout is 240 seconds, isolated from production; the first 120-second attempt cancelled during delayed specialist startup while final compilation was also active. Its aggregate execution capacity must match the existing shared host slice (5949 MiB at validation); a mismatch is rejected by resource admission. Do not reconfigure the shared production slice to fit a test. This changes only the test controller environment, not production limits.


## Role charter cleanup and Timeline (2026-10-23)

AGENTS.md is the single semantic employee Contract. New onboarding charters define
outcomes, authority and boundaries without prescribing a generic reasoning workflow.
Existing employees’ live files are not overwritten by a software update.

The normal provider adapter reads the staged instruction file. The compiler runs
after staging and retains its SHA-256 and exact bytes for audit; its renderer
excludes that snapshot. Existing instruction revisions are referenced when their
hash matches; managed file runs do not require a legacy revision row. Historical
runs cannot be retroactively assigned a file hash that was never captured.

Audit → Timeline is an operational card history with visible date, agent, project,
Mission, category, Run outcome and search filters. Previous/next moves by the
selected window; density and employee grouping replace tiny chart bars. Each card
opens source evidence in a side drawer. Raw Events / Technical Audit remains under
Audit Activity. The Timeline API uses a timestamp+UUID cursor, a bounded page and
company checks; only Run records carry usage. Completion events stay stored.

Codex reports cached input as a subset of input. Timeline totals count input +
output for Codex, retaining cached input as a breakdown; additive cache-read
adapters keep their existing accounting. No provider usage rows are rewritten.
Re-registering an artifact updates the existing work product and now records an
update audit action rather than a misleading creation action. Canonical activity
IDs remain the evidence-ingestion idempotency keys; historical events stay intact.
