import { expect, it, vi } from "vitest";
import { ExecutionResourceOwnership, type ExecutionResourceContext } from "./execution-resource-context.js";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";
function fixture() {
  const policy = resolveExecutionResourcePolicy({}, "linux", 8 * 1024 ** 3);
  const admission = new ExecutionResourceAdmission(policy.capacityBytes, 1);
  const context = (runId: string): ExecutionResourceContext => ({ runId, policy, admission,
    scratchDir: ".", slice: "paperclip-test.slice", signal: new AbortController().signal,
    onUnitPrepared: vi.fn(async () => {}), onOwnershipCommitted: vi.fn(async () => {}), onEvidence: vi.fn(async () => {}) });
  const a = context("run-a"), b = context("run-b");
  const owner = new ExecutionResourceOwnership(a);
  const root = { unit: "paperclip-execution-run-a-root.service", memoryMaxBytes: policy.memoryMaxBytes,
    verify: vi.fn(async () => {}), rebind: vi.fn() };
  owner.register(root);
  return { a, b, owner, root };
}
it("fences new launch signals while durable handoff is pending", async () => {
  const { b, owner } = fixture();
  let release!: () => void;
  const recording = new Promise<void>(resolve => { release = resolve; });
  b.onOwnershipCommitted = vi.fn(() => recording);
  const handoff = owner.handoff(b);
  await expect.poll(() => vi.mocked(b.onOwnershipCommitted!).mock.calls.length).toBe(1);
  try {
    expect(() => owner.signal).toThrow("ownership handoff is pending");
  } finally { release(); await handoff; }
  expect(owner.signal).toBe(b.signal);
});
it("keeps the previous owner and cancellation authority when durable recording fails", async () => {
  const { a, b, owner, root } = fixture();
  b.onOwnershipCommitted = async () => { throw new Error("database unavailable"); };
  await expect(owner.handoff(b)).rejects.toThrow("database unavailable");
  await owner.evidence({ resourceLimitReached: true } as ExecutionResourceEvidence);
  expect(a.onEvidence).toHaveBeenCalledOnce();
  expect(b.onEvidence).not.toHaveBeenCalled();
  expect(root.rebind).not.toHaveBeenCalled();
});
it("refuses a changed unit after persistence before committing or rebinding", async () => {
  const { b, owner, root } = fixture();
  root.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("PID changed"));
  await expect(owner.handoff(b)).rejects.toThrow("PID changed");
  expect(b.onOwnershipCommitted).not.toHaveBeenCalled();
  expect(root.rebind).not.toHaveBeenCalled();
});
it("refuses an unrecorded or incompatible handoff", async () => {
  const { b, owner, root } = fixture();
  await expect(owner.handoff({ ...b, onOwnershipCommitted: undefined })).rejects.toThrow("durable controller recording");
  await expect(owner.handoff({ ...b, admission: new ExecutionResourceAdmission(b.policy.capacityBytes, 1) })).rejects.toThrow("policy or admission changed");
  expect(root.verify).not.toHaveBeenCalled();
});
it("records immutable origin and commits before changing the event sink", async () => {
  const { a, b, owner, root } = fixture();
  await owner.handoff(b);
  expect(b.onUnitPrepared).toHaveBeenCalledWith({ unit: root.unit, memoryMaxBytes: root.memoryMaxBytes, originRunId: "run-a", previousRunId: "run-a" });
  expect(b.onOwnershipCommitted).toHaveBeenCalledWith({ previousRunId: "run-a", units: [root.unit] });
  expect(root.rebind).toHaveBeenCalledWith(b.signal);
  await owner.evidence({ resourceLimitReached: true } as ExecutionResourceEvidence);
  expect(a.onEvidence).not.toHaveBeenCalled();
  expect(b.onEvidence).toHaveBeenCalledOnce();
});

it("records new control roots created by an older retained factory under the active owner", async () => {
  const { b, owner } = fixture();
  await owner.handoff(b);
  vi.mocked(b.onOwnershipCommitted!).mockClear();
  const unit = "paperclip-execution-run-a-control.scope";
  await owner.prepared({ unit, memoryMaxBytes: b.policy.memoryMaxBytes }, "run-a");
  expect(b.onOwnershipCommitted).toHaveBeenCalledWith({ previousRunId: "run-a", units: [unit] });
});
