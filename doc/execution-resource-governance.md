# Execution resource governance

Implementation in progress on `feat/runtime-resource-governance`. Server
adapter dispatch now installs the shared operator resource context and persists
unit ownership before launch. Shared child-runner and native runnerd launcher
paths are validated through real systemd units. Direct native Codex now uses a
stream-preserving boundary with JSON-RPC, queued cancellation and descendant
cleanup tests. Direct OpenCode now uses the shared descriptor-preserving scope
through an async launch hook; authenticated HTTP session startup/recovery, queued
cancellation, descendant cleanup, OOM evidence and a later session have fixture
coverage. Direct ACPX now prepares one server-owned session envelope and bounded
verified command roots. Full native session/resume/restart qualification remains pending. Do not deploy this intermediate branch as a completed resource fix.

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
Direct ACPX uses a server-owned envelope and prepared descriptor handoffs.

Descriptor-preserving launches can instead use a transient systemd scope.
`systemd-run --scope` retains the worker PID, process group and inherited file
descriptors. The packaged native runner's private `--resource-exec` handoff reads
and removes the same private invocation file, writes worker identity, and replaces
itself through Unix `exec`. It leaves no additional supervisor. Node's
[`process.execve`](https://nodejs.org/api/process.html#processexecvefile-args-env)
closes descriptors beyond stdin/stdout/stderr, so the service loader cannot
preserve verified executable and credential-fence descriptors. OpenCode uses this scope primitive without replacing its executable descriptor
with a mutable pathname. ACPX forwards its verified descriptor layout through the
same scope handoff.
Startup accounting and durable ownership recognize both services and scopes.
`prepareResourceScopeProcess` can reserve capacity and persist unit ownership
before a verified launcher duplicates descriptors. Its single-use synchronous
spawn returns a stable child PID, inherited pipes/descriptors, a readiness promise
and the same tracked completion path as the async transports. Closing or cancelling
an unused preparation releases its reservation only after cleanup. This seam is
connected to the ACPX command resource owner. ACPX has persistent and transient command
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
prepared roots, shared OOM containment and recovery. ACPX now uses this envelope.
The verified ACPX installation now accepts an operator-owned synchronous process
launcher after it constructs its exact arguments, environment and inherited
descriptors. Native-distribution and qualified-package leases use the same seam;
all digest, guardian and credential-fence checks remain in the verified launcher.
The runtime host can prepare both its initial command and replacements through
one operator callback. A real scope fixture passed guardian ownership, inherited
credential fences, provider-exit proof and a transient verified command beside
the persistent sentinel with one global slot. Production dispatch now selects this command resource owner through the backend
factory and driver. Both initial and replacement leases use prepared scopes.
The runtime host retains credential authority until graceful runtime exit proof
and verified command-resource cleanup both complete. An idle session retains its
budget until host close. Concurrent abort and runtime cleanup share one lease-close
attempt; failed leases remain retryable. Full session/recovery/stress qualification
is still pending.
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

Remaining before handoff: full direct-native session/resume/cancellation/restart
coverage and older helper-spawn inventory, integrated
UI/API/PostgreSQL stress and low-memory measurements, full checks, internal
review, and the focused PR. No live deployment or resource-PR merge is authorized.

## Quota polling and remaining helper paths

Quota polling now installs the same operator context as run dispatch. Simultaneous
UI polls share one request. Its 20-second deadline aborts both queued admission
and running subprocesses. Codex quota JSON-RPC uses the shared bounded stdio
launcher; shutdown awaits complete unit cleanup before removing private launch
files. Quota diagnostics and incomplete RPC lines have finite buffers. HTTP-only
quota adapters retain their existing provider request timeouts.

The older `adapter-utils/acpx-engine` is a separate execution path from the native
ACPX driver. Its patched ACPX 0.12 runtime now routes providers and host-side ACP terminal
commands through an operator-owned launch hook and one shared run envelope.
The packaged runner retains actual worker PID/group identity; terminal shutdown
awaits complete unit cleanup, including detached descendants. Runtime close
releases the session reservation only after verified slice cleanup. Missing loader
configuration fails closed. ACPX direct-command ENOENT shell fallback is preserved.
Real tests cover sibling cgroups, exact provider/terminal environment, one-slot
terminal admission, provider OOM, later recovery and cancellation. Immediate
terminal commands retain their launch identity until readiness consumes it;
backpressured streams retain output during that wait. Terminal completion is
settled from verified cleanup, so an already-exited child or rejected cleanup
cannot lose its exit notification. Repeated `/bin/true`, actual shell-string
fallback with output, and cleanup-rejection fixtures pass. ACPX 0.12
creates an initial provider at ensureSession and a second at startTurn; both
roots receive the same session envelope. Gemini version and Copilot help probes
also use that launch hook, with the same sanitized provider environment and
session budget. Their existing deadlines now signal the complete probe unit and
wait for verified cleanup; retained output is capped at 64 KiB. Probes keep the
original direct spawn when isolation is disabled. Focused fixtures verify probe
cgroup membership, exact environment/arguments, and timeout cleanup of a detached
descendant before later provider execution. A native driver qualification cannot
prove containment of these separate paths. SSH/tar
transport and workspace helper spawns also remain in the inventory; command
strings executed inside an already-bounded worker must be distinguished from
host-side controller spawns.

### Host helper inventory (2026-10-07 qualification)

The following paths still require resource integration or a documented bounded
exception before the branch is ready. Timeouts and finite output alone do not
provide an OS memory boundary.

| Path | Execution location and remaining gap |
| --- | --- |
| `adapter-utils/src/ssh.ts` | Buffered SSH commands and Git bundle/fetch/merge helpers now use the shared buffered scope runner when a resource context is present. Paired tar/SSH and file-stream roots now use one run envelope when a resource context is present, so one partner cannot queue behind the other. Backpressure and authentication cleanup remain intact; completion waits for drained output and verified scope cleanup. Preparation/restoration context coverage remains to be qualified. |
| `adapter-utils/src/sandbox-managed-runtime.ts` (`execTar`) | Host archive creation/extraction now uses the shared buffered scope runner when a resource context is present, including durable workspace seeds, with a finite 120-second deadline and whole-tree cleanup. Server preparation/restoration and deferred callbacks install operator policy through the shared host target wrapper; direct non-server callers still require a resource context. |
| `adapter-utils/src/workspace-git-stream.ts` | The shared Git scheduler now uses a cgroup scope through the shared launcher. UI/API scans install an operator resource context even outside agent dispatch; admission waits count toward the scan deadline. Run-owned scans retain the controller run id for recorded-unit cancellation. Existing scheduler/output/backpressure and Git locking rules remain in place. |
| `adapter-utils/src/git-workspace-sync.ts` (`runLocalGit`) and `server/services/execution-workspaces.ts` (`runGit`) | Shared metadata/bundle helpers now use buffered scopes when a resource context is present. Server workspace Git calls install the operator context, including calls outside dispatch. Server instruction/checkpoint/native workspace preparation and deferred restoration install the operator context. Mandatory writer locks and caller Git environment settings remain unchanged. |
| `server/services/agent-directory-working-copies.ts` | SSH instruction staging/restoration now installs operator policy independently of dispatch. The shared server target wrapper also covers legacy instruction copies, file-checkpoint transport, and native workspace preparation, including callbacks invoked later outside the original context. |
| `server/services/native-runtime/native-codex-runner.ts` (`executeNativeCodexRunner`) | The exported compatibility runner now installs operator policy and uses the shared stdio boundary, preserving the actual worker PID, bootstrap environment and session arguments. Completion and shutdown await whole-unit cleanup; admission cancellation releases the prepared coordinator. Source search still found no production caller. |

Generated process-session commands in `execution-target.ts`, the GitHub launcher,
and the local sandbox network proxy launch children at their execution target.
They must inherit the target's verified boundary; a textual `spawn` match in their
source generator does not prove a host controller launch. Native file handoff's
`lsof` lookup is Darwin-only, with a one-second deadline and 16 KiB output cap;
it is outside the Linux cgroup coverage claim.

Rebuild and stage the release runner before packaged qualification. A stale local
`dist/bin/paperclip-runnerd` can precede the rebuilt debug binary in resolution and
lack the private resource handoff. Passing tests against an explicitly selected
debug loader does not qualify that staged release artifact.

Scheduled Git scans share global admission and the aggregate slice with agents.
When agents use all capacity, scans queue until capacity is available or their
deadline expires; they do not fall back to unrestricted execution. The stress
qualification must assess UI behavior under this contention, including an
operator configuration with one execution slot. Host helpers retain their
private launch files when unit cleanup fails and log memory-limit evidence once
per failed helper. Other direct Git, SSH and archive helpers in the table still
require integration.

Buffered commands retain exact arguments, environment and optional stdin. Their
limits cover admission waits, buffered bytes and complete descendant cleanup;
memory kills remain distinct from ordinary exits, timeouts and cancellation.
Missing executables retain ENOENT/EACCES compatibility, and nonzero exits retain
stdout/stderr diagnostics. SSH text helpers keep their existing limits; archive
commands now have a two-minute deadline. Server workspace metadata Git commands
keep Node's former 1 MiB output budget and gain a two-minute deadline. Tests cover
real Git metadata/tar creation call sites and an SSH executable fixture handoff,
alongside timeout descendants, output overflow, memory failure and recovery.

Transfer groups reuse an existing session envelope or reserve one global slot for
all local transfer roots. Each root has a scope within the shared memory/CPU/task
budget; the two-minute deadline includes admission and completion cleanup.
Cancellation stops complete scopes, and a memory kill reports
`execution_resource_limit` before subsequent work is admitted. Streaming stderr
retains a finite 128 Ki-character diagnostic tail. The SSH remote host still owns
its remote-side resource policy; a local SSH cgroup does not govern a remote
machine. Tests cover one-slot paired streams, delayed subscription to immediate
exit, deadline descendants, failed partners, queued admission, shared OOM and
recovery, and real tar streams through a local SSH executable fixture.

Controller staging uses `server/services/host-execution-target.ts` for both
preparation and later restore/snapshot-cleanup callbacks. Every invocation
reuses an active run context or installs operator policy with the original run
identity. The local instruction Git-exclude program also uses the buffered
scope runner. A lightweight `native-runtime/runner-binary.ts` resolver avoids
loading the native execution and authorized-tool graph for a helper; its old
export remains available. Focused real tests use a mocked target transport that
launches actual scoped commands, including deferred restore OOM and recovery.
They prove the wrapper boundary; separate instruction/checkpoint/native workspace
regressions cover the actual service call sites. Remote platform shell probes now use the shared server target wrapper. Model
discovery/refresh/detection and all environment-test route branches install
operator policy outside dispatch. Native ACPX installation verification opens
and closes verified descriptor leases without launching a provider. It is not
an additional child-process path. The older exported native runner is now
governed; broader native detach/reattach/restart qualification remains open.

A bounded compiler diagnostic excluded 258 colocated server test roots without
changing the repository configuration. It still approached the existing 2.2 GiB
validation ceiling and did not finish by the diagnostic deadline. Test inclusion
alone does not explain the server compiler memory problem. No full server
compiler pass or low-memory VPS claim follows from this diagnostic.


### Discovery and compatibility runner qualification (2026-10-08)

Real systemd fixtures verify registry model listing, refresh and detection outside
agent dispatch; a 96 MiB discovery OOM is distinct from an ordinary error, and a
later discovery succeeds. The authenticated environment-test route launches its
fixture inside a scope, while the saved-agent redacted environment regression
continues to pass. These cover the server context boundary; external plugins
that bypass shared launch functions must still implement their own boundary.

The older exported native Codex entry point retains the direct spawn when
operator isolation is disabled. Under systemd, the shared service boundary
preserves arguments, bootstrap environment and worker identity. An optional
AbortSignal cancels queued/running launches. Both graceful shutdown and failure
wait for descendant cleanup, and memory-limit errors propagate even when the
provider parser would otherwise fail. A real runner/PostgreSQL vertical slice
proved durable completion and provider session resume in two separate worker
cgroups. A separate coordinator fixture proves literal environment preservation,
detached-descendant cleanup, OOM classification, later recovery, and queued
cancellation before launch. These do not qualify all native providers or control
plane restart recovery.

Validation controller units retain finite hard memory, CPU, task and runtime
limits. The real fixture worker budget was 96 MiB inside the existing 192 MiB
aggregate validation slice; the live managed installation was not reconfigured.
Live cgroup samples are retained because systemd exit-time peaks under-report
these validation units. Full repository checks and the integrated workload
benchmark remain required before PR readiness or a minimum-VPS recommendation.

### Adopted local runner containment (2026-10-08)

Local runner adoption now captures its systemd unit from server-owned run events
scoped to the company and run, checks the live PID start fingerprint and cgroup,
and verifies the manager's unit identity and memory limit. Signals cover every
process in that unit. After authenticated transport shutdown, cleanup verifies
whole-unit termination even if the leader already exited. A failed cleanup
rejects close; it does not prove the session can be reused. Authentication
failure and detached-controller finalization do not authorize cleanup. Existing
unmanaged pre-upgrade runners retain their prior verified-PID behavior.

A real sibling-cgroup fixture kills the leader and confirms its detached child
survives until recovered unit cleanup. Focused transport regressions check the
authentication and detached-controller gates. This is component qualification;
the database-backed hard-restart scenario and remaining provider lifecycle
coverage still need qualification with the resource boundary enabled.

The 40,000-file streaming fixture now sets repository-local Git identity so it
does not depend on operator configuration. In a 1,500 MiB controller unit it
reached the deletion lane but exceeded its 180-second deadline. This remains an
open validation failure; the fixture timeout and resource defaults were not
increased to claim a pass.
