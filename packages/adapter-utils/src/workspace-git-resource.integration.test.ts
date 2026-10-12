import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withExecutionResourceContext } from "./execution-resource-context.js";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { runWorkspaceGitProcess } from "./workspace-git-stream.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
function context() {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR!;
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
  const evidence: ExecutionResourceEvidence[] = [];
  return { runId: randomUUID(), scratchDir, policy, evidence, admission: new ExecutionResourceAdmission(policy.memoryMaxBytes, 1),
    nativeLoaderCommand: () => process.env.PAPERCLIP_TEST_RESOURCE_LOADER!,
    onEvidence: async (event: ExecutionResourceEvidence) => { evidence.push(event); } };
}
function scan(script: string, options: Partial<Parameters<typeof runWorkspaceGitProcess>[0]> = {}) {
  return runWorkspaceGitProcess({ cwd: process.cwd(), args: ["status"], gitBinary: process.execPath,
    gitArgsPrefix: ["-e", script, "--"], timeoutMs: 5000, maxStdoutBytes: 4096, maxStderrBytes: 4096, ...options });
}
async function absent(pid: number) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat === null || stat.split(") ")[1]?.startsWith("Z");
}
(enabled ? describe : describe.skip)("workspace Git resource boundary", () => {
  it("contains a short command and preserves sanitized environment, arguments and output", async () => {
    const resources = context();
    const env = { PATH: process.env.PATH, PRIVATE_GIT_FIXTURE: "exact-value", GIT_OPTIONAL_LOCKS: "1" };
    const result = await withExecutionResourceContext(resources, () => scan(`console.log(JSON.stringify({pid:process.pid,cgroup:require('fs').readFileSync('/proc/self/cgroup','utf8'),secret:process.env.PRIVATE_GIT_FIXTURE,locks:process.env.GIT_OPTIONAL_LOCKS,args:process.argv.slice(1)}))`, { env }));
    const identity = JSON.parse(result.stdout);
    expect(identity.cgroup).toContain(".scope");
    expect(identity.cgroup).not.toContain("paperclipai.service");
    expect(identity.secret).toBe("exact-value");
    expect(identity.locks).toBe("0");
    expect(identity.args).toEqual(["-C",process.cwd(),"status"]);
    expect(env.GIT_OPTIONAL_LOCKS).toBe("1");
    expect(resources.evidence).toHaveLength(1);
    expect(resources.evidence[0].unit).toMatch(new RegExp(`^paperclip-execution-${resources.runId}-`));
    expect(resources.admission.snapshot.active).toBe(0);
  },15000);
  it("includes capacity waiting in its deadline and never launches a cancelled queued scan", async () => {
    const resources = context();
    const release = await resources.admission.acquire(resources.policy.memoryMaxBytes);
    try {
      await withExecutionResourceContext(resources, async () => {
        await expect(scan("process.exit(0)",{timeoutMs:50})).rejects.toMatchObject({code:"workspace_git_scan_timeout"});
        const abort = new AbortController();
        const waiting = scan("process.exit(0)",{signal:abort.signal});
        abort.abort();
        await expect(waiting).rejects.toMatchObject({code:"workspace_git_scan_cancelled"});
      });
      expect(resources.evidence).toEqual([]);
      expect(resources.admission.snapshot).toEqual({active:1,usedBytes:resources.policy.memoryMaxBytes,queued:0});
    } finally { release(); }
  });
  it("stops detached descendants at the deadline and permits a later scan", async () => {
    const resources = context();
    const identity = path.join(resources.scratchDir,`git-descendant-${randomUUID()}.json`);
    try {
      await withExecutionResourceContext(resources, async () => {
        await expect(scan(`const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify({pid:process.pid,descendant:child.pid}));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`, {timeoutMs:1500,killGraceMs:100})).rejects.toMatchObject({code:"workspace_git_scan_timeout"});
        const ids=JSON.parse(await fs.readFile(identity,'utf8'));
        expect(await absent(ids.pid)).toBe(true);
        expect(await absent(ids.descendant)).toBe(true);
        expect((await scan("console.log('recovered')")).stdout).toBe("recovered\n");
      });
      expect(resources.admission.snapshot.active).toBe(0);
    } finally { await fs.rm(identity,{force:true}); }
  },15000);
  it("reports a memory kill distinctly and restores admission for subsequent work", async () => {
    const resources = context();
    await withExecutionResourceContext(resources, async () => {
      await expect(scan("const chunks=[];setInterval(()=>chunks.push(Buffer.alloc(8*1024*1024,1)),5)" )).rejects.toMatchObject({code:"workspace_git_scan_resource_limit"});
      expect((await scan("console.log('after oom')")).stdout).toBe("after oom\n");
    });
    expect(resources.evidence.some(event=>event.resourceLimitReached)).toBe(true);
    expect(resources.admission.snapshot.active).toBe(0);
  },15000);
});
