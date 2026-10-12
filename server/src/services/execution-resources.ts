import { resolvePaperclipRunnerBinary } from "./native-runtime/runner-binary.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { currentExecutionResources, withOperatorExecutionResources } from "@paperclipai/adapter-utils/execution-resource-context";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import type { ExecutionResourceEvidence } from "@paperclipai/adapter-utils/systemd-execution";

export const RESOURCE_UNIT_PREPARED = "execution_resource_prepared";
export const RESOURCE_UNIT_FINISHED = "execution_resource_finished";
const execFileAsync = promisify(execFile);
const queuedResourceControllers = new Map<string, AbortController>();

/** A queue reservation is not an opted-in provider stop owner. */
export function cancelQueuedResourceExecution(runId: string, reason: string): void {
  if (!runningProcesses.has(runId)) queuedResourceControllers.get(runId)?.abort(new Error(reason));
}

// Adapter output is data, not controller-owned cancellation authority.
export function resourceSafeAdapterEventType(eventType: string): string {
  return eventType.startsWith("execution_resource_") ? `adapter.${eventType}` : eventType;
}

export class ExecutionResourceLimitError extends Error {
  readonly code = "execution_resource_limit";
  constructor(readonly evidence: ExecutionResourceEvidence[]) {
    super("Execution exceeded its memory resource limit");
  }
}

/** Resource failures are projected once, independently of adapter parsers. */
export async function executeWithResourceGovernance(input: {
  runId?: string;
  scratchDir: string;
  slice?: string;
  signal: AbortSignal;
  controller?: AbortController;
  record: (event: { eventType: string; message: string; payload: Record<string, unknown> }) => Promise<void>;
}, execute: () => Promise<AdapterExecutionResult>): Promise<AdapterExecutionResult> {
  const evidence: ExecutionResourceEvidence[] = [];
  return withOperatorExecutionResources({
    runId: input.runId,
    scratchDir: input.scratchDir, slice: input.slice, signal: input.signal,
    nativeLoaderCommand: resolvePaperclipRunnerBinary,
    onUnitPrepared: async unit => input.record({ eventType: RESOURCE_UNIT_PREPARED,
      message: "Resource execution unit prepared", payload: unit }),
    onOwnershipCommitted: async claim => input.record({ eventType: "execution_resource_claimed",
      message: "Retained execution resources transferred to the active run", payload: claim }),
    onEvidence: async result => {
      evidence.push(result);
      await input.record({ eventType: RESOURCE_UNIT_FINISHED,
        message: result.resourceLimitReached ? "Execution exceeded its memory resource limit" : "Resource execution unit stopped",
        payload: { ...result } });
    },
  }, async () => {
    if (input.runId && input.controller && currentExecutionResources()?.policy.isolation === "systemd") {
      queuedResourceControllers.set(input.runId, input.controller);
    }
    try {
      let result: AdapterExecutionResult;
      try { result = await execute(); }
      catch (error) {
        if (evidence.some(item => item.resourceLimitReached)) throw new ExecutionResourceLimitError(evidence);
        throw error;
      }
      const limited = evidence.some(item => item.resourceLimitReached);
      return { ...result,
        ...(limited ? { exitCode: result.exitCode || 1, errorCode: "execution_resource_limit", errorMessage: "Execution exceeded its memory resource limit" } : {}),
        ...(evidence.length ? { resultJson: { ...result.resultJson, executionResources: evidence } } : {}),
      };
    } finally {
      if (input.runId && queuedResourceControllers.get(input.runId) === input.controller) queuedResourceControllers.delete(input.runId);
    }
  });
}

/** Only immutable local run-log ownership, never agent-supplied unit names. */
export async function stopRecordedLegacyExecutionUnits(db: Db, run: { id: string; companyId: string; runtimeMode: string | null },
  systemctl: (args: string[], timeout: number) => Promise<string> = async (args, timeout) =>
    (await execFileAsync("systemctl", ["--user", ...args], { timeout })).stdout,
): Promise<boolean> {
  if (process.platform !== "linux" || run.runtimeMode === "native") return false;
  const rows = await db.select({ payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
    eq(heartbeatRunEvents.eventType, RESOURCE_UNIT_PREPARED), isNull(heartbeatRunEvents.sourceEventId),
  ));
  const prefix = `paperclip-execution-${run.id.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}-`;
  const units = new Set<string>();
  for (const row of rows) {
    const payload = row.payload ?? {};
    const unit = payload.unit;
    if (typeof unit !== "string" || !/^paperclip-execution-[a-zA-Z0-9-]+\.(?:service|scope)$/.test(unit)) continue;
    const originalPrefix = typeof payload.originRunId === "string" && typeof payload.previousRunId === "string"
      ? `paperclip-execution-${payload.originRunId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 48)}-` : undefined;
    if (!unit.startsWith(prefix) && !(originalPrefix && unit.startsWith(originalPrefix))) continue;
    if (units.has(unit)) continue;
    // Unit names retain the first run's prefix. Cancellation and restart
    // cleanup must follow the latest committed controller claim instead.
    const [latest] = await db.select({ runId: heartbeatRunEvents.runId }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.companyId, run.companyId),
        eq(heartbeatRunEvents.eventType, "execution_resource_claimed"), isNull(heartbeatRunEvents.sourceEventId),
        sql`${heartbeatRunEvents.payload}->'units' ? ${unit}`))
      .orderBy(desc(heartbeatRunEvents.id)).limit(1);
    if (latest && latest.runId !== run.id) throw new Error("Execution unit belongs to a later run");
    if (!unit.startsWith(prefix) && !latest) throw new Error("Execution resource handoff was not committed");
    units.add(unit);
  }
  for (const unit of units) {
    const stdout = await systemctl(["show", unit, "--property=LoadState", "--value"], 5_000);
    if (stdout.trim() === "not-found") continue;
    await systemctl(["stop", unit], 15_000);
    const state = await systemctl(["show", unit, "--property=ActiveState", "--value"], 5_000);
    if (!["inactive", "failed"].includes(state.trim())) throw new Error("Execution unit termination was not verified");
    await systemctl(["reset-failed", unit], 5_000).catch(() => {});
  }
  return units.size > 0;
}
