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
  const memoryMaxBytes = integer(env, "PAPERCLIP_EXECUTION_MEMORY_MAX_MIB", Math.floor(Math.min(2 * GiB, capacityBytes) / MiB)) * MiB;
  const memoryHighBytes = integer(env, "PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB", Math.floor(memoryMaxBytes * 0.75 / MiB)) * MiB;
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
    maxConcurrent: integer(env, "PAPERCLIP_EXECUTION_MAX_CONCURRENT", Math.min(2, Math.floor(capacityBytes / memoryMaxBytes))),
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
    GOMEMLIMIT: `${Math.floor(policy.memoryHighBytes / MiB)}MiB`,
    npm_config_workspace_concurrency: jobs,
    ...env,
  };
}

interface PendingAdmission {
  bytes: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** FIFO, whole-budget reservation. Share one instance across all companies/adapters. */
export class ExecutionResourceAdmission {
  #usedBytes = 0;
  #active = 0;
  #pending: PendingAdmission[] = [];

  constructor(readonly capacityBytes: number, readonly maxConcurrent: number) {
    if (!Number.isSafeInteger(capacityBytes) || capacityBytes < 1
      || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("Execution admission needs positive integer capacity and concurrency");
    }
  }

  get snapshot() {
    return { usedBytes: this.#usedBytes, active: this.#active, queued: this.#pending.length };
  }

  /** Count already-running OS units before accepting new work after restart.
   * Existing work can exceed a newly reduced slot count; successors then wait.
   */
  adopt(bytes: number): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(this.#usedBytes + bytes)) {
      throw new Error("Existing execution unit has an invalid memory budget");
    }
    this.#usedBytes += bytes;
    this.#active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#usedBytes -= bytes;
      this.#active--;
      this.#drain();
    };
  }

  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > this.capacityBytes) {
      return Promise.reject(new Error("Execution budget exceeds admission capacity"));
    }
    if (signal?.aborted) return Promise.reject(new Error("Execution cancelled while queued"));
    return new Promise((resolve, reject) => {
      const entry: PendingAdmission = { bytes, resolve, reject, signal };
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
    while (this.#pending.length && this.#active < this.maxConcurrent) {
      const entry = this.#pending[0]!;
      if (this.#usedBytes + entry.bytes > this.capacityBytes) return;
      this.#pending.shift();
      entry.signal?.removeEventListener("abort", entry.abort!);
      this.#usedBytes += entry.bytes;
      this.#active++;
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        this.#usedBytes -= entry.bytes;
        this.#active--;
        this.#drain();
      });
    }
  }
}
