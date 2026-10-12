import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { execFileWithResources } from "@paperclipai/adapter-utils/resource-buffered-command";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { prepareAdapterExecutionTargetRuntime, runAdapterExecutionTargetShellCommand } from "./host-execution-target.js";

const fixture = vi.hoisted(() => ({ observations: [] as { group: string; runId?: string }[], limited: false }));
vi.mock("@paperclipai/adapter-utils/execution-target", async importOriginal => {
  const original = await importOriginal<typeof import("@paperclipai/adapter-utils/execution-target")>();
  return {
    ...original,
    prepareAdapterExecutionTargetRuntime: async (input: { target: unknown }) => {
      const observe = async () => {
        const resources = currentExecutionResources();
        expect(resources?.runId).toBeDefined();
        const script = fixture.limited
          ? "const held=[];setInterval(()=>held.push(Buffer.alloc(16*1024*1024,1)),10)"
          : "console.log(require('fs').readFileSync('/proc/self/cgroup','utf8'))";
        const result = await execFileWithResources(process.execPath, ["-e", script], { timeout: 5000, maxBuffer: 4096 });
        fixture.observations.push({ group: result.stdout.trim(), runId: resources?.runId });
      };
      await observe();
      return { target: input.target, workspaceRemoteDir: null, runtimeRootDir: null,
        assetDirs: {}, additionalSourceDirs: {}, additionalSourceFailures: [], workspaceSyncSnapshot: null,
        restoreWorkspace: observe, cleanupWorkspaceSnapshot: observe };
    },
    runAdapterExecutionTargetShellCommand: async () => {
      expect(currentExecutionResources()?.runId).toBeDefined();
      return execFileWithResources(process.execPath, ["-e", "console.log('shell helper')"], { timeout: 5000, maxBuffer: 4096 });
    },
  };
});

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("deferred controller staging resources", () => {
  it("protects preparation, later restore/cleanup, and shell calls outside dispatch", async () => {
    fixture.observations = [];
    expect(currentExecutionResources()).toBeUndefined();
    const runId = randomUUID();
    const runtime = await prepareAdapterExecutionTargetRuntime({
      target: { kind: "local" }, runId, adapterKey: "fixture", workspaceLocalDir: process.cwd(),
    });
    expect(currentExecutionResources()).toBeUndefined();
    await runtime.restoreWorkspace();
    await runtime.cleanupWorkspaceSnapshot!();
    const result = await runAdapterExecutionTargetShellCommand(randomUUID(), { kind: "local" }, "fixture", {
      cwd: process.cwd(), env: {}, timeoutSec: 5,
    });
    expect(result.stdout).toBe("shell helper\n");
    expect(fixture.observations).toHaveLength(3);
    expect(fixture.observations.every(({ group, runId: owner }) => owner === runId && group.includes(".scope") && !group.includes("paperclipai.service"))).toBe(true);
    await fs.writeFile(path.join(process.env.PAPERCLIP_SCRATCH_DIR!, "staging-identities.json"), JSON.stringify(fixture.observations, null, 2));
    expect(currentExecutionResources()).toBeUndefined();
    expect(await fs.readdir(path.join(resolvePaperclipInstanceRoot(), "runtime", "execution-helpers"))).toEqual([]);
  }, 20_000);

  it("propagates a deferred restore memory limit and permits later restoration", async () => {
    const runtime = await prepareAdapterExecutionTargetRuntime({
      target: { kind: "local" }, runId: randomUUID(), adapterKey: "fixture", workspaceLocalDir: process.cwd(),
    });
    fixture.limited = true;
    try { await expect(runtime.restoreWorkspace()).rejects.toMatchObject({ code: "execution_resource_limit" }); }
    finally { fixture.limited = false; }
    await runtime.restoreWorkspace();
    expect(currentExecutionResources()).toBeUndefined();
    expect(await fs.readdir(path.join(resolvePaperclipInstanceRoot(), "runtime", "execution-helpers"))).toEqual([]);
  }, 20_000);
});
