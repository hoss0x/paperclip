# Company OS implementation map

Baseline: hoss0x/paperclip origin/master, 068136d6e. Branch: feat/company-os-runtime.

## Existing systems to extend

| Concern | Existing implementation | Extension |
| --- | --- | --- |
| Employee identity and organization | db/schema/agents.ts; services/agents.ts; routes/agents.ts; AgentDetail, Agents, Org UI | Keep agent identity/reporting/hiring. Add versioned company-scoped employee contracts linked to agents. |
| Goals | db/schema/goals.ts; services/goals.ts; routes/goals.ts; Goals/GoalDetail UI | Reuse company/team/agent levels and ownerAgentId; missions reference these goals without creating issues. |
| Execution and wakes | services/heartbeat.ts; agent_wakeup_requests; heartbeat_runs; server/index.ts scheduler | Dispatch durable organization-event deliveries into existing wakeup API. Compile context at run start. No second execution engine. |
| Prompt delivery | adapter-utils/server-utils.ts selectPaperclipPromptSections; existing adapter contexts | Append compiled employee contract/context to shared prompt sections, preserve instruction files and ordinary issue context. |
| Deliverables and isolation | issues, project_workspaces, execution_workspaces, work_products | Keep issue checkout unchanged; workstreams reference project/workspace boundaries and flag overlap. |
| Audit | services/activity-log.ts; activity_log | Record actor/run and mutation alongside organization state in the same transaction; reuse run/work-product evidence. |
| Auth | routes/authz.ts assertCompanyAccess/getActorInfo; API actor middleware | Scope every query and referenced ID. Board edits contracts; agents act as themselves. |
| Persistence | PostgreSQL, Drizzle schema/index.ts and generated migrations | Add contracts, missions, workstreams, receipts, append-only events, knowledge entities/relations, context packs/cursors, delivery outbox. |
| UI | React Query, company context, App routes, Sidebar and shared controls | Company OS pages for missions/workstreams, contracts, receipts, searchable knowledge, causal timeline and run context. Use index.css tokens. |

## Semantics and reliability

Contract revisions are immutable; optimistic version checks prevent lost edits. Mission participation is explicit. Receipts preserve the work owner, have correlated replies, and never create an issue. Capability resolution fails on ambiguity. Events and delivery intents commit with state. Delivery retries use existing wake request idempotency. Goals alone do not wake employees. Paused employees and normal budget gates remain in the heartbeat path.

Knowledge records represent current structure with temporal provenance; events represent causal history. Context packs are bounded, company/project/mission scoped, persisted for inspection, and use a per-employee mission cursor advanced after successful execution. Run failure must not consume context deltas.

## Verification and delivery gates

Use an isolated worktree and isolated PostgreSQL/app/runtime storage. Do not migrate or modify production. Test contract history/concurrency, two-company reference/read isolation, mission lifecycle, ownership overlap, receipt round trip with issue-free wakes, subscription filtering, causal history, temporal knowledge, bounded context/deltas, and old issue/adapters. Run typecheck/tests/build and token gates before handoff. Then prove a real Antigravity or OpenCode receipt round trip on the isolated VPS instance. Record exact evidence and limitations; do not mark the parent complete before all gates pass.

## Checkpoints

1. Domain schema, validators and transactional services.
2. Existing heartbeat integration, reliable deliveries and context compiler.
3. Usable company-scoped UI.
4. Isolation/regression tests, documentation and live VPS smoke evidence.
