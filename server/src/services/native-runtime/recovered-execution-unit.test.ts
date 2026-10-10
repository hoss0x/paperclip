import { expect, it, vi } from "vitest";
import { recoverExecutionUnit } from "./recovered-execution-unit.js";
import { withExecutionResourceContext, ExecutionResourceOwnership, type ExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";

const unit = "paperclip-execution-run-1-owned.service";
const cgroup = `/user.slice/${unit}`;
const record = { unit, memoryMaxBytes: 100 };
function fixture() {
  let stopped = false;
  const isAlive = vi.fn(async () => true);
  const readCgroup = vi.fn(async () => `0::${cgroup}\n`);
  const systemctl = vi.fn(async (args: string[]): Promise<string> => {
    if (args.includes("--property=Id")) return `Id=${unit}\nControlGroup=${cgroup}\nMemoryMax=100\n`;
    if (args.includes("--property=LoadState")) return "loaded";
    if (args[0] === "stop") stopped = true;
    if (args.includes("--property=ActiveState")) return stopped ? "inactive" : "active";
    return "";
  });
  return { isAlive, readCgroup, systemctl };
}
it("signals the complete verified unit and cleans descendants after the leader exits", async () => {
  const dependencies = fixture();
  const recovered = await recoverExecutionUnit("run-1", [record], dependencies);
  expect(await recovered!.signal("SIGTERM")).toBe(true);
  expect(dependencies.systemctl).toHaveBeenCalledWith(["kill", "--kill-whom=all", "--signal=SIGTERM", unit]);
  dependencies.isAlive.mockResolvedValue(false);
  expect(await recovered!.signal("SIGKILL")).toBe(false);
  await recovered!.cleanup();
  expect(dependencies.systemctl).toHaveBeenCalledWith(["stop", unit]);
});
it.each([{ records: [] }, { records: [{ ...record, unit: "paperclipai.service" }] }, { records: [{ ...record, memoryMaxBytes: 0 }] }])(
  "rejects missing or invalid durable ownership (%j)", async ({ records }) => {
    const dependencies = fixture();
    await expect(recoverExecutionUnit("run-1", records, dependencies)).rejects.toThrow("ownership is missing");
    expect(dependencies.systemctl).not.toHaveBeenCalled();
  },
);
it("rejects another run even with a matching unit record", async () => {
  await expect(recoverExecutionUnit("other-run", [record], fixture())).rejects.toThrow("ownership is missing");
});
it("refuses PID reuse before capturing or signalling authority", async () => {
  const dependencies = fixture();
  dependencies.isAlive.mockResolvedValue(false);
  await expect(recoverExecutionUnit("run-1", [record], dependencies)).rejects.toThrow("process identity changed");
  expect(dependencies.systemctl).not.toHaveBeenCalled();
});
it("rejects changed cgroup membership before signalling", async () => {
  const dependencies = fixture();
  const recovered = await recoverExecutionUnit("run-1", [record], dependencies);
  dependencies.readCgroup.mockResolvedValue("0::/other.service\n");
  await expect(recovered!.signal("SIGTERM")).rejects.toThrow("process moved");
  expect(dependencies.systemctl.mock.calls.some(([args]) => args[0] === "kill")).toBe(false);
});
it("retains failed cleanup instead of treating it as session reuse proof", async () => {
  const dependencies = fixture();
  const recovered = await recoverExecutionUnit("run-1", [record], dependencies);
  dependencies.systemctl.mockImplementation(async args => {
    if (args[0] === "stop") throw new Error("manager unavailable");
    return args.includes("--property=Id") ? `Id=${unit}\nControlGroup=${cgroup}\nMemoryMax=100` : "loaded";
  });
  await expect(recovered!.cleanup()).rejects.toThrow("manager unavailable");
});
it("retains unmanaged pre-upgrade recovery compatibility", async () => {
  const dependencies = fixture();
  dependencies.readCgroup.mockResolvedValue("0::/legacy-controller.service\n");
  expect(await recoverExecutionUnit("run-1", [], dependencies)).toBeNull();
  expect(dependencies.systemctl).not.toHaveBeenCalled();
});
it("rejects changed OS unit identity without signalling", async () => {
  const dependencies = fixture();
  dependencies.systemctl.mockResolvedValue(`Id=${unit}\nControlGroup=${cgroup}\nMemoryMax=200`);
  await expect(recoverExecutionUnit("run-1", [record], dependencies)).rejects.toThrow("unit identity changed");
  expect(dependencies.systemctl.mock.calls.some(([args]) => args[0] === "kill")).toBe(false);
});
it("rejects cleanup that leaves the unit active", async () => {
  const dependencies = fixture();
  const recovered = await recoverExecutionUnit("run-1", [record], dependencies);
  dependencies.systemctl.mockImplementation(async args => args.includes("--property=Id")
    ? `Id=${unit}\nControlGroup=${cgroup}\nMemoryMax=100` : args.includes("--property=LoadState") ? "loaded" : "active");
  await expect(recovered!.cleanup()).rejects.toThrow("termination was not verified");
});

it("accepts an authenticated transferred record while retaining the original OS name", async () => {
  const dependencies = fixture();
  const transferred = { ...record, originRunId: "run-1", previousRunId: "run-1" };
  const recovered = await recoverExecutionUnit("run-2", [transferred], dependencies);
  expect(await recovered!.signal("SIGTERM")).toBe(true);
});
it("rejects a transferred record whose origin does not match the verified unit", async () => {
  await expect(recoverExecutionUnit("run-2", [{ ...record, originRunId: "foreign", previousRunId: "run-1" }], fixture()))
    .rejects.toThrow("ownership is missing");
});

function resourceContext(signal: AbortSignal) {
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_ISOLATION: "systemd" }, "linux", 8 * 1024 ** 3);
  const recordEvidence = vi.fn(async () => {});
  const context: ExecutionResourceContext = { runId: "run-1", signal, scratchDir: ".", policy,
    admission: new ExecutionResourceAdmission(policy.capacityBytes, 1), slice: "paperclip-test.slice",
    onUnitPrepared: vi.fn(async () => {}), onOwnershipCommitted: vi.fn(async () => {}), onEvidence: recordEvidence };
  const owner = new ExecutionResourceOwnership({ ...context });
  context.ownership = owner;
  context.onEvidence = evidence => owner.evidence(evidence);
  return { context, recordEvidence, owner };
}
it("does not install cancellation or record terminal resources before transport authentication", async () => {
  const controller = new AbortController();
  const { context, recordEvidence } = resourceContext(controller.signal);
  const dependencies = fixture();
  const recovered = await withExecutionResourceContext(context, () => recoverExecutionUnit("run-1", [record], dependencies));
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(dependencies.systemctl.mock.calls.some(([args]) => args[0] === "stop")).toBe(false);
  await recovered!.cleanup();
  expect(recordEvidence).not.toHaveBeenCalled();
});
it("restores current-run cancellation only after authentication and moves it at warm admission", async () => {
  const a = new AbortController(), b = new AbortController();
  const { context, recordEvidence, owner } = resourceContext(a.signal);
  const dependencies = fixture();
  const recovered = await withExecutionResourceContext(context, () => recoverExecutionUnit("run-1", [record], dependencies));
  const nextEvidence = vi.fn(async () => {});
  try {
    await recovered!.onAuthenticated();
    await owner.handoff({ ...context, ownership: undefined, runId: "run-2", signal: b.signal, onEvidence: nextEvidence });
    a.abort();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(dependencies.systemctl.mock.calls.some(([args]) => args[0] === "stop")).toBe(false);
    b.abort();
    await recovered!.cleanup();
    expect(recordEvidence).not.toHaveBeenCalled();
    expect(nextEvidence).toHaveBeenCalledWith(expect.objectContaining({ unit, cancelled: true }));
  } finally { await recovered!.cleanup(); }
});

it("keeps failed-unit evidence on recorder failure and resets the unit only after persistence succeeds", async () => {
  const { context, recordEvidence } = resourceContext(new AbortController().signal);
  const dependencies = fixture();
  const recovered = await withExecutionResourceContext(context, () => recoverExecutionUnit("run-1", [record], dependencies));
  await recovered!.onAuthenticated();
  recordEvidence.mockRejectedValueOnce(new Error("record unavailable"));
  await expect(recovered!.cleanup()).rejects.toThrow("record unavailable");
  expect(dependencies.systemctl).not.toHaveBeenCalledWith(["reset-failed", unit]);
  await recovered!.cleanup();
  expect(recordEvidence).toHaveBeenCalledTimes(2);
  expect(dependencies.systemctl).toHaveBeenCalledWith(["reset-failed", unit]);
});
