import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { currentExecutionResources, type ExecutionResourceOwnership } from "@paperclipai/adapter-utils/execution-resource-context";
import type { CodexAppServerTransport } from "@paperclipai/paperclip-runner";
import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { recoverRecordedExecutionUnit } from "./recovered-execution-unit.js";
import { executeWithResourceGovernance } from "../execution-resources.js";
import { createResourceCodexTransport } from "./resource-codex-transport.js";

const ctl = promisify(execFile);
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
const testSlice = `paperclip-retainedcheck${randomUUID().replaceAll("-", "")}.slice`;
const program = `const readline=require('readline');const held=[];
const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.method==='oom'){setInterval(()=>held.push(Buffer.alloc(4*1024*1024,1)),10);return;}
if(r.id!==undefined)console.log(JSON.stringify({id:r.id,result:{pid:process.pid,descendant:child.pid,cgroup:require('fs').readFileSync('/proc/self/cgroup','utf8')}}));});`;
(enabled ? describe : describe.skip)("authenticated retained native resource ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("retained-resources-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Resource ownership regression", issuePrefix: "ROR" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Retained native fixture", status: "active", adapterType: "codex_local" });
  });
  afterAll(async () => { await database?.cleanup(); });
  it("attributes a reused transport's OOM only to Run B, then admits a later session", async () => {
    const slice = testSlice;
    const records: Array<{ runId: string; eventType: string; payload: Record<string, unknown> }> = [];
    const runA = randomUUID(), runB = randomUUID();
    let firstIdentity: Record<string, unknown> | undefined;
    let owner: ExecutionResourceOwnership | undefined;
    let transport: CodexAppServerTransport | undefined;
    const seqs = new Map<string, number>();
    const run = (runId: string, execute: () => Promise<AdapterExecutionResult>, signal = new AbortController().signal) => executeWithResourceGovernance({
      runId, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR!, slice, signal,
      record: async event => {
        if (!seqs.has(runId)) { await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native" }); seqs.set(runId, 0); }
        const seq = seqs.get(runId)! + 1; seqs.set(runId, seq);
        await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq, eventType: event.eventType, stream: "system", payload: event.payload });
        records.push({ runId, ...event });
      },
    }, execute);
    try {
      await run(runA, async () => {
        owner = currentExecutionResources()!.ownership!;
        transport = await createResourceCodexTransport(runA)!({ command: process.execPath, args: ["-e", program],
          workingDirectory: process.cwd(), environment: { PATH: process.env.PATH! } });
        const first = await transport.request("initialize", {});
        firstIdentity = first;
        expect(first.cgroup).not.toContain("paperclipai.service");
        return { exitCode: 0, signal: null, timedOut: false };
      });
      const result = await run(runB, async () => {
        await owner!.handoff(currentExecutionResources()!);
        const recovered = await recoverRecordedExecutionUnit(db, { companyId, runId: runB, pid: Number(firstIdentity!.pid), isAlive: async () => true });
        expect(recovered).not.toBeNull();
        await expect(recoverRecordedExecutionUnit(db, { companyId, runId: runA, pid: Number(firstIdentity!.pid), isAlive: async () => true }))
          .rejects.toThrow("belongs to a later run");
        expect(await transport!.request("initialize", {})).toEqual(firstIdentity);
        await expect(transport!.request("oom", {})).rejects.toThrow();
        await transport!.close();
        return { exitCode: 1, signal: null, timedOut: false, errorMessage: "Command failed" };
      });
      expect(result.errorCode).toBe("execution_resource_limit");
      const descendant = await readFile(`/proc/${firstIdentity!.descendant}/stat`, "utf8").catch(() => null);
      expect(descendant === null || descendant.split(") ")[1]?.startsWith("Z")).toBe(true);
      expect(result.resultJson?.executionResources).toEqual(expect.arrayContaining([expect.objectContaining({ resourceLimitReached: true })]));
      expect(records.filter(r => r.runId === runA && r.payload.resourceLimitReached)).toEqual([]);
      const persisted = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      expect(persisted.filter(row => row.runId === runB && row.payload?.resourceLimitReached)).toHaveLength(1);
      expect(persisted.filter(row => row.runId === runA && row.payload?.resourceLimitReached)).toHaveLength(0);
      expect(records.filter(r => r.runId === runB && r.payload.resourceLimitReached)).toHaveLength(1);
      expect(records.find(r => r.runId === runB && r.eventType === "execution_resource_prepared")?.payload).toMatchObject({ originRunId: runA, previousRunId: runA });
      expect(records.find(r => r.runId === runB && r.eventType === "execution_resource_claimed")).toBeDefined();
      const later = await run(randomUUID(), async () => {
        transport = await createResourceCodexTransport(randomUUID())!({ command: process.execPath, args: ["-e", program], environment: { PATH: process.env.PATH! } });
        await transport.request("initialize", {}); await transport.close();
        return { exitCode: 0, signal: null, timedOut: false };
      });
      expect(later.exitCode).toBe(0);
      expect(later.errorCode).toBeUndefined();
      await writeFile(`${process.env.PAPERCLIP_SCRATCH_DIR}/retained-two-run-evidence.json`, JSON.stringify({ runA, runB, result, records }, null, 2));
    } finally {
      await transport?.close().catch(() => {});
      await ctl("systemctl", ["--user", "stop", slice]);
      await ctl("systemctl", ["--user", "revert", slice]);
    }
  }, 30_000);
  it("moves cancellation to Run B and leaves Run A's later abort harmless", async () => {
    const first = new AbortController(), second = new AbortController();
    let owner: ExecutionResourceOwnership | undefined;
    let transport: CodexAppServerTransport | undefined;
    const run = (runId: string, signal: AbortSignal, execute: () => Promise<AdapterExecutionResult>) => executeWithResourceGovernance({
      runId, signal, slice: testSlice, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR!, record: async () => {},
    }, execute);
    try {
      const runA = randomUUID();
      await run(runA, first.signal, async () => {
        owner = currentExecutionResources()!.ownership!;
        transport = await createResourceCodexTransport(runA)!({ command: process.execPath, args: ["-e", program], environment: { PATH: process.env.PATH! } });
        await transport.request("initialize", {});
        return { exitCode: 0, signal: null, timedOut: false };
      });
      const result = await run(randomUUID(), second.signal, async () => {
        await owner!.handoff(currentExecutionResources()!);
        first.abort();
        expect(await transport!.request("initialize", {})).toHaveProperty("pid");
        second.abort();
        await expect.poll(() => transport!.processInfo?.().exited, { timeout: 5000 }).toBe(true);
        await transport!.close();
        return { exitCode: 1, signal: null, timedOut: false };
      });
      expect(result.errorCode).toBeUndefined();
      expect(result.resultJson?.executionResources).toEqual(expect.arrayContaining([expect.objectContaining({ cancelled: true, resourceLimitReached: false })]));
    } finally {
      await transport?.close().catch(() => {});
      await ctl("systemctl", ["--user", "stop", testSlice]);
      await ctl("systemctl", ["--user", "revert", testSlice]);
    }
  }, 30_000);

});
