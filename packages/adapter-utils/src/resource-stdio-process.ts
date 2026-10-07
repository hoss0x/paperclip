import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import { currentExecutionResources } from "./execution-resource-context.js";
import { applyLowMemoryEnvironment } from "./execution-resource-policy.js";
import { prepareSystemdExecution } from "./systemd-execution.js";

/** A protocol transport retains its own stream decoder and diagnostic policy. */
export interface ResourceStdioProcess {
  child: ChildProcessWithoutNullStreams;
  pid: number;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  signal: (signal: NodeJS.Signals) => void;
}

interface StdioLaunchInput {
  runId: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal;
  scope?: boolean;
  nativeLoaderCommand?: string;
  extraStdio?: Array<"pipe" | "ignore" | number>;
  detached?: boolean;
}

export interface PreparedResourceScopeProcess {
  /** Descriptor leases remain open until this synchronous spawn returns. */
  spawn(input: Pick<StdioLaunchInput, "command" | "args" | "cwd" | "env" | "extraStdio" | "detached">): ResourceStdioProcess & { ready: Promise<void> };
  close(): Promise<void>;
}

export async function launchResourceStdioProcess(input: StdioLaunchInput): Promise<ResourceStdioProcess> {
  const prepared = await reserveStdioProcess(input);
  try { const worker = prepared.spawn(input); await worker.ready; return worker; }
  catch (error) { await prepared.close(); throw error; }
}

/** Admit before a verified synchronous launcher duplicates its descriptors. */
export async function prepareResourceScopeProcess(input: {
  runId: string; cwd: string; nativeLoaderCommand: string; signal?: AbortSignal;
}): Promise<PreparedResourceScopeProcess> {
  return reserveStdioProcess({ ...input, scope: true, command: "/bin/false", args: [], env: {} });
}

async function reserveStdioProcess(input: StdioLaunchInput): Promise<PreparedResourceScopeProcess> {
  const resources = currentExecutionResources();
  if (!resources || resources.policy.isolation !== "systemd") throw new Error("Stdio isolation requires a resource context");
  const cancellationSignal = input.signal && resources.signal ? AbortSignal.any([input.signal, resources.signal]) : input.signal ?? resources.signal;
  const release = await resources.admission.acquire(resources.policy.memoryMaxBytes, cancellationSignal);
  let boundary: Awaited<ReturnType<typeof prepareSystemdExecution>> | undefined;
  try {
    boundary = await prepareSystemdExecution({ ...input, policy: resources.policy,
      env: applyLowMemoryEnvironment(input.env, resources.policy), scratchDir: resources.scratchDir, slice: resources.slice });
    await resources.onUnitPrepared?.({ unit: boundary.unit, memoryMaxBytes: resources.policy.memoryMaxBytes });
    if (cancellationSignal?.aborted) throw new Error("Execution cancelled before launch");
  } catch (error) {
    await boundary?.finish();
    release();
    throw error;
  }
  const owned = boundary;
  let worker: (ResourceStdioProcess & { ready: Promise<void> }) | undefined;
  let consumed = false;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= (async () => {
    consumed = true;
    cancellationSignal?.removeEventListener("abort", cancelPrepared);
    if (worker) {
      worker.signal("SIGTERM");
      const escalation = setTimeout(() => worker!.signal("SIGKILL"), 1_000);
      try { await worker.completion; } finally { clearTimeout(escalation); }
    } else {
      const evidence = await owned.finish(cancellationSignal?.aborted ?? false);
      release();
      await resources.onEvidence?.(evidence);
    }
  })();
  const cancelPrepared = () => { void close().catch(() => {}); };
  cancellationSignal?.addEventListener("abort", cancelPrepared, { once: true });
  if (cancellationSignal?.aborted) cancelPrepared();
  return {
    close,
    spawn: launch => {
      if (consumed || cancellationSignal?.aborted) throw new Error("Prepared execution scope is closed or cancelled");
      consumed = true;
      cancellationSignal?.removeEventListener("abort", cancelPrepared);
      try {
        if (input.scope) owned.configureScope({ ...launch, env: applyLowMemoryEnvironment(launch.env, resources.policy) });
        worker = spawnStdioProcess({ ...input, ...launch }, owned, resources, release, cancellationSignal);
        return worker;
      } catch (error) {
        void close().catch(() => {});
        throw error;
      }
    },
  };
}

function spawnStdioProcess(input: StdioLaunchInput,
  owned: Awaited<ReturnType<typeof prepareSystemdExecution>>,
  resources: NonNullable<ReturnType<typeof currentExecutionResources>>,
  release: () => void, cancellationSignal?: AbortSignal,
): ResourceStdioProcess & { ready: Promise<void> } {
  // The systemd client needs the operator's user-manager connection variables.
  // Only the private invocation file supplies the provider's exact environment.
  if (input.extraStdio?.length && !input.scope) throw new Error("Inherited execution descriptors require a systemd scope");
  const child = spawn(owned.command, owned.args, { cwd: input.cwd, env: process.env,
    stdio: ["pipe", "pipe", "pipe", ...(input.extraStdio ?? [])], detached: input.detached ?? false }) as ChildProcessWithoutNullStreams;
  let cancelled = false;
  let escalation: NodeJS.Timeout | undefined;
  const signal = (requested: NodeJS.Signals) => {
    cancelled = true;
    void owned.signal(requested).catch(() => { /* Completion verifies whole-unit cleanup. */ });
  };
  const abort = () => {
    signal("SIGTERM");
    escalation ??= setTimeout(() => signal("SIGKILL"), 1_000);
  };
  cancellationSignal?.addEventListener("abort", abort, { once: true });
  const samples = setInterval(() => { void owned.sample(); }, 500);
  samples.unref();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  void closed.catch(() => {});
  // A scope's leader can exit while descendants retain protocol pipes. Clean
  // the unit on leader exit, then drain close; waiting for close first can hang.
  const exited = input.scope ? new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }) : closed;
  const completion = exited.then(async result => {
    const evidence = await owned.finish(cancelled);
    await closed;
    release();
    await resources.onEvidence?.(evidence);
    const signalled = evidence.mainExitCode === 2 || evidence.mainExitCode === 3;
    return {
      code: signalled ? null : evidence.mainExitCode === 1 ? evidence.mainExitStatus : result.code,
      signal: signalled ? (Object.entries(os.constants.signals).find(([, code]) => code === evidence.mainExitStatus)?.[0] as NodeJS.Signals | undefined) ?? result.signal : result.signal,
    };
  }, async error => {
    const evidence = await owned.finish(cancelled);
    release();
    await resources.onEvidence?.(evidence);
    throw error;
  }).finally(() => {
    clearInterval(samples);
    clearTimeout(escalation);
    cancellationSignal?.removeEventListener("abort", abort);
  });
  // Attach before returning/awaiting identity; short-lived failures cannot leak
  // an unhandled rejection while a protocol constructor is being prepared.
  void completion.catch(() => {});
  const ready = Promise.race([owned.identity(), completion.then(() => {
    throw new Error("Execution stopped before its protocol transport started");
  })]).then(identity => {
    if (input.scope && identity.pid !== child.pid) throw new Error("Scope worker PID changed during handoff");
    worker.pid = identity.pid;
    if (cancellationSignal?.aborted) abort();
  }).catch(async error => {
    signal("SIGKILL");
    await completion.catch(() => {});
    throw error;
  });
  void ready.catch(() => {});
  const worker = { child, pid: child.pid ?? 0, completion, signal, ready };
  return worker;
}
