# Execution resource governance

Implementation in progress on `feat/runtime-resource-governance`. The shared
child-process runner now accepts a resource context and is tested
through real systemd units. That context is **not yet connected to server adapter
dispatch**. The native session executor has a context-aware launcher hook,
but its session/resume paths are not yet validated under isolation. These
settings do not currently isolate ordinary
agent runs. Do not deploy this intermediate branch as a completed resource fix.

## Shared boundary

`packages/adapter-utils/src/systemd-execution.ts` prepares a Linux user-systemd
transient service in a sibling cgroup. Systemd owns memory/CPU/task accounting,
whole-cgroup signalling, and cleanup. A private invocation file carries the exact
command, arguments, working directory and environment. Its directory has mode
0700 and its file has mode 0600. A small loader removes that file and uses Node's
`execve` to replace itself with the command. No extra supervisor remains, and
stdin/stdout/stderr remain connected through `systemd-run --pipe --wait`.

`execution-resource-context.ts` uses async-local storage to carry an operator
policy, one admission pool, cancellation and an evidence sink across adapter
calls. Within that context, `runChildProcess` reserves a whole budget before
launch, supplies build-tool defaults, samples memory every 500 ms, and releases
capacity only after whole-unit cleanup. The loader writes a private worker-PID
marker before `execve`; spawn metadata and stdin gating use that PID, rather than
the `systemd-run` client PID. Signals target the full unit. Exit results retain
worker signal semantics and name memory failures `execution_resource_limit`.
A pre-launch `onUnitPrepared` hook lets dispatch persist unit ownership before
provider work can start. The native synchronous launcher seam now has a shared
bridge that returns a handle while admission/launch proceeds asynchronously;
it updates the handle with the worker PID and uses whole-unit signals. Raw
process output does not gain a new native logging path. Full native protocol,
reattach and session/resume coverage is still pending.
Calls outside this context retain their existing direct-spawn behavior until
dispatch integration is complete.

The boundary sets `MemoryHigh`, `MemoryMax`, `MemorySwapMax`, `CPUQuota`,
`TasksMax`, `KillMode=control-group` and `OOMPolicy=stop`. An explicitly requested
boundary fails if Linux cgroup v2 or the user systemd manager is unavailable.
It does not retry outside isolation. Node.js must support `process.execve`;
Paperclip's supported Node.js version is 24.11 or newer. Systemd must support
`--expand-environment=no` (254 or newer).

Live samples read `memory.peak` and `memory.events`; terminal properties supply
the systemd result and main exit status. A short successful transient unit can
unload before inspection, so unavailable measurements remain null. Do not use
validation-unit teardown peaks as workload benchmark measurements.

## Operator policy

The resolver takes the **operator process environment**, never an agent's adapter
environment. Limits below are initial implementation defaults, pending integrated
measurement. They are not a minimum-VPS recommendation.

| Environment variable | Initial default |
| --- | --- |
| `PAPERCLIP_EXECUTION_ISOLATION` | `auto`: systemd on Linux, `none` elsewhere |
| `PAPERCLIP_EXECUTION_RESERVE_MIB` | Greater of 1024 MiB and 25% of host RAM |
| `PAPERCLIP_EXECUTION_CAPACITY_MIB` | Host RAM minus reserve |
| `PAPERCLIP_EXECUTION_MEMORY_MAX_MIB` | Lesser of 2048 MiB and capacity |
| `PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB` | 75% of the hard limit |
| `PAPERCLIP_EXECUTION_MEMORY_SWAP_MAX_MIB` | 0 |
| `PAPERCLIP_EXECUTION_MAX_CONCURRENT` | Lesser of 2 and whole budgets fitting capacity |
| `PAPERCLIP_EXECUTION_CPU_QUOTA_PERCENT` | 100 (one CPU equivalent) |
| `PAPERCLIP_EXECUTION_TASKS_MAX` | 128 |
| `PAPERCLIP_EXECUTION_BUILD_JOBS` | 1 |

The resolver rejects malformed numbers, contradictory thresholds, and capacity
that consumes the reserved host memory. Its admission primitive reserves complete
hard-memory budgets in FIFO order, checks both memory capacity and concurrency,
and removes cancelled queued requests. Dispatch integration must use one pool
across all companies/adapters, release only after verified cleanup, and reconcile
surviving units after controller restart. `withOperatorExecutionResources` now
prepares `paperclip-executions.slice` with `MemoryMax` equal to total admission
capacity. Its aggregate swap cap equals the configured per-execution swap cap
(default zero). All services launched in that context enter this slice. Limits
survive controller restarts; runtime slice configuration is recreated after a
user-manager restart. Existing conflicting capacity is rejected before launch.
The real aggregate test used separate launch paths without a shared JS queue
and proved slice OOM containment plus later recovery. Reconciliation of existing
units into admission and durable run ownership is still required; the OS cap
bounds memory but does not provide cross-controller FIFO scheduling.

The low-memory environment supplies supported defaults for `CARGO_BUILD_JOBS`,
`CMAKE_BUILD_PARALLEL_LEVEL`, `RAYON_NUM_THREADS`, Go runtime concurrency, and pnpm
workspace concurrency. `GOMEMLIMIT` defaults to the configured memory-high
threshold. It is a soft per-runtime GC target, not an RSS or process-tree limit;
see the [Go GC guide](https://go.dev/doc/gc-guide#Memory_limit). The pinned
TypeScript 7 `tsc` launcher executes a native compiler, so Node heap options do
not govern its memory. Go settings apply generically to Go programs.
Explicit tool settings survive. TypeScript has no universal safe concurrency
environment switch. Vitest validation uses `--maxWorkers=1 --no-file-parallelism`.
The OS hard limit remains the enforcement boundary.

## Regression fixes

The Slack provider-ordering test previously waited only Vitest's default one
second for a database-backed asynchronous drain. A one-core validation reproduced
the failure after all eight ingress receipts were saved. Bounded ten-second waits
preserve all ordering/wake assertions; both fixture services now shut down in a
`finally` block before database teardown.

The close-readiness GET first calls `getById`, which hydrates Git display state,
then previously repeated an uncached inspection in `getCloseReadiness`. Read-only
readiness now shares the existing five-second display cache and its single-flight
inspection. Archive and destructive cleanup retain the default fresh inspection.
Database readiness and authorization are still checked on each request. This
redundancy is separate from the proven service-cgroup OOM cause.

## Validation and unfinished work

Policy/admission unit tests cover capacity, FIFO ordering, cancellation,
configuration rejection, explicit tool settings, and unsupported platforms.
Opt-in systemd integration tests cover actual cgroup membership, stdin, exact
environment/argument preservation, detached-descendant cancellation, cgroup OOM,
and a successful execution after failure. Set `PAPERCLIP_TEST_SYSTEMD=1` and
`PAPERCLIP_SCRATCH_DIR` to a run-owned scratch directory to run these tests.
Run heavy validation inside a bounded sibling unit, never inside the live service.

Remaining before handoff: shared runner/adapter dispatch integration, native
transport coverage, durable cancellation/restart cleanup, aggregate admission
integration, resource-failure projection into run logs/results, integrated
UI/API/PostgreSQL stress and low-memory measurements, full checks, internal
review, and the focused PR. No live deployment or resource-PR merge is authorized.
