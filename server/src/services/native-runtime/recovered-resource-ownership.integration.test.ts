import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { currentExecutionResources, type ExecutionResourceOwnership } from "@paperclipai/adapter-utils/execution-resource-context";
import { execFileWithResources } from "@paperclipai/adapter-utils/resource-buffered-command";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { executeWithResourceGovernance } from "../execution-resources.js";
import { recoverRecordedExecutionUnit } from "./recovered-execution-unit.js";

const exec = promisify(execFile);
const enabled = process.platform === "linux" && process.env.PAPERCLIP_TEST_SYSTEMD === "1";
(enabled ? describe : describe.skip)("recovered native resource ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("recovered-resources-");
    db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Recovered resources", issuePrefix: "RRC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovered native fixture", status: "active", adapterType: "codex_local" });
  });
  afterAll(async () => { await database?.cleanup(); });
  it("restores a controller lease before warm reuse and assigns the later OOM only to Run B", async () => {
    const runA = randomUUID(), runB = randomUUID();
    const slice = `paperclip-recoveredcheck${randomUUID().replaceAll("-", "")}.slice`;
    const unit = `paperclip-execution-${runA}-recovered.service`;
    const identityFile = `${process.env.PAPERCLIP_SCRATCH_DIR}/${runA}.json`;
    const a = new AbortController(), b = new AbortController();
    const ctl = async (args: string[]) => (await exec("systemctl", ["--user", ...args], { timeout: 15_000 })).stdout;
    const success = (): AdapterExecutionResult => ({ exitCode: 0, signal: null, timedOut: false });
    const seqs = new Map<string, number>();
    const run = async (id: string, signal: AbortSignal, execute: () => Promise<AdapterExecutionResult>) => {
      await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running", runtimeMode: "native" });
      seqs.set(id, id === runA ? 1 : 0);
      return executeWithResourceGovernance({ runId: id, signal, slice, scratchDir: process.env.PAPERCLIP_SCRATCH_DIR!,
        record: async event => {
          const seq = seqs.get(id)! + 1; seqs.set(id, seq);
          await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: id, seq,
            eventType: event.eventType, payload: event.payload, stream: "system" });
        },
      }, execute);
    };
    let recovered: Awaited<ReturnType<typeof recoverRecordedExecutionUnit>> = null;
    let owner: ExecutionResourceOwnership | undefined;
    const alive = async (pid: number) => {
      try { return !(await readFile(`/proc/${pid}/stat`, "utf8")).split(") ")[1]?.startsWith("Z"); }
      catch { return false; }
    };
    try {
      // This unit has no old controller recorder or launch callback. It survives
      // independently, as a runner does after the first controller exits.
      await exec("systemd-run", ["--user", `--unit=${unit}`, `--slice=${slice}`,
        "--property=Type=exec", "--property=MemoryHigh=96M", "--property=MemoryMax=96M",
        "--property=MemorySwapMax=0", "--property=TasksMax=32", "--property=RuntimeMaxSec=30",
        "--property=KillMode=control-group", "--property=OOMPolicy=stop", process.execPath, "-e",
        `const fs=require('fs');const held=[];const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,child:child.pid}));process.on('SIGUSR1',()=>setInterval(()=>held.push(Buffer.alloc(4*1024*1024,1)),10));setInterval(()=>{},1000)`, identityFile], { timeout: 5000 });
      await expect.poll(async () => readFile(identityFile, "utf8").catch(() => null), { timeout: 5000 }).not.toBeNull();
      const ids = JSON.parse(await readFile(identityFile, "utf8")) as { pid: number; child: number };
      await run(runA, a.signal, async () => {
        await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: runA, seq: 1,
          eventType: "execution_resource_prepared", stream: "system", payload: { unit, memoryMaxBytes: 96 * 1024 * 1024 } });
        owner = currentExecutionResources()!.ownership;
        recovered = await recoverRecordedExecutionUnit(db, { companyId, runId: runA, pid: ids.pid, isAlive: () => alive(ids.pid) });
        expect(recovered).not.toBeNull();
        // Only the authenticated transport may activate the restored lease.
        await (recovered as typeof recovered & { onAuthenticated?: () => Promise<void> })?.onAuthenticated?.();
        return success();
      });
      const result = await run(runB, b.signal, async () => {
        await owner!.handoff(currentExecutionResources()!);
        a.abort();
        expect(await alive(ids.pid)).toBe(true);
        await recovered!.signal("SIGUSR1");
        await expect.poll(async () => (await ctl(["show", unit, "--property=Result", "--value"])).trim(), { timeout: 5000 }).toBe("oom-kill");
        await recovered!.cleanup();
        return success();
      });
      expect(result.errorCode).toBe("execution_resource_limit");
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, companyId));
      expect(events.filter(event => event.runId === runA && event.payload?.resourceLimitReached)).toHaveLength(0);
      expect(events.filter(event => event.runId === runB && event.payload?.resourceLimitReached)).toHaveLength(1);
      expect(events.some(event => event.runId === runB && event.eventType === "execution_resource_claimed" &&
        Array.isArray(event.payload?.units) && event.payload.units.includes(unit))).toBe(true);
      await expect.poll(() => alive(ids.child), { timeout: 5000 }).toBe(false);
      await expect.poll(async () => (await ctl(["show", unit, "--property=LoadState", "--value"])).trim(), { timeout: 5000 }).toBe("not-found");
      const runC = randomUUID();
      const later = await run(runC, new AbortController().signal, async () => {
        await expect.poll(() => currentExecutionResources()!.admission.snapshot.active, { timeout: 5000 }).toBe(0);
        const output = await execFileWithResources(process.execPath, ["-e", "console.log('recovered')"], { timeout: 5000 });
        expect(output.stdout.trim()).toBe("recovered");
        return success();
      });
      expect(later.exitCode).toBe(0);
      expect(later.errorCode).toBeUndefined();
      await writeFile(`${process.env.PAPERCLIP_SCRATCH_DIR}/recovered-ownership-evidence.json`, JSON.stringify({ runA, runB, runC, ids, result, later, events }, null, 2));
    } finally {
      await recovered?.cleanup().catch(() => {});
      await ctl(["stop", unit]).catch(() => {});
      await ctl(["reset-failed", unit]).catch(() => {});
      await ctl(["stop", slice]).catch(() => {});
      await ctl(["revert", slice]).catch(() => {});
    }
  }, 30_000);
});
