import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { describe, expect, it } from "vitest";
import { ExecutionResourceAdmission, resolveExecutionResourcePolicy } from "./execution-resource-policy.js";
import { withExecutionResourceContext, type ExecutionResourceContext } from "./execution-resource-context.js";
import { runChildProcess } from "./server-utils.js";

const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
function context(): ExecutionResourceContext {
  const scratchDir = process.env.PAPERCLIP_SCRATCH_DIR;
  if (!scratchDir) throw new Error("Tests require run-owned scratch");
  const policy = resolveExecutionResourcePolicy({ PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "96", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "96" }, "linux", 8 * 1024 ** 3);
  return { policy, scratchDir, admission: new ExecutionResourceAdmission(policy.memoryMaxBytes, 1) };
}
function run(script: string, extra: Partial<Parameters<typeof runChildProcess>[3]> = {}) {
  return runChildProcess(randomUUID(), process.execPath, ["-e", script], {
    cwd: process.cwd(), env: {}, timeoutSec: 10, graceSec: 1, onLog: async () => {}, ...extra,
  });
}

(enabled ? describe : describe.skip)("shared runner resource context", () => {
  it("keeps stream/persistence ordering and reports the worker PID and sibling cgroup", async () => {
    const resources = context();
    let preparedUnit: string | undefined;
    resources.onUnitPrepared = async meta => { preparedUnit = meta.unit; };
    let persisted = false;
    let identity: { pid: number; executionUnit?: string } | undefined;
    const result = await withExecutionResourceContext(resources, () => run(`
      const fs=require('node:fs'); let input=''; process.stdin.setEncoding('utf8');
      process.stdin.on('data', s=>input+=s); process.stdin.on('end',()=>console.log(JSON.stringify({input,
        pid:process.pid,cgroup:fs.readFileSync('/proc/self/cgroup','utf8'),jobs:process.env.CARGO_BUILD_JOBS,secret:process.env.PRIVATE_VALUE})));`, {
      stdin: "hello\n", env: { PRIVATE_VALUE: '$HOME "literal"\nvalue' },
      onSpawn: async meta => { identity = meta; await new Promise(resolve => setTimeout(resolve, 20)); persisted = true; },
      onLog: async () => { expect(persisted).toBe(true); },
    }));
    const output = JSON.parse(result.stdout.trim());
    expect(result.exitCode, result.stderr).toBe(0);
    expect(identity?.executionUnit).toBe(preparedUnit);
    expect(identity?.pid).toBe(output.pid);
    expect(result.pid).toBe(output.pid);
    expect(output).toMatchObject({ input: "hello\n", jobs: "1", secret: '$HOME "literal"\nvalue' });
    expect(output.cgroup).toContain(identity?.executionUnit);
    expect(output.cgroup).not.toContain("paperclipai.service");
    expect(resources.admission.snapshot).toEqual({ active: 0, queued: 0, usedBytes: 0 });
  }, 20_000);

  it("cancels queued work before launch and releases capacity after detached descendants stop", async () => {
    const resources = context();
    const controller = new AbortController();
    let descendant = 0;
    const active = withExecutionResourceContext({ ...resources, signal: controller.signal }, () => run(`
      const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      console.log(child.pid); setInterval(()=>{},1000);`, { onLog: async (_stream, chunk) => { descendant = Number(chunk.trim()); } }));
    await expect.poll(() => descendant, { timeout: 5_000 }).toBeGreaterThan(0);
    const queuedController = new AbortController();
    let launched = false;
    const queued = withExecutionResourceContext({ ...resources, signal: queuedController.signal }, () => run("console.log('unreachable')", { onSpawn: async () => { launched = true; } }));
    const queuedFailure = expect(queued).rejects.toThrow("cancelled while queued");
    await expect.poll(() => resources.admission.snapshot.queued).toBe(1);
    queuedController.abort();
    await queuedFailure;
    expect(launched).toBe(false);
    controller.abort();
    const result = await active;
    expect(result.resourceUsage?.cancelled).toBe(true);
    const stat = await fs.readFile(`/proc/${descendant}/stat`, "utf8").catch(() => null);
    expect(stat === null || stat.split(") ")[1]?.startsWith("Z")).toBe(true);
    expect(resources.admission.snapshot.active).toBe(0);
    const recovered = await withExecutionResourceContext(resources, () => run("console.log('recovered')"));
    expect(recovered.exitCode, recovered.stderr).toBe(0);
  }, 20_000);

  it("keeps timeout escalation and worker signal semantics inside the unit", async () => {
    const resources = context();
    const result = await withExecutionResourceContext(resources, () => run(
      "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
      { timeoutSec: 1, graceSec: 1 },
    ));
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGKILL");
    expect(resources.admission.snapshot.active).toBe(0);
  }, 20_000);

  it("projects a cgroup memory kill and admits the next command", async () => {
    const resources = context();
    const result = await withExecutionResourceContext(resources, () => run("const allocations=[]; for(let i=0;i<128;i++) allocations.push(Buffer.alloc(4*1024*1024,1)); setInterval(()=>{},1000)"));
    expect(result.errorCode).toBe("execution_resource_limit");
    expect(result.resourceUsage?.resourceLimitReached).toBe(true);
    expect(resources.admission.snapshot.active).toBe(0);
    const recovered = await withExecutionResourceContext(resources, () => run("console.log('ok')"));
    expect(recovered.stdout.trim()).toBe("ok");
    expect(recovered.exitCode).toBe(0);
  }, 20_000);
});
