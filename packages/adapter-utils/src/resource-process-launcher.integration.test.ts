import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { withExecutionResourceContext } from "./execution-resource-context.js";
import { createResourceProcessLauncher } from "./resource-process-launcher.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("native synchronous resource launcher seam", () => {
  it("returns a handle before admission and later records the real worker identity", async () => {
    const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
    if (!scratchDir) throw new Error("Tests require scratch");
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96",
      PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
    const admission = new ExecutionResourceAdmission(policy.memoryMaxBytes, 1);
    const releaseBlocker = await admission.acquire(policy.memoryMaxBytes);
    const evidence: boolean[] = [];
    await withExecutionResourceContext({ policy, admission, scratchDir, onEvidence: async result => { evidence.push(result.cancelled); } }, async () => {
      let recordedPid = 0;
      let unit: string | undefined;
      let releaseOwnership!: () => void;
      const ownership = new Promise<void>(resolve => { releaseOwnership = resolve; });
      const launcher = createResourceProcessLauncher({ runId: randomUUID(), onSpawn: async meta => { recordedPid = meta.pid; unit = meta.executionUnit; await ownership; } })!;
      const handle = launcher({ command: process.execPath, args: ["-e", "console.log('raw output must stay private');setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH } });
      expect(handle.child.pid).toBeUndefined();
      await expect.poll(() => admission.snapshot.queued).toBe(1);
      releaseBlocker();
      await expect.poll(() => handle.child.pid, { timeout: 5_000 }).toBeGreaterThan(0);
      let ready = false;
      void handle.ready.then(() => { ready = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(ready).toBe(false);
      releaseOwnership();
      expect(await handle.ready).toMatchObject({ pid: recordedPid, processGroupId: null, ownershipRecorded: true });
      expect(ready).toBe(true);
      expect(handle.child.pid).toBe(recordedPid);
      expect(unit).toMatch(/^paperclip-execution-/);
      const membership = await fs.readFile(`/proc/${handle.child.pid}/cgroup`, "utf8");
      expect(membership).toContain(unit);
      expect(membership).not.toContain("paperclipai.service");
      expect(handle.processGroupId).toBeNull();
      handle.child.kill("SIGKILL");
      const completed = await handle.completion;
      expect(completed.signal).toBe("SIGKILL");
      expect(completed.stdout).toBe("");
      expect(completed.stderr).toBe("");
      expect(evidence).toEqual([true]);
      expect(admission.snapshot.active).toBe(0);
    });
  }, 20_000);
  it("rejects readiness when a queued launch is cancelled without spawning", async () => {
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
    const admission = new ExecutionResourceAdmission(policy.memoryMaxBytes, 1);
    const release = await admission.acquire(policy.memoryMaxBytes);
    try {
      await withExecutionResourceContext({ policy, admission, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR! }, async () => {
        const handle = createResourceProcessLauncher({ runId: randomUUID() })!({ command: process.execPath,
          args: ["-e", "throw new Error('must not launch')"], cwd: process.cwd(), environment: {} });
        await expect.poll(() => admission.snapshot.queued).toBe(1);
        const readiness = handle.ready.catch(error => error);
        const completion = handle.completion.catch(error => error);
        handle.child.kill("SIGTERM");
        expect(await readiness).toMatchObject({ message: "Execution cancelled while queued" });
        expect(await completion).toMatchObject({ message: "Execution cancelled while queued" });
        expect(handle.child.pid).toBeUndefined();
        expect(admission.snapshot.queued).toBe(0);
      });
    } finally { release(); }
  }, 10_000);
  it("rejects readiness and contains the worker when ownership persistence fails", async () => {
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
    const admission = new ExecutionResourceAdmission(policy.memoryMaxBytes, 1);
    await withExecutionResourceContext({ policy, admission, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR! }, async () => {
      const handle = createResourceProcessLauncher({ runId: randomUUID(), onSpawn: async () => { throw new Error("ownership unavailable"); } })!({
        command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH },
      });
      await expect(handle.ready).rejects.toThrow("ownership unavailable");
      await handle.completion;
      expect(admission.snapshot.active).toBe(0);
      await expect(fs.stat(`/proc/${handle.child.pid}`)).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 15_000);
});
