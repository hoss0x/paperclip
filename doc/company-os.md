# Company OS foundation

Company OS extends existing companies, employees (agents), goals, runs, workspaces
and activity logging. It does not add an execution engine or replace tasks.
Open **Company OS** in the company sidebar.

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
company goals, the mission, owned workstreams, incoming receipt, scoped knowledge,
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
and owner, then waits for a finding, correlated reply, automatic return wake,
acknowledgement and successful runs. It checks both persisted context packs and
unchanged work ownership. It writes `live-receipt-evidence.json` and a timeline
screenshot under the Playwright output directory.

The harness always uses a temporary instance home and a separate port. If
`DATABASE_URL` is set, it must identify a dedicated disposable test database.
Never supply the production connection. `PAPERCLIP_E2E_LOW_PROCESS=1` reduces
Chromium worker processes for constrained hosts. Run build, typecheck and browser
checks sequentially when the agent execution has a small thread budget.
