import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { resourceSafeAdapterEventType, stopRecordedLegacyExecutionUnits } from "../services/execution-resources.js";

const run = { id: "run-1", companyId: "company-1", runtimeMode: "legacy" };
const unit = "paperclip-execution-run-1-unit.service";
function fixture(payloads: Record<string, unknown>[]) {
  const where = vi.fn(async () => payloads.map(payload => ({ payload })));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as Db, select, where };
}

describe("durable legacy resource-unit cancellation", () => {
  it("stops each owned unit once and confirms its inactive state before returning", async () => {
    const { db, where } = fixture([{ unit }, { unit }, { unit: "paperclip-execution-other-run-unit.service" },
      { unit: `${unit};bad` }, { unit: "paperclipai.service" }]);
    const calls: string[][] = [];
    const systemctl = vi.fn(async (args: string[]) => {
      calls.push(args);
      return args.includes("--property=LoadState") ? "loaded\n" : args.includes("--property=ActiveState") ? "inactive\n" : "";
    });
    expect(await stopRecordedLegacyExecutionUnits(db, run, systemctl)).toBe(true);
    expect(where).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      ["show", unit, "--property=LoadState", "--value"], ["stop", unit],
      ["show", unit, "--property=ActiveState", "--value"], ["reset-failed", unit],
    ]);
  });

  it("treats unloaded owned units as already stopped", async () => {
    const { db } = fixture([{ unit }]);
    const systemctl = vi.fn(async () => "not-found\n");
    expect(await stopRecordedLegacyExecutionUnits(db, run, systemctl)).toBe(true);
    expect(systemctl).toHaveBeenCalledOnce();
  });

  it.each(["active", "deactivating"])("retains ownership when termination is not confirmed (%s)", async state => {
    const { db } = fixture([{ unit }]);
    await expect(stopRecordedLegacyExecutionUnits(db, run, async args =>
      args.includes("--property=LoadState") ? "loaded" : args.includes("--property=ActiveState") ? state : ""))
      .rejects.toThrow("termination was not verified");
  });

  it("does not release ownership when the OS stop fails", async () => {
    const { db } = fixture([{ unit }]);
    await expect(stopRecordedLegacyExecutionUnits(db, run, async args => {
      if (args[0] === "stop") throw new Error("manager unavailable");
      return "loaded";
    })).rejects.toThrow("manager unavailable");
  });

  it("leaves native cancellation under its existing audited authority", async () => {
    const { db, select } = fixture([{ unit }]);
    const systemctl = vi.fn();
    expect(await stopRecordedLegacyExecutionUnits(db, { ...run, runtimeMode: "native" }, systemctl)).toBe(false);
    expect(select).not.toHaveBeenCalled();
    expect(systemctl).not.toHaveBeenCalled();
  });

  it("keeps adapter output from creating controller-owned cancellation records", () => {
    expect(resourceSafeAdapterEventType("execution_resource_prepared")).toBe("adapter.execution_resource_prepared");
    expect(resourceSafeAdapterEventType("execution_resource_finished")).toBe("adapter.execution_resource_finished");
    expect(resourceSafeAdapterEventType("provider.progress")).toBe("provider.progress");
  });
});
