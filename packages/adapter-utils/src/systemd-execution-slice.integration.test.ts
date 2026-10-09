import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { listActiveExecutionUnits, reconcileExecutionAdmission } from "./execution-resource-reconciliation.js";
import { prepareSystemdExecution, type SystemdExecutionBoundary } from "./systemd-execution.js";
import { ensureSystemdExecutionSlice } from "./systemd-execution-slice.js";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("aggregate execution slice", () => {
  it("reconstructs admission from a real surviving unit before admitting new work", async () => {
    const slice = `paperclip-recovery-${randomUUID()}.slice`;
    const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
    if (!scratchDir) throw new Error("Tests require run-owned scratch");
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_CAPACITY_MIB: "128",
      PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
    await ensureSystemdExecutionSlice(policy, slice);
    const boundary = await prepareSystemdExecution({ runId: randomUUID(), command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), env: { PATH: process.env.PATH }, policy, scratchDir, slice });
    const child = spawn(boundary.command, boundary.args, { stdio: "ignore" });
    const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", () => resolve()); });
    const deadline = setTimeout(() => { void boundary.signal("SIGKILL").catch(() => {}); }, 10_000);
    try {
      await boundary.identity();
      expect(await listActiveExecutionUnits(slice)).toEqual([{ unit: boundary.unit, memoryMaxBytes: policy.memoryMaxBytes }]);
      const admission = new ExecutionResourceAdmission(policy.capacityBytes, 1);
      await reconcileExecutionAdmission({ admission, list: () => listActiveExecutionUnits(slice), intervalMs: 100 });
      let admitted = false;
      const next = admission.acquire(policy.memoryMaxBytes).then(release => { admitted = true; return release; });
      expect(admission.snapshot).toEqual({ active: 1, usedBytes: policy.memoryMaxBytes, queued: 1 });
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(admitted).toBe(false);
      await boundary.finish(true);
      await closed;
      await expect.poll(() => admitted, { timeout: 5_000 }).toBe(true);
      (await next)();
      expect(admission.snapshot).toEqual({ active: 0, usedBytes: 0, queued: 0 });
    } finally {
      clearTimeout(deadline);
      await boundary.finish(true);
      await execFileAsync("systemctl", ["--user", "stop", slice]);
    }
  }, 20_000);

  it("bounds independent units, rejects a conflicting policy, and permits later recovery", async () => {
    const slice = `paperclip-validation-${randomUUID()}.slice`;
    const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
    if (!scratchDir) throw new Error("Tests require run-owned scratch");
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_CAPACITY_MIB: "128",
      PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
    const boundaries: SystemdExecutionBoundary[] = [];
    const timers: NodeJS.Timeout[] = [];
    async function launch(script: string) {
      const boundary = await prepareSystemdExecution({ runId: randomUUID(), command: process.execPath,
        args: ["-e", script], env: { PATH: process.env.PATH }, cwd: process.cwd(), policy, scratchDir: scratchDir!, slice });
      boundaries.push(boundary);
      const child = spawn(boundary.command, boundary.args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); });
      child.stderr.resume();
      timers.push(setTimeout(() => { void boundary.signal("SIGKILL").catch(() => {}); }, 10_000));
      const completion = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
      });
      return { boundary, completion, output: () => stdout };
    }
    try {
      await ensureSystemdExecutionSlice(policy, slice);
      await expect(ensureSystemdExecutionSlice({ ...policy, capacityBytes: 160 * 1024 ** 2 }, slice)).rejects.toThrow("different capacity");
      const { stdout: cgroupPath } = await execFileAsync("systemctl", ["--user", "show", slice, "--property=ControlGroup", "--value"]);
      const cgroup = `/sys/fs/cgroup${cgroupPath.trim()}`;
      const workers = await Promise.all([launch(`
        const fs=require('node:fs'); console.log(fs.readFileSync('/proc/self/cgroup','utf8'));
        const allocations=[]; const timer=setInterval(()=>{allocations.push(Buffer.alloc(2*1024*1024,1)); if(allocations.length===28)clearInterval(timer)},10);
        setTimeout(()=>process.exit(0),2000);`), launch(`
        const fs=require('node:fs'); console.log(fs.readFileSync('/proc/self/cgroup','utf8'));
        const allocations=[]; const timer=setInterval(()=>{allocations.push(Buffer.alloc(2*1024*1024,1)); if(allocations.length===28)clearInterval(timer)},10);
        setTimeout(()=>process.exit(0),2000);`)]);
      await Promise.all(workers.map(worker => worker.completion));
      for (const worker of workers) {
        expect(worker.output()).toContain(slice);
        expect(worker.output()).not.toContain("paperclipai.service");
      }
      const events = await fs.readFile(`${cgroup}/memory.events`, "utf8");
      expect(events).toMatch(/^oom_kill [1-9]\d*$/m);
      const peak = Number(await fs.readFile(`${cgroup}/memory.peak`, "utf8"));
      expect(peak).toBeLessThanOrEqual(policy.capacityBytes + 1024 * 1024);
      console.info("aggregate measurement", JSON.stringify({ slice, capacityBytes: policy.capacityBytes, peakMemoryBytes: peak, memoryEvents: events }));
      for (const worker of workers) await worker.boundary.finish();
      const recovered = await launch("console.log('recovered')");
      expect(await recovered.completion).toBe(0);
      expect(recovered.output().trim()).toBe("recovered");
      await recovered.boundary.finish();
    } finally {
      for (const timer of timers) clearTimeout(timer);
      for (const boundary of boundaries) await boundary.finish();
      await execFileAsync("systemctl", ["--user", "stop", slice]);
    }
  }, 25_000);
});
