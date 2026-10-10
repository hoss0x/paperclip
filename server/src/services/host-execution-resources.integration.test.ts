import fs from "node:fs/promises";
import path from "node:path";
import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { runWorkspaceGitProcess } from "@paperclipai/adapter-utils/workspace-git-stream";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createWorkspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareExecutionRunEnvelope } from "@paperclipai/adapter-utils/execution-run-envelope";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withExecutionResourceContext } from "@paperclipai/adapter-utils/execution-resource-context";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "@paperclipai/adapter-utils/execution-resource-policy";
import { createResourceProcessLauncher } from "@paperclipai/adapter-utils/resource-process-launcher";
import { execFileWithResources } from "@paperclipai/adapter-utils/resource-buffered-command";
import { listActiveExecutionUnits } from "@paperclipai/adapter-utils/execution-resource-reconciliation";
import { ensureSystemdExecutionSlice } from "@paperclipai/adapter-utils/systemd-execution-slice";
import { withHostExecutionResources } from "./host-execution-resources.js";

const quotaAdapter = vi.hoisted(() => ({ getQuotaWindows: vi.fn() }));
vi.mock("../adapters/registry.js", () => ({ listServerAdapters: () => [{ type: "codex_local", getQuotaWindows: quotaAdapter.getQuotaWindows }] }));
import { fetchAllQuotaWindows } from "./quota-windows.js";

const slices: string[] = [];
afterEach(async () => {
  for (const slice of slices.splice(0)) {
    await promisify(execFile)("systemctl", ["--user", "stop", slice], { timeout: 5000 });
    await promisify(execFile)("systemctl", ["--user", "revert", slice], { timeout: 5000 });
  }
});
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
beforeAll(() => {
  if (enabled) expect(resolveExecutionResourcePolicy().isolation).toBe("systemd");
});
async function context() {
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96",
    PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96", PAPERCLIP_EXECUTION_CAPACITY_MIB: "192",
    PAPERCLIP_EXECUTION_MAX_CONCURRENT: "1" }, "linux", 8 * 1024 ** 3);
  const slice = await ensureSystemdExecutionSlice(policy, `paperclip-helpertest${randomUUID().replaceAll("-", "")}.slice`);
  slices.push(slice);
  return { runId: randomUUID(), policy, slice, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR!,
    nativeLoaderCommand: () => process.env.PAPERCLIP_TEST_RESOURCE_LOADER!,
    admission: new ExecutionResourceAdmission(policy.capacityBytes, 1, 1) };
}
(enabled ? describe : describe.skip)("host helper admission", () => {
  it.each([2, 4])("admits a dependent helper under defaults for a %i GiB host", async (hostGiB) => {
    const policy = resolveExecutionResourcePolicy({}, "linux", hostGiB * 1024 ** 3);
    const slice = await ensureSystemdExecutionSlice(policy, `paperclip-smallhelper${randomUUID().replaceAll("-", "")}.slice`);
    slices.push(slice);
    const resources = { runId: randomUUID(), policy, slice, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR!,
      nativeLoaderCommand: () => process.env.PAPERCLIP_TEST_RESOURCE_LOADER!,
      admission: new ExecutionResourceAdmission(policy.capacityBytes, policy.maxConcurrent, policy.helperMaxConcurrent) };
    await withExecutionResourceContext(resources, async () => {
      const root = createResourceProcessLauncher({ runId: resources.runId })!({ command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH } });
      await root.ready;
      try {
        const result = await withHostExecutionResources(undefined, () => execFileWithResources(process.execPath,
          ["-e", "console.log('dependent helper completed')"], { timeout: 3000 }));
        expect(result.stdout).toBe("dependent helper completed\n");
        expect(resources.admission.snapshot.usedBytes).toBe(policy.memoryMaxBytes);
      } finally { root.child.kill("SIGKILL"); await root.completion; }
      expect(resources.admission.snapshot).toEqual({ usedBytes: 0, active: 0, queued: 0 });
    });
  }, 15000);
  it("executes a helper beside a persistent agent and records its actual sibling cgroup", async () => {
    const resources = await context();
    await withExecutionResourceContext(resources, async () => {
      const root = createResourceProcessLauncher({ runId: resources.runId })!({ command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH } });
      await root.ready;
      const controller = new AbortController();
      const next = resources.admission.acquire(resources.policy.memoryMaxBytes, controller.signal);
      const cancelled = expect(next).rejects.toThrow("cancelled while queued");
      try {
        const result = await withHostExecutionResources(undefined, () => execFileWithResources(process.execPath,
          ["-e", "console.log(require('fs').readFileSync('/proc/self/cgroup','utf8'))"], { timeout: 3000 }));
        expect(result.stdout).toContain("-helper.scope");
        expect(result.stdout).toContain(resources.slice);
        expect(result.stdout).not.toContain("paperclipai.service");
        expect(resources.admission.snapshot).toEqual({ usedBytes: resources.policy.memoryMaxBytes, active: 1, queued: 1 });
      } finally {
        controller.abort(); await cancelled;
        root.child.kill("SIGKILL"); await root.completion;
      }
      expect(resources.admission.snapshot.active).toBe(0);
    });
  }, 15000);
  it("polls UI quota in the helper lane while a retained agent owns the only agent slot", async () => {
    const resources = await context();
    await withExecutionResourceContext(resources, async () => {
      const root = createResourceProcessLauncher({ runId: resources.runId })!({ command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH } });
      await root.ready;
      quotaAdapter.getQuotaWindows.mockImplementation(async () => {
        const result = await execFileWithResources(process.execPath,
          ["-e", "console.log(require('fs').readFileSync('/proc/self/cgroup','utf8'))"], { timeout: 3000 });
        expect(result.stdout).toContain("-helper.scope");
        expect(result.stdout).toContain(resources.slice);
        return { provider: "openai", ok: true, windows: [] };
      });
      try {
        expect(await fetchAllQuotaWindows()).toEqual([{ provider: "openai", ok: true, windows: [] }]);
        expect(resources.admission.snapshot).toEqual({ usedBytes: resources.policy.memoryMaxBytes, active: 1, queued: 0 });
      } finally { root.child.kill("SIGKILL"); await root.completion; }
    });
  }, 15000);
  it("discovers a surviving helper's bounded budget and helper role from the OS", async () => {
    const resources = await context();
    await withExecutionResourceContext({ ...resources, admissionKind: "helper" }, async () => {
      const root = createResourceProcessLauncher({ runId: resources.runId })!({ command: process.execPath,
        args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH } });
      await root.ready;
      try {
        const units = await listActiveExecutionUnits(resources.slice);
        expect(units).toHaveLength(1);
        expect(units[0]).toMatchObject({ memoryMaxBytes: resources.policy.memoryMaxBytes, admissionKind: "helper" });
        expect(units[0]!.unit).toContain(resources.runId);
        expect(units[0]!.unit).toMatch(/-helper\.service$/);
      } finally { root.child.kill("SIGKILL"); await root.completion; }
    });
  }, 15000);
  it("counts a helper envelope once beside a reserved agent and preserves its restart role", async () => {
    const resources = await context();
    const releaseAgent = await resources.admission.acquire(resources.policy.memoryMaxBytes);
    try {
      await withExecutionResourceContext(resources, () => withHostExecutionResources(undefined, async () => {
        const envelope = await prepareExecutionRunEnvelope();
        try {
          await envelope.run(async () => {
            const root = createResourceProcessLauncher({ runId: resources.runId })!({ command: process.execPath,
              args: ["-e", "setInterval(()=>{},1000)"], cwd: process.cwd(), environment: { PATH: process.env.PATH } });
            await root.ready;
            try {
              const units = await listActiveExecutionUnits(resources.slice);
              expect(units).toEqual([{ unit: envelope.slice, memoryMaxBytes: resources.policy.memoryMaxBytes, admissionKind: "helper" }]);
              const result = await execFileWithResources(process.execPath, ["-e", "console.log('paired')"]);
              expect(result.stdout).toBe("paired\n");
              expect(resources.admission.snapshot.usedBytes).toBe(resources.policy.capacityBytes);
            } finally { root.child.kill("SIGKILL"); await root.completion; }
          });
        } finally { await envelope.close(); }
      }));
      expect(resources.admission.snapshot.active).toBe(1);
    } finally { releaseAgent(); }
  }, 15000);
  it("keeps helpers queued when aggregate bytes are unavailable", async () => {
    const resources = await context();
    const release = await resources.admission.acquire(resources.policy.capacityBytes);
    try {
      await withExecutionResourceContext(resources, () => withHostExecutionResources(undefined,
        () => expect(execFileWithResources(process.execPath, ["-e", "console.log('unreachable')"], { timeout: 300 }))
          .rejects.toThrow("Command timed out")));
      expect(resources.admission.snapshot).toEqual({ usedBytes: resources.policy.capacityBytes, active: 1, queued: 0 });
    } finally { release(); }
  }, 15000);
});

