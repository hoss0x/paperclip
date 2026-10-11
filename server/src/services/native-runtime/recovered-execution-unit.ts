import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";
import { currentExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import type { ExecutionResourceEvidence } from "@paperclipai/adapter-utils/systemd-execution";

const exec = promisify(execFile);
export interface RecoveredExecutionUnitDependencies {
  isAlive: () => Promise<boolean>;
  readCgroup: () => Promise<string>;
  systemctl: (args: string[]) => Promise<string>;
}

/** Capture authority from server-owned run events AND the verified live PID.
 * Once captured, the unit remains owned after its leader exits. Never derive
 * cancellation authority from provider output or a PID without its fingerprint.
 */
export async function recoverExecutionUnit(
  runId: string,
  records: { unit?: unknown; memoryMaxBytes?: unknown; originRunId?: unknown; previousRunId?: unknown }[],
  dependencies: RecoveredExecutionUnitDependencies,
): Promise<{ signal: (signal: NodeJS.Signals) => Promise<boolean>; cleanup: () => Promise<void>; onAuthenticated: () => Promise<void> } | null> {
  if (!await dependencies.isAlive()) throw new Error("Recovered execution process identity changed");
  const cgroup = (await dependencies.readCgroup()).split("\n").find(line => line.startsWith("0::"))?.slice(3);
  const unit = cgroup?.split("/").at(-1);
  if (!unit?.startsWith("paperclip-execution-")) return null;
  const prefix = `paperclip-execution-${runId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}-`;
  const record = records.find(record => record.unit === unit && Number.isSafeInteger(record.memoryMaxBytes)
    && Number(record.memoryMaxBytes) > 0);
  // Transferred authority is an authenticated controller event (the DB reader
  // excludes provider-source events). The original unit name stays immutable.
  const transferredPrefix = typeof record?.originRunId === "string" && typeof record.previousRunId === "string"
    ? `paperclip-execution-${record.originRunId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}-` : undefined;
  if ((!unit.startsWith(prefix) && !(transferredPrefix && unit.startsWith(transferredPrefix))) || !/^paperclip-execution-[a-zA-Z0-9-]+\.(service|scope)$/.test(unit) || !record) {
    throw new Error("Recovered execution unit ownership is missing");
  }
  const verify = async () => {
    const properties = Object.fromEntries((await dependencies.systemctl([
      "show", unit, "--property=Id", "--property=ControlGroup", "--property=MemoryMax",
    ])).trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    if (properties.Id !== unit || properties.ControlGroup !== cgroup || Number(properties.MemoryMax) !== record.memoryMaxBytes) {
      throw new Error("Recovered execution unit identity changed");
    }
  };
  await verify();
  if (!await dependencies.isAlive() || (await dependencies.readCgroup()).split("\n").find(line => line.startsWith("0::")) !== `0::${cgroup}`) {
    throw new Error("Recovered execution process identity changed");
  }
  const resources = currentExecutionResources();
  const evidence: ExecutionResourceEvidence = {
    unit, memoryMaxBytes: Number(record.memoryMaxBytes), memoryHighBytes: Number(record.memoryMaxBytes),
    memorySwapMaxBytes: 0, peakMemoryBytes: null, result: null, resourceLimitReached: false,
    mainExitCode: null, mainExitStatus: null, cancelled: false,
  };
  let authenticated = false;
  let reported = false;
  let samples: NodeJS.Timeout | undefined;
  let unregister: (() => void) | undefined;
  let activeSignal: AbortSignal | undefined;
  let closing: Promise<void> | undefined;
  const sample = async (properties = false) => {
    try {
      const [peak, events] = await Promise.all([
        readFile(`/sys/fs/cgroup${cgroup}/memory.peak`, "utf8"),
        readFile(`/sys/fs/cgroup${cgroup}/memory.events`, "utf8"),
      ]);
      const bytes = Number(peak.trim());
      if (Number.isSafeInteger(bytes)) evidence.peakMemoryBytes = Math.max(evidence.peakMemoryBytes ?? 0, bytes);
      evidence.resourceLimitReached ||= /^oom_kill [1-9]\d*$/m.test(events);
    } catch { /* Keep measurements when systemd removes the cgroup after exit. */ }
    if (!properties) return;
    const values = Object.fromEntries((await dependencies.systemctl(["show", unit,
      "--property=MemoryHigh,MemorySwapMax,MemoryPeak,Result,ExecMainCode,ExecMainStatus",
    ])).trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    for (const [property, field] of [["MemoryHigh", "memoryHighBytes"], ["MemorySwapMax", "memorySwapMaxBytes"],
      ["ExecMainCode", "mainExitCode"], ["ExecMainStatus", "mainExitStatus"]] as const) {
      const value = values[property];
      if (value && Number.isSafeInteger(Number(value))) evidence[field] = Number(value);
    }
    const peak = Number(values.MemoryPeak);
    if (values.MemoryPeak && Number.isSafeInteger(peak)) evidence.peakMemoryBytes = Math.max(evidence.peakMemoryBytes ?? 0, peak);
    evidence.result = values.Result || evidence.result;
    evidence.resourceLimitReached ||= values.Result === "oom-kill";
  };
  const recovered = {
    signal: async (signal: NodeJS.Signals) => {
      if (!await dependencies.isAlive()) return false;
      if (!(await dependencies.readCgroup()).split("\n").includes(`0::${cgroup}`)) throw new Error("Recovered execution process moved");
      await verify();
      await dependencies.systemctl(["kill", "--kill-whom=all", `--signal=${signal}`, unit]);
      return true;
    },
    cleanup: (): Promise<void> => closing ??= (async () => {
      if (authenticated) await sample(true);
      const load = await dependencies.systemctl(["show", unit, "--property=LoadState", "--value"]);
      if (load.trim() !== "not-found") {
        const previousState = await dependencies.systemctl(["show", unit, "--property=ActiveState", "--value"]);
        if (!["inactive", "failed"].includes(previousState.trim())) {
          await verify();
          await dependencies.systemctl(["stop", unit]);
          const state = await dependencies.systemctl(["show", unit, "--property=ActiveState", "--value"]);
          if (!["inactive", "failed"].includes(state.trim())) throw new Error("Recovered execution unit termination was not verified");
        }
        if (authenticated) await sample(true);
      }
      if (authenticated && !reported) {
        await resources?.onEvidence?.({ ...evidence });
        reported = true;
      }
      // Failed units retain their terminal state until reset. Persist evidence
      // first; a recorder failure must leave that state available for retry.
      if (load.trim() !== "not-found") await dependencies.systemctl(["reset-failed", unit]).catch(() => {});
      clearInterval(samples);
      activeSignal?.removeEventListener("abort", abort);
      unregister?.();
    })().catch(error => { closing = undefined; throw error; }),
    // PID/cgroup verification alone does not authorize a replacement controller
    // to subscribe cancellation or take the retained lease. PRP authenticates first.
    onAuthenticated: async () => {
      if (authenticated || resources?.policy.isolation !== "systemd") return;
      await sample(true);
      if (!await dependencies.isAlive()) {
        if (evidence.resourceLimitReached) {
          authenticated = true;
          await recovered.cleanup();
          throw new Error("Recovered execution unit exceeded its resource limit");
        }
        throw new Error("Recovered execution process identity changed");
      }
      await verify();
      if (!(await dependencies.readCgroup()).split("\n").includes(`0::${cgroup}`)) throw new Error("Recovered execution process moved");
      unregister = resources.ownership?.register({ unit, memoryMaxBytes: Number(record.memoryMaxBytes),
        originRunId: typeof record.originRunId === "string" ? record.originRunId : runId,
        verify: async () => {
          if (closing || !await dependencies.isAlive()) throw new Error("Recovered execution process identity changed");
          if (!(await dependencies.readCgroup()).split("\n").includes(`0::${cgroup}`)) throw new Error("Recovered execution process moved");
          await verify(); await sample(true);
          if (evidence.resourceLimitReached) throw new Error("Recovered execution unit exceeded its resource limit");
        },
        rebind: signal => bindSignal(signal),
      });
      authenticated = true;
      let sampling = false;
      samples = setInterval(() => {
        if (sampling || closing) return;
        sampling = true;
        void sample().finally(() => { sampling = false; });
      }, 250);
      samples.unref();
      bindSignal(resources.signal);
    },
  };
  const abort = () => { evidence.cancelled = true; void recovered.cleanup().catch(() => { /* Retain ownership on failed cleanup. */ }); };
  function bindSignal(signal?: AbortSignal) {
    activeSignal?.removeEventListener("abort", abort);
    activeSignal = signal;
    activeSignal?.addEventListener("abort", abort, { once: true });
    if (activeSignal?.aborted) abort();
  }
  return recovered;
}

export async function recoverRecordedExecutionUnit(db: Db, input: {
  companyId: string; runId: string; pid: number; isAlive: () => Promise<boolean>;
}) {
  if (process.platform !== "linux") return null;
  const rows = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, input.companyId), eq(heartbeatRunEvents.runId, input.runId),
    eq(heartbeatRunEvents.eventType, "execution_resource_prepared"), isNull(heartbeatRunEvents.sourceEventId),
  ));
  const records = rows.map(row => row.payload ?? {});
  for (const record of records) {
    if (typeof record.unit !== "string") continue;
    const [latest] = await db.select({ runId: heartbeatRunEvents.runId })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.eventType, "execution_resource_claimed"), isNull(heartbeatRunEvents.sourceEventId),
        sql`${heartbeatRunEvents.payload}->'units' ? ${record.unit}`))
      .orderBy(desc(heartbeatRunEvents.id)).limit(1);
    if (latest && latest.runId !== input.runId) throw new Error("Recovered execution unit belongs to a later run");
    if (record.previousRunId && (!latest || latest.runId !== input.runId)) {
      throw new Error("Recovered execution resource handoff was not committed");
    }
  }
  return recoverExecutionUnit(input.runId, records, {
    isAlive: input.isAlive,
    readCgroup: () => readFile(`/proc/${input.pid}/cgroup`, "utf8"),
    systemctl: async args => (await exec("systemctl", ["--user", ...args], {
      timeout: args[0] === "stop" ? 15_000 : 5_000, maxBuffer: 64 * 1024,
    })).stdout,
  });
}
