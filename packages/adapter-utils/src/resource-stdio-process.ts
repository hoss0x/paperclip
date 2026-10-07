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

export async function launchResourceStdioProcess(input: {
  runId: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<ResourceStdioProcess> {
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
  // The systemd client needs the operator's user-manager connection variables.
  // Only the private invocation file supplies the provider's exact environment.
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(owned.command, owned.args, { cwd: input.cwd, env: process.env, stdio: "pipe", detached: false });
  } catch (error) {
    await owned.finish();
    release();
    throw error;
  }
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
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const completion = exited.then(async result => {
    const evidence = await owned.finish(cancelled);
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
  try {
    const identity = await Promise.race([owned.identity(), completion.then(() => {
      throw new Error("Execution stopped before its protocol transport started");
    })]);
    if (cancellationSignal?.aborted) abort();
    return { child, pid: identity.pid, completion, signal };
  } catch (error) {
    signal("SIGKILL");
    await completion.catch(() => {});
    throw error;
  }
}
