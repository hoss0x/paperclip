import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { currentExecutionResources, withExecutionResourceContext } from "./execution-resource-context.js";
import { launchResourceStdioProcess } from "./resource-stdio-process.js";

export interface BufferedCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  stdin?: string;
  signal?: AbortSignal;
}

/** Buffered host commands use the same scope/admission path as transports.
 * Unsupported or explicitly disabled isolation retains Node execFile behavior.
 */
export async function execFileWithResources(command: string, args: string[], options: BufferedCommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const resources = currentExecutionResources();
  const timeoutMs = options.timeout ?? 15_000;
  const maxBuffer = options.maxBuffer ?? 128 * 1024;
  if (resources?.policy.isolation !== "systemd") {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, { cwd: options.cwd, env: options.env,
        timeout: timeoutMs, maxBuffer, signal: options.signal }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
      child.stdin?.on("error", () => { /* execFile callback owns failure. */ });
      child.stdin?.end(options.stdin);
    });
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) {
    throw new Error("Resource commands require finite positive timeout and output limits");
  }
  const deadline = new AbortController();
  const signal = AbortSignal.any([deadline.signal,
    ...[options.signal, resources.signal].filter((value): value is AbortSignal => !!value)]);
  const cancelled = () => options.signal?.aborted || resources.signal?.aborted;
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref();
  let limited = false;
  let stdout = "";
  let stderr = "";
  let overflow = false;
  try {
    // Scope exec errors cannot arrive as Node spawn errors. Preserve the usual
    // ENOENT/EACCES contract for callers that detect missing Git/SSH tooling.
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const candidates = command.includes("/") ? [path.resolve(cwd, command)]
      : (env.PATH ?? "/usr/bin:/bin").split(":").map(directory => path.resolve(directory || cwd, command));
    let executable = false;
    let denied = false;
    for (const candidate of candidates) {
      try { await fs.access(candidate, constants.X_OK); executable = (await fs.stat(candidate)).isFile(); denied ||= !executable; }
      catch (error) { denied ||= (error as NodeJS.ErrnoException).code === "EACCES"; }
      if (executable) break;
    }
    if (!executable) throw Object.assign(new Error("Execution command is unavailable"), { code: denied ? "EACCES" : "ENOENT", stdout, stderr });
    const worker = await withExecutionResourceContext({ ...resources, onEvidence: async evidence => {
      limited ||= evidence.resourceLimitReached;
      await resources.onEvidence?.(evidence);
    } }, () => launchResourceStdioProcess({ runId: resources.runId ?? randomUUID(), command, args,
      cwd, env, signal,
      scope: true, nativeLoaderCommand: resources.nativeLoaderCommand?.(), detached: true, allowEarlyExit: true }));
    let escalation: NodeJS.Timeout | undefined;
    const stop = () => {
      worker.signal("SIGTERM");
      escalation ??= setTimeout(() => worker.signal("SIGKILL"), 250);
      escalation.unref();
    };
    const collect = async (stream: typeof worker.child.stdout) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const raw of stream) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (overflow) continue;
        bytes += chunk.length;
        if (bytes > maxBuffer) {
          const remaining = maxBuffer - (bytes - chunk.length);
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          overflow = true; stop();
        }
        else chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    const output = Promise.all([collect(worker.child.stdout), collect(worker.child.stderr)]);
    void output.catch(() => stop());
    worker.child.stdin.on("error", () => { /* Completion owns early child exit. */ });
    worker.child.stdin.end(options.stdin);
    try {
      const result = await worker.completion;
      [stdout, stderr] = await output;
      if (limited || overflow || signal.aborted || result.code !== 0) {
        throw Object.assign(new Error(limited ? "Execution exceeded its memory resource limit" : overflow
          ? "Command output exceeded maxBuffer" : deadline.signal.aborted ? "Command timed out"
          : cancelled() ? "Command cancelled" : `Command exited with code ${result.code ?? "null"}`), {
          code: limited ? "execution_resource_limit" : overflow ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            : cancelled() ? "ABORT_ERR" : result.code,
          signal: result.signal, killed: signal.aborted || overflow, stdout, stderr,
        });
      }
      return { stdout, stderr };
    } catch (error) {
      stop();
      worker.child.stdin.destroy();
      worker.child.stdout.destroy();
      worker.child.stderr.destroy();
      throw error;
    } finally {
      clearTimeout(escalation);
      await output.catch(() => undefined);
    }
  } catch (error) {
    if (limited) throw Object.assign(new Error("Execution exceeded its memory resource limit"), { code: "execution_resource_limit", stdout, stderr });
    if (signal.aborted) throw Object.assign(new Error(deadline.signal.aborted ? "Command timed out" : "Command cancelled"), {
      code: cancelled() ? "ABORT_ERR" : null, killed: true, stdout, stderr,
      signal: (error as { signal?: NodeJS.Signals | null }).signal ?? null,
    });
    throw error;
  } finally { clearTimeout(timer); }
}
