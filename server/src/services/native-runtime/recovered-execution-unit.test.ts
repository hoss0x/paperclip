import { expect, it, vi } from "vitest";
import { recoverExecutionUnit } from "./recovered-execution-unit.js";

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
