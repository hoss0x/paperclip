import { randomUUID } from "node:crypto";
import { currentExecutionResources, withExecutionResourceContext } from "./execution-resource-context.js";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";

export interface ResourceProcessLaunchSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

/** Structural match for the native runner's synchronous launcher seam. */
export interface ResourceProcessHandle {
  child: { pid?: number; exitCode: number | null; signalCode?: NodeJS.Signals | null; kill(signal?: NodeJS.Signals | number): boolean };
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  ready: Promise<{ pid: number; processGroupId: number | null; startedAt: string; ownershipRecorded: boolean }>;
  processGroupId: number | null;
  startedAt: string;
}

export function createResourceProcessLauncher(input: {
  runId: string;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string; executionUnit?: string }) => Promise<void>;
}): ((spec: ResourceProcessLaunchSpec) => ResourceProcessHandle) | undefined {
  const resources = currentExecutionResources();
  if (!resources || resources.policy.isolation !== "systemd") return undefined;
  return spec => {
    const executionId = `${input.runId}-${randomUUID()}`;
    const controller = new AbortController();
    // Retained factories launch later roots for the authenticated current owner.
    const parentSignal = resources.ownership ? resources.ownership.signal : resources.signal;
    const parentAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", parentAbort, { once: true });
    if (parentSignal?.aborted) parentAbort();
    const child: ResourceProcessHandle["child"] = {
      exitCode: null,
      signalCode: null,
      kill: requestedSignal => {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        const signal = requestedSignal === "SIGKILL" || requestedSignal === 9 ? "SIGKILL"
          : requestedSignal === "SIGINT" || requestedSignal === 2 ? "SIGINT" : "SIGTERM";
        const running = runningProcesses.get(executionId);
        if (running) { running.cancelled = true; signalRunningProcess(running, signal); }
        else controller.abort(new Error("Native execution cancelled before launch"));
        return true;
      },
    };
    const startedAt = new Date().toISOString();
    let resolveReady!: (identity: { pid: number; processGroupId: number | null; startedAt: string; ownershipRecorded: boolean }) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<{ pid: number; processGroupId: number | null; startedAt: string; ownershipRecorded: boolean }>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Cancellation may happen before the consumer begins awaiting readiness.
    void ready.catch(() => {});
    const completion = withExecutionResourceContext({ ...resources, signal: controller.signal }, async () => {
      const environment = Object.fromEntries(Object.entries(spec.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const result = await runChildProcess(executionId, spec.command, [...spec.args], {
        cwd: spec.cwd, env: environment, timeoutSec: 0, graceSec: 1,
        // Native runner-owned diagnostics remain the redacted, bounded channel.
        // Do not expose raw process output through a new logging path.
        onLog: async () => {},
        onSpawn: async meta => {
          child.pid = meta.pid;
          try {
            await input.onSpawn?.(meta);
            resolveReady({ ...meta, ownershipRecorded: input.onSpawn !== undefined });
          } catch (error) {
            rejectReady(error);
            controller.abort(error);
            throw error;
          }
        },
      });
      child.exitCode = result.exitCode;
      child.signalCode = result.signal as NodeJS.Signals | null;
      return { code: result.exitCode, signal: child.signalCode, stdout: "", stderr: "" };
    }).catch(error => { child.exitCode = 1; rejectReady(error); throw error; })
      .finally(() => parentSignal?.removeEventListener("abort", parentAbort));
    // A queued cancellation can settle without ever spawning a worker.
    void completion.then(() => { if (child.pid === undefined) rejectReady(new Error("Native execution ended before launch")); }, () => {});
    return { child, completion, ready, processGroupId: null, startedAt };
  };
}
