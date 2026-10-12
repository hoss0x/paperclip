import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { currentExecutionResources, withExecutionResourceContext } from "./execution-resource-context.js";
import { prepareExecutionRunEnvelope } from "./execution-run-envelope.js";
import { launchResourceStdioProcess, type ResourceStdioProcess } from "./resource-stdio-process.js";

type TransferSpawn = (command: string, args: string[], options: SpawnOptions) => Promise<ChildProcess>;

/** Transfer partners share one reservation; their pipes retain backpressure.
 * Close callbacks observe stream drain and verified cleanup, including early exit.
 */
export async function withResourceTransferGroup<T>(execute: (spawnProcess: TransferSpawn) => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const resources = currentExecutionResources();
  if (resources?.policy.isolation !== "systemd") return execute(async (command, args, options) => spawn(command, args, options));
  const abort = new AbortController();
  const signal = resources.signal ? AbortSignal.any([resources.signal, abort.signal]) : abort.signal;
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  deadline.unref();
  const workers: ResourceStdioProcess[] = [];
  let limited = false;
  let failed = false;
  let envelope: Awaited<ReturnType<typeof prepareExecutionRunEnvelope>> | undefined;
  try {
    if (!resources.rootAdmission) envelope = await prepareExecutionRunEnvelope({ signal });
    const run = async () => {
      const context = currentExecutionResources()!;
      return withExecutionResourceContext({ ...context, signal, onEvidence: async evidence => {
        limited ||= evidence.resourceLimitReached;
        await context.onEvidence?.(evidence);
      } }, () => execute(async (command, args, options) => {
        if (!Array.isArray(options.stdio) || options.stdio.length !== 3
          || options.stdio.some(value => value !== "pipe" && value !== "ignore")) throw new Error("Invalid transfer stream handoff");
        const worker = await launchResourceStdioProcess({ runId: resources.runId ?? randomUUID(), command, args,
          cwd: typeof options.cwd === "string" ? options.cwd : process.cwd(), env: options.env ?? process.env,
          scope: true, nativeLoaderCommand: resources.nativeLoaderCommand?.(), detached: true, allowEarlyExit: true, signal });
        workers.push(worker);
        const child = worker.child;
        if (options.stdio[0] === "ignore") child.stdin.end();
        if (options.stdio[1] === "ignore") child.stdout.resume();
        if (options.stdio[2] === "ignore") child.stderr.resume();
        const drained = worker.completion.then(async result => {
          await Promise.all([finished(child.stdout, { writable: false }), finished(child.stderr, { writable: false })]);
          return result;
        });
        void drained.catch(() => {});
        const proxy: ChildProcess = new Proxy(child, {
          get(target, property) {
            if (property === "kill") return (requested: NodeJS.Signals = "SIGTERM") => { worker.signal(requested); return true; };
            if (property === "on") return (event: string, listener: (...args: any[]) => void) => {
              if (event === "close") {
                void drained.then(result => listener(result.code ?? 1, result.signal)).catch(error => target.emit("error", error));
              } else {
                target.on(event, listener);
                if (event === "error") void drained.catch(listener);
              }
              return proxy;
            };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return proxy;
      }));
    };
    const result = envelope ? await envelope.run(run) : await run();
    await Promise.all(workers.map(worker => worker.completion));
    if (limited || envelope?.measurement.resourceLimitReached) throw Object.assign(new Error("Transfer exceeded its memory resource limit"), { code: "execution_resource_limit" });
    if (signal.aborted) throw new Error("Transfer cancelled or timed out");
    return result;
  } catch (error) {
    failed = true;
    if (limited || envelope?.measurement.resourceLimitReached) throw Object.assign(new Error("Transfer exceeded its memory resource limit"), { code: "execution_resource_limit" });
    throw error;
  } finally {
    if (failed || signal.aborted) {
      abort.abort();
      // Discard buffered pipes on a failed transfer so raw close cannot wait
      // behind a sink which the caller has already destroyed.
      for (const worker of workers) {
        worker.child.stdin.destroy(); worker.child.stdout.destroy(); worker.child.stderr.destroy();
        (worker.child.stdio[1] as import("node:stream").Readable | null)?.destroy();
        (worker.child.stdio[2] as import("node:stream").Readable | null)?.destroy();
      }
    }
    try { await Promise.all(workers.map(worker => worker.completion)); }
    finally {
      try { await envelope?.close(); }
      finally { clearTimeout(deadline); }
    }
  }
}
