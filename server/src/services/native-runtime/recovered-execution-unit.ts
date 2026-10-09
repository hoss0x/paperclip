import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { heartbeatRunEvents, type Db } from "@paperclipai/db";

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
): Promise<{ signal: (signal: NodeJS.Signals) => Promise<boolean>; cleanup: () => Promise<void> } | null> {
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
  return {
    signal: async signal => {
      if (!await dependencies.isAlive()) return false;
      if (!(await dependencies.readCgroup()).split("\n").includes(`0::${cgroup}`)) throw new Error("Recovered execution process moved");
      await verify();
      await dependencies.systemctl(["kill", "--kill-whom=all", `--signal=${signal}`, unit]);
      return true;
    },
    cleanup: async () => {
      const load = await dependencies.systemctl(["show", unit, "--property=LoadState", "--value"]);
      if (load.trim() === "not-found") return;
      const previousState = await dependencies.systemctl(["show", unit, "--property=ActiveState", "--value"]);
      if (["inactive", "failed"].includes(previousState.trim())) return;
      await verify();
      await dependencies.systemctl(["stop", unit]);
      const state = await dependencies.systemctl(["show", unit, "--property=ActiveState", "--value"]);
      if (!["inactive", "failed"].includes(state.trim())) throw new Error("Recovered execution unit termination was not verified");
    },
  };
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
