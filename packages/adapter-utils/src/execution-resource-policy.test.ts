import { describe, expect, it } from "vitest";
import { applyLowMemoryEnvironment, ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

describe("operator execution resource policy", () => {
  it("reserves host capacity and bounds each workload by default", () => {
    const policy = resolveExecutionResourcePolicy({}, "linux", 8 * GiB);
    expect(policy).toMatchObject({ isolation: "systemd", reserveBytes: 2 * GiB,
      capacityBytes: 6 * GiB, memoryMaxBytes: 2 * GiB,
      memoryHighBytes: 1.5 * GiB, memorySwapMaxBytes: 0,
      maxConcurrent: 2, tasksMax: 128, cpuQuotaPercent: 100, buildJobs: 1 });
  });

  it("does not promise unsupported isolation on other platforms", () => {
    expect(resolveExecutionResourcePolicy({}, "darwin", 8 * GiB).isolation).toBe("none");
    expect(() => resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_ISOLATION: "systemd" }, "win32", 8 * GiB)).toThrow("requires Linux");
  });

  it("accepts explicit limits without exceeding reserved host capacity", () => {
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "512",
      PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "384", PAPERCLIP_EXECUTION_CAPACITY_MIB: "1024",
      PAPERCLIP_EXECUTION_RESERVE_MIB: "1024", PAPERCLIP_EXECUTION_MAX_CONCURRENT: "1" }, "linux", 3 * GiB);
    expect(policy.memoryMaxBytes).toBe(512 * MiB);
    expect(policy.capacityBytes).toBe(GiB);
    expect(policy.maxConcurrent).toBe(1);
  });

  it.each(["", "-1", "1.5", "NaN", "Infinity", "0", "9007199254740992"])("rejects invalid numeric configuration %j", (value) => {
    expect(() => resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: value }, "linux", 8 * GiB)).toThrow();
  });

  it("rejects contradictory memory limits and unknown modes", () => {
    for (const env of [
      { PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "3000" },
      { PAPERCLIP_EXECUTION_CAPACITY_MIB: "8000" },
      { PAPERCLIP_EXECUTION_RESERVE_MIB: "8192" },
      { PAPERCLIP_EXECUTION_ISOLATION: "fallback" },
    ]) expect(() => resolveExecutionResourcePolicy(env, "linux", 8 * GiB)).toThrow();
  });

  it("adds conservative defaults without changing explicit tool settings or secrets", () => {
    const env = { CARGO_BUILD_JOBS: "2", API_TOKEN: "private", NODE_OPTIONS: "--enable-source-maps" };
    expect(applyLowMemoryEnvironment(env, resolveExecutionResourcePolicy({}, "linux", 8 * GiB)))
      .toEqual({ ...env, CMAKE_BUILD_PARALLEL_LEVEL: "1", RAYON_NUM_THREADS: "1", npm_config_workspace_concurrency: "1", GOMAXPROCS: "1", GOMEMLIMIT: "1536MiB" });
    expect(env).not.toHaveProperty("RAYON_NUM_THREADS");
  });
  it("preserves explicit Go memory and concurrency controls", () => {
    const env = { GOMAXPROCS: "2", GOMEMLIMIT: "768MiB" };
    expect(applyLowMemoryEnvironment(env, resolveExecutionResourcePolicy({}, "linux", 8 * GiB)))
      .toMatchObject(env);
  });

});

