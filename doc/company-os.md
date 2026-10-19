# Company OS foundation

Company OS extends existing companies, employees (agents), goals, runs, workspaces
and activity logging. It does not add an execution engine or replace tasks.
Use the native Agent Contract & services, Project Missions/Knowledge, Inbox receipts, Audit Timeline, and Run context surfaces. The former `/organization` application route redirects to Projects.

## Operator workflow

1. Create employees in Agents and configure their adapter and reporting line.
2. In Contracts, choose an employee and edit their purpose, responsibilities,
   decision rights, boundaries, capabilities, services, policies and instructions.
   Save creates an immutable revision. Concurrent edits require a reload.
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

`packages/db/src/schema/company_os.ts` defines employee contract revisions,
missions, mission workstreams, organization receipts, context events, knowledge
entities and relationships, delivery outbox, run context packs and mission
context cursors. PostgreSQL remains the canonical store. No graph database or
Git runtime store is required.

Routes use `/api/companies/:companyId/organization`:

| Resource | Operations |
| --- | --- |
| `/contracts/:agentId` | GET current; PUT `{contract, expectedVersion}` (board only) |
| `/contracts/:agentId/history` | GET revision history |
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

Before execution, the context compiler loads the current contract, employee and
company goals, the triggering event (including company-wide events without a
mission), the mission, owned workstreams, incoming receipt, scoped knowledge,
recent events and project work products. Existing instruction files remain in
the adapter prompt. Context packs persist the contract version and exact input.
Successful runs advance mission cursors; failed runs preserve unconsumed deltas.
Run completion is recorded without recursively waking completion subscribers.

## Migration and deployment

Do not run migration experiments against production. First validate on a separate
PostgreSQL database, port, instance home, runtime storage and workspace.

For an approved deployment, back up the database, uploads and secrets key, stop
new run admission, apply the branch's generated migration using the normal
`pnpm db:migrate` workflow against the intended database, then deploy the matching
server/shared/UI build. Confirm health and the organization pages before enabling
employee subscriptions. The migration adds tables; old task and adapter behavior
remains available. Rollback application code only after stopping organization
runs; preserve new tables and evidence. Do not drop organization data as an
application rollback shortcut.

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
pnpm exec vitest run server/src/__tests__/company-os.integration.test.ts ui/src/pages/CompanyOs.test.tsx ui/src/lib/company-routes.test.ts
pnpm check:token-gates
```

The browser scenario creates two employees through the existing setup UI, saves
and revises a contract, creates a mission and owned workstream, then sends a
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
and receipt context packs, the returned knowledge and unchanged work ownership. It writes `live-receipt-evidence.json` and a timeline
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

Company settings owns the long-term Company mission and employee action policy. This purpose is separate from Goals and operational Missions. Structured company and Contract policies intersect normal authorization; they never grant additional Paperclip privileges. Supported restrictions are allowed, denied, owned_only, assigned_only, participant_only and approval_required. The latter fails closed for agents: a board operator reviews and performs the action through the authorized API; an arbitrary approved Issue cannot authorize it. Contract edits remain board-only.

Contracts advertise mission, organization-subtree or company service exposure. Company specialists can receive/reply to a Mission receipt without becoming Mission participants. Receipt recipient identity grants context for that specific service interaction, not unrelated Mission access. Ambiguous eligible providers are rejected.

Context events carry origin and source identity. Reserved domain namespaces cannot be emitted through the observation API. Native state transitions emit system events; employee observations and explicit board observations retain separate origins. Canonical work-product, approval, project-workspace and execution-workspace audit evidence is ingested idempotently with source activity provenance. No deployment or code-change fact is inferred from a URL alone.

Migration0301 adds company mission/policy, event sequence/origin/source identity, and an ordered per-employee Mission cursor. Historical migrations are unchanged. Old ID-set cursors restart at sequence0, so old relevant events may be delivered again rather than silently lost. Each pack records its base and delivered stream position plus backlog indication. Successful runs compare-and-advance only through included events; failed/cancelled runs do not consume a page. Concurrent packs may repeat the same page; their settlement cannot skip an intervening page.

Knowledge context uses a replaceable deterministic retriever: explicit entity IDs and ownership keys, two current-relationship hops, scoped text matching, then Mission-scoped recent updates as fallback. Cross-company and unrelated project scope is excluded. All explicitly linked Mission Goals are included alongside relevant company/employee Goals. Pack budgets still apply; long text has a bounded preview and full records remain accessible through the API.

This correction is not approved for master merge or production deployment. Apply only to isolated development while validation is in progress. For an eventual approved deployment, use the existing backup, matching-build and forward migration workflow. Roll back application code after stopping new organizational runs; retain the additive tables/columns and immutable evidence.
