import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionResourceAdmission } from "./execution-resource-policy.js";
import { reconcileExecutionAdmission } from "./execution-resource-reconciliation.js";

afterEach(() => vi.useRealTimers());
describe("restart execution admission", () => {
  it("counts surviving units before admitting successors and releases only confirmed stops", async () => {
    vi.useFakeTimers();
    const admission = new ExecutionResourceAdmission(100, 1);
    const list = vi.fn().mockResolvedValue([{ unit: "existing", memoryMaxBytes: 80 }]);
    await reconcileExecutionAdmission({ admission, list });
    let started = false;
    const successor = admission.acquire(40).then(release => { started = true; return release; });
    expect(admission.snapshot).toEqual({ active: 1, usedBytes: 80, queued: 1 });
    list.mockRejectedValueOnce(new Error("manager unavailable"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(false);
    list.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1_000);
    (await successor)();
    expect(admission.snapshot).toEqual({ active: 0, usedBytes: 0, queued: 0 });
    const calls = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(list).toHaveBeenCalledTimes(calls);
  });

  it("blocks new work when survivors exceed reduced capacity or concurrency", async () => {
    vi.useFakeTimers();
    const admission = new ExecutionResourceAdmission(100, 1);
    const list = vi.fn().mockResolvedValue([
      { unit: "one", memoryMaxBytes: 80 }, { unit: "two", memoryMaxBytes: 80 },
    ]);
    await reconcileExecutionAdmission({ admission, list });
    const controller = new AbortController();
    const queued = admission.acquire(20, controller.signal);
    const failed = expect(queued).rejects.toThrow("cancelled while queued");
    expect(admission.snapshot).toEqual({ active: 2, usedBytes: 160, queued: 1 });
    controller.abort();
    await failed;
    list.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(admission.snapshot.usedBytes).toBe(0);
  });

  it("fails initialization closed when existing unit accounting cannot be read", async () => {
    const admission = new ExecutionResourceAdmission(100, 1);
    await expect(reconcileExecutionAdmission({ admission, list: async () => { throw new Error("unavailable"); } }))
      .rejects.toThrow("unavailable");
  });
});
