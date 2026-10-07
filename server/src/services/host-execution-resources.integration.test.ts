import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { runWorkspaceGitProcess } from "@paperclipai/adapter-utils/workspace-git-stream";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { withHostExecutionResources } from "./host-execution-resources.js";
import { createWorkspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
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
