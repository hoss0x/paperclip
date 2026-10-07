import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withExecutionResourceContext } from "./execution-resource-context.js";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { launchResourceStdioProcess } from "./resource-stdio-process.js";
import { listActiveExecutionUnits } from "./execution-resource-reconciliation.js";
import type { ExecutionResourceEvidence } from "./systemd-execution.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
function context() {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
  if (!scratchDir) throw new Error("Tests require run-owned scratch");
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
  const evidence: ExecutionResourceEvidence[] = [];
  return { scratchDir, policy, admission: new ExecutionResourceAdmission(policy.memoryMaxBytes, 1), evidence,
    onEvidence: async (value: ExecutionResourceEvidence) => { evidence.push(value); } };
}
(enabled ? describe : describe.skip)("descriptor-preserving execution scope", () => {
  it("fails closed without a native loader and returns the admission reservation", async () => {
    const resources = context();
    await withExecutionResourceContext(resources, async () => {
      await expect(launchResourceStdioProcess({ runId: randomUUID(), command: process.execPath,
        args: [], cwd: process.cwd(), env: {}, scope: true })).rejects.toThrow("packaged native runner");
    });
    expect(resources.admission.snapshot).toEqual({ active: 0, usedBytes: 0, queued: 0 });
  });
  it("keeps worker/group identity, inherited descriptors and detached-descendant cleanup", async () => {
    const resources = context();
    const file = path.join(resources.scratchDir, `descriptor-${randomUUID()}`);
    await fs.writeFile(file, "verified-descriptor");
    const descriptor = await fs.open(file, "r");
    try {
      await withExecutionResourceContext(resources, async () => {
        const worker = await launchResourceStdioProcess({ runId: randomUUID(), command: process.execPath,
          args: ["-e", `const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
            console.log(JSON.stringify({pid:process.pid,descendant:child.pid,fd:fs.readFileSync(3,'utf8'),env:process.env.SCOPE_TEST_VALUE,argv:process.argv.slice(1),cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));setInterval(()=>{},1000);`, '$literal; $(ignored)', 'two words'],
          cwd: process.cwd(), env: { PATH: process.env.PATH, SCOPE_TEST_VALUE: "exact private environment" }, scope: true, nativeLoaderCommand: process.env.PAPERCLIP_TEST_RESOURCE_LOADER, detached: true, extraStdio: [descriptor.fd] });
        try {
          let output = "";
          worker.child.stdout.on("data", chunk => { output += String(chunk); });
          let stderr = ""; worker.child.stderr.on("data", chunk => { stderr += String(chunk); });
          await expect.poll(() => output.includes("\n") || stderr.length > 0, { timeout: 5_000 }).toBe(true);
          expect(stderr).toBe("");
          const identity = JSON.parse(output.trim());
          expect(identity.fd).toBe("verified-descriptor");
          expect(identity.env).toBe("exact private environment");
          expect(identity.argv).toEqual(["$literal; $(ignored)", "two words"]);
          expect(identity.pid).toBe(worker.pid);
          expect(worker.child.pid).toBe(worker.pid);
          expect(identity.cgroup).toContain(".scope");
          expect(identity.cgroup).not.toContain("paperclipai.service");
          const slice = identity.cgroup.trim().split("/").slice(1, -1).reverse().find((part: string) => part.endsWith(".slice"));
          expect(await listActiveExecutionUnits(slice)).toContainEqual({
            unit: identity.cgroup.trim().split("/").at(-1), memoryMaxBytes: resources.policy.memoryMaxBytes,
          });
          const stat = await fs.readFile(`/proc/${worker.pid}/stat`, "utf8");
          expect(Number(stat.split(") ")[1]!.split(" ")[2])).toBe(worker.pid);
          worker.signal("SIGTERM");
          await worker.completion;
          const descendant = await fs.readFile(`/proc/${identity.descendant}/stat`, "utf8").catch(() => null);
          expect(descendant === null || descendant.split(") ")[1]?.startsWith("Z")).toBe(true);
        } finally { worker.signal("SIGKILL"); await worker.completion.catch(() => {}); }
      });
      expect(resources.admission.snapshot.active).toBe(0);
      expect(resources.evidence[0]?.cancelled).toBe(true);
    } finally { await descriptor.close(); await fs.rm(file, { force: true }); }
  }, 20_000);

  it("cleans descendants holding protocol pipes after the leader succeeds", async () => {
    const resources = context();
    await withExecutionResourceContext(resources, async () => {
      const worker = await launchResourceStdioProcess({ runId: randomUUID(), command: process.execPath,
        args: ["-e", `process.stdin.once('data',()=>{const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,2]});console.log(child.pid);process.exit(0);});`],
        cwd: process.cwd(), env: process.env, scope: true, nativeLoaderCommand: process.env.PAPERCLIP_TEST_RESOURCE_LOADER });
      let output = ""; worker.child.stdout.on("data", chunk => { output += String(chunk); });
      worker.child.stderr.resume(); worker.child.stdin.write("start");
      expect((await worker.completion).code).toBe(0);
      const descendant = await fs.readFile(`/proc/${Number(output.trim())}/stat`, "utf8").catch(() => null);
      expect(descendant === null || descendant.split(") ")[1]?.startsWith("Z")).toBe(true);
    });
    expect(resources.admission.snapshot.active).toBe(0);
  }, 20_000);

  it("records a scope memory kill and admits later work", async () => {
    const resources = context();
    await withExecutionResourceContext(resources, async () => {
      const worker = await launchResourceStdioProcess({ runId: randomUUID(), command: process.execPath,
        args: ["-e", "process.stdin.once('data',()=>{const b=[];for(let i=0;i<128;i++)b.push(Buffer.alloc(4*1024*1024,1));});"],
        cwd: process.cwd(), env: process.env, scope: true, nativeLoaderCommand: process.env.PAPERCLIP_TEST_RESOURCE_LOADER });
      worker.child.stdout.resume(); worker.child.stderr.resume();
      worker.child.stdin.write("start");
      await worker.completion;
      expect(resources.evidence[0]?.resourceLimitReached).toBe(true);
      const recovered = await launchResourceStdioProcess({ runId: randomUUID(), command: process.execPath,
        args: ["-e", "process.stdin.once('data',()=>process.exit(0))"], cwd: process.cwd(), env: process.env, scope: true, nativeLoaderCommand: process.env.PAPERCLIP_TEST_RESOURCE_LOADER });
      recovered.child.stdout.resume(); recovered.child.stderr.resume(); recovered.child.stdin.write("start");
      expect((await recovered.completion).code).toBe(0);
    });
    expect(resources.admission.snapshot.active).toBe(0);
  }, 20_000);
});
