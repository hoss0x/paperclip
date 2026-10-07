import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { currentExecutionResources, withExecutionResourceContext } from "./execution-resource-context.js";

const execFileAsync = promisify(execFile);

/** Persistent and transient protocol roots share one reservation and OS budget.
 * The owner must retain this lease for the session lifetime, including idle time.
 * close() releases capacity only after every root and the slice have stopped.
 */
export async function prepareExecutionRunEnvelope(input: { signal?: AbortSignal } = {}) {
  const resources = currentExecutionResources();
  if (!resources || resources.policy.isolation !== "systemd") throw new Error("Run envelopes require systemd isolation");
  if (resources.rootAdmission) throw new Error("Execution run envelopes cannot be nested");
  const parent = resources.slice;
  if (!parent) throw new Error("Run envelopes require a configured aggregate slice");
  if (!/^paperclip-[a-zA-Z0-9-]+\.slice$/.test(parent)) throw new Error("Invalid execution parent slice");
  const cancelled = new AbortController();
  const signal = AbortSignal.any([cancelled.signal, ...[input.signal, resources.signal].filter((value): value is AbortSignal => !!value)]);
  const release = await resources.admission.acquire(resources.policy.memoryMaxBytes, signal);
  const slice = `${parent.slice(0, -6)}-run${randomUUID().replaceAll("-", "")}.slice`;
  const policy = resources.policy;
  const ctl = (args: string[]) => execFileAsync("systemctl", ["--user", ...args], { timeout: 5_000 });
  let cgroup: string;
  async function stop() {
    await ctl(["stop", slice]);
    const { stdout } = await ctl(["show", slice, "--property=ActiveState", "--value"]);
    if (!["inactive", "failed"].includes(stdout.trim())) throw new Error("Execution run envelope did not stop");
    await ctl(["revert", slice]);
  }
  try {
    await ctl(["start", slice]);
    await ctl(["set-property", "--runtime", slice,
      `MemoryMax=${policy.memoryMaxBytes}`, `MemoryHigh=${policy.memoryHighBytes}`,
      `MemorySwapMax=${policy.memorySwapMaxBytes}`, `CPUQuota=${policy.cpuQuotaPercent}%`,
      `TasksMax=${policy.tasksMax}`, "MemoryAccounting=yes"]);
    const { stdout } = await ctl(["show", slice, "--property=MemoryMax,MemoryHigh,MemorySwapMax,TasksMax"]);
    const applied = Object.fromEntries(stdout.trim().split("\n").map(line => line.split("=")));
    if (Number(applied.MemoryMax) !== policy.memoryMaxBytes || Number(applied.MemoryHigh) !== policy.memoryHighBytes
      || Number(applied.MemorySwapMax) !== policy.memorySwapMaxBytes || Number(applied.TasksMax) !== policy.tasksMax) {
      throw new Error("Execution run envelope did not apply its limits");
    }
    if (signal.aborted) throw new Error("Execution cancelled before run envelope admission");
    const { stdout: group } = await ctl(["show", slice, "--property=ControlGroup", "--value"]);
    if (!group.trim().startsWith("/") || group.trim() === "/") throw new Error("Execution run envelope has no cgroup");
    cgroup = `/sys/fs/cgroup${group.trim()}`;
  } catch (error) {
    await stop();
    release();
    throw error;
  }
  let active = 0;
  let closing = false;
  let closed = false;
  let closingPromise: Promise<void> | undefined;
  let peakMemoryBytes = 0;
  let resourceLimitReached = false;
  async function sample() {
    try {
      const [peak, events] = await Promise.all([fs.readFile(`${cgroup}/memory.peak`, "utf8"), fs.readFile(`${cgroup}/memory.events`, "utf8")]);
      peakMemoryBytes = Math.max(peakMemoryBytes, Number(peak));
      resourceLimitReached ||= /^oom_kill [1-9]\d*$/m.test(events);
    } catch { /* Preserve previous samples after systemd unloads the cgroup. */ }
  }
  const drainWaiters = new Set<() => void>();
  const admission = {
    async acquire(bytes: number, requestedSignal?: AbortSignal): Promise<() => void> {
      if (closing || signal.aborted || requestedSignal?.aborted) throw new Error("Execution run envelope is closed or cancelled");
      if (bytes !== policy.memoryMaxBytes) throw new Error("Execution root budget differs from its run envelope");
      active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active--;
        if (!active) for (const resolve of drainWaiters) resolve();
      };
    },
  };
  const context = { ...resources, rootAdmission: admission, slice, signal,
    onEvidence: async (evidence: Parameters<NonNullable<typeof resources.onEvidence>>[0]) => {
      await sample();
      await resources.onEvidence?.({ ...evidence, resourceLimitReached: evidence.resourceLimitReached || resourceLimitReached });
    } };
  function close(): Promise<void> {
    if (closed) return Promise.resolve();
    return closingPromise ??= (async () => {
      closing = true;
      signal.removeEventListener("abort", abort);
      clearInterval(samples);
      await sample();
      cancelled.abort();
      // Stopping the parent also catches detached roots and kills them together.
      await stop();
      if (active) await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); drainWaiters.delete(done); resolve(); };
        const timer = setTimeout(() => { drainWaiters.delete(done); reject(new Error("Execution roots have not completed verified cleanup")); }, 10_000);
        drainWaiters.add(done);
      });
      closed = true;
      signal.removeEventListener("abort", abort);
      release();
    })().catch(error => { closingPromise = undefined; throw error; });
  }
  const abort = () => { void close().catch(() => { /* Retain reservation; owner can retry cleanup. */ }); };
  let sampling = false;
  const samples = setInterval(() => {
    if (sampling || closing) return;
    sampling = true;
    void sample().then(() => { if (resourceLimitReached) abort(); }).finally(() => { sampling = false; });
  }, 250);
  samples.unref();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return { slice, close, get measurement() { return { peakMemoryBytes, resourceLimitReached }; }, run: <T>(execute: () => Promise<T>): Promise<T> => {
    if (closing || signal.aborted) return Promise.reject(new Error("Execution run envelope is closed or cancelled"));
    return withExecutionResourceContext(context, execute);
  } };
}
