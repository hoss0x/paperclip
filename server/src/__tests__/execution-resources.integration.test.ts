import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createResourceProcessLauncher } from "@paperclipai/adapter-utils/resource-process-launcher";
import { executeWithResourceGovernance, ExecutionResourceLimitError, RESOURCE_UNIT_PREPARED } from "../services/execution-resources.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
const slice = `paperclip-dispatch-${randomUUID()}.slice`;
const execFileAsync = promisify(execFile);
function input(signal = new AbortController().signal) {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
  if (!scratchDir) throw new Error("Integration tests require run-owned scratch");
  const events: { eventType: string; payload: Record<string, unknown> }[] = [];
  return { scratchDir, signal, slice, events,
    record: async (event: { eventType: string; payload: Record<string, unknown> }) => { events.push(event); } };
}
function command(script: string, onSpawn?: Parameters<typeof runChildProcess>[3]["onSpawn"]) {
  return runChildProcess(randomUUID(), process.execPath, ["-e", script], {
    cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {}, onSpawn,
  });
}

(enabled ? describe : describe.skip)("server dispatch resource governance", () => {
  afterAll(async () => {
    await execFileAsync("systemctl", ["--user", "stop", slice], { timeout: 5_000 });
  });

  it("persists ownership before launch and projects OOM independently of adapter output", async () => {
    const context = input();
    const result = await executeWithResourceGovernance(context, async () => {
      await command("const b=[]; for(let i=0;i<128;i++)b.push(Buffer.alloc(4*1024*1024,1));setInterval(()=>{},1000)", async meta => {
        expect(context.events.some(event => event.eventType === RESOURCE_UNIT_PREPARED && event.payload.unit === meta.executionUnit)).toBe(true);
      });
      // A provider parser must not turn the memory kill into a successful run.
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { adapter: "preserved" } };
    });
    expect(result).toMatchObject({ exitCode: 1, errorCode: "execution_resource_limit", resultJson: { adapter: "preserved" } });
    expect(context.events.at(-1)?.payload).toMatchObject({ resourceLimitReached: true, memoryMaxBytes: 96 * 1024 ** 2 });
  }, 20_000);

  it("keeps memory evidence when the adapter throws and permits later executions", async () => {
    await expect(executeWithResourceGovernance(input(), async () => {
      await command("const b=[];for(let i=0;i<128;i++)b.push(Buffer.alloc(4*1024*1024,1));setInterval(()=>{},1000)");
      throw new Error("provider parser failed");
    })).rejects.toBeInstanceOf(ExecutionResourceLimitError);
    const result = await executeWithResourceGovernance(input(), async () => {
      const child = await command("console.log('recovered')");
      expect(child.stdout.trim()).toBe("recovered");
      return { exitCode: child.exitCode, signal: child.signal, timedOut: child.timedOut };
    });
    expect(result.exitCode).toBe(0);
  }, 20_000);

  it("never launches if durable ownership cannot be saved", async () => {
    let spawned = false;
    await expect(executeWithResourceGovernance({ ...input(), record: async () => { throw new Error("database unavailable"); } }, async () => {
      await command("console.log('unreachable')", async () => { spawned = true; });
      return { exitCode: 0, signal: null, timedOut: false };
    })).rejects.toThrow("database unavailable");
    expect(spawned).toBe(false);
  }, 20_000);

  it("carries the operator context into the native launcher and cancels its cgroup", async () => {
    const controller = new AbortController();
    const context = input(controller.signal);
    const result = await executeWithResourceGovernance(context, async () => {
      let spawned = false;
      const launch = createResourceProcessLauncher({ runId: randomUUID(), onSpawn: async meta => {
        const membership = await fs.readFile(`/proc/${meta.pid}/cgroup`, "utf8");
        expect(membership).toContain(slice);
        expect(membership).toContain(meta.executionUnit);
        expect(membership).not.toContain("paperclipai.service");
        spawned = true;
      } });
      expect(launch).toBeTypeOf("function");
      const handle = launch!({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: process.env });
      await expect.poll(() => spawned, { timeout: 5_000 }).toBe(true);
      controller.abort();
      const child = await handle.completion;
      return { exitCode: child.code, signal: child.signal, timedOut: false };
    });
    expect(result.resultJson?.executionResources).toEqual(expect.arrayContaining([expect.objectContaining({ cancelled: true })]));
  }, 20_000);
});
