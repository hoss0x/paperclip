# Execution resource governance

Implementation in progress on `feat/runtime-resource-governance`. Server
adapter dispatch now installs the shared operator resource context and persists
unit ownership before launch. Shared child-runner and native runnerd launcher
paths are validated through real systemd units. Direct native Codex now uses a
stream-preserving boundary with JSON-RPC, queued cancellation and descendant
cleanup tests. Direct OpenCode now uses the shared descriptor-preserving scope
through an async launch hook; authenticated HTTP session startup/recovery, queued
cancellation, descendant cleanup, OOM evidence and a later session have fixture
coverage. Direct ACPX still needs integration, and full
native session/resume/restart qualification remains pending. Do not deploy this intermediate branch as a completed resource fix.

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
Calls outside this context retain their existing direct-spawn behavior. The direct Codex backend now uses an async
process-transport factory. `resource-stdio-process.ts` reuses policy, admission
and systemd boundary primitives while leaving protocol decoding and diagnostic
redaction in the transport. It reports the worker PID, signals the whole unit,
and settles close only after descendant cleanup and terminal evidence. The
systemd client receives operator user-manager connection variables; the provider
receives its exact private invocation environment. Startup cancellation reaches
admission before a process can launch. Existing runnerd/remote factory input
contracts stay unchanged. Direct OpenCode forwards launch descriptors and startup/
recovery signals through an operator hook. Driver close waits for whole-unit
cleanup; the HTTP/SSE protocol and diagnostic redaction remain in the driver.
Direct ACPX launches remain unfinished.

Descriptor-preserving launches can instead use a transient systemd scope.
`systemd-run --scope` retains the worker PID, process group and inherited file
descriptors. The packaged native runner's private `--resource-exec` handoff reads
and removes the same private invocation file, writes worker identity, and replaces
itself through Unix `exec`. It leaves no additional supervisor. Node's
[`process.execve`](https://nodejs.org/api/process.html#processexecvefile-args-env)
closes descriptors beyond stdin/stdout/stderr, so the service loader cannot
preserve verified executable and credential-fence descriptors. OpenCode uses this scope primitive without replacing its executable descriptor
with a mutable pathname. ACPX driver wiring is still pending.
Startup accounting and durable ownership recognize both services and scopes.
`prepareResourceScopeProcess` can reserve capacity and persist unit ownership
before a verified launcher duplicates descriptors. Its single-use synchronous
spawn returns a stable child PID, inherited pipes/descriptors, a readiness promise
and the same tracked completion path as the async transports. Closing or cancelling
an unused preparation releases its reservation only after cleanup. This seam is
validated but not yet connected to ACPX. ACPX has persistent and transient command
roots within one runtime; those roots need one run envelope, rather than competing
for separate full-budget slots. Per-command admission with one slot could block
status/control requests behind the runtime they must control.
`prepareExecutionRunEnvelope` now reserves one global slot for a session and
creates a child slice under the operator aggregate. Persistent and transient
roots borrow that reservation. Their combined memory, swap, CPU and task use is
bounded by the child slice, even while control commands overlap the persistent
runtime. The owner retains capacity while the session is idle and explicitly
closes the envelope after the session. Cancellation stops the slice and waits
for verified root cleanup before releasing capacity; failed cleanup retains it.
Periodic cgroup samples detect a memory kill, stop the other roots, and propagate
the shared limit failure into each root's local run evidence. Startup recovery
groups surviving roots by their envelope and counts its budget once. Real tests
cover concurrent roots with a single global slot, queued cancellation, unused
prepared roots, shared OOM containment and recovery. ACPX wiring remains pending.
Scope mode requires the packaged runner; it never falls back to an unbounded
launch. Scope OOM evidence comes from cgroup events and the systemd result;
`OOMPolicy=stop` applies to services only.

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
and removes cancelled queued requests. Dispatch uses one pool across all companies/adapters in a control-plane process
and releases capacity after verified cleanup. Initialization counts active units
in the execution slice before accepting new work. Surviving-unit reservations
remain until the user manager confirms termination; failed refreshes retain
capacity. This provides restart accounting for a single controller. Multiple
independent controllers sharing a user-manager slice do not yet share FIFO slots. `withOperatorExecutionResources` now
prepares `paperclip-executions.slice` with `MemoryMax` equal to total admission
capacity. Its aggregate swap cap equals the configured per-execution swap cap
(default zero). All services launched in that context enter this slice. Limits
survive controller restarts; runtime slice configuration is recreated after a
user-manager restart. Existing conflicting capacity is rejected before launch.
The real aggregate test used separate launch paths without a shared JS queue
and proved slice OOM containment plus later recovery. The OS cap bounds memory but does not provide cross-controller FIFO scheduling.
Legacy cancellation and stale-controller recovery stop recorded run-owned units
and verify their inactive state before releasing ownership. Adapter output cannot
create the reserved unit-ownership event types. Native cancellation retains its
existing audited authority; full detach/reattach qualification is still pending.

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
Scope tests additionally require `PAPERCLIP_TEST_RESOURCE_LOADER` pointing to the
rebuilt native `paperclip-runnerd` binary. Server transport fixtures additionally
select `PAPERCLIP_EXECUTION_ISOLATION=systemd`, 128 MiB memory high/max/capacity,
and one concurrent slot. Equal high/max thresholds make the intentional hard-limit
fixture immediate; a 96 MiB high/128 MiB max run crossed its 20-second test deadline.
Qualification of sustained soft-threshold pressure remains pending.
Run heavy validation inside a bounded sibling unit, never inside the live service.

Server dispatch records per-unit limits and terminal evidence in the local run
log. A memory kill overrides an adapter success or parser failure with
`execution_resource_limit`; other provider errors retain their original meaning.
Tests exercise failed ownership persistence, OOM projection/recovery, native
launcher context propagation, and real surviving-unit admission reconstruction.

Remaining before handoff: direct ACPX transport integration and full session/
resume/cancellation/restart coverage, integrated
UI/API/PostgreSQL stress and low-memory measurements, full checks, internal
review, and the focused PR. No live deployment or resource-PR merge is authorized.