(enabled ? describe : describe.skip)("controller helper resource context", () => {
  it("governs a scheduler scan outside agent dispatch and removes its private launch files", async () => {
    expect(currentExecutionResources()).toBeUndefined();
    const scratch = process.env.PAPERCLIP_SCRATCH_DIR!;
    const identity = path.join(scratch,"controller-git-identity.json");
    const scheduler = createWorkspaceGitOperationScheduler({gitBinary:process.execPath,
      gitArgsPrefix:["-e",`const fs=require('fs');fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),locks:process.env.GIT_OPTIONAL_LOCKS}));console.log('scheduler-output')`,"--"]});
    try {
      const result = await scheduler.run({workspacePath:scratch,args:["status"],operation:"test.resource_scan",cacheTtlMs:0,timeoutMs:5000});
      expect(result.stdout).toBe("scheduler-output\n");
      const observed=JSON.parse(await fs.readFile(identity,"utf8"));
      expect(observed.cgroup).toContain(".scope");
      expect(observed.cgroup).not.toContain("paperclipai.service");
      expect(observed.locks).toBe("0");
      const helpers=path.join(resolvePaperclipInstanceRoot(),"runtime","execution-helpers");
      expect(await fs.readdir(helpers)).toEqual([]);
      expect(currentExecutionResources()).toBeUndefined();
    } finally { await fs.rm(identity,{force:true}); }
  },15000);
  it("preserves a scan resource-limit failure and allows a later controller helper",async()=>{
    const scan=(script:string)=>runWorkspaceGitProcess({cwd:process.cwd(),args:[],gitBinary:process.execPath,gitArgsPrefix:["-e",script,"--"],timeoutMs:5000,maxStdoutBytes:1024,maxStderrBytes:1024});
    await expect(withHostExecutionResources(undefined,()=>scan("const chunks=[];setInterval(()=>chunks.push(Buffer.alloc(8*1024*1024,1)),5)"))).rejects.toMatchObject({code:"workspace_git_scan_resource_limit"});
    expect((await withHostExecutionResources(undefined,()=>scan("console.log('controller recovered')"))).stdout).toBe("controller recovered\n");
    expect(await fs.readdir(path.join(resolvePaperclipInstanceRoot(),"runtime","execution-helpers"))).toEqual([]);
  },15000);
});
