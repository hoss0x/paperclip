import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ensureRuntimeServicesForRun, releaseRuntimeServicesForRun, resetRuntimeServicesForTests } from "../services/workspace-runtime.js";
import { readLocalServiceRegistryRecord, listLocalServiceRegistryRecords, resolveLocalServiceLogPath } from "../services/local-service-supervisor.js";
import { verifyWorkspaceRuntimeExecution, stopWorkspaceRuntimeExecution } from "../services/workspace-runtime-resources.js";
import { executeWorkspaceRuntimeCommand } from "../services/workspace-runtime-command.js";
import { logger } from "../middleware/logger.js";
import { listActiveExecutionUnits } from "@paperclipai/adapter-utils/execution-resource-reconciliation";

const exec = promisify(execFile);
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
describe.skipIf(!enabled)("workspace runtime physical resource ownership", () => {
  let directory: string;
  const original = { ...process.env };
  const ids: string[] = [];
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(process.env.PAPERCLIP_SCRATCH_DIR!, "workspace-runtime-"));
    Object.assign(process.env, { PAPERCLIP_HOME: path.join(directory, "home"), PAPERCLIP_INSTANCE_ID: "runtime-resource-test",
      PAPERCLIP_DISABLE_CWD_ENV_FILE: "true", PAPERCLIP_EXECUTION_ISOLATION: "systemd",
      PAPERCLIP_EXECUTION_MEMORY_MAX_MIB: "160", PAPERCLIP_EXECUTION_MEMORY_HIGH_MIB: "160",
      PAPERCLIP_EXECUTION_RUNTIME_MEMORY_MAX_MIB: "128", PAPERCLIP_EXECUTION_CAPACITY_MIB: "512",
      PAPERCLIP_EXECUTION_RESERVE_MIB: "1024", PAPERCLIP_EXECUTION_MAX_CONCURRENT: "1" });
    const cg = (await exec("systemctl", ["--user", "show", "paperclip-executions.slice", "--property=ControlGroup", "--value"])).stdout.trim();
    if (cg) expect(await fs.readFile(`/sys/fs/cgroup${cg}/cgroup.stat`, "utf8")).toContain("nr_descendants 0\n");
    await exec("systemctl", ["--user", "revert", "paperclip-executions.slice"]);
    await fs.writeFile(path.join(directory, "server.cjs"), `
      const fs = require('node:fs'); const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
      fs.writeFileSync(process.env.RUNTIME_CHILD_FILE,String(child.pid)); child.unref();
      const held=[];
      require('node:http').createServer((req,res)=>{
        if(req.url==='/oom'){res.end('allocating');setTimeout(()=>setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),10),100)}
        else res.end(JSON.stringify({pid:process.pid,marker:process.env.RUNTIME_MARKER,cgroup:fs.readFileSync('/proc/self/cgroup','utf8')}));
      }).listen(Number(process.env.PORT),'127.0.0.1');
    `);
  });
  afterEach(async () => {
    for (const id of ids.splice(0)) await releaseRuntimeServicesForRun(id);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    for (const id of ids) await releaseRuntimeServicesForRun(id);
    await resetRuntimeServicesForTests({ terminateProcesses: true });
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    vi.restoreAllMocks();
  });
  const start = async (name: string, policy = "on_run_finish") => {
    const runId = randomUUID(); ids.push(runId);
    const services = await ensureRuntimeServicesForRun({ runId,
      agent: { id: "fixture-agent", name: "Runtime fixture", companyId: "fixture-company" }, issue: null,
      workspace: { baseCwd: directory, cwd: directory, source: "project_primary", strategy: "project_primary", projectId: "fixture-project", workspaceId: "fixture-workspace", repoUrl: null, repoRef: null, branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
      adapterEnv: { RUNTIME_MARKER: "exact-fixture-environment", RUNTIME_CHILD_FILE: path.join(directory, name + ".child") },
      config: { workspaceRuntime: { services: [{ name, command: `${process.execPath} ${path.join(directory, 'server.cjs')}`,
        port: { type: "auto" }, readiness: { type: "http", urlTemplate: "http://127.0.0.1:{{port}}", timeoutSec: 30, intervalMs: 100 },
        expose: { type: "url", urlTemplate: "http://127.0.0.1:{{port}}" }, lifecycle: "shared", reuseScope: "project_workspace", stopPolicy: { type: policy } }] } },
    });
    return { runId, service: services[0]! };
  };
  it("keeps a preview bounded across turns and stops its detached descendants", async () => {
    const first = await start("reuse"); const second = await start("reuse");
    const data = await (await fetch(first.service.url!)).json() as { pid: number; marker: string; cgroup: string };
    expect(second.service.id).toBe(first.service.id); expect(second.service.reused).toBe(true);
    expect(data.marker).toBe("exact-fixture-environment");
    expect(data.cgroup).toContain("-runtime.service");
    expect(data.cgroup).not.toBe(await fs.readFile("/proc/self/cgroup", "utf8"));
    const records = (await listLocalServiceRegistryRecords()).filter(record => record.runtimeServiceId === first.service.id);
    const record = records[0]!; expect(record.pid).toBe(data.pid); expect(record.resourceOwner).toBeTruthy();
    await verifyWorkspaceRuntimeExecution(record.resourceOwner!, data.pid);
    expect((await listActiveExecutionUnits("paperclip-executions.slice")).find(unit => unit.unit === record.resourceOwner!.unit)?.admissionKind).toBe("runtime");
    await releaseRuntimeServicesForRun(first.runId); expect((await fetch(first.service.url!)).ok).toBe(true);
    const detached = Number(await fs.readFile(path.join(directory, "reuse.child"), "utf8"));
    await releaseRuntimeServicesForRun(second.runId);
    await expect(fs.readFile(`/proc/${data.pid}/cgroup`, "utf8")).rejects.toThrow();
    await expect(fs.readFile(`/proc/${detached}/cgroup`, "utf8")).rejects.toThrow();
    expect(await readLocalServiceRegistryRecord(record.serviceKey)).toBeNull();
  }, 120_000);
  it("contains a preview OOM, preserves terminal memory evidence and permits a later service", async () => {
    const warning = vi.spyOn(logger, "warn");
    const first = await start("oom");
    const [record] = (await listLocalServiceRegistryRecords()).filter(record => record.runtimeServiceId === first.service.id);
    await fetch(first.service.url! + "/oom");
    for (let i = 0; i < 100; i++) {
      try { await fs.readFile(`/proc/${record!.pid}/cgroup`, "utf8"); } catch { break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await expect(fs.readFile(`/proc/${record!.pid}/cgroup`, "utf8")).rejects.toThrow();
    await releaseRuntimeServicesForRun(first.runId);
    await vi.waitFor(() => expect(warning.mock.calls.some(call => call[0] && typeof call[0] === "object" && "runtimeServiceId" in call[0] && call[0].runtimeServiceId === first.service.id)).toBe(true), { timeout: 1000 });
    const memory = warning.mock.calls.map(call => call[0]).find(value => value && typeof value === "object"
      && "runtimeServiceId" in value && value.runtimeServiceId === first.service.id) as { executionResources: { resourceLimitReached: boolean; peakMemoryBytes: number } };
    expect(memory.executionResources.resourceLimitReached).toBe(true);
    expect(memory.executionResources.peakMemoryBytes).toBeGreaterThanOrEqual(128 * 1024 ** 2);
    warning.mockRestore();
    const durable = await fs.readFile(resolveLocalServiceLogPath(record!.serviceKey), "utf8");
    expect(durable).toContain("execution_resource_limit");
    expect(durable).toContain('"peakMemoryBytes":134217728');
    const later = await start("recovery"); expect((await fetch(later.service.url!)).ok).toBe(true);
    // A registry descriptor for another owner cannot cancel a healthy successor.
    const [next] = (await listLocalServiceRegistryRecords()).filter(record => record.runtimeServiceId === later.service.id);
    await expect(stopWorkspaceRuntimeExecution({ ...next!.resourceOwner!, ownerId: randomUUID() })).rejects.toThrow("ownership");
    expect((await fetch(later.service.url!)).ok).toBe(true);
  }, 120_000);
  it("reconciles a surviving preview in an independent controller without taking the agent slot", async () => {
    const first = await start("restart");
    const [record] = (await listLocalServiceRegistryRecords()).filter(record => record.runtimeServiceId === first.service.id);
    const published = process.env.PAPERCLIP_TEST_PUBLISHED_SERVER_ROOT;
    const script = path.join(directory, published ? "successor.mjs" : "successor.mts");
    const supervisor = published ? path.join(published, "dist/services/local-service-supervisor.js")
      : path.resolve("server/src/services/local-service-supervisor.ts");
    const context = published ? path.join(published, "node_modules/@paperclipai/adapter-utils/dist/execution-resource-context.js")
      : path.resolve("packages/adapter-utils/src/execution-resource-context.ts");
    await fs.writeFile(script, `
      import {findAdoptableLocalService} from ${JSON.stringify(supervisor)};
      import {withOperatorExecutionResources,currentExecutionResources} from ${JSON.stringify(context)};
      await withOperatorExecutionResources({scratchDir:${JSON.stringify(directory)}},async()=>{
        const record=await findAdoptableLocalService({serviceKey:${JSON.stringify(record!.serviceKey)}});
        const pool=currentExecutionResources().admission;
        const before=pool.snapshot;
        const agent=await pool.acquire(160*1024**2);
        const helper=await pool.acquire(160*1024**2,undefined,'helper');
        console.log(JSON.stringify({pid:record.pid,before,after:pool.snapshot})); helper();agent();
      });
    `);
    const result = await exec(process.execPath, published ? ["--no-experimental-strip-types", script]
      : [path.resolve("server/node_modules/tsx/dist/cli.mjs"), script],
      { cwd: process.cwd(), env: process.env, timeout: 30_000, maxBuffer: 64 * 1024 });
    const resultLine = result.stdout.trim().split("\n").find(line => line.startsWith('{"pid"'))!;
    expect(JSON.parse(resultLine)).toMatchObject({ pid: record!.pid,
      before: { active: 1, usedBytes: 128 * 1024 ** 2 }, after: { active: 3, usedBytes: 448 * 1024 ** 2, queued: 0 } });
    expect((await fetch(first.service.url!)).ok).toBe(true);
  }, 120_000);
  it("classifies a preparation OOM and releases capacity before a later command", async () => {
    await expect(executeWorkspaceRuntimeCommand({ command: process.execPath, args: ["-e",
      "const held=[];setInterval(()=>held.push(Buffer.alloc(8*1024*1024,1)),10)"], cwd: directory },
      { stdout: () => {}, stderr: () => {} })).rejects.toMatchObject({ code: "execution_resource_limit" });
    expect(await executeWorkspaceRuntimeCommand({ command: "/bin/true", args: [], cwd: directory },
      { stdout: () => {}, stderr: () => {} })).toBe(0);
  }, 120_000);
  it("governs short preparation commands and preserves streamed output", async () => {
    let stdout = ""; let stderr = "";
    const code = await executeWorkspaceRuntimeCommand({ command: process.execPath,
      args: ["-e", "process.stdout.write(require('node:fs').readFileSync('/proc/self/cgroup','utf8'));process.stderr.write('exact-stderr')"], cwd: directory },
    { stdout: chunk => { stdout += chunk; }, stderr: chunk => { stderr += chunk; } });
    expect(code).toBe(0); expect(stdout).toContain("paperclip-execution-");
    expect(stdout).not.toBe(await fs.readFile("/proc/self/cgroup", "utf8")); expect(stderr).toBe("exact-stderr");
  }, 120_000);
});
