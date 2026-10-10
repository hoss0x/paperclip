import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ExecutionResourceOwnership, withExecutionResourceContext, type ExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import { ensureSystemdExecutionSlice } from "@paperclipai/adapter-utils/systemd-execution-slice";
import { createResourceAcpxCommands } from "../services/native-runtime/resource-acpx-commands.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("server-owned ACPX command resources", () => {
  it("starts a retained session's new control root after the earlier run is cancelled", async () => {
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_CAPACITY_MIB: "256",
      PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "128" }, "linux", 8 * 1024 ** 3);
    const slice = await ensureSystemdExecutionSlice(policy, `paperclip-acpxhandoff-${randomUUID()}.slice`);
    const admission = new ExecutionResourceAdmission(policy.capacityBytes, 1);
    const a = new AbortController(), b = new AbortController();
    const context = (signal: AbortSignal): ExecutionResourceContext => ({ runId: randomUUID(),
      policy, admission, slice, signal, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR!,
      onUnitPrepared: async () => {}, onOwnershipCommitted: async () => {}, onEvidence: async () => {} });
    const first = context(a.signal), second = context(b.signal);
    first.ownership = new ExecutionResourceOwnership(first);
    let owner: Awaited<ReturnType<NonNullable<ReturnType<typeof createResourceAcpxCommands>>>> | undefined;
    let persistent: Awaited<ReturnType<NonNullable<typeof owner>["openCommand"]>> | undefined;
    const ctl = promisify(execFile);
    try {
      await withExecutionResourceContext(first, async () => {
        owner = await createResourceAcpxCommands(first.runId!, () => process.env.PAPERCLIP_TEST_RESOURCE_LOADER!)!({ cwd: process.cwd(), signal: a.signal });
        const installation = { commandDigest: "fixture", agentServerPackageJsonPath: null, agentRuntimePackageJsonPath: null,
          openCommand: async (options: Parameters<Parameters<typeof owner.openCommand>[0]["openCommand"]>[0]) => ({
            spawn: (args: readonly string[] = []) => options!.processLauncher!(process.execPath, args, { cwd: process.cwd(), env: {}, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
            close: async () => {},
          }) };
        persistent = await owner.openCommand(installation);
        const child = persistent.spawn(["-e", "console.log('ready');setInterval(()=>{},1000)"]);
        let output = ""; child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.resume();
        await expect.poll(() => output).toContain("ready");
        await first.ownership!.handoff(second);
        a.abort();
        const control = await owner.openCommand(installation);
        const root = control.spawn(["-e", "console.log('current');setTimeout(()=>process.exit(0),300)"]);
        let result = ""; root.stdout!.on("data", chunk => { result += chunk; }); root.stderr!.resume();
        await control.close();
        expect(result).toContain("current");
        expect(child.exitCode).toBeNull();
        b.abort();
        await persistent.close();
      });
    } finally {
      b.abort();
      await owner?.close();
      await persistent?.close();
      await ctl("systemctl", ["--user", "stop", slice]); await ctl("systemctl", ["--user", "revert", slice]);
    }
    expect(admission.snapshot.active).toBe(0);
  }, 20_000);
  it("owns persistent and refreshed roots through completion and idle session shutdown", async () => {
    const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_CAPACITY_MIB: "256",
      PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "128", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "128" }, "linux", 8 * 1024 ** 3);
    const slice = await ensureSystemdExecutionSlice(policy, `paperclip-acpxowner-${randomUUID()}.slice`);
    const admission = new ExecutionResourceAdmission(policy.capacityBytes, 1);
    const ctl = promisify(execFile);
    const cancellation = new AbortController();
    const resources = { policy, admission, slice, signal: cancellation.signal, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR! };
    try {
      await withExecutionResourceContext(resources, async () => {
        const owner = await createResourceAcpxCommands(randomUUID(), () => process.env.PAPERCLIP_TEST_RESOURCE_LOADER!)!({ cwd: process.cwd() });
        const installation = { commandDigest: "fixture", agentServerPackageJsonPath: null, agentRuntimePackageJsonPath: null,
          openCommand: async (options: Parameters<Parameters<typeof owner.openCommand>[0]["openCommand"]>[0]) => ({
            spawn: (args: readonly string[] = []) => options!.processLauncher!(process.execPath, args, { cwd: process.cwd(), env: {}, shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] }),
            close: async () => {},
          }) };
        try {
          const persistent = await owner.openCommand(installation);
          const child = persistent.spawn(["-e", "console.log(require('node:fs').readFileSync('/proc/self/cgroup','utf8'));setInterval(()=>{},1000)"]);
          let output = ""; child.stdout!.on("data", chunk => { output += chunk; }); child.stderr!.resume();
          await expect.poll(() => output).toContain(".scope"); expect(output).not.toContain("paperclipai.service");
          const transient = await owner.openCommand(installation);
          const control = transient.spawn(["-e", "setTimeout(()=>process.exit(0),300)"]);
          control.stdout!.resume(); control.stderr!.resume();
          await transient.close();
          expect(admission.snapshot.active).toBe(1);
          let closed = false;
          const closing = persistent.close().then(() => { closed = true; });
          await new Promise(resolve => setTimeout(resolve, 100));
          expect(closed).toBe(false); // A lease close alone cannot replace runtime exit proof.
          child.kill("SIGTERM"); await closing;
          expect(admission.snapshot.active).toBe(1); // Idle owner still reserves capacity.
        } finally { await owner.close(); }
        expect(admission.snapshot).toEqual({ active: 0, queued: 0, usedBytes: 0 });
      });
    } finally {
      cancellation.abort();
      await ctl("systemctl", ["--user", "stop", slice]); await ctl("systemctl", ["--user", "revert", slice]);
    }
  }, 20_000);
});
