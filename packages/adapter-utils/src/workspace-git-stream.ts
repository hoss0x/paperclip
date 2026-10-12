import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { currentExecutionResources, withExecutionResourceContext } from "./execution-resource-context.js";
import { launchResourceStdioProcess, type ResourceStdioProcess } from "./resource-stdio-process.js";
import { WORKSPACE_STREAM_CHUNK_BYTES } from "./workspace-manifest.js";

export interface WorkspaceGitProcessInput {
  cwd: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  killGraceMs?: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  onStdout?: (chunk: Buffer) => Promise<void> | void;
  gitBinary?: string;
  gitArgsPrefix?: readonly string[];
}

function failure(code: string, message: string, details: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, details });
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  // The leader may have exited while a descendant still holds its pipes open.
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, signal); return; } catch { /* direct child fallback */ }
  }
  try { child.kill(signal); } catch { /* close owns settlement */ }
}

/** Completion is a barrier for the process, its pipes, and the awaited sink. */
export async function runWorkspaceGitProcess(input: WorkspaceGitProcessInput): Promise<{ stdout: string; stderr: string }> {
  if (input.signal?.aborted) throw failure("workspace_git_scan_cancelled", "Workspace Git scan was cancelled");
  const resources = currentExecutionResources();
  const command = input.gitBinary ?? "git";
  const args = [...(input.gitArgsPrefix ?? []), "-C", input.cwd, ...input.args];
  const env = { ...(input.env ?? process.env), GIT_OPTIONAL_LOCKS: "0" };
  let worker: ResourceStdioProcess | undefined;
  let limited = false;
  // Admission is part of the scan deadline. Capacity waits must not occupy a
  // scheduler slot indefinitely, and queued cancellation must never launch.
  const deadline = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const admissionTimer = setTimeout(() => deadline.abort(), input.timeoutMs);
  admissionTimer.unref();
  try {
    if (resources?.policy.isolation === "systemd") {
      worker = await withExecutionResourceContext({ ...resources, onEvidence: async evidence => {
        limited ||= evidence.resourceLimitReached;
        await resources.onEvidence?.(evidence);
      } }, () => launchResourceStdioProcess({ runId: resources.runId ?? randomUUID(), command, args, cwd: input.cwd, env,
        signal, scope: true, nativeLoaderCommand: resources.nativeLoaderCommand?.(),
        detached: true, allowEarlyExit: true }));
      worker.child.stdin.end();
    }
  } catch (cause) {
    clearTimeout(admissionTimer);
    if (limited) throw failure("workspace_git_scan_resource_limit", "Workspace Git scan exceeded its memory resource limit");
    if (input.signal?.aborted) throw failure("workspace_git_scan_cancelled", "Workspace Git scan was cancelled");
    if (deadline.signal.aborted) throw failure("workspace_git_scan_timeout", "Workspace Git scan deadline expired during admission");
    throw cause;
  }
  const child = worker?.child ?? spawn(command, args, {
    // Background scans must not compete with real writers by refreshing the
    // index as a side effect. Mandatory locks for writes remain enforced by Git.
    cwd: input.cwd, env,
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true,
  });
  let error: Error | null = null;
  let killTimer: NodeJS.Timeout | undefined;
  const kill = (signal: NodeJS.Signals) => worker ? worker.signal(signal) : signalProcess(child, signal);
  const terminate = (reason: Error) => {
    if (error) return;
    error = reason;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), input.killGraceMs ?? 250);
    killTimer.unref();
  };
  const onAbort = () => terminate(failure("workspace_git_scan_cancelled", "Workspace Git scan was cancelled"));
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  const onDeadline = () => terminate(failure("workspace_git_scan_timeout", `Workspace Git scan timed out after ${input.timeoutMs}ms`, { timeoutMs: input.timeoutMs }));
  deadline.signal.addEventListener("abort", onDeadline, { once: true });
  if (deadline.signal.aborted) onDeadline();
  const closed = worker?.completion ?? new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", (cause) => terminate(failure("workspace_git_scan_failed", "Workspace Git scan could not start", { cause: cause.message })));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const collect = async (stream: NonNullable<typeof child.stdout>, limit: number, sink?: WorkspaceGitProcessInput["onStdout"]) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const raw of stream) {
        const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (error) continue;
        if (sink) {
          for (let offset = 0; offset < buffer.length; offset += WORKSPACE_STREAM_CHUNK_BYTES) {
            if (error) break;
            await sink(buffer.subarray(offset, offset + WORKSPACE_STREAM_CHUNK_BYTES));
          }
        } else {
          bytes += buffer.length;
          if (bytes > limit) {
            terminate(failure("workspace_git_scan_output_limit", "Workspace Git scan exceeded its output limit"));
          } else chunks.push(buffer);
        }
      }
    } catch (cause) {
      terminate(failure("workspace_git_scan_failed", "Workspace Git scan stream failed", { cause: cause instanceof Error ? cause.message : String(cause) }));
    }
    return Buffer.concat(chunks).toString("utf8");
  };
  try {
    const [outcome, stdout, stderr] = await Promise.all([
      closed, collect(child.stdout!, input.maxStdoutBytes, input.onStdout), collect(child.stderr!, input.maxStderrBytes),
    ]);
    if (limited) throw failure("workspace_git_scan_resource_limit", "Workspace Git scan exceeded its memory resource limit");
    if (error) throw error;
    if (outcome.code !== 0) throw failure("workspace_git_scan_failed", "Workspace Git scan failed", {
      exitCode: outcome.code, signal: outcome.signal, stderr: stderr.trim().slice(0, 1000),
    });
    return { stdout, stderr };
  } finally {
    clearTimeout(admissionTimer);
    if (killTimer) clearTimeout(killTimer);
    input.signal?.removeEventListener("abort", onAbort);
    deadline.signal.removeEventListener("abort", onDeadline);
  }
}