describe("aggregate execution admission", () => {
  it("queues on memory capacity even when a process slot is free", async () => {
    const pool = new ExecutionResourceAdmission(100, 3);
    const release = await pool.acquire(70);
    let launched = false;
    const next = pool.acquire(40).then((release) => { launched = true; return release; });
    await Promise.resolve();
    expect(launched).toBe(false);
    expect(pool.snapshot).toEqual({ usedBytes: 70, active: 1, queued: 1 });
    release();
    const releaseNext = await next;
    expect(pool.snapshot).toEqual({ usedBytes: 40, active: 1, queued: 0 });
    release(); // Idempotence prevents over-admission.
    expect(pool.snapshot.usedBytes).toBe(40);
    releaseNext();
    expect(pool.snapshot.usedBytes).toBe(0);
  });

  it("queues on concurrency and preserves FIFO across differently sized requests", async () => {
    const pool = new ExecutionResourceAdmission(100, 1);
    const first = await pool.acquire(60);
    const order: number[] = [];
    const second = pool.acquire(80).then((release) => { order.push(2); return release; });
    const third = pool.acquire(20).then((release) => { order.push(3); return release; });
    first();
    const releaseSecond = await second;
    expect(order).toEqual([2]);
    releaseSecond();
    (await third)();
    expect(order).toEqual([2, 3]);
  });

  it("removes cancelled queued work and admits its successor", async () => {
    const pool = new ExecutionResourceAdmission(100, 2);
    const first = await pool.acquire(60);
    const cancelled = new AbortController();
    const second = pool.acquire(80, cancelled.signal);
    const rejected = expect(second).rejects.toThrow("cancelled while queued");
    const third = pool.acquire(20);
    cancelled.abort();
    await rejected;
    const releaseThird = await third;
    expect(pool.snapshot).toEqual({ usedBytes: 80, active: 2, queued: 0 });
    first();
    releaseThird();
  });

  it("rejects impossible budgets and pre-cancelled work without queueing", async () => {
    const pool = new ExecutionResourceAdmission(100, 1);
    await expect(pool.acquire(101)).rejects.toThrow("capacity");
    await expect(pool.acquire(1, AbortSignal.abort())).rejects.toThrow("cancelled");
    expect(pool.snapshot.queued).toBe(0);
  });
});


describe("controller helper admission", () => {
  it("lets a helper pass a slot-blocked agent while charging aggregate memory", async () => {
    const pool = new ExecutionResourceAdmission(200, 1, 1);
    const agent = await pool.acquire(100);
    let agentStarted = false;
    const successor = pool.acquire(100).then(release => { agentStarted = true; return release; });
    const helper = await pool.acquire(100, undefined, "helper");
    expect(agentStarted).toBe(false);
    expect(pool.snapshot).toEqual({ active: 2, usedBytes: 200, queued: 1 });
    helper(); agent(); (await successor)();
    expect(pool.snapshot.usedBytes).toBe(0);
  });
  it("keeps helper concurrency and memory bounded, with queued cancellation", async () => {
    const pool = new ExecutionResourceAdmission(200, 1, 1);
    const first = await pool.acquire(100, undefined, "helper");
    const controller = new AbortController();
    const pending = pool.acquire(100, controller.signal, "helper");
    const cancelled = expect(pending).rejects.toThrow("cancelled while queued");
    const agent = await pool.acquire(100);
    expect(pool.snapshot).toEqual({ active: 2, usedBytes: 200, queued: 1 });
    controller.abort(); await cancelled; first(); agent();
    const full = await pool.acquire(200);
    const deadline = new AbortController();
    const noCapacity = pool.acquire(1, deadline.signal, "helper");
    const failure = expect(noCapacity).rejects.toThrow("cancelled while queued");
    expect(pool.snapshot.queued).toBe(1);
    deadline.abort(); await failure; full();
  });
  it("counts adopted helpers in their lane without consuming an agent slot", async () => {
    const pool = new ExecutionResourceAdmission(200, 1, 1);
    const survivor = pool.adopt(100, "helper");
    const agent = await pool.acquire(100);
    const signal = new AbortController();
    const pending = pool.acquire(100, signal.signal, "helper");
    const failure = expect(pending).rejects.toThrow("cancelled while queued");
    signal.abort(); await failure; survivor(); survivor(); agent();
    expect(pool.snapshot).toEqual({ active: 0, usedBytes: 0, queued: 0 });
  });
  it("validates the operator helper slot setting", () => {
    expect(resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_HELPER_MAX_CONCURRENT: "2" }, "linux", 8 * GiB).helperMaxConcurrent).toBe(2);
    expect(() => resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_HELPER_MAX_CONCURRENT: "0" }, "linux", 8 * GiB)).toThrow();
  });
});


it("leaves one helper budget in default agent concurrency when capacity permits", () => {
  const policy = resolveExecutionResourcePolicy({}, "linux", 7933 * MiB);
  expect(policy.maxConcurrent).toBe(1);
  expect(policy.capacityBytes - policy.maxConcurrent * policy.memoryMaxBytes).toBeGreaterThanOrEqual(policy.memoryMaxBytes);
  const small = resolveExecutionResourcePolicy({}, "linux", 2 * GiB);
  expect(small.maxConcurrent).toBe(1);
});
