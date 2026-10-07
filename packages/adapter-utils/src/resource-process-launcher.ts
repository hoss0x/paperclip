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
    const parentAbort = () => controller.abort(resources.signal?.reason);
    resources.signal?.addEventListener("abort", parentAbort, { once: true });
    if (resources.signal?.aborted) parentAbort();
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
    const completion = withExecutionResourceContext({ ...resources, signal: controller.signal }, async () => {
      const environment = Object.fromEntries(Object.entries(spec.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const result = await runChildProcess(executionId, spec.command, [...spec.args], {
        cwd: spec.cwd, env: environment, timeoutSec: 0, graceSec: 1,
        // Native runner-owned diagnostics remain the redacted, bounded channel.
        // Do not expose raw process output through a new logging path.
        onLog: async () => {},
        onSpawn: async meta => { child.pid = meta.pid; await input.onSpawn?.(meta); },
      });
      child.exitCode = result.exitCode;
      child.signalCode = result.signal as NodeJS.Signals | null;
      return { code: result.exitCode, signal: child.signalCode, stdout: "", stderr: "" };
    }).catch(error => { child.exitCode = 1; throw error; })
      .finally(() => resources.signal?.removeEventListener("abort", parentAbort));
    return { child, completion, processGroupId: null, startedAt };
  };
}
