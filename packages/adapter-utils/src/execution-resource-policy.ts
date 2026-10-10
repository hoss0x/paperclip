import os from "node:os";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export interface ExecutionResourcePolicy {
  isolation: "systemd" | "none";
  memoryMaxBytes: number;
  memoryHighBytes: number;
  memorySwapMaxBytes: number;
  capacityBytes: number;
  reserveBytes: number;
  maxConcurrent: number;
  helperMaxConcurrent?: number;
  cpuQuotaPercent: number;
  tasksMax: number;
  buildJobs: number;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum = 1): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${key} must be a safe integer >= ${minimum}`);
  }
  return value;
}

/** Operator environment only. Never resolve this from adapter/agent environment. */
export function resolveExecutionResourcePolicy(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  hostMemoryBytes = os.totalmem(),
): ExecutionResourcePolicy {
  const mode = env.PAPERCLIP_EXECUTION_ISOLATION ?? "auto";
  if (!["auto", "systemd", "none"].includes(mode)) {
    throw new Error("PAPERCLIP_EXECUTION_ISOLATION must be auto, systemd, or none");
  }
  if (mode === "systemd" && platform !== "linux") {
    throw new Error("systemd execution isolation requires Linux");
  }
  const reserveBytes = integer(env, "PAPERCLIP_EXECUTION_RESERVE_MIB", Math.ceil(Math.max(GiB, hostMemoryBytes / 4) / MiB)) * MiB;
  const capacityBytes = integer(env, "PAPERCLIP_EXECUTION_CAPACITY_MIB", Math.floor((hostMemoryBytes - reserveBytes) / MiB)) * MiB;
  // Retained agents need a full helper budget to make progress on small hosts.
  // Explicit operator limits remain authoritative.
  const memoryMaxBytes = integer(env, "PAPERCLIP_EXECUTION_MEMORY_MAX_MIB", Math.floor(Math.min(2 * GiB, capacityBytes / 2) / MiB)) * MiB;
  // A lower memory.high can throttle unreclaimable compiler/provider pages
  // indefinitely before memory.max is reached. Default to the hard boundary;
  // operators can opt into a measured lower soft threshold.
  const memoryHighBytes = integer(env, "PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB", memoryMaxBytes / MiB) * MiB;
  const memorySwapMaxBytes = integer(env, "PAPERCLIP_EXECUTION_MEMORY_SWAP_MAX_MIB", 0, 0) * MiB;
  if (![reserveBytes, capacityBytes, memoryMaxBytes, memoryHighBytes, memorySwapMaxBytes].every(Number.isSafeInteger)
    || !Number.isSafeInteger(hostMemoryBytes) || hostMemoryBytes <= 0
    || reserveBytes >= hostMemoryBytes || capacityBytes <= 0
    || capacityBytes + reserveBytes > hostMemoryBytes
    || memoryMaxBytes > capacityBytes || memoryHighBytes > memoryMaxBytes) {
    throw new Error("Execution memory policy must fit host memory after its reserved capacity");
  }
  return {
    isolation: mode === "none" || (mode === "auto" && platform !== "linux") ? "none" : "systemd",
    reserveBytes, capacityBytes, memoryMaxBytes, memoryHighBytes, memorySwapMaxBytes,
    maxConcurrent: integer(env, "PAPERCLIP_EXECUTION_MAX_CONCURRENT", Math.min(2, Math.max(1, Math.floor(capacityBytes / memoryMaxBytes) - 1))),
    helperMaxConcurrent: integer(env, "PAPERCLIP_EXECUTION_HELPER_MAX_CONCURRENT", 1),
    cpuQuotaPercent: integer(env, "PAPERCLIP_EXECUTION_CPU_QUOTA_PERCENT", 100),
    tasksMax: integer(env, "PAPERCLIP_EXECUTION_TASKS_MAX", 128),
    buildJobs: integer(env, "PAPERCLIP_EXECUTION_BUILD_JOBS", 1),
  };
}

/** Defaults use supported build-tool environment controls; explicit values survive. */
export function applyLowMemoryEnvironment(env: NodeJS.ProcessEnv, policy: ExecutionResourcePolicy): NodeJS.ProcessEnv {
  const jobs = String(policy.buildJobs);
  return {
    CARGO_BUILD_JOBS: jobs,
    CMAKE_BUILD_PARALLEL_LEVEL: jobs,
    RAYON_NUM_THREADS: jobs,
    GOMAXPROCS: jobs,
    GOMEMLIMIT: `${Math.floor(Math.min(policy.memoryHighBytes, policy.memoryMaxBytes * 0.75) / MiB)}MiB`,
    npm_config_workspace_concurrency: jobs,
    ...env,
  };
}

interface PendingAdmission {
  kind: "agent" | "helper";
  bytes: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** FIFO per lane, whole-budget reservation. Agents and controller helpers share
 * byte capacity across every company; each lane has its own bounded slot count. */
export class ExecutionResourceAdmission {
  #usedBytes = 0;
  #active = 0;
  #helpers = 0;
  #pending: PendingAdmission[] = [];

  constructor(readonly capacityBytes: number, readonly maxConcurrent: number, readonly helperMaxConcurrent = 1) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1
      || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1
      || !Number.isSafeInteger(helperMaxConcurrent) || helperMaxConcurrent < 1) {
      throw new Error("Execution admission needs positive integer capacity and concurrency");
    }
  }

  get snapshot() {
    return { usedBytes: this.#usedBytes, active: this.#active, queued: this.#pending.length };
  }

  /** Count already-running OS units before accepting new work after restart.
   * Existing work can exceed a newly reduced slot count; successors then wait.
   */
  adopt(bytes: number, kind: "agent" | "helper" = "agent"): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(this.#usedBytes + bytes)) {
      throw new Error("Existing execution unit has an invalid memory budget");
    }
    this.#usedBytes += bytes;
    this.#active++;
    if (kind === "helper") this.#helpers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#usedBytes -= bytes;
      this.#active--;
      if (kind === "helper") this.#helpers--;
      this.#drain();
    };
  }

  acquire(bytes: number, signal?: AbortSignal, kind: "agent" | "helper" = "agent"): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.capacityBytes) {
      return Promise.reject(new Error("Execution budget exceeds admission capacity"));
    }
    if (signal?.aborted) return Promise.reject(new Error("Execution cancelled while queued"));
    return new Promise((resolve, reject) => {
      const entry: PendingAdmission = { bytes, resolve, reject, signal, kind };
      entry.abort = () => {
        const index = this.#pending.indexOf(entry);
        if (index < 0) return;
        this.#pending.splice(index, 1);
        signal?.removeEventListener("abort", entry.abort!);
        reject(new Error("Execution cancelled while queued"));
        this.#drain();
      };
      this.#pending.push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.#drain();
    });
  }

  #drain() {
    while (this.#pending.length) {
      // FIFO within each lane. A helper can pass an agent waiting for an agent
      // slot, but both still reserve bytes from the same aggregate capacity.
      const seen = new Set<string>();
      const index = this.#pending.findIndex(entry => {
        if (seen.has(entry.kind)) return false;
        seen.add(entry.kind);
        const available = entry.kind === "helper" ? this.#helpers < this.helperMaxConcurrent
          : this.#active - this.#helpers < this.maxConcurrent;
        return available && this.#usedBytes + entry.bytes <= this.capacityBytes;
      });
      if (index < 0) return;
      const entry = this.#pending.splice(index, 1)[0]!;
      entry.signal?.removeEventListener("abort", entry.abort!);
      this.#usedBytes += entry.bytes;
      this.#active++;
      if (entry.kind === "helper") this.#helpers++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.#usedBytes -= entry.bytes;
        this.#active--;
        if (entry.kind === "helper") this.#helpers--;
        this.#drain();
      });
    }
  }
}
